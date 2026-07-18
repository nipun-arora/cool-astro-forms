/**
 * The RCV-01/D3 lazy lead-recovery sweep. Module-gated exactly like
 * handle-abandon.ts's `maybePurgeExpired` (a module-level `lastRecoverySweepAt`
 * checked/updated on real request traffic) — deliberately NOT `setTimeout`,
 * because Passenger recycles idle workers and a timer-based schedule would
 * be silently dropped mid-flight (RESEARCH.md Anti-Patterns). Every eligible
 * row is atomically claimed via `storage.markRecoverySent` (04-01's
 * BEGIN-IMMEDIATE double-send gate) BEFORE a send is attempted, so a
 * concurrent sweep call — or a process recycle between the claim and the
 * send — can never result in the same visitor receiving two follow-ups.
 *
 * D4a (04-CONTEXT.md): `recovery_suppressions` rows are EXCLUDED from
 * `purgeVisitor`'s GDPR-erasure cascade and therefore survive erasure
 * forever — the client-side visitor UUID persists through an erasure too,
 * so deleting the suppression marker would silently re-enable contact with
 * a visitor who explicitly opted out. This sweep relies on that guarantee:
 * `findRecoverableEntries` already excludes suppressed visitors at the
 * storage layer (04-01), so nothing here re-checks suppression directly.
 *
 * Per-form recovery override (04-10 gap closure — RCV-01/ROADMAP Phase 4
 * SC4 "per-form flag", T-04-39/T-04-40/T-04-41): `runRecoverySweep` filters
 * every eligible row against `recoveryDisabledFormIds(config)` BEFORE
 * `resolveVisitorEmail` and BEFORE the `markRecoverySent` claim — mirroring
 * the existing no-resolvable-email skip ordering — so a form the host has
 * turned off is never claimed (a claim would falsely set
 * `recovery_sent_at`, permanently silencing a lead the host may
 * re-enable later). Bounded-starvation rationale (accepted, NO
 * schema/migration change per the gap-closure constraint): once
 * handle-abandon.ts honors the same per-form resolution, a recovery-off
 * form's NEW leads never gain `consent_at` in the first place — the only
 * rows this filter can ever skip are LEGACY rows whose consent predates
 * the host flipping the form off. That legacy set is bounded and drains
 * via `purgeExpired` (90-day retention on abandoned rows), so any
 * `BATCH_LIMIT` head-of-line pressure from unclaimed filtered rows is
 * transient and self-healing, not a permanent denial of service.
 *
 * Clean-room: written fresh against the Plan 01/04 contracts (no commercial WordPress form plugins
 * precedent — RESEARCH.md established recovery has none).
 */
import { z } from 'zod';
import type { CoolFormsConfig } from '../../config.js';
import type { Entry } from '../../types.js';
import { logError } from '../log.js';
import { sendRecoveryEmail, type RecoveryEmailData } from '../notify.js';
import type { StorageAdapter } from '../storage/adapter.js';
import { BATCH_LIMIT, RECOVERY_SWEEP_INTERVAL_MS } from '../drive-recovery-constants.js';
import { recoveryDisabledFormIds } from './resolve.js';
import { resolveRecoverySecret, signUnsubscribeToken } from './unsubscribe-token.js';

/** `trailingSlash` rides on the virtual config module (checker B1 cast precedent — middleware.ts/admin/*.astro/routes/abandon.ts). */
export type ConfigWithTrailingSlash = CoolFormsConfig & { trailingSlash?: 'always' | 'never' | 'ignore' };

export interface RecoverySweepDeps {
  storage: StorageAdapter;
  config: ConfigWithTrailingSlash;
  now?: () => number;
  /** Defaults to notify.ts's sendRecoveryEmail — injectable for tests (network-free). */
  send?: (data: RecoveryEmailData) => Promise<unknown>;
  /** Defaults to unsubscribe-token.ts's resolveRecoverySecret — injectable for tests. */
  resolveSecret?: (dbPath: string) => string;
}

/** Module-level (per-process) gate: the sweep fires at most once per RECOVERY_SWEEP_INTERVAL_MS. */
let lastRecoverySweepAt = 0;

/** Test-only reset hook for the module-level lazy-sweep gate. */
export function resetRecoverySweepGate(): void {
  lastRecoverySweepAt = 0;
}

const EMAIL_KEY_PATTERN = /email/i;

/**
 * Resolves the visitor's email out of an entry's captured fields — the same
 * `/email/i` key heuristic + `z.email()` validity check as
 * handle-abandon.ts's `hasValidEmailOrPhone` (that helper is private, so
 * this is a small dedicated re-implementation, not an import of a private
 * fn). Returns the first matching valid address, or `undefined` when none
 * is found — never throws.
 */
