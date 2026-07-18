import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  fakeStorage,
  getDbMock,
  logErrorMock,
  SqliteStorageMock,
  resolveAdminSecretMock,
  verifySessionMock,
  maybeRunRecoverySweepMock,
  assertExplicitSecretsMock,
  mockConfig,
} = vi.hoisted(() => {
  const fakeStorage = {
    purgeExpired: vi.fn(async (_days: number) => 0),
  };
  const mockConfig: {
    siteId: string;
    dbPath: string;
    retentionDays: number;
    geo: { enabled: boolean; providerUrl: string; timeoutMs: number };
    admin: { sessionTtlDays: number };
    drive: { linkAccess: 'anyone' | 'private'; attachmentFallbackMaxBytes: number; rootFolderName: string };
    recovery: { enabled: boolean; delayMins: number; consentMode: 'auto' | 'checkbox' };
    storage: { kind: 'sqlite' | 'turso' };
    trailingSlash?: 'always' | 'never' | 'ignore';
  } = {
    siteId: 'demo-site',
    dbPath: 'data/forms.db',
    retentionDays: 90,
    geo: { enabled: true, providerUrl: 'https://ipwho.is/{ip}', timeoutMs: 3000 },
    admin: { sessionTtlDays: 7 },
    drive: { linkAccess: 'private', attachmentFallbackMaxBytes: 10_485_760, rootFolderName: 'cool-astro-forms' },
    recovery: { enabled: false, delayMins: 60, consentMode: 'auto' },
    storage: { kind: 'sqlite' },
    trailingSlash: undefined,
  };
  return {
    fakeStorage,
    getDbMock: vi.fn(() => ({})),
    logErrorMock: vi.fn(),
    SqliteStorageMock: vi.fn(function FakeSqliteStorage() {
      return fakeStorage;
    }),
    resolveAdminSecretMock: vi.fn(() => 'test-secret'),
    verifySessionMock: vi.fn((_value: string, _secret: string) => false),
    maybeRunRecoverySweepMock: vi.fn(),
    // D2 fix #2 (05-01): mocked as a no-op by default so this file's
    // existing suites (predating 05-01) stay unaffected; the dedicated
    // "explicit secrets preflight" describe block below exercises wiring.
    assertExplicitSecretsMock: vi.fn(),
    mockConfig,
  };
});

vi.mock('virtual:cool-astro-forms/config', () => ({ default: mockConfig }));
vi.mock('./storage/db.js', () => ({ getDb: getDbMock }));
vi.mock('./storage/sqlite.js', () => ({ SqliteStorage: SqliteStorageMock }));
vi.mock('./log.js', () => ({ logError: logErrorMock, log: vi.fn() }));
vi.mock('./recovery/sweep.js', () => ({ maybeRunRecoverySweep: maybeRunRecoverySweepMock }));
vi.mock('./security/admin-secret.js', () => ({ resolveAdminSecret: resolveAdminSecretMock }));
vi.mock('./security/admin-session.js', () => ({ verifySession: verifySessionMock }));
vi.mock('./security/secrets-preflight.js', () => ({ assertExplicitSecrets: assertExplicitSecretsMock }));

import { onRequest, registerRuntimeConfig, resetRuntimeConfigRegistration } from './middleware.js';

const ORIGINAL_CAF_DB_PATH = process.env.CAF_DB_PATH;
const ORIGINAL_CAF_STORAGE_KIND = process.env.CAF_STORAGE_KIND;
const ORIGINAL_CAF_GEO_ENABLED = process.env.CAF_GEO_ENABLED;
const ORIGINAL_CAF_GEO_PROVIDER = process.env.CAF_GEO_PROVIDER;
const ORIGINAL_CAF_GEO_TIMEOUT_MS = process.env.CAF_GEO_TIMEOUT_MS;
const ORIGINAL_CAF_DRIVE_LINK_ACCESS = process.env.CAF_DRIVE_LINK_ACCESS;
const ORIGINAL_CAF_DRIVE_ROOT_FOLDER = process.env.CAF_DRIVE_ROOT_FOLDER;
const ORIGINAL_CAF_DRIVE_FALLBACK_MAX_BYTES = process.env.CAF_DRIVE_FALLBACK_MAX_BYTES;

