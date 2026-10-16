import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureOrder,
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
        user_action: 'PAY_NOW',
      },
    });
  });

  // 0.1.18: the return page captures the order the moment the payer lands
  // on it. Without user_action PayPal defaults to CONTINUE, a "Continue"
  // button for flows that send the payer back WITHOUT processing the payment
  // (final amount not yet known). PAY_NOW shows "Pay Now": the amount is
  // final and the payment is processed immediately, which is what happens.
  it('declares the immediate-capture flow: user_action PAY_NOW, so PayPal shows "Pay Now" rather than "Continue"', async () => {
    const fetchMock = mockFetch({
      '/v1/oauth2/token': () => ({ ok: true, json: async () => tokenFixture }),
      '/v2/checkout/orders': () => ({ ok: true, json: async () => orderFixture }),
    });

    await createOrder(
      {
        totalCents: 100,
        currency: 'usd',
        entryId: 'entry_paynow',
        returnUrl: 'https://site.example/forms-pay/paypal-return',
        cancelUrl: 'https://site.example/forms-pay',
      },
      { fetch: fetchMock as unknown as typeof fetch },
    );

    const orderCall = fetchMock.mock.calls.find(([url]) => (url as string).includes('/v2/checkout/orders'))!;
    const [, init] = orderCall as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { application_context: { user_action?: string } };
    expect(body.application_context.user_action).toBe('PAY_NOW');
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

// ---------------------------------------------------------------------------
// captureOrder (0.1.18). Up to 0.1.17 the package created `intent: CAPTURE`
// orders and never captured them after the buyer approved, so no money moved
// and PAYMENT.CAPTURE.COMPLETED never fired. Capture is
// POST /v2/checkout/orders/{id}/capture with a FRESH PayPal-Request-Id per
// attempt. PayPal replays the stored answer for a reused id, so an id fixed
// per order would replay an INSTRUMENT_DECLINED (or a pre-approval
// ORDER_NOT_APPROVED) after the payer fixed it in PayPal. A reload or double
// hit cannot capture twice because PayPal allows one capture per
// CAPTURE-intent order (ORDER_ALREADY_CAPTURED, mapped in paypal-return.ts).
// ---------------------------------------------------------------------------

describe('captureOrder', () => {
  const ORDER_ID = '5O190127TN364715T';
  /** `crypto.randomUUID()` output (RFC 4122 v4). */
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const captureUrl = `https://api-m.sandbox.paypal.com/v2/checkout/orders/${ORDER_ID}/capture`;

  /** A 2xx capture body (Prefer: return=representation): the order, and the capture inside its purchase unit. */
  const captured = (captureStatus: string, orderStatus = 'COMPLETED') => ({
    id: ORDER_ID,
    status: orderStatus,
    purchase_units: [{ payments: { captures: [{ id: '3C679366HH908993F', status: captureStatus }] } }],
  });

  /** PayPal's documented error envelope: name, details[].issue, debug_id. */
  const paypalError = (issue: string, name = 'UNPROCESSABLE_ENTITY') => ({
    name,
    details: [{ issue, description: 'from PayPal' }],
    debug_id: 'f1e2d3c4b5a6',
  });

  /** Capture handler first: the order-create pattern '/v2/checkout/orders' is a prefix of the capture URL. */
  function captureFetch(response: () => unknown) {
    return mockFetch({
      '/capture': response,
      '/v1/oauth2/token': () => ({ ok: true, status: 200, json: async () => tokenFixture }),
    });
  }

  it('POSTs the documented capture call: bearer token, a UUID idempotency key, full representation, no body', async () => {
    const fetchMock = captureFetch(() => ({ ok: true, status: 201, json: async () => captured('COMPLETED') }));

    const result = await captureOrder(ORDER_ID, { fetch: fetchMock as unknown as typeof fetch });

    expect(result).toEqual({ ok: true, orderStatus: 'COMPLETED', captureStatus: 'COMPLETED' });
    const captureCall = fetchMock.mock.calls.find(([url]) => (url as string).includes('/capture'))!;
    const [url, init] = captureCall as [string, RequestInit];
    expect(url).toBe(captureUrl);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': expect.stringMatching(UUID_PATTERN),
      Prefer: 'return=representation',
    });
    expect(init.body).toBeUndefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('two capture attempts for the same order send DIFFERENT PayPal-Request-Ids, so a retry after a decline is a new request, not a replay', async () => {
    const fetchMock = captureFetch(() => ({ ok: true, status: 200, json: async () => captured('COMPLETED') }));

    await captureOrder(ORDER_ID, { fetch: fetchMock as unknown as typeof fetch });
    await captureOrder(ORDER_ID, { fetch: fetchMock as unknown as typeof fetch });

    const requestIds = fetchMock.mock.calls
      .filter(([url]) => (url as string).includes('/capture'))
      .map(([, init]) => ((init as RequestInit).headers as Record<string, string>)['PayPal-Request-Id']);
    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).toMatch(UUID_PATTERN);
    expect(requestIds[1]).toMatch(UUID_PATTERN);
    expect(requestIds[0]).not.toBe(requestIds[1]);
  });

  it('reports a pending capture as such (PayPal took the order but has not settled the money)', async () => {
    const fetchMock = captureFetch(() => ({ ok: true, status: 201, json: async () => captured('PENDING') }));

    expect(await captureOrder(ORDER_ID, { fetch: fetchMock as unknown as typeof fetch })).toEqual({
      ok: true,
      orderStatus: 'COMPLETED',
      captureStatus: 'PENDING',
    });
  });

  it.each([
    ['ORDER_ALREADY_CAPTURED', 422],
    ['INSTRUMENT_DECLINED', 422],
    ['ORDER_NOT_APPROVED', 422],
    ['PREVIOUS_REQUEST_IN_PROGRESS', 409],
  ])('a %s error comes back as {ok:false} with the issue, HTTP status and debug id (never thrown)', async (issue, status) => {
    const fetchMock = captureFetch(() => ({ ok: false, status, json: async () => paypalError(issue) }));

    expect(await captureOrder(ORDER_ID, { fetch: fetchMock as unknown as typeof fetch })).toEqual({
      ok: false,
      httpStatus: status,
      issue,
      debugId: 'f1e2d3c4b5a6',
    });
  });

  it('an error body without details falls back to the error name as the issue', async () => {
    const fetchMock = captureFetch(() => ({
      ok: false,
      status: 404,
      json: async () => ({ name: 'RESOURCE_NOT_FOUND', debug_id: 'abc' }),
    }));

    expect(await captureOrder(ORDER_ID, { fetch: fetchMock as unknown as typeof fetch })).toEqual({
      ok: false,
      httpStatus: 404,
      issue: 'RESOURCE_NOT_FOUND',
      debugId: 'abc',
    });
  });

  it('resolves {ok:false} (never rejects) on a network throw or an unparseable body', async () => {
    const throwing = vi.fn(async (url: string) => {
      if (url.includes('/v1/oauth2/token')) return { ok: true, status: 200, json: async () => tokenFixture };
      throw new Error('network down');
    });
    expect(await captureOrder(ORDER_ID, { fetch: throwing as unknown as typeof fetch })).toEqual({ ok: false });

    const garbled = captureFetch(() => ({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('Unexpected token');
      },
    }));
    expect(await captureOrder(ORDER_ID, { fetch: garbled as unknown as typeof fetch })).toEqual({
      ok: false,
      httpStatus: 500,
    });
  });

  it('resolves {ok:false} without calling the capture endpoint when no access token can be had', async () => {
    const fetchMock = mockFetch({
      '/capture': () => ({ ok: true, status: 201, json: async () => captured('COMPLETED') }),
      '/v1/oauth2/token': () => ({ ok: false, status: 401, json: async () => ({}) }),
    });

    expect(await captureOrder(ORDER_ID, { fetch: fetchMock as unknown as typeof fetch })).toEqual({ ok: false });
    expect(fetchMock.mock.calls.some(([url]) => (url as string).includes('/capture'))).toBe(false);
  });

  // The id goes into the request path. PayPal documents order ids as
  // ^[A-Z0-9]+$ (1-36 chars); anything else is refused before any network
  // call, so no value can reshape the path.
  it.each(['', '../../v1/oauth2/token', 'abc123', 'A'.repeat(37), 'ORDER 1', 'ORDER%2F1'])(
    'refuses a malformed order id %j before any network call',
    async (orderId) => {
      const fetchMock = captureFetch(() => ({ ok: true, status: 201, json: async () => captured('COMPLETED') }));

      expect(await captureOrder(orderId, { fetch: fetchMock as unknown as typeof fetch })).toEqual({ ok: false });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
