import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { handleAbandonMock, verifyTurnstileMock, lookupGeoMock, sqliteStorageMock } = vi.hoisted(() => ({
  handleAbandonMock: vi.fn(async (_input: unknown, _deps: unknown) => ({ status: 200, body: '{"saved":true}' })),
  verifyTurnstileMock: vi.fn(async () => ({ ok: true })),
  lookupGeoMock: vi.fn(async () => undefined),
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
  },
}));
vi.mock('../handlers/handle-abandon.js', () => ({ handleAbandon: handleAbandonMock }));
vi.mock('../turnstile.js', () => ({ verifyTurnstile: verifyTurnstileMock }));
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

    expect(verifyTurnstileMock).toHaveBeenCalledWith('some-token', {
      secret: 'test-secret',
      remoteip: '203.0.113.5',
    });
  });
});