function resolveVisitorEmail(fields: Record<string, unknown>): string | undefined {
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (EMAIL_KEY_PATTERN.test(key) && z.email().safeParse(trimmed).success) return trimmed;
  }
  return undefined;
}

/**
 * Builds the client-visible unsubscribe endpoint (mirrors integration.ts's
 * `computeAbandonEndpoint` trailingSlash-aware reasoning — checker B1 /
 * LESSONS #3 third-strike class): a hardcoded slashless path 404s on a host
 * with `trailingSlash: 'always'`. The route itself is created
 * in 04-06 at `/api/forms/recovery-unsubscribe`.
 */
function computeRecoveryUnsubscribeEndpoint(siteUrl: string, trailingSlash: ConfigWithTrailingSlash['trailingSlash']): string {
  return `${siteUrl}/api/forms/recovery-unsubscribe${trailingSlash === 'always' ? '/' : ''}`;
}

/**
 * Runs one sweep pass: fetches up to `BATCH_LIMIT` eligible rows (the
 * `findRecoverableEntries` WHERE clause already excludes non-consenting,
 * already-sent, converted, and suppressed visitors — 04-01), resolves each
 * row's visitor email, atomically claims the row, and sends the follow-up.
 *
 * Ordering matters: a row with no resolvable email is skipped WITHOUT
 * attempting the claim (so a defensive/unexpected data shape never burns
 * the atomic claim on a send that can't happen); a row that loses the
 * atomic claim (a concurrent sweep already claimed it) is never emailed.
 * Never throws into its caller — a storage/send failure on one row is
 * logged via `logError` and the loop continues to the next row.
 */
export async function runRecoverySweep(deps: RecoverySweepDeps): Promise<void> {
  const { storage, config } = deps;
  if (!config.recovery.enabled) return;

  const now = deps.now ? deps.now() : Date.now();
  const send = deps.send ?? sendRecoveryEmail;
  const resolveSecret = deps.resolveSecret ?? resolveRecoverySecret;
  // 04-10: built once per pass — the set of form ids a per-form override has
  // turned off. Consulted BEFORE resolveVisitorEmail/markRecoverySent below.
  const disabledFormIds = new Set(recoveryDisabledFormIds(config));

  let entries: Entry[];
  try {
    entries = await storage.findRecoverableEntries(config.recovery.delayMins, now, BATCH_LIMIT);
  } catch (err) {
    logError('recovery.sweep-query-failed', err);
    return;
  }
  if (entries.length === 0) return;

  const secret = resolveSecret(config.dbPath);
  const unsubscribeEndpoint = computeRecoveryUnsubscribeEndpoint(config.siteUrl, config.trailingSlash);

  for (const entry of entries) {
    // 04-10: a recovery-off form is skipped WITHOUT attempting the claim —
    // same ordering/rationale as the no-resolvable-email skip below (T-04-40).
    if (disabledFormIds.has(entry.formId)) continue;

    const email = resolveVisitorEmail(entry.fields);
    if (!email) continue;

    let claimed: boolean;
    try {
      claimed = await storage.markRecoverySent(entry.id, now);
    } catch (err) {
      logError('recovery.claim-failed', err, { entryId: entry.id });
      continue;
    }
    if (!claimed) continue;

    const token = signUnsubscribeToken(entry.visitorUuid, secret);
    const unsubscribeUrl = `${unsubscribeEndpoint}?token=${token}`;
    const resumeUrl = entry.pageUrl ?? config.siteUrl;

    await send({
      to: email,
      siteId: entry.siteId,
      formId: entry.formId,
      resumeUrl,
      unsubscribeUrl,
    }).catch((err: unknown) => {
      logError('recovery.send-failed', err, { entryId: entry.id, siteId: entry.siteId, formId: entry.formId });
    });
  }
}

/**
 * Lazy, fire-and-forget entry point (invoked from middleware, 04-06). Total
 * no-op — never queries — when `config.recovery.enabled` is false.
 * Otherwise gated to at most once per `RECOVERY_SWEEP_INTERVAL_MS` per
 * process (the gate is set BEFORE the sweep runs, mirroring
 * handle-abandon.ts's `maybePurgeExpired`, so a slow sweep can never cause a
 * pile-up of concurrent sweeps from back-to-back requests). Never throws —
 * `runRecoverySweep`'s own promise is caught here.
 */
export function maybeRunRecoverySweep(deps: RecoverySweepDeps): void {
  if (!deps.config.recovery.enabled) return;

  const now = deps.now ? deps.now() : Date.now();
  if (now - lastRecoverySweepAt < RECOVERY_SWEEP_INTERVAL_MS) return;
  lastRecoverySweepAt = now;

  runRecoverySweep(deps).catch((err: unknown) => {
    logError('recovery.sweep-failed', err);
  });
}
