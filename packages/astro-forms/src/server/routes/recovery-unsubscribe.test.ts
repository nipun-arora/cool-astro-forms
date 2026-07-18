/**
 * recovery-unsubscribe.ts tests (D4/RCV-01). `handleRecoveryUnsubscribe` is
 * exercised directly against a fake StorageAdapter + a REAL signed token
 * (`signUnsubscribeToken`) — no Astro Request/Response involved, matching
 * handle-abandon.test.ts's framework-free-core convention. A thin block at
 * the end smoke-tests the `GET` Astro wrapper's query-param + content-type
 * plumbing (canary.test.ts's vi.mock-the-virtual-config convention).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorageAdapter } from '../storage/adapter.js';

const { resolveRecoverySecretMock, getDbMock, SqliteStorageMock, logErrorMock, routeFakeStorage } = vi.hoisted(() => {
  const routeFakeStorage = { suppressRecovery: vi.fn(async (_visitorUuid: string, _now: number) => undefined) };
  return {
    resolveRecoverySecretMock: vi.fn((_dbPath: string) => 'resolved-secret'),
    getDbMock: vi.fn(() => ({})),
    routeFakeStorage,
    SqliteStorageMock: vi.fn(function FakeSqliteStorage() {
      return routeFakeStorage;
    }),
    logErrorMock: vi.fn(),
  };
});

vi.mock('virtual:cool-astro-forms/config', () => ({ default: { dbPath: 'data/forms.db' } }));
vi.mock('../storage/db.js', () => ({ getDb: getDbMock }));
vi.mock('../storage/sqlite.js', () => ({ SqliteStorage: SqliteStorageMock }));
vi.mock('../recovery/unsubscribe-token.js', async () => {
  const actual = await vi.importActual<typeof import('../recovery/unsubscribe-token.js')>(
    '../recovery/unsubscribe-token.js',
  );
  return { ...actual, resolveRecoverySecret: resolveRecoverySecretMock };
});
vi.mock('../log.js', () => ({ logError: logErrorMock }));

import { signUnsubscribeToken } from '../recovery/unsubscribe-token.js';
import { GET, handleRecoveryUnsubscribe } from './recovery-unsubscribe.js';

const TEST_SECRET = 'unsubscribe-route-test-secret-do-not-use-in-prod';
const OTHER_SECRET = 'a-different-secret-entirely';

function notImplemented(name: string) {
  return vi.fn(async () => {
    throw new Error(`${name} not stubbed for this test`);
  });
}

function makeFakeStorage(overrides: Partial<StorageAdapter> = {}): StorageAdapter {
  return {
    createEntry: notImplemented('createEntry'),
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
    appendPaymentEventIfAbsent: notImplemented(
      'appendPaymentEventIfAbsent',
    ) as unknown as StorageAdapter['appendPaymentEventIfAbsent'],
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

// ---------------------------------------------------------------------------
// handleRecoveryUnsubscribe — the framework-free core
// ---------------------------------------------------------------------------

describe('handleRecoveryUnsubscribe — valid token', () => {
  it('a valid token suppresses the visitor exactly once and returns a 200 plain-text confirmation', async () => {
    const storage = makeFakeStorage();
    const token = signUnsubscribeToken('visitor-abc', TEST_SECRET);

    const result = await handleRecoveryUnsubscribe({ token, storage, secret: TEST_SECRET, now: () => 5000 });

    expect(result.status).toBe(200);
    expect(result.body).toBe("You've been unsubscribed from recovery emails.");
    expect(storage.suppressRecovery).toHaveBeenCalledTimes(1);
    expect(storage.suppressRecovery).toHaveBeenCalledWith('visitor-abc', 5000);
  });

  it('a second identical request is idempotent — still 200, suppressRecovery called again (storage layer is INSERT OR IGNORE)', async () => {
    const storage = makeFakeStorage();
    const token = signUnsubscribeToken('visitor-abc', TEST_SECRET);

    const first = await handleRecoveryUnsubscribe({ token, storage, secret: TEST_SECRET });
    const second = await handleRecoveryUnsubscribe({ token, storage, secret: TEST_SECRET });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toBe(first.body);
    expect(storage.suppressRecovery).toHaveBeenCalledTimes(2);
  });

  it('defaults `now` to Date.now() when not injected', async () => {
    const storage = makeFakeStorage();
    const token = signUnsubscribeToken('visitor-abc', TEST_SECRET);
    const before = Date.now();

    await handleRecoveryUnsubscribe({ token, storage, secret: TEST_SECRET });

    const call = storage.suppressRecovery as ReturnType<typeof vi.fn>;
    const [, calledNow] = call.mock.calls[0] as [string, number];
    expect(calledNow).toBeGreaterThanOrEqual(before);
  });
});

describe('handleRecoveryUnsubscribe — invalid token (no enumeration)', () => {
  it('a missing token (null) returns a constant 400 without calling suppressRecovery', async () => {
    const storage = makeFakeStorage();

    const result = await handleRecoveryUnsubscribe({ token: null, storage, secret: TEST_SECRET });

    expect(result.status).toBe(400);
    expect(result.body).toBe('This unsubscribe link is invalid or expired.');
    expect(storage.suppressRecovery).not.toHaveBeenCalled();
  });

  it('a malformed token (no dot separator) returns the SAME constant 400', async () => {
    const storage = makeFakeStorage();

    const result = await handleRecoveryUnsubscribe({ token: 'not-a-real-token', storage, secret: TEST_SECRET });

    expect(result.status).toBe(400);
    expect(result.body).toBe('This unsubscribe link is invalid or expired.');
    expect(storage.suppressRecovery).not.toHaveBeenCalled();
  });

  it('a forged token (valid shape, wrong signature) is rejected — no suppression, same message', async () => {
    const storage = makeFakeStorage();
    const forged = 'visitor-abc.0000000000000000000000000000000000000000000000000000000000000000';

    const result = await handleRecoveryUnsubscribe({ token: forged, storage, secret: TEST_SECRET });

    expect(result.status).toBe(400);
    expect(result.body).toBe('This unsubscribe link is invalid or expired.');
    expect(storage.suppressRecovery).not.toHaveBeenCalled();
  });

  it('a token signed with a DIFFERENT secret is rejected identically (same message, no enumeration hint)', async () => {
    const storage = makeFakeStorage();
    const token = signUnsubscribeToken('visitor-abc', OTHER_SECRET);

    const result = await handleRecoveryUnsubscribe({ token, storage, secret: TEST_SECRET });

    expect(result.status).toBe(400);
    expect(result.body).toBe('This unsubscribe link is invalid or expired.');
    expect(storage.suppressRecovery).not.toHaveBeenCalled();
  });
});

describe('handleRecoveryUnsubscribe — never throws', () => {
  beforeEach(() => {
    logErrorMock.mockClear();
  });

  it('a suppressRecovery storage failure is caught, logged, and answered with a clean message (no stack leak)', async () => {
    const storage = makeFakeStorage({
      suppressRecovery: vi.fn(async () => {
        throw new Error('SQLITE_BUSY: database is locked');
      }),
    });
    const token = signUnsubscribeToken('visitor-abc', TEST_SECRET);

    const result = await handleRecoveryUnsubscribe({ token, storage, secret: TEST_SECRET });

    expect(result.status).toBe(500);
    expect(result.body).not.toContain('SQLITE_BUSY');
    expect(result.body).not.toMatch(/at\s+\S+\s+\(/); // no stack-trace-shaped leak
    expect(logErrorMock).toHaveBeenCalledWith('recovery.unsubscribe-failed', expect.any(Error), {
      visitorUuid: 'visitor-abc',
    });
  });
});

// ---------------------------------------------------------------------------
// GET (Astro APIRoute wrapper) — thin plumbing smoke tests
// ---------------------------------------------------------------------------

describe('GET /api/forms/recovery-unsubscribe — Astro wrapper plumbing', () => {
  beforeEach(() => {
    resolveRecoverySecretMock.mockClear().mockReturnValue('resolved-secret');
    getDbMock.mockClear();
    logErrorMock.mockClear();
  });

  it('reads the token from the URL query and returns a plain-text Response with the core result status/body', async () => {
    const token = signUnsubscribeToken('visitor-real', 'resolved-secret');
    const request = new Request(`https://example.com/api/forms/recovery-unsubscribe?token=${token}`);

    const res = (await GET({ request } as unknown as Parameters<typeof GET>[0])) as Response;

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await res.text()).toBe("You've been unsubscribed from recovery emails.");
  });

  it('a missing token query param resolves the constant 400 message', async () => {
    const request = new Request('https://example.com/api/forms/recovery-unsubscribe');

    const res = (await GET({ request } as unknown as Parameters<typeof GET>[0])) as Response;

    expect(res.status).toBe(400);
    expect(await res.text()).toBe('This unsubscribe link is invalid or expired.');
  });

  it('a storage/secret-resolution throw during setup resolves a clean logged 500, never a crash', async () => {
    resolveRecoverySecretMock.mockImplementationOnce(() => {
      throw new Error('fs unavailable');
    });
    const request = new Request('https://example.com/api/forms/recovery-unsubscribe?token=whatever');

    const res = (await GET({ request } as unknown as Parameters<typeof GET>[0])) as Response;

    expect(res.status).toBe(500);
    expect(await res.text()).toBe('Something went wrong. Please try again later.');
    expect(logErrorMock).toHaveBeenCalledWith('recovery.unsubscribe-route-failed', expect.any(Error));
  });
});
