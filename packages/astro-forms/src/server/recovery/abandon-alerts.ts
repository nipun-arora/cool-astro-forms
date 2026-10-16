/**
 * Deferred abandoned-lead alert (0.1.18).
 *
 * The capture sends its abandon beacon on `visibilitychange` to hidden, exit
 * intent, a leaving-link click (tel:/mailto:/WhatsApp included) and
 * `beforeunload`, as soon as an email or phone is typed. Up to 0.1.17 the
 * abandon route emailed the owner's "Abandoned" alert and fired
 * `entry.abandoned` on that first save, so a visitor who switched tabs
 * mid-form and then submitted produced a false alert followed by the real
 * submission (seen live on all three revenue sites). Now the save stores a
 * due time (`abandonment.alertDelayMins` after the first abandon, default
 * 15) and this sweep sends the alert and the webhook once it has passed,
 * unless a submission promoted the draft first (convertAndCreateSubmitted
 * clears the due time). The draft row itself is saved, and listed in
 * /forms-admin/abandoned, immediately either way.
 *
 * Scheduling: the same request-driven piggyback as the recovery sweep
 * (middleware.ts calls `maybeRunAbandonAlertSweep` on every request, at most
 * once per ABANDON_ALERT_SWEEP_INTERVAL_MS per process), never `setTimeout`
 * (Passenger recycles idle workers and drops timers), and NOT gated on
 * `recovery.enabled`: the live sites run with recovery off. The resulting
 * guarantee is "at or after the delay, never before": the claim itself
 * refuses a row that is not yet due, and on a quiet site the alert goes out
 * with the first request the server handles after the due time (any page or
 * endpoint the middleware runs on, the next abandon or form-start ping
 * included), which can be later. On serverless the sweep runs fire-and-
 * forget inside whichever invocation trips the gate, like the recovery sweep.
 *
 * Exactly once: every row is claimed with `storage.claimAbandonAlert` (one
 * conditional UPDATE) BEFORE anything is sent, so overlapping sweeps, in one
 * process or across instances, send it once. The cost is the recovery
 * sweep's: a crash between the claim and the send loses that one alert
 * rather than risking a second one.
 *
 * Clean-room: written fresh against this package's own sweep/notify/webhook
 * contracts, not derived from any commercial form-plugin source.
 */
import type { CoolFormsConfig } from '../../config.js';
import type { WebhookEventType } from '../../types.js';
import { BATCH_LIMIT } from '../drive-recovery-constants.js';
import { log, logError } from '../log.js';
import { sendAbandonedLeadEmail, type AbandonedLeadEmailData, type NotifyTemplateFn } from '../notify.js';
import type { DueAbandonAlert, StorageAdapter } from '../storage/adapter.js';
import { deliverWebhook as deliverWebhookImpl } from '../webhooks/deliver.js';

/** Default `abandonment.alertDelayMins`: long enough to outlast a tab or app switch, short enough to still be a timely lead alert. */
export const DEFAULT_ABANDON_ALERT_DELAY_MINS = 15;

/** Per-process gate for the request-driven sweep: the query is one indexed lookup, so a minute keeps the added latency small. */
export const ABANDON_ALERT_SWEEP_INTERVAL_MS = 60 * 1000;

/**
 * One pass claims batches of BATCH_LIMIT until nothing more is due, up to
 * this many batches (200 alerts) or ABANDON_ALERT_PASS_BUDGET_MS, whichever
 * comes first (0.1.18 audit). At one batch per minute a backlog of a few
 * thousand drafts (a bot's, typically: the storage lists Turnstile-flagged
 * drafts last, so they only ever delay each other) took hours to drain and
 * held genuine alerts and webhooks back behind it.
 */
export const ABANDON_ALERT_MAX_BATCHES_PER_PASS = 8;

/** No further batch starts once a pass has run this long, so slow SMTP sends cannot stretch one pass towards the next. */
export const ABANDON_ALERT_PASS_BUDGET_MS = 5 * 1000;

/** The Turnstile soft-fail flag handle-abandon.ts writes into the stored fields; the pre-0.1.18 email and webhook never carried it. DUE_ABANDON_ALERTS_SQL (storage/adapter.ts) lists drafts carrying it last. */
const BOT_FLAG_FIELD = '_turnstile';

/** `templates` rides on the virtual config module (routes/abandon.ts reads the same seam). */
type ConfigWithTemplates = CoolFormsConfig & { templates?: { abandonedLead?: NotifyTemplateFn } };

export interface AbandonAlertSweepDeps {
  storage: StorageAdapter;
  config: CoolFormsConfig;
  now?: () => number;
  /** Defaults to notify.ts's sendAbandonedLeadEmail with the host's `templates.abandonedLead` override. */
  notify?: (data: AbandonedLeadEmailData) => Promise<unknown>;
  /** Defaults to webhooks/deliver.ts's deliverWebhook (targets registered by middleware.ts). */
  deliverWebhook?: (type: WebhookEventType, data: unknown) => void;
}

