import { describe, expect, it, vi } from 'vitest';
import type { FeeBreakdownLine, FeeLine } from '../../types.js';
import type { RateLimiter } from '../security/rate-limit.js';
import type { StorageAdapter } from '../storage/adapter.js';
import {
  handlePaymentRequest,
  type ConfigWithTrailingSlash,
  type HandlePaymentRequestDeps,
} from './payment-request.js';

// ---------------------------------------------------------------------------
// Fixtures (mirrors handle-abandon.test.ts's makeConfig/makeFakeStorage
// conventions — same StorageAdapter shape, same notImplemented() pattern).
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<ConfigWithTrailingSlash> = {}): ConfigWithTrailingSlash {
  return {
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
      payLinkFees: [{ label: 'Card fee', percent: 0.03 }],
      feeOverrides: 'off',
      quoteCurrency: 'usd',
      adminQuote: 'builtin',
      requestPage: { minAmountCents: 100, maxAmountCents: 1_000_000, allowedCurrencies: ['usd'] },
    },
    webhooks: [],
    drive: { linkAccess: 'private', attachmentFallbackMaxBytes: 10_485_760, rootFolderName: 'cool-astro-forms' },
    recovery: { enabled: false, delayMins: 60, consentMode: 'auto' },
    rateLimit: { store: 'memory' },
    storage: { kind: 'sqlite' },
    ...overrides,
  };
}

function notImplemented(name: string) {
  return vi.fn(async () => {
    throw new Error(`${name} not stubbed for this test`);
  });
}

function makeFakeStorage(overrides: Partial<StorageAdapter> = {}): StorageAdapter {
  return {
    createEntry: vi.fn(async (input) => ({
      id: 'entry-1',
      createdAt: 1000,
      updatedAt: 1000,
      ...input,
    })),
    updateEntry: notImplemented('updateEntry'),
    findAbandoned: vi.fn(async () => undefined),
    listEntries: vi.fn(async () => []),
    countEntries: vi.fn(async () => 0),
    attachPayment: vi.fn(async () => undefined),
    attachFiles: vi.fn(async () => undefined),
    exportCsv: vi.fn(async () => ''),
    upsertAbandoned: notImplemented('upsertAbandoned') as unknown as StorageAdapter['upsertAbandoned'],
    convertAndCreateSubmitted: notImplemented(
      'convertAndCreateSubmitted',
    ) as unknown as StorageAdapter['convertAndCreateSubmitted'],
    purgeVisitor: vi.fn(async () => 0),
    purgeExpired: vi.fn(async () => 0),
    recordFormStart: vi.fn(async () => undefined),
    getFunnel: vi.fn(async () => ({ started: 0, abandoned: 0, submitted: 0, converted: 0 })),
    getTopDropOff: vi.fn(async () => []),
    getEntryById: vi.fn(async () => undefined),
    deleteEntry: vi.fn(async () => false),
    getPaymentByProviderRef: vi.fn(async () => undefined),
    getPaymentsByEntry: vi.fn(async () => []),
    updatePayment: notImplemented('updatePayment') as unknown as StorageAdapter['updatePayment'],
    appendPaymentEventIfAbsent: vi.fn(async () => false),
    listPayments: vi.fn(async () => []),
    countPayments: vi.fn(async () => 0),
    getFilesByEntry: vi.fn(async () => []),
    findRecoverableEntries: vi.fn(async () => []),
    markConsent: vi.fn(async () => undefined),
    markRecoverySent: vi.fn(async () => true),
    suppressRecovery: vi.fn(async () => undefined),
    isRecoverySuppressed: vi.fn(async () => false),
    consumeRateLimitToken: vi.fn(async () => true),
    ...overrides,
  };
}

function makeFakeRateLimiter(allow = true): RateLimiter {
  return {
    allow: vi.fn(() => allow),
    size: vi.fn(() => 0),
    clear: vi.fn(),
  };
}

interface MakeInputOptions {
  origin?: string;
  body?: string;
  ip?: string;
}

function makeInput(opts: MakeInputOptions = {}) {
  const headers = new Headers();
  headers.set('Origin', opts.origin ?? 'https://example.com');
  return {
    body: opts.body ?? 'amount=200&currency=usd&email=payer%40example.com',
    headers,
    ip: opts.ip ?? '203.0.113.5',
  };
}

