/**
 * auth.ts tests — POST /forms-admin/auth (ADMN-01): constant-time password
 * login gated by a dedicated tight rate-limit bucket (separate from the
 * abandon route's), CSRF-checked via isSameOrigin, and inert (never a
 * bypass) when FORMS_ADMIN_PASSWORD is unset. Every emitted redirect goes
 * through adminUrl (checker B1).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveAdminSecretMock } = vi.hoisted(() => ({
  resolveAdminSecretMock: vi.fn(() => 'fixed-test-secret'),
}));

vi.mock('virtual:cool-astro-forms/config', () => ({
  default: {
    siteId: 'demo-site',
    siteUrl: 'https://example.com',
    forms: {},
    requireConsent: false,
    journeyParams: false,
    retentionDays: 90,
    dbPath: '/tmp/nonexistent/forms.db',
    admin: { sessionTtlDays: 7 },
    trailingSlash: undefined as 'always' | 'never' | 'ignore' | undefined,
  },
}));
vi.mock('../../security/admin-secret.js', () => ({ resolveAdminSecret: resolveAdminSecretMock }));

import config from 'virtual:cool-astro-forms/config';
import { verifySession } from '../../security/admin-session.js';
import { ADMIN_SESSION_COOKIE, POST, resetLoginRateLimiter } from './auth.js';

const ORIGINAL_ADMIN_PASSWORD = process.env.FORMS_ADMIN_PASSWORD;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

interface FakeCookies {
  set: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

function makeFakeCookies(): FakeCookies {
  return { set: vi.fn(), get: vi.fn(), delete: vi.fn() };
}

function fakeRedirect(path: string, status = 302): Response {
  return new Response(null, { status, headers: { Location: path } });
}

function makeRequest(
  body: Record<string, string>,
  headers: Record<string, string> = {},
): Request {
  const form = new URLSearchParams(body);
  return new Request('https://example.com/forms-admin/auth', {
    method: 'POST',
    headers: { origin: 'https://example.com', ...headers },
    body: form,
  });
}

async function callPost(
  body: Record<string, string>,
  opts: { headers?: Record<string, string>; clientAddress?: string } = {},
): Promise<{ res: Response; cookies: FakeCookies }> {
  const cookies = makeFakeCookies();
  const request = makeRequest(body, opts.headers);
  const res = await POST({
    request,
    cookies,
    redirect: fakeRedirect,
    clientAddress: opts.clientAddress ?? '1.2.3.4',
  } as unknown as Parameters<typeof POST>[0]);
  return { res, cookies };
}

describe('POST /forms-admin/auth', () => {
  beforeEach(() => {
    resetLoginRateLimiter();
    resolveAdminSecretMock.mockClear();
    process.env.FORMS_ADMIN_PASSWORD = 'correct-horse';
    delete process.env.NODE_ENV;
    (config as { trailingSlash?: 'always' | 'never' | 'ignore' }).trailingSlash = undefined;
  });

  afterEach(() => {
    if (ORIGINAL_ADMIN_PASSWORD === undefined) delete process.env.FORMS_ADMIN_PASSWORD;
    else process.env.FORMS_ADMIN_PASSWORD = ORIGINAL_ADMIN_PASSWORD;
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  it('sets a correctly-flagged session cookie and redirects to /forms-admin/entries on the correct password', async () => {
    const { res, cookies } = await callPost({ password: 'correct-horse' });

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/forms-admin/entries');

    expect(cookies.set).toHaveBeenCalledTimes(1);
    const [name, value, options] = cookies.set.mock.calls[0]!;
    expect(name).toBe(ADMIN_SESSION_COOKIE);
    expect(options).toMatchObject({
      httpOnly: true,
      secure: false,
      sameSite: 'strict',
      path: '/forms-admin',
      maxAge: 7 * 86400,
    });
    expect(verifySession(value as string, 'fixed-test-secret')).toBe(true);
  });

  it('sets secure:true on the session cookie in production', async () => {
    process.env.NODE_ENV = 'production';
    const { cookies } = await callPost({ password: 'correct-horse' });
    const [, , options] = cookies.set.mock.calls[0]!;
    expect(options).toMatchObject({ secure: true });
  });

  it('rejects a wrong password: no cookie set, redirects to /forms-admin/login?error=1', async () => {
    const { res, cookies } = await callPost({ password: 'wrong-password' });

    expect(cookies.set).not.toHaveBeenCalled();
    expect(res.headers.get('Location')).toBe('/forms-admin/login?error=1');
  });

  it("honors trailingSlash:'always' on both the success and failure redirect targets", async () => {
    (config as { trailingSlash?: 'always' | 'never' | 'ignore' }).trailingSlash = 'always';

    const ok = await callPost({ password: 'correct-horse' });
    expect(ok.res.headers.get('Location')).toBe('/forms-admin/entries/');

    const bad = await callPost({ password: 'wrong-password' });
    expect(bad.res.headers.get('Location')).toBe('/forms-admin/login/?error=1');
  });

  it('is inert (always fails) when FORMS_ADMIN_PASSWORD is unset, even for an empty submitted password', async () => {
    delete process.env.FORMS_ADMIN_PASSWORD;
    const { res, cookies } = await callPost({ password: '' });

    expect(cookies.set).not.toHaveBeenCalled();
    expect(res.headers.get('Location')).toBe('/forms-admin/login?error=1');
  });

  it('blocks further attempts with 429 after the login limiter capacity (5) is exhausted', async () => {
    for (let i = 0; i < 5; i += 1) {
      const { res } = await callPost({ password: 'wrong-password' });
      expect(res.status).not.toBe(429);
    }
    const { res: sixth } = await callPost({ password: 'wrong-password' });
    expect(sixth.status).toBe(429);
  });

  it('gives distinct client IPs independent login-limiter buckets', async () => {
    for (let i = 0; i < 5; i += 1) {
      await callPost({ password: 'wrong-password' }, { clientAddress: '9.9.9.9' });
    }
    const { res } = await callPost({ password: 'wrong-password' }, { clientAddress: '5.5.5.5' });
    expect(res.status).not.toBe(429);
  });

  it('rejects a cross-origin POST with 403 before ever consuming a rate-limit token or reading the body', async () => {
    const { res, cookies } = await callPost(
      { password: 'correct-horse' },
      { headers: { origin: 'https://evil.example' } },
    );
    expect(res.status).toBe(403);
    expect(cookies.set).not.toHaveBeenCalled();
  });

  it('resolves the admin secret from resolveAdminSecret(config.dbPath) on a successful login', async () => {
    await callPost({ password: 'correct-horse' });
    expect(resolveAdminSecretMock).toHaveBeenCalledWith('/tmp/nonexistent/forms.db');
  });
});