/** The alert delay for one form, in minutes: its `abandonment.alertDelayMins`, else the default. */
export function abandonAlertDelayMins(config: CoolFormsConfig, formId: string): number {
  return config.forms[formId]?.abandonment.alertDelayMins ?? DEFAULT_ABANDON_ALERT_DELAY_MINS;
}

/** Whether `storage` can hold a deferred alert. A custom adapter without both methods gets the immediate alert, so none is ever lost. */
export function canDeferAbandonAlerts(storage: StorageAdapter): boolean {
  return typeof storage.findDueAbandonAlerts === 'function' && typeof storage.claimAbandonAlert === 'function';
}

function withoutBotFlag(fields: Record<string, unknown>): Record<string, unknown> {
  if (!(BOT_FLAG_FIELD in fields)) return fields;
  const copy = { ...fields };
  delete copy[BOT_FLAG_FIELD];
  return copy;
}

/** Module-level (per-process) gate, set before the sweep runs so back-to-back requests never stack sweeps. */
let lastAbandonAlertSweepAt = 0;

/** Test-only reset hook for the module-level gate. */
export function resetAbandonAlertSweepGate(): void {
  lastAbandonAlertSweepAt = 0;
}

/**
 * One pass: lists up to BATCH_LIMIT due alerts, claims each, then fires the
 * `entry.abandoned` webhook (first alert only: it was creation-only before
 * 0.1.18 and stays so) and emails the owner the draft as stored now, then
 * lists the next batch, until one comes back short (nothing more is due),
 * claims nothing (another sweep holds the rows, or claims are failing), or
 * the pass reaches ABANDON_ALERT_MAX_BATCHES_PER_PASS batches or
 * ABANDON_ALERT_PASS_BUDGET_MS. Every batch is listed and claimed against
 * the time the pass started. Never throws: a failure on one row is logged
 * and the next row still goes out, and a failed query ends the pass.
 */
export async function runAbandonAlertSweep(deps: AbandonAlertSweepDeps): Promise<void> {
  const { storage, config } = deps;
  if (!storage.findDueAbandonAlerts || !storage.claimAbandonAlert) return;

  const clock = deps.now ?? Date.now;
  const now = clock();
  const template = (config as ConfigWithTemplates).templates?.abandonedLead;
  const notify = deps.notify ?? ((data: AbandonedLeadEmailData) => sendAbandonedLeadEmail(data, { template }));
  const deliverWebhook = deps.deliverWebhook ?? deliverWebhookImpl;

  for (let batch = 0; batch < ABANDON_ALERT_MAX_BATCHES_PER_PASS; batch++) {
    if (batch > 0 && clock() - now >= ABANDON_ALERT_PASS_BUDGET_MS) return;

    let due: DueAbandonAlert[];
    try {
      due = await storage.findDueAbandonAlerts(now, BATCH_LIMIT);
    } catch (err) {
      logError('abandon-alert.sweep-query-failed', err);
      return;
    }

    let claimedAny = false;
    for (const { entry, alertedBefore } of due) {
      const logCtx = { entryId: entry.id, siteId: entry.siteId, formId: entry.formId };

      let claimed: boolean;
      try {
        claimed = await storage.claimAbandonAlert(entry.id, now);
      } catch (err) {
        logError('abandon-alert.claim-failed', err, logCtx);
        continue;
      }
      if (!claimed) continue;
      claimedAny = true;

      // Claimed even so: an unclaimed row would be listed again on every pass.
      const formConfig = config.forms[entry.formId];
      if (!formConfig) {
        log('abandon-alert.unknown-form', logCtx);
        continue;
      }

      const fields = withoutBotFlag(entry.fields);
      if (!alertedBefore) {
        deliverWebhook('entry.abandoned', {
          id: entry.id,
          siteId: entry.siteId,
          formId: entry.formId,
          fields,
          geo: entry.geo,
          createdAt: entry.createdAt,
        });
      }

      await notify({
        siteId: entry.siteId,
        formId: entry.formId,
        notifyTo: formConfig.notifyTo,
        fields,
        journey: entry.journey,
        pageUrl: entry.pageUrl,
        referrer: entry.referrer,
        geo: entry.geo,
      }).catch((err: unknown) => {
        logError('notify.failed', err, logCtx);
      });
    }

    if (due.length < BATCH_LIMIT || !claimedAny) return;
  }
}

/**
 * Request-driven entry point (middleware.ts, every request). Runs regardless
 * of `recovery.enabled`; a no-op for a storage adapter without the alert
 * methods. Fire-and-forget and never throws.
 */
export function maybeRunAbandonAlertSweep(deps: AbandonAlertSweepDeps): void {
  if (!canDeferAbandonAlerts(deps.storage)) return;

  const now = deps.now ? deps.now() : Date.now();
  if (now - lastAbandonAlertSweepAt < ABANDON_ALERT_SWEEP_INTERVAL_MS) return;
  lastAbandonAlertSweepAt = now;

  runAbandonAlertSweep(deps).catch((err: unknown) => {
    logError('abandon-alert.sweep-failed', err);
  });
}