function makeDeps(overrides: Partial<HandlePaymentRequestDeps> = {}): HandlePaymentRequestDeps {
  const createCheckoutSession = vi.fn(async () => ({ url: 'https://checkout.stripe.com/session-1', providerRef: 'cs_1' }));
  return {
    config: makeConfig(),
    storage: makeFakeStorage(),
    createCheckoutSession,
    rateLimiter: makeFakeRateLimiter(),
    log: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Reject branches
// ---------------------------------------------------------------------------

describe('handlePaymentRequest — reject branches', () => {
  it('origin mismatch -> 403, reason origin, no entry/session created', async () => {
    const deps = makeDeps();
    const result = await handlePaymentRequest(makeInput({ origin: 'https://evil.example' }), deps);

    expect(result.status).toBe(403);
    expect(JSON.parse(result.body ?? '{}')).toEqual({ ok: false, reason: 'origin' });
    expect(deps.storage.createEntry).not.toHaveBeenCalled();
    expect(deps.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('oversized body -> 413, reason payload', async () => {
    const deps = makeDeps();
    const oversized = 'amount=' + '2'.repeat(60_000);
    const result = await handlePaymentRequest(makeInput({ body: oversized }), deps);

    expect(result.status).toBe(413);
    expect(JSON.parse(result.body ?? '{}')).toEqual({ ok: false, reason: 'payload' });
    expect(deps.storage.createEntry).not.toHaveBeenCalled();
  });

  it('rate limit exceeded -> 429, reason rate-limit', async () => {
    const deps = makeDeps({ rateLimiter: makeFakeRateLimiter(false) });
    const result = await handlePaymentRequest(makeInput(), deps);

    expect(result.status).toBe(429);
    expect(JSON.parse(result.body ?? '{}')).toEqual({ ok: false, reason: 'rate-limit' });
    expect(deps.storage.createEntry).not.toHaveBeenCalled();
  });

  it('missing/malformed amount -> 400, reason invalid', async () => {
    const deps = makeDeps();
    const result = await handlePaymentRequest(makeInput({ body: 'amount=+200&currency=usd' }), deps);

    expect(result.status).toBe(400);
    expect(JSON.parse(result.body ?? '{}')).toEqual({ ok: false, reason: 'invalid' });
    expect(deps.storage.createEntry).not.toHaveBeenCalled();
  });

  it('amount out of range -> 400, reason amount-range', async () => {
    const deps = makeDeps();
    const result = await handlePaymentRequest(makeInput({ body: 'amount=0.50&currency=usd' }), deps);

    expect(result.status).toBe(400);
    expect(JSON.parse(result.body ?? '{}')).toEqual({ ok: false, reason: 'amount-range' });
    expect(deps.storage.createEntry).not.toHaveBeenCalled();
  });

  it('currency not in whitelist -> 400, reason currency', async () => {
    const deps = makeDeps();
    const result = await handlePaymentRequest(makeInput({ body: 'amount=200&currency=eur' }), deps);

    expect(result.status).toBe(400);
    expect(JSON.parse(result.body ?? '{}')).toEqual({ ok: false, reason: 'currency' });
    expect(deps.storage.createEntry).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Turnstile hard gate (T-03-20) — unlike abandon's soft-log, this is a HARD
// gate: a configured-but-failing check rejects BEFORE any entry/session
// exists, never soft-logs and continues.
// ---------------------------------------------------------------------------

describe('handlePaymentRequest — Turnstile hard gate', () => {
  it('verifyTurnstile configured + fails -> 403, reason turnstile, NO entry/session created', async () => {
    const verifyTurnstile = vi.fn(async () => ({ ok: false }));
    const deps = makeDeps({ verifyTurnstile });
    const result = await handlePaymentRequest(makeInput({ body: 'amount=200&currency=usd&email=payer%40example.com' }), deps);

    expect(result.status).toBe(403);
    expect(JSON.parse(result.body ?? '{}')).toEqual({ ok: false, reason: 'turnstile' });
    expect(deps.storage.createEntry).not.toHaveBeenCalled();
    expect(deps.createCheckoutSession).not.toHaveBeenCalled();
    expect(verifyTurnstile).toHaveBeenCalledWith(undefined, '203.0.113.5');
  });

  it('a fetch client (Accept: application/json) gets 200 {ok:true, url} instead of a 302 — XHR submits cannot follow cross-origin redirects, and edge bot-challenges cannot intercept XHR the way they break navigation POSTs', async () => {
    const deps = makeDeps();
    const headers = new Headers();
    headers.set('Origin', 'https://example.com');
    headers.set('Accept', 'application/json');
    const result = await handlePaymentRequest(
      { body: 'amount=200&currency=usd&email=payer%40example.com', headers, ip: '203.0.113.5' },
      deps,
    );

    expect(result.status).toBe(200);
    expect(JSON.parse(result.body ?? '{}')).toEqual({
      ok: true,
      url: 'https://checkout.stripe.com/session-1',
    });
    expect(result.location).toBeUndefined();
  });

  it('a turnstile reject logs Cloudflare error-codes so production failures are diagnosable from the reject line alone', async () => {
    const verifyTurnstile = vi.fn(async () => ({ ok: false, errorCodes: ['timeout-or-duplicate'] }));
    const deps = makeDeps({ verifyTurnstile });
    await handlePaymentRequest(makeInput({ body: 'amount=200&currency=usd&email=payer%40example.com' }), deps);

    expect(deps.log).toHaveBeenCalledWith(
      'payment-request.reject',
      expect.objectContaining({ reason: 'turnstile', errorCodes: ['timeout-or-duplicate'] }),
    );
  });

  it('turnstile fail recovery carries the first Cloudflare error code in the redirect (sanitized), so the visitor-facing URL names the cause without server access', async () => {
    const verifyTurnstile = vi.fn(async () => ({ ok: false, errorCodes: ['timeout-or-duplicate', 'x'] }));
    const deps = makeDeps({ verifyTurnstile, config: makeConfig({ trailingSlash: 'always' }) });
    const headers = new Headers();
    headers.set('Origin', 'https://example.com');
    headers.set('Accept', 'text/html');
    headers.set('Referer', 'https://example.com/secure/?pay=200');
    const result = await handlePaymentRequest(
      { body: 'amount=200&currency=usd&email=payer%40example.com', headers, ip: '203.0.113.5' },
      deps,
    );

    expect(result.status).toBe(303);
    expect(result.location).toBe(
      'https://example.com/secure/?pay=200&error=turnstile&amount=200.00&code=timeout-or-duplicate',
    );
  });

  it('a weird error code is sanitized out of the redirect (never a query-injection surface)', async () => {
    const verifyTurnstile = vi.fn(async () => ({ ok: false, errorCodes: ['bad&code=<x>'] }));
    const deps = makeDeps({ verifyTurnstile, config: makeConfig({ trailingSlash: 'always' }) });
    const headers = new Headers();
    headers.set('Origin', 'https://example.com');
    headers.set('Accept', 'text/html');
    const result = await handlePaymentRequest(
      { body: 'amount=200&currency=usd&email=payer%40example.com', headers, ip: '203.0.113.5' },
      deps,
    );

    expect(result.status).toBe(303);
    expect(result.location).toBe('https://example.com/forms-pay/?error=turnstile&amount=200.00');
  });

  it('turnstile fail recovery honors a SAME-ORIGIN Referer: 303 back to the host page the visitor paid from, its own query preserved, error + amount merged', async () => {
    const verifyTurnstile = vi.fn(async () => ({ ok: false }));
    const deps = makeDeps({ verifyTurnstile, config: makeConfig({ trailingSlash: 'always' }) });
    const headers = new Headers();
    headers.set('Origin', 'https://example.com');
    headers.set('Accept', 'text/html');
    headers.set('Referer', 'https://example.com/secure/?pay=200');
    const result = await handlePaymentRequest(
      { body: 'amount=200&currency=usd&email=payer%40example.com', headers, ip: '203.0.113.5' },
      deps,
    );

    expect(result.status).toBe(303);
    expect(result.location).toBe('https://example.com/secure/?pay=200&error=turnstile&amount=200.00');
  });

  it('turnstile fail recovery IGNORES a cross-origin Referer (no open redirect) and falls back to the package pay page', async () => {
    const verifyTurnstile = vi.fn(async () => ({ ok: false }));
    const deps = makeDeps({ verifyTurnstile, config: makeConfig({ trailingSlash: 'always' }) });
    const headers = new Headers();
    headers.set('Origin', 'https://example.com');
    headers.set('Accept', 'text/html');
    headers.set('Referer', 'https://evil.example/secure/?pay=200');
    const result = await handlePaymentRequest(
      { body: 'amount=200&currency=usd&email=payer%40example.com', headers, ip: '203.0.113.5' },
      deps,
    );

    expect(result.status).toBe(303);
    expect(result.location).toBe('https://example.com/forms-pay/?error=turnstile&amount=200.00');
  });

  it('turnstile fail on a BROWSER form post (Accept: text/html) -> 303 back to the pay page with error=turnstile + amount preserved, never a raw-JSON dead end', async () => {
    const verifyTurnstile = vi.fn(async () => ({ ok: false }));
    const deps = makeDeps({ verifyTurnstile, config: makeConfig({ trailingSlash: 'always' }) });
    const headers = new Headers();
    headers.set('Origin', 'https://example.com');
    headers.set('Accept', 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8');
    const result = await handlePaymentRequest(
      { body: 'amount=200&currency=usd&email=payer%40example.com', headers, ip: '203.0.113.5' },
      deps,
    );

    expect(result.status).toBe(303);
    expect(result.location).toBe('https://example.com/forms-pay/?error=turnstile&amount=200.00');
    expect(result.body).toBeUndefined();
    expect(deps.storage.createEntry).not.toHaveBeenCalled();
    expect(deps.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('verifyTurnstile configured + passes -> proceeds to checkout', async () => {
    const verifyTurnstile = vi.fn(async () => ({ ok: true }));
    const deps = makeDeps({ verifyTurnstile });
    const result = await handlePaymentRequest(
      makeInput({ body: 'amount=200&currency=usd&cf-turnstile-response=tok-123&email=payer%40example.com' }),
      deps,
    );

    expect(result.status).toBe(302);
    expect(verifyTurnstile).toHaveBeenCalledWith('tok-123', '203.0.113.5');
    expect(deps.storage.createEntry).toHaveBeenCalledTimes(1);
  });

  it('verifyTurnstile undefined (Turnstile off) -> gate skipped, proceeds to checkout', async () => {
    const deps = makeDeps();
    const result = await handlePaymentRequest(makeInput({ body: 'amount=200&currency=usd&email=payer%40example.com' }), deps);

    expect(result.status).toBe(302);
    expect(deps.storage.createEntry).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Happy path (Stripe) — server-recomputed breakdown, synthetic entry,
// link_created payment row, 302 to the canned Checkout URL.
// ---------------------------------------------------------------------------

describe('handlePaymentRequest — happy path (Stripe)', () => {
  it('creates a synthetic _payment_request entry + link_created payment row and 302s to the Checkout URL', async () => {
    const deps = makeDeps();
    const result = await handlePaymentRequest(makeInput({ body: 'amount=200&currency=usd&label=Consulting&email=payer%40example.com' }), deps);

    expect(result.status).toBe(302);
    expect(result.location).toBe('https://checkout.stripe.com/session-1');

    expect(deps.storage.createEntry).toHaveBeenCalledTimes(1);
    const createEntryArg = (deps.storage.createEntry as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(createEntryArg).toMatchObject({
      siteId: 'demo-site',
      formId: '_payment_request',
      status: 'submitted',
      fields: { amountCents: 20000, currency: 'usd', memo: 'Consulting', source: 'payment-request' },
    });
    expect(typeof createEntryArg.visitorUuid).toBe('string');
    expect(createEntryArg.visitorUuid.length).toBeGreaterThan(0);

    // SERVER breakdown (base 20000 + 3% fee line = 600) — never a client total.
    expect(deps.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        baseAmountCents: 20000,
        feeLines: [{ label: 'Card fee', amountCents: 600 }] satisfies FeeBreakdownLine[],
        currency: 'usd',
        memo: 'Consulting',
        entryId: 'entry-1',
      }),
    );

    expect(deps.storage.attachPayment).toHaveBeenCalledWith('entry-1', {
      provider: 'stripe',
      amountCents: 20600,
      currency: 'usd',
      status: 'link_created',
      payLinkUrl: 'https://checkout.stripe.com/session-1',
      providerRef: 'cs_1',
    });
  });

  it('a client-sent bogus total/fee field is ignored — breakdown is always recomputed server-side', async () => {
    const deps = makeDeps();
    const result = await handlePaymentRequest(
      makeInput({ body: 'amount=100&currency=usd&total=999999&totalCents=999999&feeCents=0&email=payer%40example.com' }),
      deps,
    );

    expect(result.status).toBe(302);
    expect(deps.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        baseAmountCents: 10000,
        feeLines: [{ label: 'Card fee', amountCents: 300 }],
      }),
    );
    expect(deps.storage.attachPayment).toHaveBeenCalledWith(
      'entry-1',
      expect.objectContaining({ amountCents: 10300 }),
    );
  });
});

// ---------------------------------------------------------------------------
// Payer identity. Stripe only attributes repeat payments to a Customer when
// we hand it an email, so the shipped pay page asks for one. The server
// contract stays NON-BREAKING for host-owned pay forms that post only
// amount+currency: a missing/blank email is accepted (no customerEmail is
// forwarded, so Stripe still creates an anonymous Customer). A PRESENT but
// garbled address is a payer typo, rejected up front — before any entry or
// Checkout Session exists — so it never leaves an orphan entry behind.
// ---------------------------------------------------------------------------

describe('handlePaymentRequest — payer identity (Stripe customer attribution)', () => {
  function createEntryFields(deps: HandlePaymentRequestDeps): Record<string, unknown> {
    return (deps.storage.createEntry as ReturnType<typeof vi.fn>).mock.calls[0]![0].fields;
  }

  it('the payer email reaches createCheckoutSession so Stripe can attribute the payment to a customer', async () => {
    const deps = makeDeps();
    const result = await handlePaymentRequest(
      makeInput({ body: 'amount=200&currency=usd&email=payer%40example.com&name=Ada%20Lovelace' }),
      deps,
    );

    expect(result.status).toBe(302);
    expect(deps.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ customerEmail: 'payer@example.com', customerName: 'Ada Lovelace' }),
    );
  });

  it('the email is trimmed before it is forwarded, so stray whitespace cannot create a second Stripe customer for the same payer', async () => {
    const deps = makeDeps();
    await handlePaymentRequest(makeInput({ body: 'amount=200&currency=usd&email=%20payer%40example.com%20' }), deps);

    expect(deps.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ customerEmail: 'payer@example.com' }),
    );
  });

  it.each([
    ['missing', 'amount=200&currency=usd'],
    ['empty', 'amount=200&currency=usd&email='],
    ['whitespace only', 'amount=200&currency=usd&email=%20%20'],
  ])(
    'a Stripe request with a %s email still succeeds (host-owned pay forms post only amount+currency): no customerEmail forwarded, no email stored on the entry',
    async (_label, body) => {
      const deps = makeDeps();
      const result = await handlePaymentRequest(makeInput({ body }), deps);

      expect(result.status).toBe(302);
      expect(result.location).toBe('https://checkout.stripe.com/session-1');
      const sessionInput = (deps.createCheckoutSession as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(sessionInput.customerEmail).toBeUndefined();
      expect(createEntryFields(deps)).not.toHaveProperty('email');
    },
  );

  it.each([
    ['not an address', 'amount=200&currency=usd&email=not-an-email'],
    ['no domain', 'amount=200&currency=usd&email=payer%40'],
    ['oversized', 'amount=200&currency=usd&email=' + 'a'.repeat(300) + '%40example.com'],
  ])(
    'a Stripe request with a %s email -> 400 invalid-email BEFORE any entry or Checkout Session exists (no orphan entry, no Stripe call)',
    async (_label, body) => {
      const verifyTurnstile = vi.fn(async () => ({ ok: true }));
      const deps = makeDeps({ verifyTurnstile });
      const result = await handlePaymentRequest(makeInput({ body }), deps);

      expect(result.status).toBe(400);
      expect(JSON.parse(result.body ?? '{}')).toEqual({ ok: false, reason: 'invalid-email' });
      expect(deps.storage.createEntry).not.toHaveBeenCalled();
      expect(deps.createCheckoutSession).not.toHaveBeenCalled();
      // Cheap local validation runs before the Cloudflare round trip.
      expect(verifyTurnstile).not.toHaveBeenCalled();
    },
  );

  it('a rejected email is never written to the log (logs go to host stdout)', async () => {
    const deps = makeDeps();
    await handlePaymentRequest(makeInput({ body: 'amount=200&currency=usd&email=secret-person%40nope' }), deps);

    const logged = JSON.stringify((deps.log as ReturnType<typeof vi.fn>).mock.calls);
    expect(logged).toContain('invalid-email');
    expect(logged).not.toContain('secret-person');
  });

  it('a successful request never logs the payer email or name', async () => {
    const deps = makeDeps();
    await handlePaymentRequest(
      makeInput({ body: 'amount=200&currency=usd&email=payer%40example.com&name=Ada%20Lovelace' }),
      deps,
    );

    const logged = JSON.stringify((deps.log as ReturnType<typeof vi.fn>).mock.calls);
    expect(logged).not.toContain('payer@example.com');
    expect(logged).not.toContain('Ada');
  });

  it('the email and name are stored on the entry so the admin entries view shows who paid', async () => {
    const deps = makeDeps();
    await handlePaymentRequest(
      makeInput({ body: 'amount=200&currency=usd&email=payer%40example.com&name=Ada%20Lovelace' }),
      deps,
    );

    expect(createEntryFields(deps)).toMatchObject({
      email: 'payer@example.com',
      name: 'Ada Lovelace',
      amountCents: 20000,
      source: 'payment-request',
    });
  });

  it('name is optional: omitting it still succeeds, forwards no customerName and stores no name', async () => {
    const deps = makeDeps();
    const result = await handlePaymentRequest(makeInput(), deps);

    expect(result.status).toBe(302);
    const sessionInput = (deps.createCheckoutSession as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(sessionInput.customerEmail).toBe('payer@example.com');
    expect(sessionInput.customerName).toBeUndefined();
    expect(createEntryFields(deps)).not.toHaveProperty('name');
  });

  it('a blank name is treated as omitted rather than stored as an empty string', async () => {
    const deps = makeDeps();
    await handlePaymentRequest(makeInput({ body: 'amount=200&currency=usd&email=payer%40example.com&name=%20%20' }), deps);

    const sessionInput = (deps.createCheckoutSession as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(sessionInput.customerName).toBeUndefined();
    expect(createEntryFields(deps)).not.toHaveProperty('name');
  });

  it('an over-long name is capped at 200 characters so a payer cannot bloat the entry or the Stripe customer record', async () => {
    const deps = makeDeps();
    await handlePaymentRequest(
      makeInput({ body: 'amount=200&currency=usd&email=payer%40example.com&name=' + 'n'.repeat(500) }),
      deps,
    );

    const sessionInput = (deps.createCheckoutSession as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(sessionInput.customerName).toBe('n'.repeat(200));
    expect(createEntryFields(deps).name).toBe('n'.repeat(200));
  });

  it('PayPal captures the payer itself, so a PayPal request without an email still succeeds', async () => {
    const createPaypalOrder = vi.fn(async () => ({
      approvalUrl: 'https://paypal.example/approve/order-1',
      providerRef: 'order-1',
    }));
    const deps = makeDeps({ createPaypalOrder });
    const result = await handlePaymentRequest(makeInput({ body: 'amount=200&currency=usd&provider=paypal' }), deps);

    expect(result.status).toBe(302);
    expect(createEntryFields(deps)).not.toHaveProperty('email');
  });

  it('PayPal with an email still records it on the entry for the admin view', async () => {
    const createPaypalOrder = vi.fn(async () => ({
      approvalUrl: 'https://paypal.example/approve/order-1',
      providerRef: 'order-1',
    }));
    const deps = makeDeps({ createPaypalOrder });
    await handlePaymentRequest(
      makeInput({ body: 'amount=200&currency=usd&provider=paypal&email=payer%40example.com' }),
      deps,
    );

    expect(createEntryFields(deps)).toMatchObject({ email: 'payer@example.com' });
  });

  it('provider=paypal with PayPal NOT configured falls through to Stripe, so a malformed email is still rejected', async () => {
    const deps = makeDeps();
    const result = await handlePaymentRequest(
      makeInput({ body: 'amount=200&currency=usd&provider=paypal&email=not-an-email' }),
      deps,
    );

    expect(result.status).toBe(400);
    expect(JSON.parse(result.body ?? '{}')).toEqual({ ok: false, reason: 'invalid-email' });
    expect(deps.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('provider=paypal with PayPal NOT configured and no email falls through to Stripe and succeeds without customerEmail', async () => {
    const deps = makeDeps();
    const result = await handlePaymentRequest(makeInput({ body: 'amount=200&currency=usd&provider=paypal' }), deps);

    expect(result.status).toBe(302);
    const sessionInput = (deps.createCheckoutSession as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(sessionInput.customerEmail).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Fee selector (payments.feeOverrides). The `fee` field is read from the
// POSTED body, so a payer can send it exactly as easily as an operator can
// put it in a shared link — it is honoured only under the host's explicit
// 'query' opt-in, and an ignored attempt is logged rather than rejected.
// ---------------------------------------------------------------------------

describe('handlePaymentRequest — fee selector opt-in (payments.feeOverrides)', () => {
  function configWithFeeOverrides(
    feeOverrides: 'off' | 'query',
    feePresets?: Record<string, FeeLine[]>,
  ): ConfigWithTrailingSlash {
    const base = makeConfig();
    return {
      ...base,
      payments: { ...base.payments, feeOverrides, ...(feePresets ? { feePresets } : {}) },
    };
  }

  function loggedEvents(deps: HandlePaymentRequestDeps): unknown[] {
    return (deps.log as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]);
  }

  it('default config: a payer-posted fee=0 cannot waive the configured fee — the 3% line is still charged and the ignored override is logged', async () => {
    const deps = makeDeps();
    const result = await handlePaymentRequest(makeInput({ body: 'amount=100&currency=usd&fee=0&email=payer%40example.com' }), deps);

    expect(result.status).toBe(302);
    expect(deps.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        baseAmountCents: 10000,
        feeLines: [{ label: 'Card fee', amountCents: 300 }] satisfies FeeBreakdownLine[],
      }),
    );
    expect(deps.storage.attachPayment).toHaveBeenCalledWith(
      'entry-1',
      expect.objectContaining({ amountCents: 10300 }),
    );
    expect(deps.log).toHaveBeenCalledWith('payment-request.fee-override-ignored', { ip: '203.0.113.5' });
  });

  it("feeOverrides: 'query' + fee=0 -> the host opted in, so fees are waived and the total equals the base amount", async () => {
    const deps = makeDeps({ config: configWithFeeOverrides('query') });
    const result = await handlePaymentRequest(makeInput({ body: 'amount=100&currency=usd&fee=0&email=payer%40example.com' }), deps);

    expect(result.status).toBe(302);
    expect(deps.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ baseAmountCents: 10000, feeLines: [] }),
    );
    expect(deps.storage.attachPayment).toHaveBeenCalledWith(
      'entry-1',
      expect.objectContaining({ amountCents: 10000 }),
    );
    expect(loggedEvents(deps)).not.toContain('payment-request.fee-override-ignored');
  });

  it("feeOverrides: 'query' + fee=<preset key> -> that preset's fee lines are charged", async () => {
    const deps = makeDeps({
      config: configWithFeeOverrides('query', { flat: [{ label: 'Flat fee', flatCents: 250 }] }),
    });
    const result = await handlePaymentRequest(makeInput({ body: 'amount=100&currency=usd&fee=flat&email=payer%40example.com' }), deps);

    expect(result.status).toBe(302);
    expect(deps.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ feeLines: [{ label: 'Flat fee', amountCents: 250 }] }),
    );
    expect(deps.storage.attachPayment).toHaveBeenCalledWith(
      'entry-1',
      expect.objectContaining({ amountCents: 10250 }),
    );
  });

  it('a request with NO fee field never logs the ignored-override event — the log means "someone tried", not "every payment"', async () => {
    const deps = makeDeps();
    await handlePaymentRequest(makeInput({ body: 'amount=100&currency=usd&email=payer%40example.com' }), deps);

    expect(loggedEvents(deps)).not.toContain('payment-request.fee-override-ignored');
  });
});

// ---------------------------------------------------------------------------
// Payer receipts (payments.payerReceipts, 0.1.18). The Checkout Session's
// receipt_email makes Stripe mail a live-mode receipt whatever the
// dashboard's customer email setting, so a merchant who turned receipts off
// on purpose would get them sent anyway, and a card tester could make the
// account mail branded receipts to typed addresses. 'dashboard' leaves that
// decision to the dashboard; absent means 'always' (the 0.1.18 fix).
// ---------------------------------------------------------------------------

describe('handlePaymentRequest — payer receipts (payments.payerReceipts)', () => {
  function sessionInput(deps: HandlePaymentRequestDeps): Record<string, unknown> {
    return (deps.createCheckoutSession as ReturnType<typeof vi.fn>).mock.calls[0]![0];
  }

  it("a config without payerReceipts asks for the payer's receipt ('always')", async () => {
    const deps = makeDeps();
    await handlePaymentRequest(makeInput(), deps);

    expect(sessionInput(deps).payerReceipts).toBe('always');
  });

  it("payerReceipts: 'dashboard' reaches createCheckoutSession, so no receipt_email is set", async () => {
    const base = makeConfig();
    const deps = makeDeps({ config: { ...base, payments: { ...base.payments, payerReceipts: 'dashboard' } } });
    await handlePaymentRequest(makeInput(), deps);

    expect(sessionInput(deps).payerReceipts).toBe('dashboard');
  });
});

// ---------------------------------------------------------------------------
// The free-text label (0.1.18). `label` is whatever the pay link or the
// visitor posts; it becomes the Checkout line item name and the PaymentIntent
// description the payer and the Stripe dashboard read, and the entry's memo.
// Control characters are removed, whitespace collapsed, the result capped at
// 100 characters; nothing left means no memo (Stripe's line item reads
// "Payment").
// ---------------------------------------------------------------------------

describe('handlePaymentRequest — label cleaning', () => {
  async function memoFor(label: string): Promise<{ sent: unknown; stored: unknown }> {
    const deps = makeDeps();
    const result = await handlePaymentRequest(
      makeInput({ body: 'amount=200&currency=usd&email=payer%40example.com&label=' + encodeURIComponent(label) }),
      deps,
    );
    expect(result.status).toBe(302);
    return {
      sent: (deps.createCheckoutSession as ReturnType<typeof vi.fn>).mock.calls[0]![0].memo,
      stored: (deps.storage.createEntry as ReturnType<typeof vi.fn>).mock.calls[0]![0].fields.memo,
    };
  }

  it('caps a long label at 100 characters, on the Stripe line item and on the entry', async () => {
    const { sent, stored } = await memoFor('x'.repeat(5000));

    expect(sent).toBe('x'.repeat(100));
    expect(stored).toBe('x'.repeat(100));
  });

  it('counts characters, not UTF-16 units: the cap never splits an emoji into a lone surrogate', async () => {
    const { sent } = await memoFor('a'.repeat(99) + '\u{1F981}\u{1F981}');

    expect(sent).toBe('a'.repeat(99) + '\u{1F981}');
  });

  it('removes control characters and collapses whitespace', async () => {
    const { sent, stored } = await memoFor('  Deposit\u0000 for\r\n\r\nthe\u001b[2J   tour\t');

    expect(sent).toBe('Deposit for the[2J tour');
    expect(stored).toBe('Deposit for the[2J tour');
  });

  it('a label that is empty after cleaning sends no memo (Stripe falls back to "Payment") and stores none', async () => {
    for (const label of ['', '   ', '\u0000\u0007\r\n\t']) {
      const { sent, stored } = await memoFor(label);

      expect(sent).toBeUndefined();
      expect(stored).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Happy path (PayPal) — provider=paypal branch.
// ---------------------------------------------------------------------------

describe('handlePaymentRequest — happy path (PayPal)', () => {
  it('provider=paypal + createPaypalOrder injected -> 302 to the approval URL, link_created payment row', async () => {
    const createPaypalOrder = vi.fn(async () => ({
      approvalUrl: 'https://paypal.example/approve/order-1',
      providerRef: 'order-1',
    }));
    const deps = makeDeps({ createPaypalOrder });
    const result = await handlePaymentRequest(makeInput({ body: 'amount=200&currency=usd&provider=paypal' }), deps);

    expect(result.status).toBe(302);
    expect(result.location).toBe('https://paypal.example/approve/order-1');
    expect(deps.createCheckoutSession).not.toHaveBeenCalled();
    expect(createPaypalOrder).toHaveBeenCalledWith(
      expect.objectContaining({ totalCents: 20600, currency: 'usd', entryId: 'entry-1' }),
    );
    expect(deps.storage.attachPayment).toHaveBeenCalledWith('entry-1', {
      provider: 'paypal',
      amountCents: 20600,
      currency: 'usd',
      status: 'link_created',
      payLinkUrl: 'https://paypal.example/approve/order-1',
      providerRef: 'order-1',
    });
  });
});

// ---------------------------------------------------------------------------
// Checker B1 — trailingSlash-aware redirect URLs (third strike on this
// pitfall class). Every URL passed to the injected adapter fakes must route
// through the shared adminUrl slash rule.
// ---------------------------------------------------------------------------

describe('handlePaymentRequest — checker B1 (trailingSlash-aware redirect URLs)', () => {
  it("trailingSlash 'always' -> successUrl/cancelUrl end in '/' (slash before the query)", async () => {
    const deps = makeDeps({ config: makeConfig({ trailingSlash: 'always' }) });
    await handlePaymentRequest(makeInput({ body: 'amount=200&currency=usd&email=payer%40example.com' }), deps);

    const call = (deps.createCheckoutSession as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.successUrl).toBe('https://example.com/forms-pay/success/?session_id={CHECKOUT_SESSION_ID}');
    expect(call.cancelUrl).toBe('https://example.com/forms-pay/?amount=200.00');
  });

  it("trailingSlash undefined/'never' -> successUrl/cancelUrl stay slashless", async () => {
    const deps = makeDeps();
    await handlePaymentRequest(makeInput({ body: 'amount=200&currency=usd&email=payer%40example.com' }), deps);

    const call = (deps.createCheckoutSession as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.successUrl).toBe('https://example.com/forms-pay/success?session_id={CHECKOUT_SESSION_ID}');
    expect(call.cancelUrl).toBe('https://example.com/forms-pay?amount=200.00');

    const depsNever = makeDeps({ config: makeConfig({ trailingSlash: 'never' }) });
    await handlePaymentRequest(makeInput({ body: 'amount=200&currency=usd&email=payer%40example.com' }), depsNever);
    const callNever = (depsNever.createCheckoutSession as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(callNever.successUrl).toBe('https://example.com/forms-pay/success?session_id={CHECKOUT_SESSION_ID}');
    expect(callNever.cancelUrl).toBe('https://example.com/forms-pay?amount=200.00');
  });

  it("PayPal returnUrl is also trailingSlash-aware under 'always'", async () => {
    const createPaypalOrder = vi.fn(async () => ({ approvalUrl: 'https://paypal.example/approve/x', providerRef: 'x' }));
    const deps = makeDeps({ config: makeConfig({ trailingSlash: 'always' }), createPaypalOrder });
    await handlePaymentRequest(makeInput({ body: 'amount=200&currency=usd&provider=paypal' }), deps);

    const call = (createPaypalOrder as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.returnUrl).toBe('https://example.com/forms-pay/paypal-return/');
    expect(call.cancelUrl).toBe('https://example.com/forms-pay/?amount=200.00');
  });
});

// ---------------------------------------------------------------------------
// Provider failure (Rule 2 — missing-critical error handling)
// ---------------------------------------------------------------------------

describe('handlePaymentRequest — provider/storage failure handling', () => {
  it('createPaypalOrder resolving undefined -> 502, reason error, payment row not attached', async () => {
    const createPaypalOrder = vi.fn(async () => undefined);
    const deps = makeDeps({ createPaypalOrder });
    const result = await handlePaymentRequest(makeInput({ body: 'amount=200&currency=usd&provider=paypal' }), deps);

    expect(result.status).toBe(502);
    expect(JSON.parse(result.body ?? '{}')).toEqual({ ok: false, reason: 'error' });
    expect(deps.storage.attachPayment).not.toHaveBeenCalled();
  });

  it('createCheckoutSession throwing -> 500, reason error', async () => {
    const createCheckoutSession = vi.fn(async () => {
      throw new Error('Stripe is not configured (STRIPE_SECRET_KEY missing)');
    });
    const deps = makeDeps({ createCheckoutSession });
    const result = await handlePaymentRequest(makeInput({ body: 'amount=200&currency=usd&email=payer%40example.com' }), deps);

    expect(result.status).toBe(500);
    expect(JSON.parse(result.body ?? '{}')).toEqual({ ok: false, reason: 'error' });
  });
});
