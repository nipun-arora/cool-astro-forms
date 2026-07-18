/**
 * Injected middleware (`order: 'pre'`, Plan 08) — runs before every request
 * on a host site.
 *
 * Jobs, all driven by `registerRuntimeConfig(config)`:
 *  1. Sets the process-wide default dbPath for `getDb()` — `recordSubmission`
 *     (called from the host's OWN submit endpoint, Plan 07) cannot see the
 *     virtual config module, so it calls `getDb()` with no argument and
 *     relies on the `CAF_DB_PATH` env fallback `db.ts` already reads. This
 *     middleware is what keeps that fallback in sync with `config.dbPath`.
 *     Also bridges `CAF_STORAGE_KIND` from `cfg.storage.kind` (05-04,
 *     ADPT-01) — the exact same reason, for the same caller:
 *     `recordSubmission` calls `getStorageAdapter()` with no config and
 *     relies on this env var to select the SAME backend the routes use, so
 *     submissions never silently split from abandons/admin onto a
 *     different storage kind.
 *  2. Sets the `CAF_GEO_*` env contract (Phase 2) from `cfg.geo` — the same
 *     mechanism, for the same reason: P02's non-injected `recordSubmission`
 *     geo default cannot see the virtual config module either.
 *  3. Registers the site's outbound webhook targets (`cfg.webhooks`,
 *     HOOK-01) with the webhooks/deliver.ts module singleton — same
 *     precedent again: `recordSubmission` cannot see the virtual config
 *     module, so this is how it (and handle-abandon.ts) obtain targets to
 *     deliver to.
 *  4. Sets the `CAF_DRIVE_*` env contract (Phase 4/DRV-01) from `cfg.drive`
 *     — the exact CAF_GEO_* precedent again: the externalized
 *     `recordSubmission`'s `defaultDriveConfig()` cannot see the virtual
 *     config module either, so this bridge is how it learns `linkAccess`/
 *     `rootFolderName`/`attachmentFallbackMaxBytes`.
 *  5. Fires the boot-time `purgeExpired(retentionDays)` retention sweep
 *     exactly once per process (item 11) — never awaited, logged on failure.
 *  6. Fires the lazy lead-recovery sweep (`maybeRunRecoverySweep`,
 *     Phase 4/RCV-01) on every request — fire-and-forget, self-gated once
 *     per `RECOVERY_SWEEP_INTERVAL_MS` per process, and a total no-op when
 *     `cfg.recovery.enabled` is false. Piggybacking on real request traffic
 *     (rather than `setTimeout`) is deliberate: Passenger recycles idle
 *     workers, silently dropping any timer-based schedule mid-flight.
 *  7. Runs `assertExplicitSecrets(cfg)` (D2 fix #2, 05-01/ADPT-01) — a
 *     no-op unless `CAF_REQUIRE_EXPLICIT_SECRETS` is truthy, in which case
 *     it THROWS on request #1 if a required secret is absent instead of
 *     letting the admin-secret/unsubscribe-token resolvers silently
 *     auto-generate a disk-persisted secret that regenerates every
 *     serverless cold start (05-RESEARCH.md Pitfall 2). Deliberately
 *     uncaught here (Rule 12 fail loud) — unlike the admin-guard try/catch
 *     below, a misconfigured explicit-secrets deploy should surface as a
 *     hard 500, not degrade to a login redirect.
 *
 * Also guards every `/forms-admin/*` request (ADMN-01, T-02-10..T-02-15b)
 * except the login page and the auth POST, which must stay reachable
 * unauthenticated: verifies the signed session cookie, redirects to the
 * login page (adminUrl-built, trailingSlash-correct) on a missing/invalid
 * session, and tags authenticated admin responses `X-Robots-Tag: noindex`
 * (T-02-15). Non-admin traffic is completely unaffected.
 */
import type { MiddlewareHandler } from 'astro';
import config from 'virtual:cool-astro-forms/config';
import type { CoolFormsConfig } from '../config.js';
import { adminUrl } from './admin/_shared.js';
import { logError } from './log.js';
import { maybeRunRecoverySweep } from './recovery/sweep.js';
import { resolveAdminSecret } from './security/admin-secret.js';
import { verifySession } from './security/admin-session.js';
import { assertExplicitSecrets } from './security/secrets-preflight.js';
import { getStorageAdapter } from './storage/index.js';
import { registerWebhookTargets } from './webhooks/deliver.js';

let bootPurgeRan = false;

/**
 * Idempotent: safe to call on every request. Re-asserts `CAF_DB_PATH` and
 * the `CAF_GEO_*` env vars each time (cheap, always reflects the resolved
 * config) but only ever fires the boot purge once per process.
 */
