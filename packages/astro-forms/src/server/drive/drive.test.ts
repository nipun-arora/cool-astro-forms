/**
 * drive.ts tests — driveConfigured / refreshAccessToken / resolveFolderId
 * (Task 2), then uploadFile / grantPermission / uploadFilesToDrive
 * orchestrator (Task 3). Every case injects a FAKE `deps.fetch` — NEVER a
 * live call to googleapis.com / oauth2.googleapis.com (mirrors
 * paypal.test.ts's fetch-mocking convention). Backoff is injected via
 * `deps.schedule` so no test depends on real elapsed time (deliver.test.ts's
 * `fastSchedule` convention).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileInput } from '../../types.js';
import { FIVE_MIB } from '../drive-recovery-constants.js';
import {
  driveApiBaseUrl,
  driveConfigured,
  grantPermission,
  oauthTokenUrl,
  refreshAccessToken,
  resetDriveCaches,
  resolveFolderId,
  uploadFile,
  uploadFilesToDrive,
} from './drive.js';

const CLIENT_ID = 'drive-client-id';
const CLIENT_SECRET = 'drive-client-secret';
const REFRESH_TOKEN = 'drive-refresh-token';
const ACCESS_TOKEN = 'ya29.x';

const tokenFixture = { access_token: ACCESS_TOKEN, expires_in: 3600 };

/** Routes a fetch mock by matching a URL substring + method — robust regardless of call order. */
function mockFetch(
  handlers: Record<string, (url: string, init: RequestInit) => unknown>,
): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string, init: RequestInit = {}) => {
    for (const [pattern, handler] of Object.entries(handlers)) {
      const [method, substr] = pattern.split(' ');
      if (url.includes(substr!) && (init.method ?? 'GET') === method) return handler(url, init);
    }
    throw new Error(`Unhandled fetch call in test: ${init.method ?? 'GET'} ${url}`);
  }) as unknown as ReturnType<typeof vi.fn>;
}

beforeEach(() => {
  process.env.GOOGLE_DRIVE_CLIENT_ID = CLIENT_ID;
  process.env.GOOGLE_DRIVE_CLIENT_SECRET = CLIENT_SECRET;
  process.env.GOOGLE_DRIVE_REFRESH_TOKEN = REFRESH_TOKEN;
  delete process.env.GOOGLE_DRIVE_API_BASE_URL;
  delete process.env.GOOGLE_OAUTH_TOKEN_URL;
  resetDriveCaches();
});

afterEach(() => {
  delete process.env.GOOGLE_DRIVE_CLIENT_ID;
  delete process.env.GOOGLE_DRIVE_CLIENT_SECRET;
  delete process.env.GOOGLE_DRIVE_REFRESH_TOKEN;
  delete process.env.GOOGLE_DRIVE_API_BASE_URL;
  delete process.env.GOOGLE_OAUTH_TOKEN_URL;
  resetDriveCaches();
});

// ---------------------------------------------------------------------------
// driveApiBaseUrl / oauthTokenUrl (env seams)
// ---------------------------------------------------------------------------

describe('driveApiBaseUrl / oauthTokenUrl', () => {
  it('defaults to the real Google hosts', () => {
    expect(driveApiBaseUrl()).toBe('https://www.googleapis.com');
    expect(oauthTokenUrl()).toBe('https://oauth2.googleapis.com/token');
  });

  it('is overridable via GOOGLE_DRIVE_API_BASE_URL / GOOGLE_OAUTH_TOKEN_URL (e2e mock seam)', () => {
    process.env.GOOGLE_DRIVE_API_BASE_URL = 'http://127.0.0.1:4393';
    process.env.GOOGLE_OAUTH_TOKEN_URL = 'http://127.0.0.1:4393/token';
    expect(driveApiBaseUrl()).toBe('http://127.0.0.1:4393');
    expect(oauthTokenUrl()).toBe('http://127.0.0.1:4393/token');
  });
});

// ---------------------------------------------------------------------------
// driveConfigured
// ---------------------------------------------------------------------------

