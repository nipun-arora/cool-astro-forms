import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  handlePaymentRequestMock,
  verifyTurnstileMock,
  paypalConfiguredMock,
  createOrderMock,
  createCheckoutSessionMock,
  sqliteStorageMock,
} = vi.hoisted(() => ({
  handlePaymentRequestMock: vi.fn(
    async (
      _input: unknown,
      _deps: unknown,
    ): Promise<{ status: number; location?: string; body?: string }> => ({
      status: 302,
      location: 'https://checkout.stripe.com/session-1',
    }),
  ),
  verifyTurnstileMock: vi.fn(async () => ({ ok: true })),
  paypalConfiguredMock: vi.fn(() => false),
  createOrderMock: vi.fn(async () => undefined),
  createCheckoutSessionMock: vi.fn(async () => ({ url: 'https://checkout.stripe.com/session-1', providerRef: 'cs_1' })),
  sqliteStorageMock: vi.fn(function FakeSqliteStorage() {
    return {};
  }),
}));

vi.mock('virtual:cool-astro-forms/config', () => ({
  default: {
    siteId: 'demo-site',
    siteUrl: 'https://example.com',
    forms: {},
    requireConsent: false,
    journeyParams: false,
    retentionDays: 90,
    dbPath: 'data/forms.db',
    geo: { enabled: false, providerUrl: 'https://ipwho.is/{ip}', timeoutMs: 3000 },
    admin: { sessionTtlDays: 7 },
    payments: {
      payLinkFees: [],
      requestPage: { minAmountCents: 100, maxAmountCents: 1_000_000, allowedCurrencies: ['usd'] },
    },
    webhooks: [],
  },
}));
vi.mock('../../payments/payment-request.js', () => ({ handlePaymentRequest: handlePaymentRequestMock }));
vi.mock('../../payments/stripe.js', () => ({ createCheckoutSession: createCheckoutSessionMock }));
vi.mock('../../payments/paypal.js', () => ({ createOrder: createOrderMock, paypalConfigured: paypalConfiguredMock }));
vi.mock('../../turnstile.js', () => ({ verifyTurnstile: verifyTurnstileMock }));
vi.mock('../../storage/db.js', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('../../storage/sqlite.js', () => ({ SqliteStorage: sqliteStorageMock }));
vi.mock('../../log.js', () => ({ log: vi.fn(), logError: vi.fn() }));

import { POST } from './create-session.js';

const ORIGINAL_TURNSTILE_SECRET = process.env.TURNSTILE_SECRET_KEY;

function makeCtx(body = 'amount=200&currency=usd'): Parameters<typeof POST>[0] {
  const request = new Request('https://example.com/api/forms/pay/create-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  return { request, clientAddress: '203.0.113.5' } as unknown as Parameters<typeof POST>[0];
}

describe('POST /api/forms/pay/create-session', () => {
  beforeEach(() => {
    handlePaymentRequestMock.mockClear();
    handlePaymentRequestMock.mockResolvedValue({ status: 302, location: 'https://checkout.stripe.com/session-1' });
    verifyTurnstileMock.mockClear();
    paypalConfiguredMock.mockReturnValue(false);
    createOrderMock.mockClear();
  });

  afterEach(() => {
    if (ORIGINAL_TURNSTILE_SECRET === undefined) delete process.env.TURNSTILE_SECRET_KEY;
    else process.env.TURNSTILE_SECRET_KEY = ORIGINAL_TURNSTILE_SECRET;
  });

  it('wires handlePaymentRequest and adapts its 302 result into a real Location redirect', async () => {
    const res = await POST(makeCtx());

    expect(handlePaymentRequestMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('https://checkout.stripe.com/session-1');
  });

  it('returns the handler reject status/body verbatim', async () => {
    handlePaymentRequestMock.mockResolvedValueOnce({
      status: 403,
      body: JSON.stringify({ ok: false, reason: 'origin' }),
    });

    const res = await POST(makeCtx());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, reason: 'origin' });
  });

  it('rejects oversized Content-Length before ever calling handlePaymentRequest', async () => {
    const request = new Request('https://example.com/api/forms/pay/create-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': String(60_000) },
      body: 'amount=200',
    });

    const res = await POST({ request, clientAddress: '203.0.113.5' } as unknown as Parameters<typeof POST>[0]);

    expect(res.status).toBe(413);
    expect(handlePaymentRequestMock).not.toHaveBeenCalled();
  });

  it('passes verifyTurnstile: undefined into deps when TURNSTILE_SECRET_KEY is unset', async () => {
    delete process.env.TURNSTILE_SECRET_KEY;

    await POST(makeCtx());

    const deps = handlePaymentRequestMock.mock.calls[0]![1] as { verifyTurnstile?: unknown };
    expect(deps.verifyTurnstile).toBeUndefined();
  });

  it('passes a working verifyTurnstile function into deps when TURNSTILE_SECRET_KEY is set', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'test-secret';

    await POST(makeCtx());

    const deps = handlePaymentRequestMock.mock.calls[0]![1] as {
      verifyTurnstile?: (token: string | undefined, ip: string) => Promise<{ ok: boolean }>;
    };
    expect(typeof deps.verifyTurnstile).toBe('function');
    await deps.verifyTurnstile?.('tok-123', '203.0.113.5');
    expect(verifyTurnstileMock).toHaveBeenCalledWith('tok-123', { secret: 'test-secret', remoteip: '203.0.113.5' });
  });

  it('passes createPaypalOrder: undefined into deps when PayPal is not configured', async () => {
    paypalConfiguredMock.mockReturnValue(false);

    await POST(makeCtx());

    const deps = handlePaymentRequestMock.mock.calls[0]![1] as { createPaypalOrder?: unknown };
    expect(deps.createPaypalOrder).toBeUndefined();
  });

  it('passes the real createOrder function into deps when PayPal IS configured', async () => {
    paypalConfiguredMock.mockReturnValue(true);

    await POST(makeCtx());

    const deps = handlePaymentRequestMock.mock.calls[0]![1] as { createPaypalOrder?: typeof createOrderMock };
    expect(deps.createPaypalOrder).toBe(createOrderMock);
  });

  it('passes the whole config (incl. trailingSlash pass-through) to the handler unmodified', async () => {
    await POST(makeCtx());

    const deps = handlePaymentRequestMock.mock.calls[0]![1] as { config: { siteId: string; siteUrl: string } };
    expect(deps.config.siteId).toBe('demo-site');
    expect(deps.config.siteUrl).toBe('https://example.com');
  });

  it('a storage/handler failure resolves a logged 500, not an unlogged crash', async () => {
    handlePaymentRequestMock.mockRejectedValueOnce(new Error('db failure'));

    const res = await POST(makeCtx());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, reason: 'error' });
  });
});
