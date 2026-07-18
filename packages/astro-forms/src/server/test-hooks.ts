/**
 * DEV/TEST-ONLY package surface (Plan 09). Re-exports the reset hooks the
 * playground's `_debug-entries` endpoint needs to fully isolate Playwright
 * specs between runs (rate limiter bucket state + per-process notify
 * health). NOT part of the production integration/`recordSubmission` API —
 * a real host site never imports this module. Kept as its own narrow export
 * rather than widening `notify.js`/`rate-limit.js`'s full API surface
 * (createRateLimiter/buildTransport/sendAbandonedLeadEmail etc.) to
 * external consumers.
 */
export { resetDefaultRateLimiter } from './security/rate-limit.js';
export { resetNotifyHealth } from './notify.js';
/**
 * Admin login's dedicated rate-limit bucket (P05/ADMN-02 e2e) — a separate
 * bucket from the abandon route's defaultRateLimiter (T-02-10). Needed here
 * so tests/admin-views.spec.ts's `resetState()` beforeEach can clear it
 * between tests; several admin e2e scenarios log in more than once per
 * spec file run and would otherwise risk tripping the bucket's capacity
 * (5, refilling over ~15 min) across the whole suite.
 */
export { resetLoginRateLimiter } from './routes/admin/auth.js';

/**
 * Lead-recovery sweep + token seams (Plan 09 e2e — RCV-01/D3/D4). The real
 * production sweep is a lazy, per-process-gated, `Date.now()`-driven
 * side-effect (`maybeRunRecoverySweep`, fired from middleware on every
 * request, throttled to once per `RECOVERY_SWEEP_INTERVAL_MS`) — there is no
 * way to make it fire deterministically inside a fast Playwright run without
 * either a real 60-minute wait or reaching the UNGATED orchestrator directly.
 * `runRecoverySweep` already accepts an injected `now`/`send`, so the
 * playground's DEV-only `/api/debug-recovery` endpoint calls it directly
 * (bypassing the module-level throttle entirely — it never touches
 * `maybeRunRecoverySweep`'s gate) with `now` advanced past `delayMins` and a
 * `send` wrapper that captures the dispatched `{to, unsubscribeUrl,
 * resumeUrl}` for the spec to assert on, while ALSO forwarding to the real
 * `sendRecoveryEmail` (jsonTransport in dev — no live SMTP) so the actual
 * production send path is exercised end-to-end, not stubbed out.
 * `signUnsubscribeToken`/`resolveRecoverySecret` let the SAME debug endpoint
 * mint a validly-signed unsubscribe link for a visitor WITHOUT running a
 * sweep first (so a suppression test can isolate "the visitor opted out"
 * from "the row was already claimed" — two different `findRecoverableEntries`
 * exclusions, D4a). Not part of the production integration/recordSubmission
 * API — a real host site never imports any of these.
 */
export { runRecoverySweep, resetRecoverySweepGate } from './recovery/sweep.js';
export type { RecoverySweepDeps } from './recovery/sweep.js';
export { sendRecoveryEmail } from './notify.js';
export type { RecoveryEmailData } from './notify.js';
export { signUnsubscribeToken, resolveRecoverySecret } from './recovery/unsubscribe-token.js';
