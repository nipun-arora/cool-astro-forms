import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAuthUrl, exchangeCodeForRefreshToken } from './get-drive-token.mjs';

// Network-free by construction (04-VALIDATION invariant): every case here
// injects a FAKE fetch — never a live call to accounts.google.com or
// oauth2.googleapis.com (paypal.test.ts / turnstile.test.ts convention).

const CLIENT_ID = 'drive-client-id';
const CLIENT_SECRET = 'drive-client-secret';
const REDIRECT_URI = 'http://127.0.0.1:53219';

afterEach(() => {
  delete process.env.GOOGLE_OAUTH_AUTH_URL;
  delete process.env.GOOGLE_OAUTH_TOKEN_URL;
});

// ---------------------------------------------------------------------------
// buildAuthUrl
// ---------------------------------------------------------------------------

describe('buildAuthUrl', () => {
  it('carries drive.file scope + access_type=offline + prompt=consent (loopback flow, not the dead OOB flow)', () => {
    const url = buildAuthUrl({ clientId: CLIENT_ID, redirectUri: REDIRECT_URI });

    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive.file');
    // The classic "no refresh token returned" bug is omitting either of these two params.
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
  });

  it('defaults to the real Google auth endpoint', () => {
    const url = buildAuthUrl({ clientId: CLIENT_ID, redirectUri: REDIRECT_URI });
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
  });

  it('is overridable via the authBase param (unit-test seam)', () => {
    const url = buildAuthUrl({
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      authBase: 'http://localhost:9999/auth',
    });
    expect(url.origin + url.pathname).toBe('http://localhost:9999/auth');
  });

  it('is overridable via GOOGLE_OAUTH_AUTH_URL when no explicit authBase is passed', () => {
    process.env.GOOGLE_OAUTH_AUTH_URL = 'http://localhost:8888/env-auth';
    const url = buildAuthUrl({ clientId: CLIENT_ID, redirectUri: REDIRECT_URI });
    expect(url.origin + url.pathname).toBe('http://localhost:8888/env-auth');
  });

  it('an explicit authBase param wins over the env override', () => {
    process.env.GOOGLE_OAUTH_AUTH_URL = 'http://localhost:8888/env-auth';
    const url = buildAuthUrl({
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      authBase: 'http://localhost:9999/param-auth',
    });
    expect(url.origin + url.pathname).toBe('http://localhost:9999/param-auth');
  });
});

// ---------------------------------------------------------------------------
// exchangeCodeForRefreshToken
// ---------------------------------------------------------------------------

describe('exchangeCodeForRefreshToken', () => {
  const tokenFixture = { refresh_token: '1//abc', access_token: 'ya29.x' };

  it('POSTs grant_type=authorization_code + code + redirect_uri form-encoded, resolves the refresh_token', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => tokenFixture }));

    const token = await exchangeCodeForRefreshToken({
      code: 'auth-code-1',
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
      fetch: fetchMock as unknown as typeof fetch,
    });

    expect(token).toBe('1//abc');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/x-www-form-urlencoded' });
    expect(init.signal).toBeInstanceOf(AbortSignal);

    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('auth-code-1');
    expect(body.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(body.get('client_id')).toBe(CLIENT_ID);
    expect(body.get('client_secret')).toBe(CLIENT_SECRET);
  });

  it('defaults to the real Google token endpoint', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => tokenFixture }));
    await exchangeCodeForRefreshToken({
      code: 'auth-code-1',
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
      fetch: fetchMock as unknown as typeof fetch,
    });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://oauth2.googleapis.com/token');
  });

  it('is overridable via the tokenUrl param (unit-test seam)', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => tokenFixture }));
    await exchangeCodeForRefreshToken({
      code: 'auth-code-1',
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
      fetch: fetchMock as unknown as typeof fetch,
      tokenUrl: 'http://localhost:9999/token',
    });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('http://localhost:9999/token');
  });

  it('is overridable via GOOGLE_OAUTH_TOKEN_URL when no explicit tokenUrl is passed', async () => {
    process.env.GOOGLE_OAUTH_TOKEN_URL = 'http://localhost:8888/env-token';
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => tokenFixture }));
    await exchangeCodeForRefreshToken({
      code: 'auth-code-1',
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
      fetch: fetchMock as unknown as typeof fetch,
    });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('http://localhost:8888/env-token');
  });

  it('resolves undefined without throwing on a non-2xx response', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, json: async () => ({ error: 'invalid_grant' }) }));
    const token = await exchangeCodeForRefreshToken({
      code: 'bad-code',
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(token).toBeUndefined();
  });

  it('resolves undefined when the response body has no refresh_token (mirrors paypal getAccessToken tolerance)', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ access_token: 'ya29.x' }) }));
    const token = await exchangeCodeForRefreshToken({
      code: 'auth-code-1',
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(token).toBeUndefined();
  });

  it('resolves undefined on a malformed JSON body (json() throws)', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => {
        throw new Error('Unexpected token');
      },
    }));
    const token = await exchangeCodeForRefreshToken({
      code: 'auth-code-1',
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(token).toBeUndefined();
  });

  it('resolves undefined (never rejects) on a network throw', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });
    const token = await exchangeCodeForRefreshToken({
      code: 'auth-code-1',
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(token).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Side-effect-free import
// ---------------------------------------------------------------------------

describe('module import side effects', () => {
  it('imports cleanly above (no socket opened) and guards main() behind the entrypoint check', () => {
    // The two describe blocks above already prove this test file can import
    // get-drive-token.mjs and exercise its helpers without vitest hanging on
    // an open http server. This assertion additionally locks the specific
    // guard shape the interface note requires, so a future edit can't drop it.
    const src = readFileSync(fileURLToPath(new URL('./get-drive-token.mjs', import.meta.url)), 'utf8');
    expect(src).toMatch(/import\.meta\.url/);
    expect(src).toMatch(/pathToFileURL\(process\.argv\[1\]\)/);
  });
});
