/**
 * StorageAdapter — the contract every persistence backend implements.
 *
 * ALL methods are Promise-returning (async-first). The accepted Postgres/
 * Turso adapters (V2-03) cannot be synchronous; fixing this later would be a
 * breaking public-API rewrite. The reference SqliteStorage implementation
 * (Plan 02) simply wraps its synchronous better-sqlite3 calls in Promises.
 */
import type {
  AnalyticsFilter,
  DropOffRow,
  Entry,
  EntryFilter,
  FileRecord,
  FunnelCounts,
  Payment,
  PaymentEvent,
  PaymentFilter,
} from '../../types.js';

export type UpsertAbandonedResult = {
  outcome: 'created' | 'updated' | 'already-converted';
  entry?: Entry;
};

/**
 * Deferred abandoned-lead alert schedule (0.1.18), passed to
 * `upsertAbandoned` when the handler defers the owner's alert and the
 * `entry.abandoned` webhook instead of sending them on the save.
 */
export interface AbandonAlertSchedule {
  /** When the alert becomes due (epoch ms). Written when the draft is created; a later dedupe update never moves it. */
  dueAt: number;
  /**
   * `notifyOnUpdate`: a dedupe update schedules one more alert at `dueAt`,
   * but only when none is pending, so a pending alert is never duplicated or
   * pushed back (it reads the latest draft when it goes out).
   */
  rearmOnUpdate?: boolean;
}

/** A draft's alert columns: `abandon_notify_due_at` (pending when set) and `abandon_notified_at` (last alert sent). */
export interface AbandonAlertState {
  dueAt: number | null;
  notifiedAt: number | null;
}

/**
 * The alert columns a dedupe update writes (0.1.18), shared by both built-in
 * adapters. The due time stays fixed at the first abandon. A notifyOnUpdate
 * re-arm schedules one only when none is pending; a draft with no due time
 * has already been alerted (claimed by a sweep, or alerted on the save
 * itself: delay 0 or a pre-0.1.18 row), so the re-arm also records that,
 * falling back to the creation time, and the sweep then sends the email
 * without a second entry.abandoned.
 */
export function alertAfterDedupeUpdate(
  row: AbandonAlertState & { createdAt: number },
  alert: AbandonAlertSchedule | undefined,
): AbandonAlertState {
  if (alert?.rearmOnUpdate && row.dueAt === null) {
    return { dueAt: alert.dueAt, notifiedAt: row.notifiedAt ?? row.createdAt };
  }
  return { dueAt: row.dueAt, notifiedAt: row.notifiedAt };
}

/** The Turnstile soft-fail flag handle-abandon.ts writes into a created draft's fields (via updateEntry, never upsertAbandoned). */
const TURNSTILE_FLAG_FIELD = '_turnstile';

/**
 * The fields `upsertAbandoned` stores (0.1.18), shared by both built-in
 * adapters. Each beacon resends the whole form, so its fields replace the
 * draft's, but `_turnstile` is the server's verdict on the draft, not form
 * data: a dedupe update carries the stored row's flag over, and a beacon's
 * own `_turnstile` is dropped on either branch. Without the carry-over a
 * flagged bot's next beacon wiped the flag, the draft sorted with clean
 * ones in DUE_ABANDON_ALERTS_SQL again, and a bot backlog could again hold
 * genuine alerts back; without the drop a client could set, replace or
 * clear the flag itself. `storedFieldsJson` is the existing row's `fields`
 * column, already read inside the upsert's transaction, so the carry-over
 * costs no extra query; unreadable JSON carries nothing over.
 */
export function abandonedDraftFields(
  incoming: Record<string, unknown> | undefined,
  storedFieldsJson?: string,
): Record<string, unknown> {
  const fields = { ...incoming };
  delete fields[TURNSTILE_FLAG_FIELD];
  if (storedFieldsJson === undefined) return fields;
  let stored: Record<string, unknown> | null = null;
  try {
    stored = JSON.parse(storedFieldsJson) as Record<string, unknown> | null;
  } catch {
    // Nothing to carry over; the update replaces the unreadable fields.
  }
  const flag = stored?.[TURNSTILE_FLAG_FIELD];
  if (flag !== undefined) fields[TURNSTILE_FLAG_FIELD] = flag;
  return fields;
}

