/**
 * DEV-ONLY debug endpoint (T-01-31 mitigation). Compile-time gated so the
 * whole handler body is dead-code-eliminated from production builds — the
 * `import.meta.env.DEV` check is a Vite `define`-time constant, `false` in
 * `astro build` output, so `smoke:built` (which runs the BUILT artifact)
 * proves this 404s in production. NEVER shipped as part of the package —
 * this file only exists in the playground app.
 *
 * Named WITHOUT a leading underscore deliberately: Astro's file-based router
 * silently EXCLUDES any `pages/` path segment starting with `_` from routing
 * (confirmed in `astro/dist/core/routing/create-manifest.js` — `_`-prefixed
 * files are the documented convention for co-located non-route files). A
 * `_debug-entries.ts` would 404 unconditionally, dev or not — the opposite
 * of what's needed here.
 *
 * `getDb()`/`getDb`-backed storage is called with NO dbPath argument: the
 * coolForms() middleware (Plan 08, `order:'pre'`) already ran for this same
 * request and set `process.env.CAF_DB_PATH` from the resolved config, so
 * `getDb()`'s own `resolveDbPath()` fallback picks it up — same pattern
 * `recordSubmission` (Plan 07) relies on.
 *
 * Playwright specs call `?action=reset` in `beforeEach` to fully isolate
 * runs: clears the entries/payments/files tables AND the package's
 * per-process test hooks (rate limiter buckets, notify health).
 */
import type { APIRoute } from 'astro';
import { getDb, SqliteStorage } from 'cool-astro-forms/server';
import { resetDefaultRateLimiter, resetLoginRateLimiter, resetNotifyHealth } from 'cool-astro-forms/server/test-hooks.js';

export const prerender = false;

function isLocalhost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

export const GET: APIRoute = async ({ url }) => {
  if (!import.meta.env.DEV) return new Response(null, { status: 404 });
  if (!isLocalhost(url.hostname)) return new Response(null, { status: 404 });

  const db = getDb();

  if (url.searchParams.get('action') === 'reset') {
    // form_starts (ANLY-01 D1) cleared alongside entries/payments/files —
    // without this, tests/analytics.spec.ts's funnel/abandonment-rate
    // assertions would accumulate started counts across repeated local
    // e2e runs (the shared on-disk forms.db persists between runs; a fresh
    // browser context mints a new visitor per run, so INSERT OR IGNORE
    // never dedupes across runs on its own).
    db.exec('DELETE FROM entries; DELETE FROM payments; DELETE FROM files; DELETE FROM form_starts;');
    resetDefaultRateLimiter();
    resetLoginRateLimiter();
    resetNotifyHealth();
    return new Response(JSON.stringify({ reset: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const storage = new SqliteStorage(db);
  const entries = await storage.listEntries({});
  // formStarts (ANLY-01 D1) — a cheap way for tests/analytics.spec.ts to
  // poll for the form_started ping landing without depending on a
  // page-reload/re-render timing race against the admin panel itself.
  const funnel = await storage.getFunnel({});
  return new Response(JSON.stringify({ entries, formStarts: funnel.started }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
