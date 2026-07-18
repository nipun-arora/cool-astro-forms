/**
 * POST /forms-admin/auth (ADMN-01) — password login for the admin UI.
 * Split page/handler (item: research route topology) to avoid a page-vs-
 * route path collision: GET /forms-admin/login renders login.astro (form
 * posts here); this route only authenticates.
 *
 * Order (threat register T-02-10/13/14): same-origin (CSRF) -> dedicated
 * tight rate limiter (brute-force, separate bucket from the abandon route's
 * defaultRateLimiter) -> constant-time password compare -> HMAC session
 * issuance. Every emitted redirect goes through adminUrl (checker B1) so
 * this route never regresses to a hardcoded slashless admin URL.
 *
 * Route INJECTION (making this reachable at /forms-admin/auth) is
 * consolidated in P05 — middleware.ts's guard exempts this path already.
 */
import type { APIRoute } from 'astro';
import config from 'virtual:cool-astro-forms/config';
import { adminUrl } from '../../admin/_shared.js';
import { resolveAdminSecret } from '../../security/admin-secret.js';
import { issueSession } from '../../security/admin-session.js';
import { tokensMatch } from '../../security/constant-time-compare.js';
import { isSameOrigin } from '../../security/origin-check.js';
import { createRateLimiter, type RateLimiter } from '../../security/rate-limit.js';

export const prerender = false;

/** Name of the signed session cookie set on successful login. */
export const ADMIN_SESSION_COOKIE = '_caf_admin_session';

const DAY_SECONDS = 24 * 60 * 60;

/**
 * Dedicated tight bucket (T-02-10): capacity 5, refilling over ~15 minutes
 * — deliberately separate from `defaultRateLimiter` (the abandon route's
 * ~20/min bucket) so a slow admin-login brute-force can't hide inside the
 * public form's traffic budget, and vice versa.
 */
let loginRateLimiter: RateLimiter = createRateLimiter({ capacity: 5, refillPerSec: 5 / 900 });

/** Test-only reset for the login limiter's bucket state (mirrors resetDefaultRateLimiter). */
export function resetLoginRateLimiter(): void {
  loginRateLimiter.clear();
}

type ConfigWithTrailingSlash = typeof config & { trailingSlash?: 'always' | 'never' | 'ignore' };

/** Reads the submitted password from a form-urlencoded/multipart or JSON body. Never throws. */
async function extractPassword(request: Request): Promise<string> {
  const contentType = request.headers.get('content-type') ?? '';
  try {
    if (contentType.includes('application/json')) {
      const body = (await request.json()) as { password?: unknown };
      return typeof body.password === 'string' ? body.password : '';
    }
    const formData = await request.formData();
    const value = formData.get('password');
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

export const POST: APIRoute = async ({ request, cookies, redirect, clientAddress }) => {
  const trailingSlash = (config as ConfigWithTrailingSlash).trailingSlash;

  // 1. Origin (CSRF, T-02-13) — the ONLY origin protection this route gets.
  if (!isSameOrigin(request.headers, config.siteUrl)) {
    return new Response(null, { status: 403 });
  }

  // 2. Rate limit (T-02-10) — checked before ever reading the body, so
  // every attempt (right or wrong password) counts against the bucket.
  const ip = clientAddress ?? '';
  if (!loginRateLimiter.allow(ip)) {
    return new Response(null, { status: 429 });
  }

  // 3. Constant-time password compare (T-02-14). An unset
  // FORMS_ADMIN_PASSWORD must never authenticate — even against an empty
  // submitted password (module inert, not crashable).
  const provided = await extractPassword(request);
  const expectedPassword = process.env.FORMS_ADMIN_PASSWORD;
  const passwordOk = Boolean(expectedPassword) && tokensMatch(provided, expectedPassword ?? '');

  if (!passwordOk) {
    return redirect(adminUrl('/forms-admin/login?error=1', trailingSlash));
  }

  // 4. Issue the HMAC session (T-02-11/12).
  const secret = resolveAdminSecret(config.dbPath);
  const sessionTtlDays = config.admin.sessionTtlDays;
  const token = issueSession(secret, sessionTtlDays * DAY_SECONDS * 1000);

  cookies.set(ADMIN_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/forms-admin',
    maxAge: sessionTtlDays * DAY_SECONDS,
  });

  return redirect(adminUrl('/forms-admin/entries', trailingSlash));
};