describe('driveConfigured', () => {
  it('true when all three GOOGLE_DRIVE_* keys are set', () => {
    expect(driveConfigured()).toBe(true);
  });

  it('false when GOOGLE_DRIVE_CLIENT_ID is missing', () => {
    delete process.env.GOOGLE_DRIVE_CLIENT_ID;
    expect(driveConfigured()).toBe(false);
  });

  it('false when GOOGLE_DRIVE_CLIENT_SECRET is missing', () => {
    delete process.env.GOOGLE_DRIVE_CLIENT_SECRET;
    expect(driveConfigured()).toBe(false);
  });

  it('false when GOOGLE_DRIVE_REFRESH_TOKEN is missing', () => {
    delete process.env.GOOGLE_DRIVE_REFRESH_TOKEN;
    expect(driveConfigured()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// refreshAccessToken
// ---------------------------------------------------------------------------

describe('refreshAccessToken', () => {
  it('POSTs grant_type=refresh_token form-encoded with client id/secret + refresh token, resolves the access token', async () => {
    const fetchMock = mockFetch({ 'POST /token': () => ({ ok: true, json: async () => tokenFixture }) });

    const token = await refreshAccessToken({ fetch: fetchMock as unknown as typeof fetch, now: () => 1_000 });

    expect(token).toBe(ACCESS_TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/x-www-form-urlencoded' });
    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('client_id')).toBe(CLIENT_ID);
    expect(body.get('client_secret')).toBe(CLIENT_SECRET);
    expect(body.get('refresh_token')).toBe(REFRESH_TOKEN);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('reuses the cached token on a second immediate call — NO second fetch', async () => {
    const fetchMock = mockFetch({ 'POST /token': () => ({ ok: true, json: async () => tokenFixture }) });
    const deps = { fetch: fetchMock as unknown as typeof fetch, now: () => 1_000 };

    const first = await refreshAccessToken(deps);
    const second = await refreshAccessToken(deps);

    expect(first).toBe(ACCESS_TOKEN);
    expect(second).toBe(ACCESS_TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refetches once the cached token has expired (ACCESS_TOKEN_TTL_MS elapsed)', async () => {
    const fetchMock = mockFetch({ 'POST /token': () => ({ ok: true, json: async () => tokenFixture }) });

    await refreshAccessToken({ fetch: fetchMock as unknown as typeof fetch, now: () => 1_000 });
    await refreshAccessToken({
      fetch: fetchMock as unknown as typeof fetch,
      now: () => 1_000 + 60 * 60 * 1000, // 1 hour later — past the ~50min cache TTL
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('resolves undefined without calling fetch when any env key is absent', async () => {
    delete process.env.GOOGLE_DRIVE_REFRESH_TOKEN;
    const fetchMock = mockFetch({ 'POST /token': () => ({ ok: true, json: async () => tokenFixture }) });

    const token = await refreshAccessToken({ fetch: fetchMock as unknown as typeof fetch });

    expect(token).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves undefined on a non-2xx response', async () => {
    const fetchMock = mockFetch({ 'POST /token': () => ({ ok: false, json: async () => ({ error: 'invalid_grant' }) }) });
    const token = await refreshAccessToken({ fetch: fetchMock as unknown as typeof fetch });
    expect(token).toBeUndefined();
  });

  it('resolves undefined (never rejects) on a network throw', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });
    const token = await refreshAccessToken({ fetch: fetchMock as unknown as typeof fetch });
    expect(token).toBeUndefined();
  });

  it('resolves undefined on a malformed JSON body', async () => {
    const fetchMock = mockFetch({
      'POST /token': () => ({
        ok: true,
        json: async () => {
          throw new Error('Unexpected token');
        },
      }),
    });
    const token = await refreshAccessToken({ fetch: fetchMock as unknown as typeof fetch });
    expect(token).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveFolderId
// ---------------------------------------------------------------------------

describe('resolveFolderId', () => {
  it('returns an existing folder id from files.list and does NOT call files.create', async () => {
    const fetchMock = mockFetch({
      'GET /drive/v3/files': () => ({ ok: true, json: async () => ({ files: [{ id: 'folder-existing' }] }) }),
      'POST /drive/v3/files': () => ({ ok: true, json: async () => ({ id: 'folder-created' }) }),
    });

    const id = await resolveFolderId('site_1', 'root', ACCESS_TOKEN, { fetch: fetchMock as unknown as typeof fetch });

    expect(id).toBe('folder-existing');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('creates the folder once when files.list is empty, returns the created id', async () => {
    const fetchMock = mockFetch({
      'GET /drive/v3/files': () => ({ ok: true, json: async () => ({ files: [] }) }),
      'POST /drive/v3/files': () => ({ ok: true, json: async () => ({ id: 'folder-created' }) }),
    });

    const id = await resolveFolderId('site_1', 'root', ACCESS_TOKEN, { fetch: fetchMock as unknown as typeof fetch });

    expect(id).toBe('folder-created');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const createCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'POST')!;
    const [, createInit] = createCall as [string, RequestInit];
    const body = JSON.parse(createInit.body as string) as { name: string; mimeType: string; parents: string[] };
    expect(body).toEqual({ name: 'site_1', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] });
  });

  it('embeds the escaped name + parent + folder mimeType + trashed=false in the list query', async () => {
    const fetchMock = mockFetch({
      'GET /drive/v3/files': () => ({ ok: true, json: async () => ({ files: [{ id: 'x' }] }) }),
    });

    await resolveFolderId("O'Brien", 'parent-1', ACCESS_TOKEN, { fetch: fetchMock as unknown as typeof fetch });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    const q = new URL(url).searchParams.get('q')!;
    expect(q).toContain("name='O\\'Brien'");
    expect(q).toContain("'parent-1' in parents");
    expect(q).toContain("mimeType='application/vnd.google-apps.folder'");
    expect(q).toContain('trashed=false');
  });

  it('caches a stable-level result by cacheKey — a second call for the SAME key hits the network zero times', async () => {
    const fetchMock = mockFetch({
      'GET /drive/v3/files': () => ({ ok: true, json: async () => ({ files: [{ id: 'folder-x' }] }) }),
    });
    const deps = { fetch: fetchMock as unknown as typeof fetch };

    const first = await resolveFolderId('2026-07', 'parent-1', ACCESS_TOKEN, deps, { cacheKey: 'site_1:2026-07' });
    const second = await resolveFolderId('2026-07', 'parent-1', ACCESS_TOKEN, deps, { cacheKey: 'site_1:2026-07' });

    expect(first).toBe('folder-x');
    expect(second).toBe('folder-x');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('NEVER caches without a cacheKey — two calls for the entryId level both re-list', async () => {
    const fetchMock = mockFetch({
      'GET /drive/v3/files': () => ({ ok: true, json: async () => ({ files: [{ id: 'entry-folder' }] }) }),
    });
    const deps = { fetch: fetchMock as unknown as typeof fetch };

    await resolveFolderId('entry_9', 'month-folder', ACCESS_TOKEN, deps);
    await resolveFolderId('entry_9', 'month-folder', ACCESS_TOKEN, deps);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('resolves undefined (never throws) when both list and create fail', async () => {
    const fetchMock = mockFetch({
      'GET /drive/v3/files': () => ({ ok: false, json: async () => ({}) }),
      'POST /drive/v3/files': () => ({ ok: false, json: async () => ({}) }),
    });

    const id = await resolveFolderId('site_1', 'root', ACCESS_TOKEN, { fetch: fetchMock as unknown as typeof fetch });
    expect(id).toBeUndefined();
  });

  it('resolves undefined (never rejects) on a network throw from files.list', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });
    const id = await resolveFolderId('site_1', 'root', ACCESS_TOKEN, { fetch: fetchMock as unknown as typeof fetch });
    expect(id).toBeUndefined();
  });

  it('every list/create call carries AbortSignal.timeout (B3)', async () => {
    const fetchMock = mockFetch({
      'GET /drive/v3/files': () => ({ ok: true, json: async () => ({ files: [] }) }),
      'POST /drive/v3/files': () => ({ ok: true, json: async () => ({ id: 'x' }) }),
    });

    await resolveFolderId('site_1', 'root', ACCESS_TOKEN, { fetch: fetchMock as unknown as typeof fetch });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      const [, init] = call as [string, RequestInit];
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });
});

// ---------------------------------------------------------------------------
// uploadFile (Task 3): 5MiB pre-flight branch + retry-then-fallback
// ---------------------------------------------------------------------------

const SMALL_FILE: FileInput = { filename: 'resume.pdf', buffer: Buffer.from('hello world'), mimeType: 'application/pdf' };
const LARGE_FILE: FileInput = {
  filename: 'video.mp4',
  buffer: Buffer.alloc(FIVE_MIB + 1),
  mimeType: 'video/mp4',
};
const UPLOAD_FIXTURE = { id: 'drive-file-1', webViewLink: 'https://drive.google.com/file/d/drive-file-1/view' };

/** No real delay — runs the scheduled backoff callback immediately (deliver.test.ts's fastSchedule convention). */
const fastSchedule = vi.fn((fn: () => void) => fn());

describe('uploadFile', () => {
  it('uses the multipart endpoint (one request) for a buffer <= FIVE_MIB', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain('uploadType=multipart');
      return { ok: true, json: async () => UPLOAD_FIXTURE };
    });

    const result = await uploadFile(SMALL_FILE, 'folder-1', ACCESS_TOKEN, {
      fetch: fetchMock as unknown as typeof fetch,
      schedule: fastSchedule,
    });

    expect(result).toEqual({ ok: true, driveFileId: 'drive-file-1', webViewLink: UPLOAD_FIXTURE.webViewLink });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses the resumable endpoint (init + single PUT) for a buffer > FIVE_MIB', async () => {
    const sessionUrl = `${driveApiBaseUrl()}/upload-session/abc123`;
    const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.includes('uploadType=resumable')) {
        return {
          ok: true,
          headers: { get: (name: string) => (name.toLowerCase() === 'location' ? sessionUrl : null) },
          json: async () => ({}),
        };
      }
      if (url === sessionUrl && init.method === 'PUT') {
        return { ok: true, json: async () => UPLOAD_FIXTURE };
      }
      throw new Error(`Unhandled fetch call: ${init.method ?? 'GET'} ${url}`);
    });

    const result = await uploadFile(LARGE_FILE, 'folder-1', ACCESS_TOKEN, {
      fetch: fetchMock as unknown as typeof fetch,
      schedule: fastSchedule,
    });

    expect(result).toEqual({ ok: true, driveFileId: 'drive-file-1', webViewLink: UPLOAD_FIXTURE.webViewLink });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries on failure then succeeds — 3 attempts total, [1000,2000] backoff, ok result', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: false, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => UPLOAD_FIXTURE });
    const scheduleMock = vi.fn((fn: () => void, _ms: number) => fn());

    const result = await uploadFile(SMALL_FILE, 'folder-1', ACCESS_TOKEN, {
      fetch: fetchMock as unknown as typeof fetch,
      schedule: scheduleMock,
    });

    expect(result).toEqual({ ok: true, driveFileId: 'drive-file-1', webViewLink: UPLOAD_FIXTURE.webViewLink });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(scheduleMock).toHaveBeenCalledTimes(2);
    expect(scheduleMock.mock.calls[0]?.[1]).toBe(1000);
    expect(scheduleMock.mock.calls[1]?.[1]).toBe(2000);
  });

  it('resolves a NOT-ok result (never throws) after exhausting all 3 attempts', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, json: async () => ({}) }));

    const result = await uploadFile(SMALL_FILE, 'folder-1', ACCESS_TOKEN, {
      fetch: fetchMock as unknown as typeof fetch,
      schedule: fastSchedule,
    });

    expect(result).toEqual({ ok: false });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('resolves a NOT-ok result (never rejects) when fetch throws on every attempt', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });

    await expect(
      uploadFile(SMALL_FILE, 'folder-1', ACCESS_TOKEN, {
        fetch: fetchMock as unknown as typeof fetch,
        schedule: fastSchedule,
      }),
    ).resolves.toEqual({ ok: false });
  });

  it('the multipart POST carries AbortSignal.timeout (UPLOAD, B3)', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return { ok: true, json: async () => UPLOAD_FIXTURE };
    });

    await uploadFile(SMALL_FILE, 'folder-1', ACCESS_TOKEN, {
      fetch: fetchMock as unknown as typeof fetch,
      schedule: fastSchedule,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('the resumable init + PUT both carry AbortSignal.timeout (META for init, UPLOAD for the body, B3)', async () => {
    const sessionUrl = `${driveApiBaseUrl()}/upload-session/abc123`;
    const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      if (url.includes('uploadType=resumable')) {
        return {
          ok: true,
          headers: { get: (name: string) => (name.toLowerCase() === 'location' ? sessionUrl : null) },
          json: async () => ({}),
        };
      }
      return { ok: true, json: async () => UPLOAD_FIXTURE };
    });

    await uploadFile(LARGE_FILE, 'folder-1', ACCESS_TOKEN, {
      fetch: fetchMock as unknown as typeof fetch,
      schedule: fastSchedule,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// grantPermission (Task 3, D2)
// ---------------------------------------------------------------------------

describe('grantPermission', () => {
  it('POSTs {role:"reader", type:"anyone"} to the file permissions endpoint', async () => {
    const fetchMock = mockFetch({ 'POST /permissions': () => ({ ok: true, json: async () => ({}) }) });

    await grantPermission('drive-file-1', ACCESS_TOKEN, { fetch: fetchMock as unknown as typeof fetch });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${driveApiBaseUrl()}/drive/v3/files/drive-file-1/permissions`);
    expect(JSON.parse(init.body as string)).toEqual({ role: 'reader', type: 'anyone' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('never throws (resolves undefined) on a non-2xx response', async () => {
    const fetchMock = mockFetch({ 'POST /permissions': () => ({ ok: false, json: async () => ({}) }) });
    await expect(grantPermission('drive-file-1', ACCESS_TOKEN, { fetch: fetchMock as unknown as typeof fetch })).resolves.toBeUndefined();
  });

  it('never throws (resolves undefined) on a network throw', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });
    await expect(grantPermission('drive-file-1', ACCESS_TOKEN, { fetch: fetchMock as unknown as typeof fetch })).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// uploadFilesToDrive orchestrator (Task 3, DRV-02)
// ---------------------------------------------------------------------------

interface TestConfigOverrides {
  linkAccess?: 'anyone' | 'private';
  attachmentFallbackMaxBytes?: number;
  rootFolderName?: string;
}

function testConfig(overrides: TestConfigOverrides = {}) {
  return {
    drive: {
      linkAccess: overrides.linkAccess ?? 'private',
      attachmentFallbackMaxBytes: overrides.attachmentFallbackMaxBytes ?? 10_485_760,
      rootFolderName: overrides.rootFolderName ?? 'cool-astro-forms',
    },
  };
}

/** Routes every Drive endpoint the orchestrator can call. Upload/permission behavior driven by `opts`. */
function buildOrchestratorFetch(
  opts: {
    tokenOk?: boolean;
    folderResolveFails?: boolean;
    uploadFailTimes?: number;
    uploadOk?: boolean;
    permissionOk?: boolean;
  } = {},
): ReturnType<typeof vi.fn> {
  let uploadAttempts = 0;
  return vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    if (url.includes('/token')) {
      return opts.tokenOk === false
        ? { ok: false, json: async () => ({}) }
        : { ok: true, json: async () => tokenFixture };
    }
    if (url.includes('/upload/drive/v3/files') && url.includes('uploadType=multipart')) {
      uploadAttempts++;
      if (opts.uploadOk === false) return { ok: false, json: async () => ({}) };
      if (opts.uploadFailTimes && uploadAttempts <= opts.uploadFailTimes) return { ok: false, json: async () => ({}) };
      return { ok: true, json: async () => UPLOAD_FIXTURE };
    }
    if (url.includes('/permissions')) {
      return opts.permissionOk === false ? { ok: false, json: async () => ({}) } : { ok: true, json: async () => ({}) };
    }
    if (url.includes('/drive/v3/files') && method === 'GET') {
      return {
        ok: !opts.folderResolveFails,
        json: async () => (opts.folderResolveFails ? {} : { files: [{ id: `folder-${Math.random()}` }] }),
      };
    }
    if (url.includes('/drive/v3/files') && method === 'POST') {
      return { ok: !opts.folderResolveFails, json: async () => (opts.folderResolveFails ? {} : { id: `created-${Math.random()}` }) };
    }
    throw new Error(`Unhandled fetch call: ${method} ${url}`);
  }) as unknown as ReturnType<typeof vi.fn>;
}

describe('uploadFilesToDrive', () => {
  it('is fully inert without all three GOOGLE_DRIVE_* keys: every file resolves email-only with the buffer kept, zero network calls', async () => {
    delete process.env.GOOGLE_DRIVE_CLIENT_ID;
    const fetchMock = vi.fn();
    const file: FileInput = { filename: 'a.txt', buffer: Buffer.from('hello'), mimeType: 'text/plain' };

    const results = await uploadFilesToDrive([file], {
      siteId: 'site_1',
      entryId: 'entry_1',
      entryCreatedAt: 1_700_000_000_000,
      config: testConfig(),
      deps: { fetch: fetchMock as unknown as typeof fetch, schedule: fastSchedule },
    });

    expect(results).toEqual([
      { filename: 'a.txt', sizeBytes: 5, mime: 'text/plain', storage: 'email-only', fallbackBuffer: file.buffer },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uploads a file successfully: storage:"drive" + driveFileId + driveLink, no permission grant with linkAccess:"private"', async () => {
    const fetchMock = buildOrchestratorFetch();
    const file: FileInput = { filename: 'resume.pdf', buffer: Buffer.from('hi'), mimeType: 'application/pdf' };

    const results = await uploadFilesToDrive([file], {
      siteId: 'site_1',
      entryId: 'entry_1',
      entryCreatedAt: 1_700_000_000_000,
      config: testConfig({ linkAccess: 'private' }),
      deps: { fetch: fetchMock as unknown as typeof fetch, schedule: fastSchedule },
    });

    expect(results).toEqual([
      {
        filename: 'resume.pdf',
        sizeBytes: 2,
        mime: 'application/pdf',
        storage: 'drive',
        driveFileId: 'drive-file-1',
        driveLink: UPLOAD_FIXTURE.webViewLink,
      },
    ]);
    expect(fetchMock.mock.calls.some((call) => (call[0] as string).includes('/permissions'))).toBe(false);
  });

  it('grants the anyone-reader permission when linkAccess:"anyone" (D2)', async () => {
    const fetchMock = buildOrchestratorFetch();
    const file: FileInput = { filename: 'resume.pdf', buffer: Buffer.from('hi'), mimeType: 'application/pdf' };

    await uploadFilesToDrive([file], {
      siteId: 'site_1',
      entryId: 'entry_1',
      entryCreatedAt: 1_700_000_000_000,
      config: testConfig({ linkAccess: 'anyone' }),
      deps: { fetch: fetchMock as unknown as typeof fetch, schedule: fastSchedule },
    });

    const permissionCall = fetchMock.mock.calls.find((call) => (call[0] as string).includes('/permissions'));
    expect(permissionCall).toBeDefined();
    const [, init] = permissionCall as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ role: 'reader', type: 'anyone' });
  });

  it('a failing permission grant does not throw and does not fail the upload', async () => {
    const fetchMock = buildOrchestratorFetch({ permissionOk: false });
    const file: FileInput = { filename: 'resume.pdf', buffer: Buffer.from('hi'), mimeType: 'application/pdf' };

    const results = await uploadFilesToDrive([file], {
      siteId: 'site_1',
      entryId: 'entry_1',
      entryCreatedAt: 1_700_000_000_000,
      config: testConfig({ linkAccess: 'anyone' }),
      deps: { fetch: fetchMock as unknown as typeof fetch, schedule: fastSchedule },
    });

    expect(results[0]?.storage).toBe('drive');
    expect(results[0]?.driveFileId).toBe('drive-file-1');
  });

  it('falls back to storage:"email-only" + fallbackBuffer when upload retries are exhausted (DRV-02)', async () => {
    const fetchMock = buildOrchestratorFetch({ uploadOk: false });
    const file: FileInput = { filename: 'resume.pdf', buffer: Buffer.from('hi'), mimeType: 'application/pdf' };

    const results = await uploadFilesToDrive([file], {
      siteId: 'site_1',
      entryId: 'entry_1',
      entryCreatedAt: 1_700_000_000_000,
      config: testConfig(),
      deps: { fetch: fetchMock as unknown as typeof fetch, schedule: fastSchedule },
    });

    expect(results).toEqual([
      { filename: 'resume.pdf', sizeBytes: 2, mime: 'application/pdf', storage: 'email-only', fallbackBuffer: file.buffer },
    ]);
  });

  it('falls back with fallbackTooLarge:true (no buffer) when the fallback exceeds attachmentFallbackMaxBytes', async () => {
    const fetchMock = buildOrchestratorFetch({ uploadOk: false });
    const file: FileInput = { filename: 'big.bin', buffer: Buffer.alloc(100), mimeType: 'application/octet-stream' };

    const results = await uploadFilesToDrive([file], {
      siteId: 'site_1',
      entryId: 'entry_1',
      entryCreatedAt: 1_700_000_000_000,
      config: testConfig({ attachmentFallbackMaxBytes: 10 }),
      deps: { fetch: fetchMock as unknown as typeof fetch, schedule: fastSchedule },
    });

    expect(results).toEqual([
      { filename: 'big.bin', sizeBytes: 100, mime: 'application/octet-stream', storage: 'email-only', fallbackTooLarge: true },
    ]);
  });

  it('falls back for every file when the token refresh fails, without ever calling upload', async () => {
    const fetchMock = buildOrchestratorFetch({ tokenOk: false });
    const file: FileInput = { filename: 'resume.pdf', buffer: Buffer.from('hi'), mimeType: 'application/pdf' };

    const results = await uploadFilesToDrive([file], {
      siteId: 'site_1',
      entryId: 'entry_1',
      entryCreatedAt: 1_700_000_000_000,
      config: testConfig(),
      deps: { fetch: fetchMock as unknown as typeof fetch, schedule: fastSchedule },
    });

    expect(results[0]?.storage).toBe('email-only');
    expect(results[0]?.fallbackBuffer).toEqual(file.buffer);
    expect(fetchMock.mock.calls.some((call) => (call[0] as string).includes('/upload/'))).toBe(false);
  });

  it('falls back for every file when folder resolution fails (list and create both fail)', async () => {
    const fetchMock = buildOrchestratorFetch({ folderResolveFails: true });
    const file: FileInput = { filename: 'resume.pdf', buffer: Buffer.from('hi'), mimeType: 'application/pdf' };

    const results = await uploadFilesToDrive([file], {
      siteId: 'site_1',
      entryId: 'entry_1',
      entryCreatedAt: 1_700_000_000_000,
      config: testConfig(),
      deps: { fetch: fetchMock as unknown as typeof fetch, schedule: fastSchedule },
    });

    expect(results[0]?.storage).toBe('email-only');
    expect(fetchMock.mock.calls.some((call) => (call[0] as string).includes('/upload/'))).toBe(false);
  });

  it('never throws when the injected fetch throws unconditionally', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('total network failure');
    });
    const file: FileInput = { filename: 'resume.pdf', buffer: Buffer.from('hi'), mimeType: 'application/pdf' };

    const results = await uploadFilesToDrive([file], {
      siteId: 'site_1',
      entryId: 'entry_1',
      entryCreatedAt: 1_700_000_000_000,
      config: testConfig(),
      deps: { fetch: fetchMock as unknown as typeof fetch, schedule: fastSchedule },
    });

    expect(results[0]?.storage).toBe('email-only');
  });

  it('resolves the stable folder levels once and reuses them across two uploadFilesToDrive calls in the same month', async () => {
    resetDriveCaches();
    const fetchMock = buildOrchestratorFetch();
    const fileA: FileInput = { filename: 'a.pdf', buffer: Buffer.from('a'), mimeType: 'application/pdf' };
    const fileB: FileInput = { filename: 'b.pdf', buffer: Buffer.from('b'), mimeType: 'application/pdf' };

    await uploadFilesToDrive([fileA], {
      siteId: 'site_1',
      entryId: 'entry_1',
      entryCreatedAt: 1_700_000_000_000,
      config: testConfig(),
      deps: { fetch: fetchMock as unknown as typeof fetch, schedule: fastSchedule },
    });
    const callsAfterFirst = fetchMock.mock.calls.length;

    await uploadFilesToDrive([fileB], {
      siteId: 'site_1',
      entryId: 'entry_2',
      entryCreatedAt: 1_700_000_000_000,
      config: testConfig(),
      deps: { fetch: fetchMock as unknown as typeof fetch, schedule: fastSchedule },
    });
    const callsAfterSecond = fetchMock.mock.calls.length - callsAfterFirst;

    // Second call: token cached (no /token call), root/siteId/month cached (no list calls for
    // those 3 levels) — only the entryId-level list/create + the upload fetch happen fresh.
    expect(callsAfterSecond).toBeLessThan(callsAfterFirst);
  });

  it('returns an empty array without any network call for an empty files array', async () => {
    const fetchMock = vi.fn();

    const results = await uploadFilesToDrive([], {
      siteId: 'site_1',
      entryId: 'entry_1',
      entryCreatedAt: 1_700_000_000_000,
      config: testConfig(),
      deps: { fetch: fetchMock as unknown as typeof fetch, schedule: fastSchedule },
    });

    expect(results).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