/**
 * `findDueAbandonAlerts`' query, shared by both built-in adapters (args: now,
 * limit). Two choices in it are load-bearing:
 *
 * - Turnstile-flagged drafts sort after every clean one. A bot can queue
 *   thousands of cheap drafts that fail the check (soft-fail: saved, flagged
 *   `fields._turnstile`, still alerted); listed oldest due first, a backlog
 *   bigger than the sweep's batch held every genuine alert queued behind it
 *   back for hours. The key is the flag's presence, the same test the sweep
 *   uses to strip it, and `json_valid` guards it because `json_extract`
 *   raises on malformed JSON: one corrupted row would fail the whole listing
 *   instead of reaching the row mapper, which cannot read it either, so the
 *   adapter retires it (see findDueAbandonAlerts).
 * - `+status` keeps the planner off the status-led indexes. Without it,
 *   SQLite and libSQL both pick idx_entries_recovery for
 *   `status = 'abandoned'` and read every draft kept for the retention
 *   window on every sweep, never the pending-alert partial index, which
 *   holds only the rows with an alert scheduled.
 */
export const DUE_ABANDON_ALERTS_SQL = `SELECT * FROM entries
  WHERE abandon_notify_due_at IS NOT NULL AND abandon_notify_due_at <= ? AND +status = 'abandoned'
  ORDER BY CASE WHEN json_valid(fields) THEN json_extract(fields, '$._turnstile') IS NOT NULL ELSE 0 END ASC,
    abandon_notify_due_at ASC, id ASC
  LIMIT ?`;

/** One alert `findDueAbandonAlerts` returns: the draft as stored now, plus whether an earlier alert for it already went out. */
export interface DueAbandonAlert {
  entry: Entry;
  /** True for a `notifyOnUpdate` re-alert. `entry.abandoned` fires on creation only, so the sweep sends only the email for these. */
  alertedBefore: boolean;
}

export interface StorageAdapter {
  /** Insert a new entry row. */
  createEntry(input: Omit<Entry, 'id' | 'createdAt' | 'updatedAt'>): Promise<Entry>;

  /** Patch an existing entry row by id. */
  updateEntry(id: string, patch: Partial<Entry>): Promise<Entry>;

  /** Find the most recent 'abandoned' row for this visitor+form within windowMins. site_id joins the dedupe key. */
  findAbandoned(
    siteId: string,
    visitorUuid: string,
    formId: string,
    windowMins: number,
  ): Promise<Entry | undefined>;

  /** List entries matching filter, honoring limit/offset. */
  listEntries(filter: EntryFilter): Promise<Entry[]>;

  /** Count entries matching filter (for pagination totals). */
  countEntries(filter: EntryFilter): Promise<number>;

  /**
   * Attach a payment record to an entry (Phase 3; table exists from Phase 1).
   * A payment that carries a `providerRef` is written only when no row has
   * that `providerRef` yet: one provider session, one row (0.1.15). The
   * built-in adapters make the check and the insert one statement, so two
   * overlapping writers cannot both insert; the second call writes nothing.
   * Payments without a `providerRef` are always inserted.
   */
  attachPayment(entryId: string, payment: Record<string, unknown>): Promise<void>;

  /** Attach file records to an entry (Phase 4; table exists from Phase 1). */
  attachFiles(entryId: string, files: Record<string, unknown>[]): Promise<void>;

  /** Export entries matching filter as CSV text. */
  exportCsv(filter: EntryFilter): Promise<string>;

  /**
   * Atomic dedupe: create a new 'abandoned' row, or update the existing one
   * keyed by site_id + visitor_uuid + form_id within windowMins (Plan 02).
   * `alert` (0.1.18) schedules the deferred abandoned-lead alert in the same
   * transaction: a created row stores `alert.dueAt`; an updated row keeps
   * its due time, unless `alert.rearmOnUpdate` and no alert is pending.
   */
  upsertAbandoned(
    input: Omit<Entry, 'id' | 'createdAt' | 'updatedAt' | 'status'>,
    windowMins: number,
    alert?: AbandonAlertSchedule,
  ): Promise<UpsertAbandonedResult>;

