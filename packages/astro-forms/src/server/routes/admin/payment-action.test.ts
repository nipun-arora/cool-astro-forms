/**
 * payment-action.ts tests — POST /forms-admin/payments/action (PAY-01/
 * PAY-02): isSameOrigin is the ONLY origin check this route needs of its
 * own (T-03-24) — the session guard already covers every /forms-admin/*
 * path in middleware.ts. Every dependency (storage, stripe, paypal, notify)
 * is mocked so the suite stays network-free (mirrors entry-action.test.ts's
 * own vi.hoisted convention).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getEntryByIdMock,
  attachPaymentMock,
  sqliteStorageMock,
  createPaymentLinkMock,
  createOrderMock,
  paypalConfiguredMock,
  sendPaymentQuoteEmailMock,
  logErrorMock,
} = vi.hoisted(() => ({
  getEntryByIdMock: vi.fn(
    async (): Promise<{ id: string; formId: string; fields: Record<string, unknown> } | undefined> => undefined,
  ),
  attachPaymentMock: vi.fn(async () => undefined),
  sqliteStorageMock: vi.fn(function FakeSqliteStorage() {
    return {
      getEntryById: getEntryByIdMock,
      attachPayment: attachPaymentMock,
    };
  }),
  createPaymentLinkMock: vi.fn(async () => ({ url: 'https://pay.stripe.com/link_abc', providerRef: 'plink_abc' })),
  createOrderMock: vi.fn(
    async (): Promise<{ approvalUrl: string; providerRef: string } | undefined> => ({
      approvalUrl: 'https://paypal.com/checkoutnow?token=order_abc',
      providerRef: 'order_abc',
    }),
  ),
  paypalConfiguredMock: vi.fn(() => true),
  sendPaymentQuoteEmailMock: vi.fn(async (_data: unknown, _opts?: unknown) => ({ sent: true })),
  logErrorMock: vi.fn(),
}));

vi.mock('virtual:cool-astro-forms/config', () => ({
  default: {
    siteId: 'demo-site',
    siteUrl: 'https://example.com',
    dbPath: '/tmp/nonexistent/forms.db',
    trailingSlash: undefined as 'always' | 'never' | 'ignore' | undefined,
    forms: {
      contact: { notifyTo: 'fallback@example.com' },
    },
    templates: undefined as { paymentQuote?: unknown } | undefined,
  },
}));
vi.mock('../../storage/db.js', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('../../storage/sqlite.js', () => ({ SqliteStorage: sqliteStorageMock }));
vi.mock('../../payments/stripe.js', () => ({ createPaymentLink: createPaymentLinkMock }));
vi.mock('../../payments/paypal.js', () => ({
  createOrder: createOrderMock,
  paypalConfigured: paypalConfiguredMock,
}));
vi.mock('../../notify.js', () => ({ sendPaymentQuoteEmail: sendPaymentQuoteEmailMock }));
vi.mock('../../log.js', () => ({ log: vi.fn(), logError: logErrorMock }));

import config from 'virtual:cool-astro-forms/config';
import { POST } from './payment-action.js';

function makeRequest(body: Record<string, string>, origin = 'https://example.com'): Request {
  const form = new URLSearchParams(body);
  return new Request('https://example.com/forms-admin/payments/action', {
    method: 'POST',
    headers: { origin },
    body: form,
  });
}

async function callPost(body: Record<string, string>, origin = 'https://example.com'): Promise<Response> {
  const request = makeRequest(body, origin);
  return POST({ request } as unknown as Parameters<typeof POST>[0]);
}

function makeEntry(overrides: Partial<{ id: string; formId: string; fields: Record<string, unknown> }> = {}) {
  return {
    id: 'e1',
    formId: 'contact',
    fields: { email: 'customer@example.com' },
    ...overrides,
  };
}

describe('POST /forms-admin/payments/action', () => {
  beforeEach(() => {
    getEntryByIdMock.mockClear();
    attachPaymentMock.mockClear();
    createPaymentLinkMock.mockClear();
    createOrderMock.mockClear();
    paypalConfiguredMock.mockClear();
    sendPaymentQuoteEmailMock.mockClear();
    logErrorMock.mockClear();
    createPaymentLinkMock.mockResolvedValue({ url: 'https://pay.stripe.com/link_abc', providerRef: 'plink_abc' });
    createOrderMock.mockResolvedValue({
      approvalUrl: 'https://paypal.com/checkoutnow?token=order_abc',
      providerRef: 'order_abc',
    });
    paypalConfiguredMock.mockReturnValue(true);
    getEntryByIdMock.mockResolvedValue(undefined);
    (config as { trailingSlash?: 'always' | 'never' | 'ignore' }).trailingSlash = undefined;
    (config as { templates?: { paymentQuote?: unknown } }).templates = undefined;
  });

  it('rejects a cross-origin POST with 403 before dispatching any storage call', async () => {
    const res = await callPost({ entryId: 'e1', provider: 'stripe', amount: '200' }, 'https://evil.example');
    expect(res.status).toBe(403);
    expect(getEntryByIdMock).not.toHaveBeenCalled();
  });

  it('rejects a missing entryId with 400', async () => {
    const res = await callPost({ provider: 'stripe', amount: '200' });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid provider with 400', async () => {
    const res = await callPost({ entryId: 'e1', provider: 'venmo', amount: '200' });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid/malformed amount with 400 (no storage call)', async () => {
    const res = await callPost({ entryId: 'e1', provider: 'stripe', amount: '1e3' });
    expect(res.status).toBe(400);
    expect(getEntryByIdMock).not.toHaveBeenCalled();
  });

  it('rejects a zero amount with 400', async () => {
    const res = await callPost({ entryId: 'e1', provider: 'stripe', amount: '0' });
    expect(res.status).toBe(400);
  });

  it('an unknown entry returns 400 without calling any provider adapter', async () => {
    getEntryByIdMock.mockResolvedValueOnce(undefined);
    const res = await callPost({ entryId: 'missing', provider: 'stripe', amount: '200' });
    expect(res.status).toBe(400);
    expect(createPaymentLinkMock).not.toHaveBeenCalled();
  });

  it('stripe happy path: creates the link, attaches a link_created payment, sends the quote email, and 302s back to entry-detail', async () => {
    getEntryByIdMock.mockResolvedValueOnce(makeEntry());
    const res = await callPost({ entryId: 'e1', provider: 'stripe', amount: '200.50', memo: 'Website redesign' });

    expect(createPaymentLinkMock).toHaveBeenCalledWith({
      amountCents: 20050,
      currency: 'usd',
      memo: 'Website redesign',
      entryId: 'e1',
    });
    expect(attachPaymentMock).toHaveBeenCalledWith('e1', {
      provider: 'stripe',
      amountCents: 20050,
      currency: 'usd',
      status: 'link_created',
      payLinkUrl: 'https://pay.stripe.com/link_abc',
      providerRef: 'plink_abc',
    });
    expect(sendPaymentQuoteEmailMock).toHaveBeenCalledTimes(1);
    const [emailData] = sendPaymentQuoteEmailMock.mock.calls[0]!;
    expect(emailData).toMatchObject({
      notifyTo: 'customer@example.com',
      amountCents: 20050,
      payLinkUrl: 'https://pay.stripe.com/link_abc',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/forms-admin/entries/e1');
  });

  it('honors a config paymentQuote template override, passing it through to sendPaymentQuoteEmail', async () => {
    getEntryByIdMock.mockResolvedValueOnce(makeEntry());
    const override = () => ({ subject: 'x', text: 'y' });
    (config as { templates?: { paymentQuote?: unknown } }).templates = { paymentQuote: override };

    await callPost({ entryId: 'e1', provider: 'stripe', amount: '200' });

    const [, opts] = sendPaymentQuoteEmailMock.mock.calls[0]!;
    expect((opts as { template?: unknown }).template).toBe(override);
  });

  it('falls back to the form config notifyTo when the entry has no captured email field', async () => {
    getEntryByIdMock.mockResolvedValueOnce(makeEntry({ fields: { name: 'Jane' } }));
    await callPost({ entryId: 'e1', provider: 'stripe', amount: '200' });

    const [emailData] = sendPaymentQuoteEmailMock.mock.calls[0]!;
    expect((emailData as { notifyTo: string }).notifyTo).toBe('fallback@example.com');
  });

  it('paypal happy path: creates the order, attaches a link_created payment with the approval URL, and 302s back', async () => {
    getEntryByIdMock.mockResolvedValueOnce(makeEntry());
    const res = await callPost({ entryId: 'e1', provider: 'paypal', amount: '200' });

    expect(createOrderMock).toHaveBeenCalledWith({
      totalCents: 20000,
      currency: 'usd',
      entryId: 'e1',
      returnUrl: 'https://example.com/',
      cancelUrl: 'https://example.com/',
    });
    expect(attachPaymentMock).toHaveBeenCalledWith(
      'e1',
      expect.objectContaining({
        provider: 'paypal',
        payLinkUrl: 'https://paypal.com/checkoutnow?token=order_abc',
        providerRef: 'order_abc',
      }),
    );
    expect(res.status).toBe(302);
  });

  it('paypal unconfigured: never calls createOrder, never attaches a payment, still redirects back (no partial state)', async () => {
    paypalConfiguredMock.mockReturnValue(false);
    getEntryByIdMock.mockResolvedValueOnce(makeEntry());

    const res = await callPost({ entryId: 'e1', provider: 'paypal', amount: '200' });

    expect(createOrderMock).not.toHaveBeenCalled();
    expect(attachPaymentMock).not.toHaveBeenCalled();
    expect(sendPaymentQuoteEmailMock).not.toHaveBeenCalled();
    expect(logErrorMock).toHaveBeenCalled();
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/forms-admin/entries/e1');
  });

  it('a stripe create-link failure (adapter throws) logs, never attaches a partial payment, and redirects back', async () => {
    getEntryByIdMock.mockResolvedValueOnce(makeEntry());
    createPaymentLinkMock.mockRejectedValueOnce(new Error('Stripe API down'));

    const res = await callPost({ entryId: 'e1', provider: 'stripe', amount: '200' });

    expect(attachPaymentMock).not.toHaveBeenCalled();
    expect(sendPaymentQuoteEmailMock).not.toHaveBeenCalled();
    expect(logErrorMock).toHaveBeenCalled();
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/forms-admin/entries/e1');
  });

  it('a paypal order creation failure (adapter resolves undefined) logs and redirects back with no partial state', async () => {
    getEntryByIdMock.mockResolvedValueOnce(makeEntry());
    createOrderMock.mockResolvedValueOnce(undefined);

    const res = await callPost({ entryId: 'e1', provider: 'paypal', amount: '200' });

    expect(attachPaymentMock).not.toHaveBeenCalled();
    expect(logErrorMock).toHaveBeenCalled();
    expect(res.status).toBe(302);
  });

  it("honors trailingSlash:'always' on the entry-detail redirect target (B1)", async () => {
    (config as { trailingSlash?: 'always' | 'never' | 'ignore' }).trailingSlash = 'always';
    getEntryByIdMock.mockResolvedValueOnce(makeEntry());

    const res = await callPost({ entryId: 'e1', provider: 'stripe', amount: '200' });
    expect(res.headers.get('Location')).toBe('/forms-admin/entries/e1/');
  });

  it("computes the PayPal returnUrl/cancelUrl trailingSlash-aware, never a hardcoded slashless URL (B1)", async () => {
    (config as { trailingSlash?: 'always' | 'never' | 'ignore' }).trailingSlash = 'always';
    getEntryByIdMock.mockResolvedValueOnce(makeEntry());

    await callPost({ entryId: 'e1', provider: 'paypal', amount: '200' });

    expect(createOrderMock).toHaveBeenCalledWith(
      expect.objectContaining({ returnUrl: 'https://example.com/', cancelUrl: 'https://example.com/' }),
    );
  });

  it('does not block the 302 redirect on a rejected fire-and-forget quote email (copy-link is always available regardless of email outcome)', async () => {
    getEntryByIdMock.mockResolvedValueOnce(makeEntry());
    sendPaymentQuoteEmailMock.mockRejectedValueOnce(new Error('smtp exploded'));

    const res = await callPost({ entryId: 'e1', provider: 'stripe', amount: '200' });
    expect(res.status).toBe(302);
  });
});