export function registerRuntimeConfig(cfg: CoolFormsConfig): void {
  process.env.CAF_DB_PATH = cfg.dbPath;
  process.env.CAF_STORAGE_KIND = cfg.storage.kind;
  process.env.CAF_GEO_ENABLED = String(cfg.geo.enabled);
  process.env.CAF_GEO_PROVIDER = cfg.geo.providerUrl;
  process.env.CAF_GEO_TIMEOUT_MS = String(cfg.geo.timeoutMs);
  process.env.CAF_DRIVE_LINK_ACCESS = cfg.drive.linkAccess;
  process.env.CAF_DRIVE_ROOT_FOLDER = cfg.drive.rootFolderName;
  process.env.CAF_DRIVE_FALLBACK_MAX_BYTES = String(cfg.drive.attachmentFallbackMaxBytes);
  registerWebhookTargets(cfg.webhooks ?? []);

  if (bootPurgeRan) return;
  bootPurgeRan = true;

  // getStorageAdapter is async (it may dynamic-import the turso backend) —
  // registerRuntimeConfig itself STAYS synchronous (item 5 above fires
  // fire-and-forget), so the acquisition + purge run as a promise chain
  // rather than an awaited call here.
  getStorageAdapter(cfg)
    .then((storage) => storage.purgeExpired(cfg.retentionDays))
    .catch((err: unknown) => {
      logError('storage.purge-failed', err);
    });
}

/** Test-only reset for the boot-purge gate. */
export function resetRuntimeConfigRegistration(): void {
  bootPurgeRan = false;
}

// Must match routes/admin/auth.ts's ADMIN_SESSION_COOKIE — the single admin
// session cookie name both the issuer (auth.ts) and this guard read.
const ADMIN_SESSION_COOKIE = '_caf_admin_session';

const ADMIN_PREFIX = '/forms-admin';

type ConfigWithTrailingSlash = CoolFormsConfig & { trailingSlash?: 'always' | 'never' | 'ignore' };

/** True for `/forms-admin` itself or any `/forms-admin/...` path — never a same-prefix unrelated route. */
function isAdminPath(pathname: string): boolean {
  return pathname === ADMIN_PREFIX || pathname.startsWith(`${ADMIN_PREFIX}/`);
}

/** Strips exactly one trailing slash so ± trailing-slash forms compare equal. */
function stripTrailingSlash(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

/** True for the login page or the auth POST — the two unauthenticated-allowed entry points. */
function isExemptAdminPath(pathname: string, trailingSlash: ConfigWithTrailingSlash['trailingSlash']): boolean {
  const normalized = stripTrailingSlash(pathname);
  const loginPath = stripTrailingSlash(adminUrl('/forms-admin/login', trailingSlash));
  const authPath = stripTrailingSlash(adminUrl('/forms-admin/auth', trailingSlash));
  return normalized === loginPath || normalized === authPath;
}

export const onRequest: MiddlewareHandler = async (context, next) => {
  const cfg = config as ConfigWithTrailingSlash;
  registerRuntimeConfig(cfg);

  // D2 fix #2 (05-01/ADPT-01): fails LOUD on request #1 of a misconfigured
  // explicit-secrets deploy — deliberately NOT wrapped in try/catch, see
  // item 7 in the file docstring above.
  assertExplicitSecrets(cfg);

  // RCV-01 lazy sweep piggyback: fired on EVERY request (not just non-admin
  // traffic) so recovery keeps making progress even on an admin-heavy site.
  // Fire-and-forget + self-gated + inert when recovery is off (sweep.ts) —
  // never awaited, never affects the guard/next() flow below. A `.catch`
  // guards the (new, 05-04) async storage acquisition itself — the
  // sync-construct predecessor could only ever fail by throwing straight
  // out of onRequest; this fire-and-forget chain must log instead of
  // producing an unhandled rejection.
  void getStorageAdapter(cfg)
    .then((storage) => maybeRunRecoverySweep({ storage, config: cfg }))
    .catch((err: unknown) => {
      logError('storage.recovery-sweep-acquire-failed', err);
    });

  const pathname = context.url.pathname;
  if (!isAdminPath(pathname) || isExemptAdminPath(pathname, cfg.trailingSlash)) {
    return next();
  }

  // Guard: never let a secret-resolution/verification error crash the
  // request — an error here fails CLOSED (redirect to login), not open.
  let sessionValid = false;
  try {
    const cookie = context.cookies.get(ADMIN_SESSION_COOKIE);
    if (cookie) {
      const secret = resolveAdminSecret(cfg.dbPath);
      sessionValid = verifySession(cookie.value, secret);
    }
  } catch (err) {
    logError('admin.guard-failed', err);
    sessionValid = false;
  }

  if (!sessionValid) {
    return context.redirect(adminUrl('/forms-admin/login', cfg.trailingSlash));
  }

  const res = await next();
  res.headers.set('X-Robots-Tag', 'noindex');
  return res;
};