  /**
   * Atomic find→convert-ALL-matching→create-submitted (Plan 02/07).
   * Marks every matching abandoned row 'converted' and creates (or reuses)
   * the submitted entry, returning how many rows were converted. A
   * converted row's pending abandoned-lead alert is cancelled in the same
   * statement (0.1.18): the visitor submitted, so nobody abandoned.
   */
  convertAndCreateSubmitted(
    input: Omit<Entry, 'id' | 'createdAt' | 'updatedAt' | 'status'>,
    lookbackMs: number,
  ): Promise<{ converted: number; entry: Entry }>;

  /** Erasure hook (D5) — cascades payments/files for the visitor. Returns rows deleted. */
  purgeVisitor(visitorUuid: string): Promise<number>;

  /** Retention purge of expired abandoned rows older than retentionDays. Returns rows deleted. */
  purgeExpired(retentionDays: number): Promise<number>;

  /**
   * Idempotent once-per-(siteId,formId,visitorUuid) counter ping (ANLY-01
   * D1) — the funnel's "started" denominator. Repeat calls for the same
   * triple are silent no-ops (INSERT OR IGNORE against a unique index).
   */
  recordFormStart(siteId: string, formId: string, visitorUuid: string): Promise<void>;

  /** started (from form_starts) + abandoned/submitted/converted (from entries.status), scoped by filter. */
  getFunnel(filter: AnalyticsFilter): Promise<FunnelCounts>;

  /** Abandoned-row counts grouped by last_field, highest first. Rows with a null last_field are excluded. */
  getTopDropOff(filter: AnalyticsFilter): Promise<DropOffRow[]>;

  /** Admin entry-detail read (ADMN-02) — undefined when missing or corrupted. */
  getEntryById(id: string): Promise<Entry | undefined>;

  /**
   * HARD delete of one entry plus its payments/files rows (the admin
   * per-entry delete — purgeVisitor remains the visitor-wide GDPR erasure).
   * Returns whether a row was actually removed.
   */
  deleteEntry(id: string): Promise<boolean>;

  // -------------------------------------------------------------------------
  // Payments read/write surface (Phase 3, Plan 01). The payments table has
  // existed since migration v1 (attachPayment insert-only); these methods
  // give it a real read/write/idempotent-append surface.
  // -------------------------------------------------------------------------

  /** Inbound-webhook find key lookup (Stripe Checkout Session id / PayPal order id). */
  getPaymentByProviderRef(providerRef: string): Promise<Payment | undefined>;

  /** All payment rows attached to one entry (admin entry-detail view). */
  getPaymentsByEntry(entryId: string): Promise<Payment[]>;

  /** Patch an existing payment row by id (read-merge-write, bumps updated_at). */
  updatePayment(id: string, patch: Partial<Payment>): Promise<Payment>;

  /**
   * Atomic inbound-webhook idempotency primitive (checker W1): SELECT the
   * payment, check whether `eventId` is already in its `events[]`, and if
   * not, append the event AND apply the optional `patch` — all inside ONE
   * `db.transaction(...).immediate()` so a crash can never leave the event
   * recorded without its accompanying status change (or vice versa).
   * Returns true when the event was newly appended (patch applied), false
   * with ZERO writes when `eventId` was already present.
   *
   * 0.1.17: the paid patch also carries `customerRef` / `payerEmail` (the
   * Stripe Customer and payer email of the session, migration v6). They ride
   * this same transaction, so a replayed event can neither write them twice
   * nor overwrite the first delivery's values.
   */
  appendPaymentEventIfAbsent(
    paymentId: string,
    eventId: string,
    event: PaymentEvent,
    patch?: Partial<Payment>,
  ): Promise<boolean>;

  /** List payment rows matching filter, honoring limit/offset (admin Payments view). */
  listPayments(filter: PaymentFilter): Promise<Payment[]>;

  /** Count payment rows matching filter (pagination totals). */
  countPayments(filter: PaymentFilter): Promise<number>;

  // -------------------------------------------------------------------------
  // Drive files + lead recovery read/write surface (Phase 4, Plan 01). The
  // `files` table has existed since migration v1 (attachFiles insert-only);
  // migration v4 adds the recovery columns/table this surface reads/writes.
  // -------------------------------------------------------------------------

  /** All file rows attached to one entry (admin entry-detail Files section), oldest first. */
  getFilesByEntry(entryId: string): Promise<FileRecord[]>;

