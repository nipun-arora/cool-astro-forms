import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createOrder,
  getAccessToken,
  paypalBaseUrl,
  paypalConfigured,
  verifyPaypalWebhookSignature,
} from './paypal.js';

// Every case here injects a FAKE `deps.fetch` — NEVER a live call to
// api-m.paypal.com / api-m.sandbox.paypal.com (mirrors geo.ts/turnstile.ts's
// fetch-mocking convention, generalized to dependency injection since
// paypal.ts routes every call through an injectable `deps.fetch`).

const CLIENT_ID = 'paypal-client-id';
const CLIENT_SECRET = 'paypal-client-secret';
const WEBHOOK_ID = 'WH-TEST-1';
const ACCESS_TOKEN = 'A21AAtest-access-token';

const tokenFixture = { access_token: ACCESS_TOKEN, token_type: 'Bearer', expires_in: 32400 };

/** Routes a fetch mock by matching a URL substring — robust regardless of call order (token, then order/verify). */
function mockFetch(handlers: Record<string, () => unknown>): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string) => {
    for (const [pattern, handler] of Object.entries(handlers)) {
      if (url.includes(pattern)) return handler();
    }
    throw new Error(`Unhandled fetch URL in test: ${url}`);
  }) as unknown as ReturnType<typeof vi.fn>;
}

beforeEach(() => {
  process.env.PAYPAL_CLIENT_ID = CLIENT_ID;
  process.env.PAYPAL_CLIENT_SECRET = CLIENT_SECRET;
  process.env.PAYPAL_WEBHOOK_ID = WEBHOOK_ID;
  delete process.env.PAYPAL_ENV;
});

afterEach(() => {
  delete process.env.PAYPAL_CLIENT_ID;
  delete process.env.PAYPAL_CLIENT_SECRET;
  delete process.env.PAYPAL_WEBHOOK_ID;
  delete process.env.PAYPAL_ENV;
});

// ---------------------------------------------------------------------------
// paypalBaseUrl / paypalConfigured
// ---------------------------------------------------------------------------

describe('paypalBaseUrl', () => {
  it('defaults to the sandbox host', () => {
    expect(paypalBaseUrl()).toBe('https://api-m.sandbox.paypal.com');
  });

  it('uses the live host when PAYPAL_ENV=live', () => {
    process.env.PAYPAL_ENV = 'live';
    expect(paypalBaseUrl()).toBe('https://api-m.paypal.com');
  });
});

