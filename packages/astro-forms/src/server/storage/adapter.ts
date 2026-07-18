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

  /** Attach a payment record to an entry (Phase 3; table exists from Phase 1). */
  attachPayment(entryId: string, payment: Record<string, unknown>): Promise<void>;

  /** Attach file records to an entry (Phase 4; table exists from Phase 1). */
  attachFiles(entryId: string, files: Record<string, unknown>[]): Promise<void>;

  /** Export entries matching filter as CSV text. */
  exportCsv(filter: EntryFilter): Promise<string>;

  /**
   * Atomic dedupe: create a new 'abandoned' row, or update the existing one
   * keyed by site_id + visitor_uuid + form_id within windowMins (Plan 02).
   */
  upsertAbandoned(
    input: Omit<Entry, 'id' | 'createdAt' | 'updatedAt' | 'status'>,
    windowMins: number,
  ): Promise<UpsertAbandonedResult>;

  /**
   * Atomic find→convert-ALL-matching→create-submitted (Plan 02/07).
   * Marks every matching abandoned row 'converted' and creates (or reuses)
   * the submitted entry, returning how many rows were converted.
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