  /**
   * RCV-01 sweep query — every 'abandoned' entry with a recorded consent
   * basis, no recovery email sent yet, past its delay window, and not
   * suppressed. The WHERE clause is the only thing standing between a
   * converted/non-consenting/unsubscribed visitor and an unwanted email
   * (T-04-02) — contract-tested per exclusion.
   */
  findRecoverableEntries(delayMins: number, now: number, limit: number): Promise<Entry[]>;

  /** Records the consent basis timestamp (D3) — idempotent: only fills consent_at when it is currently NULL, so the FIRST basis wins. */
  markConsent(entryId: string, now: number): Promise<void>;

  /**
   * Atomic double-send gate (T-04-04): checks `recovery_sent_at IS NULL`
   * and sets it to `now` inside ONE `db.transaction(...).immediate()`
   * (BEGIN IMMEDIATE — the appendPaymentEventIfAbsent pattern). Returns
   * true when this call claimed the send (zero prior sends); false with
   * ZERO writes when a prior call already claimed it.
   */
  markRecoverySent(entryId: string, now: number): Promise<boolean>;

  /** Idempotent never-email-again marker (D4) — INSERT OR IGNORE keyed by visitor. The one-click unsubscribe route's target. */
  suppressRecovery(visitorUuid: string, now: number): Promise<void>;

  /** Whether a visitor has ever suppressed recovery email. Survives purgeVisitor (D4a). */
  isRecoverySuppressed(visitorUuid: string): Promise<boolean>;

  // -------------------------------------------------------------------------
  // Deferred abandoned-lead alert (0.1.18, migration v7). OPTIONAL so a
  // custom adapter written against 0.1.17 still type-checks: the abandon
  // handler defers only when BOTH methods exist (and then passes `alert` to
  // upsertAbandoned); otherwise it alerts on the save, as before. Both
  // built-in adapters implement them.
  // -------------------------------------------------------------------------

  /**
   * Abandoned rows whose alert is due (`dueAt <= now`), oldest due first,
   * at most `limit`. Converted, claimed and never-scheduled rows are never
   * returned. A listed row whose stored JSON cannot be read is retired
   * instead (its due time cleared, logged once by id) and the listing re-run,
   * so corrupted rows can neither hold the head of the queue for good nor
   * return a short batch that ends a sweep's drain early.
   */
  findDueAbandonAlerts?(now: number, limit: number): Promise<DueAbandonAlert[]>;

  /**
   * Atomic exactly-once claim, made before the send: ONE conditional UPDATE
   * that clears the due time and stamps `abandon_notified_at = now`, matching
   * only a row that is still 'abandoned' with an alert due at or before
   * `now`. True when this call claimed it; false with zero writes when
   * another sweep or instance already did, a submission converted the draft,
   * or it is not due yet.
   */
  claimAbandonAlert?(entryId: string, now: number): Promise<boolean>;

  // -------------------------------------------------------------------------
  // Rate limiting persistent surface (Phase 5, Plan 02, D2 fix #1, ADPT-01).
  // Additive interface addition backing the OPT-IN `StorageBackedRateLimiter`
  // (rate-limit-store.ts) — an adapter-backed token bucket that survives
  // serverless cold starts, unlike the in-process `defaultRateLimiter`
  // (rate-limit.ts) which stays the DEFAULT for long-lived hosts.
  // -------------------------------------------------------------------------

  /**
   * Atomic token-bucket claim (T-05-06): reads (or seeds at full `capacity`)
   * the bucket keyed by `bucketKey`, refills by `elapsed * refillPerSec`
   * clamped to `capacity`, and if the result is >= 1 decrements and returns
   * true; otherwise returns false with the refilled-but-not-decremented
   * value persisted. ALL inside one `db.transaction(...).immediate()`
   * (BEGIN IMMEDIATE — the markRecoverySent/appendPaymentEventIfAbsent
   * pattern) so concurrent same-key callers serialize and can never both
   * succeed on the last token. Refill math mirrors `rate-limit.ts`'s
   * in-process token bucket exactly for a given (capacity, refillPerSec, now)
   * sequence. `nowMs` is always caller-injected — never a real-clock read
   * inside the adapter — so both SqliteStorage and TursoStorage (05-03) are
   * deterministic under test.
   */
  consumeRateLimitToken(
    bucketKey: string,
    capacity: number,
    refillPerSec: number,
    nowMs: number,
  ): Promise<boolean>;
}