/**
 * Flushes several microtask ticks — 05-04's storage acquisition sites
 * (`getStorageAdapter(cfg).then(...)`) add extra Promise hops beyond the
 * pre-05-04 synchronous `new SqliteStorage(getDb(...))` construction, so
 * fire-and-forget assertions need more than one `await Promise.resolve()`
 * to observe the mocked call.
 */
async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

interface FakeCookies {
  get: ReturnType<typeof vi.fn>;
}

function makeContext(pathname: string, opts: { cookieValue?: string } = {}) {
  const cookies: FakeCookies = {
    get: vi.fn((name: string) =>
      name === '_caf_admin_session' && opts.cookieValue !== undefined ? { value: opts.cookieValue } : undefined,
    ),
  };
  const redirect = vi.fn((path: string, status = 302) => new Response(null, { status, headers: { Location: path } }));
  return {
    url: new URL(`https://example.com${pathname}`),
    cookies,
    redirect,
  };
}

describe('registerRuntimeConfig', () => {
  beforeEach(() => {
    resetRuntimeConfigRegistration();
    fakeStorage.purgeExpired.mockReset().mockResolvedValue(0);
    getDbMock.mockClear();
    logErrorMock.mockClear();
  });

  afterEach(() => {
    if (ORIGINAL_CAF_DB_PATH === undefined) delete process.env.CAF_DB_PATH;
    else process.env.CAF_DB_PATH = ORIGINAL_CAF_DB_PATH;
    if (ORIGINAL_CAF_STORAGE_KIND === undefined) delete process.env.CAF_STORAGE_KIND;
    else process.env.CAF_STORAGE_KIND = ORIGINAL_CAF_STORAGE_KIND;
    if (ORIGINAL_CAF_GEO_ENABLED === undefined) delete process.env.CAF_GEO_ENABLED;
    else process.env.CAF_GEO_ENABLED = ORIGINAL_CAF_GEO_ENABLED;
    if (ORIGINAL_CAF_GEO_PROVIDER === undefined) delete process.env.CAF_GEO_PROVIDER;
    else process.env.CAF_GEO_PROVIDER = ORIGINAL_CAF_GEO_PROVIDER;
    if (ORIGINAL_CAF_GEO_TIMEOUT_MS === undefined) delete process.env.CAF_GEO_TIMEOUT_MS;
    else process.env.CAF_GEO_TIMEOUT_MS = ORIGINAL_CAF_GEO_TIMEOUT_MS;
    if (ORIGINAL_CAF_DRIVE_LINK_ACCESS === undefined) delete process.env.CAF_DRIVE_LINK_ACCESS;
    else process.env.CAF_DRIVE_LINK_ACCESS = ORIGINAL_CAF_DRIVE_LINK_ACCESS;
    if (ORIGINAL_CAF_DRIVE_ROOT_FOLDER === undefined) delete process.env.CAF_DRIVE_ROOT_FOLDER;
    else process.env.CAF_DRIVE_ROOT_FOLDER = ORIGINAL_CAF_DRIVE_ROOT_FOLDER;
    if (ORIGINAL_CAF_DRIVE_FALLBACK_MAX_BYTES === undefined) delete process.env.CAF_DRIVE_FALLBACK_MAX_BYTES;
    else process.env.CAF_DRIVE_FALLBACK_MAX_BYTES = ORIGINAL_CAF_DRIVE_FALLBACK_MAX_BYTES;
  });

  it('sets CAF_DB_PATH from cfg.dbPath (Phase 1 behavior preserved)', () => {
    registerRuntimeConfig({ ...mockConfig, dbPath: '/tmp/custom.db' } as never);
    expect(process.env.CAF_DB_PATH).toBe('/tmp/custom.db');
  });

  it('sets CAF_STORAGE_KIND from cfg.storage.kind (05-04, ADPT-01 — the bridge recordSubmission reads via getStorageAdapter())', () => {
    registerRuntimeConfig({ ...mockConfig, storage: { kind: 'turso' } } as never);
    expect(process.env.CAF_STORAGE_KIND).toBe('turso');
  });

  it('sets CAF_GEO_ENABLED/CAF_GEO_PROVIDER/CAF_GEO_TIMEOUT_MS from cfg.geo', () => {
    registerRuntimeConfig({
      ...mockConfig,
      geo: { enabled: false, providerUrl: 'https://example.test/{ip}', timeoutMs: 5000 },
    } as never);
    expect(process.env.CAF_GEO_ENABLED).toBe('false');
    expect(process.env.CAF_GEO_PROVIDER).toBe('https://example.test/{ip}');
    expect(process.env.CAF_GEO_TIMEOUT_MS).toBe('5000');
  });

  it('sets CAF_DRIVE_LINK_ACCESS/CAF_DRIVE_ROOT_FOLDER/CAF_DRIVE_FALLBACK_MAX_BYTES from cfg.drive (Phase 4/DRV-01 bridge — the CAF_GEO_* precedent)', () => {
    registerRuntimeConfig({
      ...mockConfig,
      drive: { linkAccess: 'anyone', attachmentFallbackMaxBytes: 5_000_000, rootFolderName: 'custom-root' },
    } as never);
    expect(process.env.CAF_DRIVE_LINK_ACCESS).toBe('anyone');
    expect(process.env.CAF_DRIVE_ROOT_FOLDER).toBe('custom-root');
    expect(process.env.CAF_DRIVE_FALLBACK_MAX_BYTES).toBe('5000000');
  });

  it('re-asserts env vars on every call but only purges once per process', async () => {
    registerRuntimeConfig(mockConfig as never);
    registerRuntimeConfig(mockConfig as never);
    registerRuntimeConfig(mockConfig as never);
    // registerRuntimeConfig itself STAYS synchronous (05-04) but the purge
    // now runs behind getStorageAdapter(cfg).then(...) — flush enough
    // microtask ticks for that chain to actually fire the mocked call.
    await flushMicrotasks();
    expect(fakeStorage.purgeExpired).toHaveBeenCalledTimes(1);
    expect(fakeStorage.purgeExpired).toHaveBeenCalledWith(90);
  });

  it('logs (does not throw) when purgeExpired rejects', async () => {
    fakeStorage.purgeExpired.mockRejectedValueOnce(new Error('disk full'));
    registerRuntimeConfig(mockConfig as never);
    await flushMicrotasks();
    expect(logErrorMock).toHaveBeenCalledWith('storage.purge-failed', expect.any(Error));
  });
});