describe('paypalConfigured (PAY-04)', () => {
  it('true when both PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are set', () => {
    expect(paypalConfigured()).toBe(true);
  });

  it('false when PAYPAL_CLIENT_ID is missing', () => {
    delete process.env.PAYPAL_CLIENT_ID;
    expect(paypalConfigured()).toBe(false);
  });

  it('false when PAYPAL_CLIENT_SECRET is missing', () => {
    delete process.env.PAYPAL_CLIENT_SECRET;
    expect(paypalConfigured()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getAccessToken
// ---------------------------------------------------------------------------

describe('getAccessToken', () => {
  it('POSTs client_credentials with Basic auth and resolves the access token on success', async () => {
    const fetchMock = mockFetch({ '/v1/oauth2/token': () => ({ ok: true, json: async () => tokenFixture }) });

    const token = await getAccessToken({ fetch: fetchMock as unknown as typeof fetch });

    expect(token).toBe(ACCESS_TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api-m.sandbox.paypal.com/v1/oauth2/token');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('grant_type=client_credentials');
    expect(init.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('resolves undefined without calling fetch when client id/secret are absent (PAY-04 inert)', async () => {
    delete process.env.PAYPAL_CLIENT_ID;
    const fetchMock = mockFetch({ '/v1/oauth2/token': () => ({ ok: true, json: async () => tokenFixture }) });

    const token = await getAccessToken({ fetch: fetchMock as unknown as typeof fetch });

    expect(token).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves undefined on a non-2xx response', async () => {
    const fetchMock = mockFetch({
      '/v1/oauth2/token': () => ({ ok: false, json: async () => ({ error: 'invalid_client' }) }),
    });
    const token = await getAccessToken({ fetch: fetchMock as unknown as typeof fetch });
    expect(token).toBeUndefined();
  });

  it('resolves undefined (never rejects) on a network throw', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });
    const token = await getAccessToken({ fetch: fetchMock as unknown as typeof fetch });
    expect(token).toBeUndefined();
  });

  it('resolves undefined on a malformed JSON body', async () => {
    const fetchMock = mockFetch({
      '/v1/oauth2/token': () => ({
        ok: true,
        json: async () => {
          throw new Error('Unexpected token');
        },
      }),
    });
    const token = await getAccessToken({ fetch: fetchMock as unknown as typeof fetch });
    expect(token).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createOrder
// ---------------------------------------------------------------------------

describe('createOrder', () => {
  const orderFixture = {
    id: 'PAYPAL-ORDER-1',
    links: [
      { rel: 'self', href: 'https://api-m.sandbox.paypal.com/v2/checkout/orders/PAYPAL-ORDER-1' },
      { rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL-ORDER-1' },
    ],
  };

  it('builds the documented CAPTURE-intent body: amount.value as a 2-dp string, custom_id = entryId', async () => {
    const fetchMock = mockFetch({
      '/v1/oauth2/token': () => ({ ok: true, json: async () => tokenFixture }),
      '/v2/checkout/orders': () => ({ ok: true, json: async () => orderFixture }),
    });

    const result = await createOrder(
      {
        totalCents: 20050,
        currency: 'usd',
        entryId: 'entry_9',
        returnUrl: 'https://site.example/forms-pay/paypal-return/',
        cancelUrl: 'https://site.example/forms-pay/?amount=200.50',
      },
      { fetch: fetchMock as unknown as typeof fetch },
    );

    expect(result).toEqual({
      approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL-ORDER-1',
      providerRef: 'PAYPAL-ORDER-1',
    });

    const orderCall = fetchMock.mock.calls.find(([url]) => (url as string).includes('/v2/checkout/orders'))!;
    const [url, init] = orderCall as [string, RequestInit];
    expect(url).toBe('https://api-m.sandbox.paypal.com/v2/checkout/orders');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${ACCESS_TOKEN}` });
    expect(JSON.parse(init.body as string)).toEqual({
      intent: 'CAPTURE',
      purchase_units: [{ amount: { currency_code: 'usd', value: '200.50' }, custom_id: 'entry_9' }],
      application_context: {
        return_url: 'https://site.example/forms-pay/paypal-return/',
        cancel_url: 'https://site.example/forms-pay/?amount=200.50',
      },
    });
  });

  it('B1: passes returnUrl/cancelUrl through byte-verbatim (trailing-slash-shaped returnUrl)', async () => {
    const fetchMock = mockFetch({
      '/v1/oauth2/token': () => ({ ok: true, json: async () => tokenFixture }),
      '/v2/checkout/orders': () => ({ ok: true, json: async () => orderFixture }),
    });
    const returnUrl = 'https://site.example/forms-pay/paypal-return/';
    const cancelUrl = 'https://site.example/forms-pay/';

    await createOrder(
      { totalCents: 100, currency: 'usd', entryId: 'entry_10', returnUrl, cancelUrl },
      { fetch: fetchMock as unknown as typeof fetch },
    );

    const orderCall = fetchMock.mock.calls.find(([url]) => (url as string).includes('/v2/checkout/orders'))!;
    const [, init] = orderCall as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      application_context: { return_url: string; cancel_url: string };
    };
    expect(body.application_context.return_url).toBe(returnUrl);
    expect(body.application_context.cancel_url).toBe(cancelUrl);
  });

  it('falls back to rel === "approve" when no "payer-action" link is present', async () => {
    const fetchMock = mockFetch({
      '/v1/oauth2/token': () => ({ ok: true, json: async () => tokenFixture }),
      '/v2/checkout/orders': () => ({
        ok: true,
        json: async () => ({
          id: 'PAYPAL-ORDER-2',
          links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL-ORDER-2' }],
        }),
      }),
    });

    const result = await createOrder(
      {
        totalCents: 100,
        currency: 'usd',
        entryId: 'entry_11',
        returnUrl: 'https://site.example/r/',
        cancelUrl: 'https://site.example/c/',
      },
      { fetch: fetchMock as unknown as typeof fetch },
    );

    expect(result).toEqual({
      approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL-ORDER-2',
      providerRef: 'PAYPAL-ORDER-2',
    });
  });

  it('resolves undefined without calling the orders endpoint when client id/secret are absent (PAY-04 inert)', async () => {
    delete process.env.PAYPAL_CLIENT_ID;
    const fetchMock = mockFetch({
      '/v1/oauth2/token': () => ({ ok: true, json: async () => tokenFixture }),
      '/v2/checkout/orders': () => ({ ok: true, json: async () => orderFixture }),
    });

    const result = await createOrder(
      {
        totalCents: 100,
        currency: 'usd',
        entryId: 'entry_12',
        returnUrl: 'https://site.example/r/',
        cancelUrl: 'https://site.example/c/',
      },
      { fetch: fetchMock as unknown as typeof fetch },
    );

    expect(result).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves undefined when the order response has no approval link', async () => {
    const fetchMock = mockFetch({
      '/v1/oauth2/token': () => ({ ok: true, json: async () => tokenFixture }),
      '/v2/checkout/orders': () => ({
        ok: true,
        json: async () => ({ id: 'PAYPAL-ORDER-3', links: [{ rel: 'self', href: 'https://x' }] }),
      }),
    });

    const result = await createOrder(
      {
        totalCents: 100,
        currency: 'usd',
        entryId: 'entry_13',
        returnUrl: 'https://site.example/r/',
        cancelUrl: 'https://site.example/c/',
      },
      { fetch: fetchMock as unknown as typeof fetch },
    );

    expect(result).toBeUndefined();
  });

  it('resolves undefined (never rejects) on a network throw from the orders endpoint', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/v1/oauth2/token')) return { ok: true, json: async () => tokenFixture };
      throw new Error('network down');
    });

    const result = await createOrder(
      {
        totalCents: 100,
        currency: 'usd',
        entryId: 'entry_14',
        returnUrl: 'https://site.example/r/',
        cancelUrl: 'https://site.example/c/',
      },
      { fetch: fetchMock as unknown as typeof fetch },
    );

    expect(result).toBeUndefined();
  });

  it('resolves undefined on a non-2xx response from the orders endpoint', async () => {
    const fetchMock = mockFetch({
      '/v1/oauth2/token': () => ({ ok: true, json: async () => tokenFixture }),
      '/v2/checkout/orders': () => ({ ok: false, json: async () => ({ name: 'INVALID_REQUEST' }) }),
    });

    const result = await createOrder(
      {
        totalCents: 100,
        currency: 'usd',
        entryId: 'entry_15',
        returnUrl: 'https://site.example/r/',
        cancelUrl: 'https://site.example/c/',
      },
      { fetch: fetchMock as unknown as typeof fetch },
    );

    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// verifyPaypalWebhookSignature
// ---------------------------------------------------------------------------

describe('verifyPaypalWebhookSignature', () => {
  const rawBody = JSON.stringify({
    id: 'WH-EVT-1',
    event_type: 'PAYMENT.CAPTURE.COMPLETED',
    resource: { id: 'CAPTURE-1', supplementary_data: { related_ids: { order_id: 'PAYPAL-ORDER-1' } } },
  });

  function inboundHeaders(): Headers {
    return new Headers({
      'paypal-transmission-id': 'txn-1',
      'paypal-transmission-time': '2026-07-17T00:00:00Z',
      'paypal-cert-url': 'https://api.sandbox.paypal.com/cert',
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-transmission-sig': 'sig-value',
    });
  }

  it('posts the 5 transmission headers + webhook_id + parsed webhook_event, resolves true on SUCCESS', async () => {
    const fetchMock = mockFetch({
      '/v1/oauth2/token': () => ({ ok: true, json: async () => tokenFixture }),
      '/v1/notifications/verify-webhook-signature': () => ({
        ok: true,
        json: async () => ({ verification_status: 'SUCCESS' }),
      }),
    });

    const result = await verifyPaypalWebhookSignature(rawBody, inboundHeaders(), {
      fetch: fetchMock as unknown as typeof fetch,
    });

    expect(result).toBe(true);
    const verifyCall = fetchMock.mock.calls.find(([url]) =>
      (url as string).includes('/v1/notifications/verify-webhook-signature'),
    )!;
    const [url, init] = verifyCall as [string, RequestInit];
    expect(url).toBe('https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature');
    expect(JSON.parse(init.body as string)).toEqual({
      transmission_id: 'txn-1',
      transmission_time: '2026-07-17T00:00:00Z',
      cert_url: 'https://api.sandbox.paypal.com/cert',
      auth_algo: 'SHA256withRSA',
      transmission_sig: 'sig-value',
      webhook_id: WEBHOOK_ID,
      webhook_event: JSON.parse(rawBody),
    });
  });

  it('resolves false when verification_status is not SUCCESS', async () => {
    const fetchMock = mockFetch({
      '/v1/oauth2/token': () => ({ ok: true, json: async () => tokenFixture }),
      '/v1/notifications/verify-webhook-signature': () => ({
        ok: true,
        json: async () => ({ verification_status: 'FAILURE' }),
      }),
    });

    const result = await verifyPaypalWebhookSignature(rawBody, inboundHeaders(), {
      fetch: fetchMock as unknown as typeof fetch,
    });

    expect(result).toBe(false);
  });

  it('defaults auth_algo to SHA256withRSA when the header is absent', async () => {
    const fetchMock = mockFetch({
      '/v1/oauth2/token': () => ({ ok: true, json: async () => tokenFixture }),
      '/v1/notifications/verify-webhook-signature': () => ({
        ok: true,
        json: async () => ({ verification_status: 'SUCCESS' }),
      }),
    });
    const headers = new Headers({
      'paypal-transmission-id': 'txn-1',
      'paypal-transmission-time': '2026-07-17T00:00:00Z',
      'paypal-cert-url': 'https://api.sandbox.paypal.com/cert',
      'paypal-transmission-sig': 'sig-value',
    });

    await verifyPaypalWebhookSignature(rawBody, headers, { fetch: fetchMock as unknown as typeof fetch });

    const verifyCall = fetchMock.mock.calls.find(([url]) =>
      (url as string).includes('/v1/notifications/verify-webhook-signature'),
    )!;
    const [, init] = verifyCall as [string, RequestInit];
    expect((JSON.parse(init.body as string) as { auth_algo: string }).auth_algo).toBe('SHA256withRSA');
  });

  it('resolves false without calling fetch when PAYPAL_WEBHOOK_ID is absent (PAY-04 inert)', async () => {
    delete process.env.PAYPAL_WEBHOOK_ID;
    const fetchMock = mockFetch({
      '/v1/oauth2/token': () => ({ ok: true, json: async () => tokenFixture }),
      '/v1/notifications/verify-webhook-signature': () => ({
        ok: true,
        json: async () => ({ verification_status: 'SUCCESS' }),
      }),
    });

    const result = await verifyPaypalWebhookSignature(rawBody, inboundHeaders(), {
      fetch: fetchMock as unknown as typeof fetch,
    });

    expect(result).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves false when the access token exchange fails', async () => {
    const fetchMock = mockFetch({ '/v1/oauth2/token': () => ({ ok: false, json: async () => ({}) }) });

    const result = await verifyPaypalWebhookSignature(rawBody, inboundHeaders(), {
      fetch: fetchMock as unknown as typeof fetch,
    });

    expect(result).toBe(false);
  });

  it('resolves false (never rejects) on a network throw from the verify endpoint', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/v1/oauth2/token')) return { ok: true, json: async () => tokenFixture };
      throw new Error('network down');
    });

    const result = await verifyPaypalWebhookSignature(rawBody, inboundHeaders(), {
      fetch: fetchMock as unknown as typeof fetch,
    });

    expect(result).toBe(false);
  });

  it('resolves false on a malformed rawBody (JSON.parse throws) without calling the verify endpoint', async () => {
    const fetchMock = mockFetch({
      '/v1/oauth2/token': () => ({ ok: true, json: async () => tokenFixture }),
      '/v1/notifications/verify-webhook-signature': () => ({
        ok: true,
        json: async () => ({ verification_status: 'SUCCESS' }),
      }),
    });

    const result = await verifyPaypalWebhookSignature('not-json{{{', inboundHeaders(), {
      fetch: fetchMock as unknown as typeof fetch,
    });

    expect(result).toBe(false);
    expect(
      fetchMock.mock.calls.some(([url]) => (url as string).includes('/v1/notifications/verify-webhook-signature')),
    ).toBe(false);
  });
});
