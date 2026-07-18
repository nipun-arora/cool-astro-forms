import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fakeStorage, getDbMock, getNotifyHealthMock, logErrorMock, SqliteStorageMock } = vi.hoisted(() => {
  const fakeStorage = {
    countEntries: vi.fn(async (_filter: { status: string; from: number }) => 0),
    listEntries: vi.fn(async (_filter: { status: string; limit: number }) => [] as { createdAt: number }[]),
  };
  return {
    fakeStorage,
    getDbMock: vi.fn(() => ({})),
    getNotifyHealthMock: vi.fn(() => ({ lastSuccessAt: null as number | null })),
    logErrorMock: vi.fn(),
    SqliteStorageMock: vi.fn(function FakeSqliteStorage() {
      return fakeStorage;
    }),
  };
});

vi.mock('virtual:cool-astro-forms/config', () => ({
  default: {
    siteId: 'demo-site',
    siteUrl: 'https://example.com',
    forms: {},
    requireConsent: false,
    journeyParams: false,
    retentionDays: 90,
    dbPath: 'data/forms.db',
  },
}));
vi.mock('../storage/db.js', () => ({ getDb: getDbMock }));
vi.mock('../storage/sqlite.js', () => ({ SqliteStorage: SqliteStorageMock }));
vi.mock('../notify.js', () => ({ getNotifyHealth: getNotifyHealthMock }));
vi.mock('../log.js', () => ({ logError: logErrorMock, log: vi.fn() }));

import { GET } from './canary.js';

const ORIGINAL_CANARY_TOKEN = process.env.CANARY_TOKEN;
const ORIGINAL_ADMIN_PASSWORD = process.env.FORMS_ADMIN_PASSWORD;

async function callGet(headers: Record<string, string> = {}): Promise<Response> {
  const request = new Request('https://example.com/api/forms/canary', { headers });
  return GET({ request } as unknown as Parameters<typeof GET>[0]);
}

describe('GET /api/forms/canary', () => {
  beforeEach(() => {
    fakeStorage.countEntries.mockReset().mockResolvedValue(0);
    fakeStorage.listEntries.mockReset().mockResolvedValue([]);
    getNotifyHealthMock.mockReset().mockReturnValue({ lastSuccessAt: null });
    logErrorMock.mockReset();
    delete process.env.CANARY_TOKEN;
    delete process.env.FORMS_ADMIN_PASSWORD;
  });

  afterEach(() => {
    if (ORIGINAL_CANARY_TOKEN === undefined) delete process.env.CANARY_TOKEN;
    else process.env.CANARY_TOKEN = ORIGINAL_CANARY_TOKEN;
    if (ORIGINAL_ADMIN_PASSWORD === undefined) delete process.env.FORMS_ADMIN_PASSWORD;
    else process.env.FORMS_ADMIN_PASSWORD = ORIGINAL_ADMIN_PASSWORD;
  });

  it('returns 404 when neither CANARY_TOKEN nor FORMS_ADMIN_PASSWORD is set', async () => {
    const res = await callGet();
    expect(res.status).toBe(404);
  });

  it('returns 401 when no Authorization header is sent', async () => {
    process.env.FORMS_ADMIN_PASSWORD = 'correct-horse';
    const res = await callGet();
    expect(res.status).toBe(401);
  });

  it('returns 401 when the bearer token does not match', async () => {
    process.env.FORMS_ADMIN_PASSWORD = 'correct-horse';
    const res = await callGet({ authorization: 'Bearer wrong-token' });
    expect(res.status).toBe(401);
  });

  it('returns 401 for a token of a different length (length-guarded compare)', async () => {
    process.env.FORMS_ADMIN_PASSWORD = 'correct-horse';
    const res = await callGet({ authorization: 'Bearer x' });
    expect(res.status).toBe(401);
  });

  it('accepts CANARY_TOKEN even when FORMS_ADMIN_PASSWORD differs (dedicated token preferred)', async () => {
    process.env.CANARY_TOKEN = 'canary-secret';
    process.env.FORMS_ADMIN_PASSWORD = 'admin-secret';
    fakeStorage.countEntries.mockResolvedValue(2);
    fakeStorage.listEntries.mockResolvedValue([{ createdAt: 5555 }]);
    getNotifyHealthMock.mockReturnValue({ lastSuccessAt: 4444 });

    const res = await callGet({ authorization: 'Bearer canary-secret' });
    expect(res.status).toBe(200);
  });

  it('returns the exact aggregate-only response shape on success', async () => {
    process.env.FORMS_ADMIN_PASSWORD = 'correct-horse';
    fakeStorage.countEntries.mockResolvedValue(3);
    fakeStorage.listEntries.mockResolvedValue([{ createdAt: 9999 }]);
    getNotifyHealthMock.mockReturnValue({ lastSuccessAt: 8888 });

    const res = await callGet({ authorization: 'Bearer correct-horse' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ lastAbandonedAt: 9999, lastNotifySuccessAt: 8888, count24h: 3 });
    expect(Object.keys(body).sort()).toEqual(['count24h', 'lastAbandonedAt', 'lastNotifySuccessAt']);
  });

  it('returns lastAbandonedAt: null when no abandoned rows exist yet', async () => {
    process.env.FORMS_ADMIN_PASSWORD = 'correct-horse';
    fakeStorage.countEntries.mockResolvedValue(0);
    fakeStorage.listEntries.mockResolvedValue([]);
    getNotifyHealthMock.mockReturnValue({ lastSuccessAt: null });

    const res = await callGet({ authorization: 'Bearer correct-horse' });
    const body = await res.json();
    expect(body.lastAbandonedAt).toBeNull();
    expect(body.lastNotifySuccessAt).toBeNull();
  });

  it('queries countEntries with an abandoned-status, 24h-window filter', async () => {
    process.env.FORMS_ADMIN_PASSWORD = 'correct-horse';
    const before = Date.now();

    await callGet({ authorization: 'Bearer correct-horse' });

    expect(fakeStorage.countEntries).toHaveBeenCalledTimes(1);
    const filter = fakeStorage.countEntries.mock.calls[0]![0] as { status: string; from: number };
    expect(filter.status).toBe('abandoned');
    expect(filter.from).toBeGreaterThan(before - 24 * 60 * 60 * 1000 - 1000);
    expect(filter.from).toBeLessThanOrEqual(before);
  });

  it('returns 500 and logs (no body leakage) when storage throws', async () => {
    process.env.FORMS_ADMIN_PASSWORD = 'correct-horse';
    fakeStorage.countEntries.mockRejectedValue(new Error('disk full'));

    const res = await callGet({ authorization: 'Bearer correct-horse' });
    expect(res.status).toBe(500);
    expect(logErrorMock).toHaveBeenCalledTimes(1);
    expect(logErrorMock.mock.calls[0]![0]).toBe('canary.failed');
  });
});
