import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { handleAbandonMock, verifyTurnstileMock, warnTurnstileInertMock, lookupGeoMock, sqliteStorageMock } = vi.hoisted(
  () => ({
    handleAbandonMock: vi.fn(async (_input: unknown, _deps: unknown) => ({ status: 200, body: '{"saved":true}' })),
    verifyTurnstileMock: vi.fn(async () => ({ ok: true, outcome: 'verified' as const })),
    warnTurnstileInertMock: vi.fn(),
    lookupGeoMock: vi.fn(async () => undefined),
    sqliteStorageMock: vi.fn(function FakeSqliteStorage() {
      return {};
    }),
  }),
);

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
  },
}));
vi.mock('../handlers/handle-abandon.js', () => ({ handleAbandon: handleAbandonMock }));
vi.mock('../turnstile.js', () => ({
  verifyTurnstile: verifyTurnstileMock,
  warnTurnstileInert: warnTurnstileInertMock,
}));
vi.mock('../geo/geo.js', () => ({ lookupGeo: lookupGeoMock }));
vi.mock('../storage/db.js', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('../storage/sqlite.js', () => ({ SqliteStorage: sqliteStorageMock }));
vi.mock('../notify.js', () => ({ sendAbandonedLeadEmail: vi.fn() }));
vi.mock('../log.js', () => ({ log: vi.fn(), logError: vi.fn() }));

import { POST } from './abandon.js';

const ORIGINAL_SECRET = process.env.TURNSTILE_SECRET_KEY;

function makeCtx(body: Record<string, unknown> = {}): Parameters<typeof POST>[0] {
  const request = new Request('https://example.com/api/forms/abandon', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { request, clientAddress: '203.0.113.5' } as unknown as Parameters<typeof POST>[0];
}

describe('POST /api/forms/abandon — Turnstile verifyToken wiring (D3/BOT-01)', () => {
  beforeEach(() => {
    handleAbandonMock.mockClear();
    verifyTurnstileMock.mockClear();
  });

  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.TURNSTILE_SECRET_KEY;
    else process.env.TURNSTILE_SECRET_KEY = ORIGINAL_SECRET;
  });

  it('passes verifyToken: undefined into handleAbandon deps when TURNSTILE_SECRET_KEY is unset', async () => {
    delete process.env.TURNSTILE_SECRET_KEY;

    await POST(makeCtx());

    expect(handleAbandonMock).toHaveBeenCalledTimes(1);
    const deps = handleAbandonMock.mock.calls[0]![1] as { verifyToken?: unknown };
    expect(deps.verifyToken).toBeUndefined();
  });

  it('passes a verifyToken function into handleAbandon deps when TURNSTILE_SECRET_KEY is set', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'test-secret';

    await POST(makeCtx());

    const deps = handleAbandonMock.mock.calls[0]![1] as { verifyToken?: unknown };
    expect(typeof deps.verifyToken).toBe('function');
  });

  it('the wired verifyToken dep delegates to verifyTurnstile with the configured secret + caller IP', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'test-secret';

    await POST(makeCtx());

    const deps = handleAbandonMock.mock.calls[0]![1] as {
      verifyToken?: (token: string | undefined, ip: string) => Promise<{ ok: boolean }>;
    };
    await deps.verifyToken?.('some-token', '203.0.113.5');

    // remoteip deliberately absent: dual-stack visitors solve the challenge
    // on one IP family and post on another, so binding the token to the
    // server-derived IP hard-fails honest users (found live 2026-07-21).
    expect(verifyTurnstileMock).toHaveBeenCalledWith('some-token', {
      secret: 'test-secret',
    });
  });
});

// ---------------------------------------------------------------------------
// The inert-gate warning. When the secret is missing the route never calls
// verifyTurnstile at all (verifyToken stays undefined), so the helper's own
// warning cannot fire — the route has to raise it. The site key is what
// separates "this host never wanted Turnstile" from "the widget is
// challenging visitors and nobody is checking the answers".
// ---------------------------------------------------------------------------

describe('POST /api/forms/abandon — inert-gate warning when the secret is missing', () => {
  const ORIGINAL_SITE_KEY = process.env.TURNSTILE_SITE_KEY;

  beforeEach(() => {
    handleAbandonMock.mockClear();
    warnTurnstileInertMock.mockClear();
  });

  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.TURNSTILE_SECRET_KEY;
    else process.env.TURNSTILE_SECRET_KEY = ORIGINAL_SECRET;
    if (ORIGINAL_SITE_KEY === undefined) delete process.env.TURNSTILE_SITE_KEY;
    else process.env.TURNSTILE_SITE_KEY = ORIGINAL_SITE_KEY;
  });

  it('warns when a site key is configured but the secret is not — the widget mints tokens the server never checks', async () => {
    process.env.TURNSTILE_SITE_KEY = '1x00000000000000000000AA';
    delete process.env.TURNSTILE_SECRET_KEY;

    await POST(makeCtx());

    expect(warnTurnstileInertMock).toHaveBeenCalledTimes(1);
    expect(warnTurnstileInertMock.mock.calls[0]![0]).toBe('routes/abandon');
  });

  it('stays silent when NEITHER key is configured — a site that never enabled Turnstile has nothing wrong with it', async () => {
    delete process.env.TURNSTILE_SITE_KEY;
    delete process.env.TURNSTILE_SECRET_KEY;

    await POST(makeCtx());

    expect(warnTurnstileInertMock).not.toHaveBeenCalled();
  });

  it('stays silent when both keys are configured', async () => {
    process.env.TURNSTILE_SITE_KEY = '1x00000000000000000000AA';
    process.env.TURNSTILE_SECRET_KEY = 'test-secret';

    await POST(makeCtx());

    expect(warnTurnstileInertMock).not.toHaveBeenCalled();
  });

  it('still saves the abandonment when the gate is inert — a missing secret must degrade to unverified, never to a dropped lead', async () => {
    process.env.TURNSTILE_SITE_KEY = '1x00000000000000000000AA';
    delete process.env.TURNSTILE_SECRET_KEY;

    const response = await POST(makeCtx());

    expect(response.status).toBe(200);
    expect(handleAbandonMock).toHaveBeenCalledTimes(1);
  });
});
