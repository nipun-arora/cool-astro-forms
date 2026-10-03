/**
 * isAdminRequest (0.1.15) — lets a host page or API route under its own
 * control (a desk quote page under /forms-admin, or an endpoint outside it)
 * ask "is this request from a signed-in admin?" with the package's own
 * session check, instead of re-implementing cookie parsing and HMAC
 * verification. It must fail CLOSED on every doubt: a wrong answer here
 * hands someone a page that can create payment links.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueSession } from './admin-session.js';
import { isAdminRequest } from './is-admin-request.js';

vi.mock('../log.js', () => ({ log: vi.fn(), logError: vi.fn(), warn: vi.fn() }));

const ENV_KEYS = ['FORMS_ADMIN_SECRET', 'CAF_REQUIRE_EXPLICIT_SECRETS', 'CAF_DB_PATH'] as const;
let saved: Record<string, string | undefined>;
let tmpDir: string;

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caf-isadmin-'));
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function ctx(cookieValue?: string) {
  return {
    cookies: {
      get: vi.fn((name: string) =>
        name === '_caf_admin_session' && cookieValue !== undefined ? { value: cookieValue } : undefined,
      ),
    },
  };
}

describe('isAdminRequest', () => {
  it('true for a session cookie signed with FORMS_ADMIN_SECRET and not yet expired', () => {
    process.env.FORMS_ADMIN_SECRET = 'host-secret';
    const token = issueSession('host-secret', 60_000);
    expect(isAdminRequest(ctx(token))).toBe(true);
  });

  it('false with no session cookie, and it does not create the auto-generated secret file as a side effect', () => {
    process.env.CAF_DB_PATH = path.join(tmpDir, 'forms.db');
    expect(isAdminRequest(ctx())).toBe(false);
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it('false for a token signed with a different secret (a forged cookie)', () => {
    process.env.FORMS_ADMIN_SECRET = 'host-secret';
    expect(isAdminRequest(ctx(issueSession('attacker-secret', 60_000)))).toBe(false);
  });

  it('false for an expired session', () => {
    process.env.FORMS_ADMIN_SECRET = 'host-secret';
    expect(isAdminRequest(ctx(issueSession('host-secret', 60_000, Date.now() - 120_000)))).toBe(false);
  });

  it('false for garbage cookie values', () => {
    process.env.FORMS_ADMIN_SECRET = 'host-secret';
    for (const value of ['', 'abc', '.', '123.', '.sig', 'x'.repeat(5000)]) {
      expect(isAdminRequest(ctx(value))).toBe(false);
    }
  });

  it('fails closed (false, no throw) when the secret cannot be resolved (explicit-secrets mode with FORMS_ADMIN_SECRET missing)', () => {
    process.env.CAF_REQUIRE_EXPLICIT_SECRETS = '1';
    process.env.CAF_DB_PATH = path.join(tmpDir, 'forms.db');
    expect(() => isAdminRequest(ctx('123.abc'))).not.toThrow();
    expect(isAdminRequest(ctx('123.abc'))).toBe(false);
  });

  it("verifies against the auto-generated secret beside the database (the middleware's own fallback), honouring an explicit dbPath option", () => {
    const dbPath = path.join(tmpDir, 'forms.db');
    // First call with a cookie makes the package resolve (and persist) the secret, exactly as the middleware would.
    expect(isAdminRequest(ctx('1.x'), { dbPath })).toBe(false);
    const secretFile = fs.readdirSync(tmpDir).find((name) => name.includes('secret'));
    expect(secretFile).toBeDefined();
    const secret = fs.readFileSync(path.join(tmpDir, secretFile!), 'utf8').trim();
    expect(isAdminRequest(ctx(issueSession(secret, 60_000)), { dbPath })).toBe(true);
  });
});

// The admin cookie is set with Path=/forms-admin, so a browser never sends it
// to any other path: there, isAdminRequest is always false. That fails
// closed, but a host developer who keeps getting 401s on a money route at
// /api/quote is pushed to weaken the check. The package says why, once.
describe('isAdminRequest outside /forms-admin', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  /** A fresh module instance (its once-per-process flag reset) and a cleared warn mock. */
  async function freshIsAdminRequest() {
    const mod = await import('./is-admin-request.js');
    const log = await import('../log.js');
    vi.mocked(log.warn).mockClear();
    return { isAdminRequest: mod.isAdminRequest, warn: vi.mocked(log.warn) };
  }

  function ctxAt(pathname: string, cookieValue?: string) {
    return { ...ctx(cookieValue), url: new URL(`https://site.example${pathname}`) };
  }

  it('logs one admin.is-admin-request-outside-admin-path warning naming the path, and still returns false', async () => {
    const fresh = await freshIsAdminRequest();
    process.env.FORMS_ADMIN_SECRET = 'host-secret';

    expect(fresh.isAdminRequest(ctxAt('/api/quote'))).toBe(false);
    expect(fresh.isAdminRequest(ctxAt('/quote/'))).toBe(false);

    expect(fresh.warn).toHaveBeenCalledTimes(1);
    expect(fresh.warn).toHaveBeenCalledWith(
      'admin.is-admin-request-outside-admin-path',
      expect.objectContaining({ path: '/api/quote' }),
    );
  });

  it('does not warn for paths under /forms-admin (the cookie is sent there)', async () => {
    const fresh = await freshIsAdminRequest();
    process.env.FORMS_ADMIN_SECRET = 'host-secret';
    const token = issueSession('host-secret', 60_000);

    expect(fresh.isAdminRequest(ctxAt('/forms-admin/quote/', token))).toBe(true);
    expect(fresh.isAdminRequest(ctxAt('/forms-admin'))).toBe(false);
    expect(fresh.warn).not.toHaveBeenCalled();
  });

  it('treats a lookalike prefix (/forms-administrator) as outside: the cookie path does not match it either', async () => {
    const fresh = await freshIsAdminRequest();

    expect(fresh.isAdminRequest(ctxAt('/forms-administrator/quote'))).toBe(false);
    expect(fresh.warn).toHaveBeenCalledTimes(1);
  });
});
