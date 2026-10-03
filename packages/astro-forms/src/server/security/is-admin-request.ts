/**
 * isAdminRequest(context) (0.1.15) — the package's admin-session check for a
 * host's own pages and routes. Exported from `cool-astro-forms/server`.
 *
 * Host admin pages and routes belong under `/forms-admin/...`. The login
 * route sets the `_caf_admin_session` cookie with `Path=/forms-admin`, so a
 * browser sends it to that prefix and nowhere else: on any other path this
 * check is always false. Under the prefix the package middleware already
 * guards every request, and this is the second, explicit check a page
 * should still make before doing anything with money. It verifies the same
 * signed cookie against the same secret the middleware uses. When the
 * context carries a `url` outside the prefix, the first such call logs one
 * `admin.is-admin-request-outside-admin-path` warning saying so.
 *
 * Fails closed: no cookie, a forged, expired or malformed token, or a secret
 * that cannot be resolved all return false, and nothing throws. The secret
 * is only resolved when a cookie is present, so a visitor without one never
 * triggers the generate-and-persist fallback beside the database.
 */
import { logError, warn } from '../log.js';
import { resolveAdminSecret } from './admin-secret.js';
import { verifySession } from './admin-session.js';

/** Must match routes/admin/auth.ts and middleware.ts: the one admin session cookie. */
const ADMIN_SESSION_COOKIE = '_caf_admin_session';
/** The cookie's `Path` (routes/admin/auth.ts): browsers send it only under this prefix. */
const ADMIN_PATH_PREFIX = '/forms-admin';

/** The slice of Astro's `APIContext` / `Astro` global this check reads, so either can be passed. */
export interface AdminRequestContext {
  cookies: { get(name: string): { value: string } | undefined };
  /** The request URL (both `APIContext` and `Astro` carry it); used only to warn about a path the cookie never reaches. */
  url?: URL;
}

/** Per process: the outside-the-prefix warning is logged once, not on every request. */
let warnedOutsideAdminPath = false;

/** Cookie path matching (RFC 6265 section 5.1.4): the prefix itself or anything below it, never a lookalike such as `/forms-administrator`. */
function isUnderAdminPath(pathname: string): boolean {
  return pathname === ADMIN_PATH_PREFIX || pathname.startsWith(ADMIN_PATH_PREFIX + '/');
}

export interface IsAdminRequestOptions {
  /**
   * The SQLite path whose directory holds the auto-generated secret when
   * `FORMS_ADMIN_SECRET` is unset. Defaults to `CAF_DB_PATH`, which the
   * package middleware sets from your config on every request, then
   * `data/forms.db`.
   */
  dbPath?: string;
}

export function isAdminRequest(context: AdminRequestContext, opts: IsAdminRequestOptions = {}): boolean {
  try {
    const pathname = context.url?.pathname;
    if (pathname !== undefined && !isUnderAdminPath(pathname) && !warnedOutsideAdminPath) {
      warnedOutsideAdminPath = true;
      warn('admin.is-admin-request-outside-admin-path', {
        path: pathname,
        reason:
          'the admin session cookie is scoped to /forms-admin, so the browser never sends it here and isAdminRequest is always false; move this page or route under /forms-admin',
      });
    }
    const cookie = context.cookies.get(ADMIN_SESSION_COOKIE);
    if (!cookie || !cookie.value) return false;
    const dbPath = opts.dbPath ?? process.env.CAF_DB_PATH ?? 'data/forms.db';
    return verifySession(cookie.value, resolveAdminSecret(dbPath));
  } catch (err) {
    logError('admin.is-admin-request-failed', err);
    return false;
  }
}