describe('onRequest — admin guard', () => {
  beforeEach(() => {
    resetRuntimeConfigRegistration();
    fakeStorage.purgeExpired.mockReset().mockResolvedValue(0);
    resolveAdminSecretMock.mockClear().mockReturnValue('test-secret');
    verifySessionMock.mockReset().mockReturnValue(false);
    maybeRunRecoverySweepMock.mockClear();
    assertExplicitSecretsMock.mockClear();
    mockConfig.trailingSlash = undefined;
  });

  it('leaves non-admin paths completely untouched (calls next(), no cookie/session check)', async () => {
    const context = makeContext('/some/other/page');
    const next = vi.fn(async () => new Response('ok'));
    const res = await onRequest(context as never, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(context.cookies.get).not.toHaveBeenCalled();
    expect((res as Response).headers.get('X-Robots-Tag')).toBeNull();
  });

  it('does not treat a same-prefix unrelated route as an admin path', async () => {
    const context = makeContext('/forms-adminstats');
    const next = vi.fn(async () => new Response('ok'));
    await onRequest(context as never, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(context.cookies.get).not.toHaveBeenCalled();
  });

  it('redirects to /forms-admin/login when no session cookie is present', async () => {
    const context = makeContext('/forms-admin/entries');
    const next = vi.fn(async () => new Response('secret'));
    const res = (await onRequest(context as never, next)) as Response;
    expect(next).not.toHaveBeenCalled();
    expect(res.headers.get('Location')).toBe('/forms-admin/login');
  });

  it('redirects to /forms-admin/login when the session cookie fails verification', async () => {
    verifySessionMock.mockReturnValue(false);
    const context = makeContext('/forms-admin/entries', { cookieValue: 'tampered.sig' });
    const next = vi.fn(async () => new Response('secret'));
    const res = (await onRequest(context as never, next)) as Response;
    expect(next).not.toHaveBeenCalled();
    expect(res.headers.get('Location')).toBe('/forms-admin/login');
  });

  it("carries a trailing-slash Location ('/forms-admin/login/') when trailingSlash is 'always' (B1 guard case)", async () => {
    mockConfig.trailingSlash = 'always';
    const context = makeContext('/forms-admin/entries');
    const next = vi.fn(async () => new Response('secret'));
    const res = (await onRequest(context as never, next)) as Response;
    expect(res.headers.get('Location')).toBe('/forms-admin/login/');
  });

  it('always allows the login page through, even with no session', async () => {
    const context = makeContext('/forms-admin/login');
    const next = vi.fn(async () => new Response('login-page'));
    await onRequest(context as never, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("always allows the login page through under trailingSlash:'always' (± slash normalized)", async () => {
    mockConfig.trailingSlash = 'always';
    const context = makeContext('/forms-admin/login/');
    const next = vi.fn(async () => new Response('login-page'));
    await onRequest(context as never, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('always allows the auth POST endpoint through, even with no session', async () => {
    const context = makeContext('/forms-admin/auth');
    const next = vi.fn(async () => new Response('auth-handled'));
    await onRequest(context as never, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('calls next() and tags the response X-Robots-Tag: noindex for a valid session', async () => {
    verifySessionMock.mockReturnValue(true);
    const context = makeContext('/forms-admin/entries', { cookieValue: 'valid.sig' });
    const next = vi.fn(async () => new Response('secret'));
    const res = (await onRequest(context as never, next)) as Response;
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
  });

  it('verifies the session against resolveAdminSecret(config.dbPath)', async () => {
    verifySessionMock.mockReturnValue(true);
    const context = makeContext('/forms-admin/entries', { cookieValue: 'valid.sig' });
    await onRequest(context as never, vi.fn(async () => new Response('ok')));
    expect(resolveAdminSecretMock).toHaveBeenCalledWith('data/forms.db');
    expect(verifySessionMock).toHaveBeenCalledWith('valid.sig', 'test-secret');
  });

  it('fails closed (redirects) instead of throwing when secret resolution throws', async () => {
    resolveAdminSecretMock.mockImplementationOnce(() => {
      throw new Error('fs unavailable');
    });
    const context = makeContext('/forms-admin/entries', { cookieValue: 'valid.sig' });
    const next = vi.fn(async () => new Response('secret'));
    const res = (await onRequest(context as never, next)) as Response;
    expect(next).not.toHaveBeenCalled();
    expect(res.headers.get('Location')).toBe('/forms-admin/login');
    expect(logErrorMock).toHaveBeenCalledWith('admin.guard-failed', expect.any(Error));
  });

  it('still registers runtime config (CAF_DB_PATH + CAF_GEO_*) on an admin-guarded request', async () => {
    delete process.env.CAF_GEO_ENABLED;
    const context = makeContext('/forms-admin/entries');
    await onRequest(context as never, vi.fn(async () => new Response('secret')));
    expect(process.env.CAF_GEO_ENABLED).toBe('true');
  });
});

// ---------------------------------------------------------------------------
// RCV-01 lazy sweep piggyback (Phase 4/04-06)
// ---------------------------------------------------------------------------

describe('onRequest — recovery sweep piggyback (RCV-01)', () => {
  beforeEach(() => {
    resetRuntimeConfigRegistration();
    fakeStorage.purgeExpired.mockReset().mockResolvedValue(0);
    maybeRunRecoverySweepMock.mockClear();
    assertExplicitSecretsMock.mockClear();
    mockConfig.trailingSlash = undefined;
  });

  it('fires maybeRunRecoverySweep on ordinary (non-admin) request traffic', async () => {
    const context = makeContext('/some/other/page');
    const next = vi.fn(async () => new Response('ok'));
    await onRequest(context as never, next);
    expect(maybeRunRecoverySweepMock).toHaveBeenCalledTimes(1);
    const call = maybeRunRecoverySweepMock.mock.calls[0]![0] as { config: unknown; storage: unknown };
    expect(call.config).toBe(mockConfig);
    expect(call.storage).toBe(fakeStorage);
  });

  it('fires maybeRunRecoverySweep even on an admin-guarded (redirected) request', async () => {
    const context = makeContext('/forms-admin/entries');
    const next = vi.fn(async () => new Response('secret'));
    await onRequest(context as never, next);
    expect(next).not.toHaveBeenCalled();
    expect(maybeRunRecoverySweepMock).toHaveBeenCalledTimes(1);
  });

  it('is never awaited — a slow/pending sweep never delays next()', async () => {
    let sweepCalled = false;
    maybeRunRecoverySweepMock.mockImplementationOnce(() => {
      sweepCalled = true;
      // Deliberately returns a still-pending promise the caller must NOT await.
      return new Promise(() => undefined);
    });
    const context = makeContext('/some/other/page');
    const next = vi.fn(async () => new Response('ok'));
    const res = (await onRequest(context as never, next)) as Response;
    expect(sweepCalled).toBe(true);
    expect(next).toHaveBeenCalledTimes(1);
    expect(await res.text()).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// D2 fix #2 explicit-secrets boot preflight (05-01/ADPT-01)
// ---------------------------------------------------------------------------

describe('onRequest — explicit secrets preflight (D2 fix #2, 05-01)', () => {
  beforeEach(() => {
    resetRuntimeConfigRegistration();
    fakeStorage.purgeExpired.mockReset().mockResolvedValue(0);
    maybeRunRecoverySweepMock.mockClear();
    assertExplicitSecretsMock.mockReset();
    mockConfig.trailingSlash = undefined;
  });

  it('calls assertExplicitSecrets(cfg) on ordinary (non-admin) request traffic', async () => {
    const context = makeContext('/some/other/page');
    const next = vi.fn(async () => new Response('ok'));
    await onRequest(context as never, next);
    expect(assertExplicitSecretsMock).toHaveBeenCalledTimes(1);
    expect(assertExplicitSecretsMock).toHaveBeenCalledWith(mockConfig);
  });

  it('calls assertExplicitSecrets(cfg) even on an admin-guarded request, before the admin guard runs', async () => {
    const context = makeContext('/forms-admin/entries');
    const next = vi.fn(async () => new Response('secret'));
    await onRequest(context as never, next);
    expect(assertExplicitSecretsMock).toHaveBeenCalledTimes(1);
    expect(assertExplicitSecretsMock).toHaveBeenCalledWith(mockConfig);
  });

  it('propagates an assertExplicitSecrets throw uncaught (fail-loud, not fail-closed like the admin guard)', async () => {
    assertExplicitSecretsMock.mockImplementationOnce(() => {
      throw new Error('FORMS_ADMIN_SECRET is required because CAF_REQUIRE_EXPLICIT_SECRETS is enabled.');
    });
    const context = makeContext('/some/other/page');
    const next = vi.fn(async () => new Response('ok'));
    await expect(onRequest(context as never, next)).rejects.toThrow(/FORMS_ADMIN_SECRET/);
    expect(next).not.toHaveBeenCalled();
  });
});
