/**
 * SqliteStorage — the reference `StorageAdapter` implementation.
 *
 * All public methods are `async` (Promise-returning) per the interface
 * contract (Plan 01), but every body is a synchronous better-sqlite3 call —
 * there is no genuine asynchrony here, only Promise-wrapping so future
 * non-synchronous adapters (Postgres/Turso, V2-03) can implement the same
 * interface without a breaking rewrite.
 *
 * Every query uses `db.prepare(...)` with `?` placeholders — never string
 * interpolation of untrusted values (T-01-04). The single sanctioned
 * exception is the `VACUUM INTO` backup statement in db.ts, which
 * apostrophe-escapes its (server-controlled) path before interpolation.
 */
import type Database from 'better-sqlite3';
import { monotonicFactory } from 'ulid';
import type { StorageAdapter, UpsertAbandonedResult } from './adapter.js';
import type {
  AnalyticsFilter,
  DropOffRow,
  Entry,
  EntryFilter,
  EntryStatus,
  FileRecord,
  FunnelCounts,
  Payment,
  PaymentEvent,
  PaymentFilter,
  PaymentProvider,
  PaymentStatus,
} from '../../types.js';
import { PAYMENT_REQUEST_FORM_ID } from '../payment-constants.js';
import { getDb } from './db.js';
import { logError } from '../log.js';

const ulid = monotonicFactory();

interface RawEntryRow {
  id: string;
  site_id: string;
  form_id: string;
  status: EntryStatus;
  fields: string;
  visitor_uuid: string;
  ip: string | null;
  user_agent: string | null;
  geo: string | null;
  journey: string | null;
  page_url: string | null;
  referrer: string | null;
  last_field: string | null;
  recovery_sent_at: number | null;
  consent_at: number | null;
  created_at: number;
  updated_at: number;
}

type NewEntryInput = {
  siteId: string;
  formId: string;
  status: EntryStatus;
  fields: Record<string, unknown>;
  visitorUuid: string;
  ip?: string;
  userAgent?: string;
  geo?: unknown;
  journey?: unknown;
  pageUrl?: string;
  referrer?: string;
  lastField?: string;
  consentAt?: number;
  recoverySentAt?: number;
};

/**
 * Row -> domain mapping. JSON.parse is try/catch-wrapped — a corrupted
 * column logs `storage.corrupt-row` and returns undefined so listing never
 * throws on a single bad row; the caller is expected to skip it.
 */
function mapRow(row: RawEntryRow): Entry | undefined {
  try {
    return {
      id: row.id,
      siteId: row.site_id,
      formId: row.form_id,
      status: row.status,
      fields: JSON.parse(row.fields) as Record<string, unknown>,
      visitorUuid: row.visitor_uuid,
      ip: row.ip ?? undefined,
      userAgent: row.user_agent ?? undefined,
      geo: row.geo !== null ? JSON.parse(row.geo) : undefined,
      journey: row.journey !== null ? JSON.parse(row.journey) : undefined,
      pageUrl: row.page_url ?? undefined,
      referrer: row.referrer ?? undefined,
      lastField: row.last_field ?? undefined,
      consentAt: row.consent_at ?? undefined,
      recoverySentAt: row.recovery_sent_at ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  } catch (err) {
    logError('storage.corrupt-row', err, { id: row.id });
    return undefined;
  }
}

function mapRowOrThrow(row: RawEntryRow | undefined): Entry {
  if (!row) throw new Error('entry row not found');
  const entry = mapRow(row);
  if (!entry) throw new Error(`entry row "${row.id}" failed to parse (corrupted JSON column)`);
  return entry;
}

interface RawPaymentRow {
  id: string;
  entry_id: string;
  provider: PaymentProvider | null;
  amount_cents: number | null;
  currency: string | null;
  status: PaymentStatus | null;
  pay_link_url: string | null;
  provider_ref: string | null;
  provider_ids: string | null;
  events: string | null;
  created_at: number | null;
  updated_at: number | null;
}

/** Row -> domain mapping for payments. Same corrupted-JSON handling as mapRow (T-01 pattern). */
function mapPaymentRow(row: RawPaymentRow): Payment | undefined {
  try {
    return {
      id: row.id,
      entryId: row.entry_id,
      provider: row.provider ?? undefined,
      amountCents: row.amount_cents ?? undefined,
      currency: row.currency ?? undefined,
      status: row.status ?? undefined,
      payLinkUrl: row.pay_link_url ?? undefined,
      providerRef: row.provider_ref ?? undefined,
      providerIds: row.provider_ids !== null ? (JSON.parse(row.provider_ids) as Record<string, unknown>) : undefined,
      events: row.events !== null ? (JSON.parse(row.events) as PaymentEvent[]) : undefined,
      createdAt: row.created_at ?? 0,
      updatedAt: row.updated_at ?? 0,
    };
  } catch (err) {
    logError('storage.corrupt-row', err, { id: row.id });
    return undefined;
  }
}

function mapPaymentRowOrThrow(row: RawPaymentRow | undefined): Payment {
  if (!row) throw new Error('payment row not found');
  const payment = mapPaymentRow(row);
  if (!payment) throw new Error(`payment row "${row.id}" failed to parse (corrupted JSON column)`);
  return payment;
}

interface RawFileRow {
  id: string;
  entry_id: string;
  filename: string | null;
  size_bytes: number | null;
  mime: string | null;
  storage: 'drive' | 'email-only' | null;
  drive_file_id: string | null;
  drive_link: string | null;
  created_at: number | null;
}

/** Row -> domain mapping for files (getFilesByEntry). No JSON columns, so no try/catch corrupt-row handling is needed (unlike mapRow/mapPaymentRow). */
function mapFileRow(row: RawFileRow): FileRecord {
  return {
    id: row.id,
    entryId: row.entry_id,
    filename: row.filename ?? undefined,
    sizeBytes: row.size_bytes ?? undefined,
    mime: row.mime ?? undefined,
    storage: row.storage ?? undefined,
    driveFileId: row.drive_file_id ?? undefined,
    driveLink: row.drive_link ?? undefined,
    createdAt: row.created_at ?? undefined,
  };
}

function buildWhere(filter: EntryFilter): { clause: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter.siteId !== undefined) {
    clauses.push('site_id = ?');
    params.push(filter.siteId);
  }
  if (filter.formId !== undefined) {
    clauses.push('form_id = ?');
    params.push(filter.formId);
  }
  if (filter.status !== undefined) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  if (filter.visitorUuid !== undefined) {
    clauses.push('visitor_uuid = ?');
    params.push(filter.visitorUuid);
  }
  if (filter.from !== undefined) {
    clauses.push('created_at >= ?');
    params.push(filter.from);
  }
  if (filter.to !== undefined) {
    clauses.push('created_at <= ?');
    params.push(filter.to);
  }
  if (filter.search) {
    clauses.push('(fields LIKE ? OR page_url LIKE ? OR referrer LIKE ?)');
    const like = `%${filter.search}%`;
    params.push(like, like, like);
  }
  if (filter.excludeFormId !== undefined) {
    clauses.push('form_id != ?');
    params.push(filter.excludeFormId);
  }

  return { clause: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/**
 * Shared site/form/date scoping for the analytics queries (getFunnel,
 * getTopDropOff). Both form_starts and entries share the same
 * site_id/form_id/created_at column names, so one builder covers both
 * tables. Same parameterized-only discipline as buildWhere (T-01-04).
 */
function buildAnalyticsWhere(filter: AnalyticsFilter): { clause: string; params: unknown[] } {
  // Synthetic payment-request entries (D-PAY-05, PAYMENT_REQUEST_FORM_ID)
  // are payment anchors, not form-funnel traffic — UNCONDITIONALLY excluded
  // so getFunnel/getTopDropOff can never count them (checker B2). Shared
  // constant from types.ts, never a mirrored literal. Harmless against
  // form_starts too (no real form ever starts with this reserved formId).
  const clauses: string[] = ['form_id != ?'];
  const params: unknown[] = [PAYMENT_REQUEST_FORM_ID];

  if (filter.siteId !== undefined) {
    clauses.push('site_id = ?');
    params.push(filter.siteId);
  }
  if (filter.formId !== undefined) {
    clauses.push('form_id = ?');
    params.push(filter.formId);
  }
  if (filter.from !== undefined) {
    clauses.push('created_at >= ?');
    params.push(filter.from);
  }
  if (filter.to !== undefined) {
    clauses.push('created_at <= ?');
    params.push(filter.to);
  }

  return { clause: `WHERE ${clauses.join(' AND ')}`, params };
}

/** Shared WHERE builder for listPayments/countPayments — same parameterized-only discipline as buildWhere (T-01-04). */
function buildPaymentWhere(filter: PaymentFilter): { clause: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter.provider !== undefined) {
    clauses.push('provider = ?');
    params.push(filter.provider);
  }
  if (filter.status !== undefined) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  if (filter.entryId !== undefined) {
    clauses.push('entry_id = ?');
    params.push(filter.entryId);
  }
  if (filter.from !== undefined) {
    clauses.push('created_at >= ?');
    params.push(filter.from);
  }
  if (filter.to !== undefined) {
    clauses.push('created_at <= ?');
    params.push(filter.to);
  }

  return { clause: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/**
 * CSV formula-injection guard (T-01-33): any cell whose stringified value
 * starts with `=`, `+`, `-`, or `@` is prefixed with a leading single quote
 * before standard CSV quoting is applied.
 */
function csvCell(value: unknown): string {
  let s = value === undefined || value === null ? '' : String(value);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  if (/[",\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export class SqliteStorage implements StorageAdapter {
  constructor(private readonly db: Database.Database = getDb()) {}

  private getRawById(id: string): RawEntryRow | undefined {
    return this.db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as RawEntryRow | undefined;
  }

  private insertEntryRow(input: NewEntryInput, now: number): string {
    const id = ulid();
    this.db
      .prepare(
        `INSERT INTO entries (id, site_id, form_id, status, fields, visitor_uuid, ip, user_agent, geo, journey, page_url, referrer, last_field, recovery_sent_at, consent_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.siteId,
        input.formId,
        input.status,
        JSON.stringify(input.fields ?? {}),
        input.visitorUuid,
        input.ip ?? null,
        input.userAgent ?? null,
        input.geo !== undefined ? JSON.stringify(input.geo) : null,
        input.journey !== undefined ? JSON.stringify(input.journey) : null,
        input.pageUrl ?? null,
        input.referrer ?? null,
        input.lastField ?? null,
        input.recoverySentAt ?? null,
        input.consentAt ?? null,
        now,
        now,
      );
    return id;
  }

  async createEntry(input: Omit<Entry, 'id' | 'createdAt' | 'updatedAt'>): Promise<Entry> {
    const now = Date.now();
    const id = this.insertEntryRow(input, now);
    return mapRowOrThrow(this.getRawById(id));
  }

  async updateEntry(id: string, patch: Partial<Entry>): Promise<Entry> {
    const existingRaw = this.getRawById(id);
    if (!existingRaw) throw new Error(`updateEntry: no entry with id "${id}"`);
    const existing = mapRowOrThrow(existingRaw);
    // updateEntry always bumps updated_at to now, regardless of any
    // updatedAt the caller passes in patch.
    const merged: Entry = { ...existing, ...patch, id: existing.id, updatedAt: Date.now() };

    this.db
      .prepare(
        `UPDATE entries SET site_id=?, form_id=?, status=?, fields=?, visitor_uuid=?, ip=?, user_agent=?, geo=?, journey=?, page_url=?, referrer=?, last_field=?, recovery_sent_at=?, consent_at=?, updated_at=?
         WHERE id=?`,
      )
      .run(
        merged.siteId,
        merged.formId,
        merged.status,
        JSON.stringify(merged.fields ?? {}),
        merged.visitorUuid,
        merged.ip ?? null,
        merged.userAgent ?? null,
        merged.geo !== undefined ? JSON.stringify(merged.geo) : null,
        merged.journey !== undefined ? JSON.stringify(merged.journey) : null,
        merged.pageUrl ?? null,
        merged.referrer ?? null,
        merged.lastField ?? null,
        merged.recoverySentAt ?? null,
        merged.consentAt ?? null,
        merged.updatedAt,
        id,
      );
    return mapRowOrThrow(this.getRawById(id));
  }

  async findAbandoned(
    siteId: string,
    visitorUuid: string,
    formId: string,
    windowMins: number,
  ): Promise<Entry | undefined> {
    const cutoff = Date.now() - windowMins * 60_000;
    const row = this.db
      .prepare(
        `SELECT * FROM entries
         WHERE site_id = ? AND visitor_uuid = ? AND form_id = ? AND status = 'abandoned' AND updated_at >= ?
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(siteId, visitorUuid, formId, cutoff) as RawEntryRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  async listEntries(filter: EntryFilter): Promise<Entry[]> {
    const { clause, params } = buildWhere(filter);
    let sql = `SELECT * FROM entries ${clause} ORDER BY created_at DESC, id DESC`;
    const allParams = [...params];
    if (filter.limit !== undefined || filter.offset !== undefined) {
      sql += ' LIMIT ?';
      // SQLite treats a negative LIMIT as "no limit" — lets offset-only
      // filters page through the full result set.
      allParams.push(filter.limit ?? -1);
      if (filter.offset !== undefined) {
        sql += ' OFFSET ?';
        allParams.push(filter.offset);
      }
    }
    const rows = this.db.prepare(sql).all(...allParams) as RawEntryRow[];
    const entries: Entry[] = [];
    for (const row of rows) {
      const entry = mapRow(row);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  async countEntries(filter: EntryFilter): Promise<number> {
    const { clause, params } = buildWhere(filter);
    const row = this.db.prepare(`SELECT COUNT(*) as count FROM entries ${clause}`).get(...params) as {
      count: number;
    };
    return row.count;
  }

  async attachPayment(entryId: string, payment: Record<string, unknown>): Promise<void> {
    const id = ulid();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO payments (id, entry_id, provider, amount_cents, currency, status, pay_link_url, provider_ref, provider_ids, events, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        entryId,
        (payment.provider as string | undefined) ?? null,
        (payment.amountCents as number | undefined) ?? null,
        (payment.currency as string | undefined) ?? null,
        (payment.status as string | undefined) ?? null,
        (payment.payLinkUrl as string | undefined) ?? null,
        (payment.providerRef as string | undefined) ?? null,
        payment.providerIds !== undefined ? JSON.stringify(payment.providerIds) : null,
        payment.events !== undefined ? JSON.stringify(payment.events) : null,
        now,
        now,
      );
  }

  async attachFiles(entryId: string, files: Record<string, unknown>[]): Promise<void> {
    const now = Date.now();
    const insert = this.db.prepare(
      `INSERT INTO files (id, entry_id, filename, size_bytes, mime, storage, drive_file_id, drive_link, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    );
    const insertAll = this.db.transaction((rows: Record<string, unknown>[]) => {
      for (const f of rows) {
        insert.run(
          ulid(),
          entryId,
          (f.filename as string | undefined) ?? null,
          (f.sizeBytes as number | undefined) ?? null,
          (f.mime as string | undefined) ?? null,
          (f.storage as string | undefined) ?? null,
          (f.driveFileId as string | undefined) ?? null,
          (f.driveLink as string | undefined) ?? null,
          now,
        );
      }
    });
    insertAll(files);
  }

  async exportCsv(filter: EntryFilter): Promise<string> {
    const entries = await this.listEntries(filter);
    const fixedCols = [
      'id',
      'siteId',
      'formId',
      'status',
      'visitorUuid',
      'ip',
      'userAgent',
      'pageUrl',
      'referrer',
      'createdAt',
      'updatedAt',
    ];
    const fieldKeys = new Set<string>();
    for (const e of entries) {
      for (const k of Object.keys(e.fields ?? {})) fieldKeys.add(k);
    }
    const fieldCols = [...fieldKeys].sort();
    const header = [...fixedCols, ...fieldCols];
    const lines = [header.map(csvCell).join(',')];
    for (const e of entries) {
      const row: unknown[] = [
        e.id,
        e.siteId,
        e.formId,
        e.status,
        e.visitorUuid,
        e.ip ?? '',
        e.userAgent ?? '',
        e.pageUrl ?? '',
        e.referrer ?? '',
        String(e.createdAt),
        String(e.updatedAt),
        ...fieldCols.map((k) => {
          const v = e.fields?.[k];
          if (v === undefined) return '';
          return typeof v === 'string' ? v : JSON.stringify(v);
        }),
      ];
      lines.push(row.map(csvCell).join(','));
    }
    return lines.join('\n');
  }

  /**
   * Atomic dedupe (T-01-34): SELECT + INSERT/UPDATE run inside ONE
   * `db.transaction(...).immediate()` (BEGIN IMMEDIATE), keyed
   * site_id + visitor_uuid + form_id throughout.
   */
  async upsertAbandoned(
    input: Omit<Entry, 'id' | 'createdAt' | 'updatedAt' | 'status'>,
    windowMins: number,
  ): Promise<UpsertAbandonedResult> {
    const txn = this.db
      .transaction(
        (
          txnInput: Omit<Entry, 'id' | 'createdAt' | 'updatedAt' | 'status'>,
          txnWindowMins: number,
        ): UpsertAbandonedResult => {
          const cutoff = Date.now() - txnWindowMins * 60_000;

          const recentConvertedOrSubmitted = this.db
            .prepare(
              `SELECT id FROM entries
               WHERE site_id = ? AND visitor_uuid = ? AND form_id = ? AND status IN ('submitted','converted') AND updated_at >= ?
               ORDER BY updated_at DESC LIMIT 1`,
            )
            .get(txnInput.siteId, txnInput.visitorUuid, txnInput.formId, cutoff);

          if (recentConvertedOrSubmitted) {
            // Phantom-abandon suppression — write nothing.
            return { outcome: 'already-converted' };
          }

          const existingAbandoned = this.db
            .prepare(
              `SELECT * FROM entries
               WHERE site_id = ? AND visitor_uuid = ? AND form_id = ? AND status = 'abandoned' AND updated_at >= ?
               ORDER BY updated_at DESC LIMIT 1`,
            )
            .get(txnInput.siteId, txnInput.visitorUuid, txnInput.formId, cutoff) as RawEntryRow | undefined;

          const now = Date.now();

          if (existingAbandoned) {
            this.db
              .prepare(
                `UPDATE entries SET fields=?, ip=?, user_agent=?, geo=?, journey=?, page_url=?, referrer=?, last_field=?, updated_at=?
                 WHERE id=?`,
              )
              .run(
                JSON.stringify(txnInput.fields ?? {}),
                txnInput.ip ?? null,
                txnInput.userAgent ?? null,
                txnInput.geo !== undefined ? JSON.stringify(txnInput.geo) : null,
                txnInput.journey !== undefined ? JSON.stringify(txnInput.journey) : null,
                txnInput.pageUrl ?? null,
                txnInput.referrer ?? null,
                txnInput.lastField ?? null,
                now,
                existingAbandoned.id,
              );
            return { outcome: 'updated', entry: mapRowOrThrow(this.getRawById(existingAbandoned.id)) };
          }

          const id = this.insertEntryRow({ ...txnInput, status: 'abandoned' }, now);
          return { outcome: 'created', entry: mapRowOrThrow(this.getRawById(id)) };
        },
      );

    return txn.immediate(input, windowMins);
  }

  /**
   * Atomic find-all -> convert -> create-submitted. Marks EVERY matching
   * abandoned row 'converted' and always creates a new 'submitted' entry —
   * a second (double-submit) call converts nothing but still creates a
   * second submitted row (idempotent conversion, non-deduped submission).
   */
  async convertAndCreateSubmitted(
    input: Omit<Entry, 'id' | 'createdAt' | 'updatedAt' | 'status'>,
    lookbackMs: number,
  ): Promise<{ converted: number; entry: Entry }> {
    const txn = this.db
      .transaction(
        (
          txnInput: Omit<Entry, 'id' | 'createdAt' | 'updatedAt' | 'status'>,
          txnLookbackMs: number,
        ): { converted: number; entry: Entry } => {
          const cutoff = Date.now() - txnLookbackMs;
          const now = Date.now();

          const result = this.db
            .prepare(
              `UPDATE entries SET status='converted', updated_at=?
               WHERE site_id = ? AND visitor_uuid = ? AND form_id = ? AND status = 'abandoned' AND updated_at >= ?`,
            )
            .run(now, txnInput.siteId, txnInput.visitorUuid, txnInput.formId, cutoff);

          const id = this.insertEntryRow({ ...txnInput, status: 'submitted' }, now);
          return { converted: result.changes, entry: mapRowOrThrow(this.getRawById(id)) };
        },
      );

    return txn.immediate(input, lookbackMs);
  }

  /**
   * Erasure hook (D5/PRIV-01) — cascades payments + files in one
   * transaction (no FK pragma; explicit DELETEs are the mechanism).
   *
   * D4a (checker B2 resolution, BINDING): `recovery_suppressions` rows are
   * DELIBERATELY EXCLUDED from this cascade. The client-side visitor UUID
   * persists through an erasure (it lives in the browser, not this DB), so
   * deleting the visitor's suppression row here would let a FUTURE abandon
   * from the same visitor re-trigger a recovery email — violating D4's
   * "never email again" guarantee. Retaining a bare opt-out marker (UUID +
   * timestamp, no personal data) to keep honoring the opt-out is the
   * canonical suppression-list erasure exception; contract-tested in
   * adapter.contract.ts ("suppression SURVIVES GDPR erasure").
   */
  async purgeVisitor(visitorUuid: string): Promise<number> {
    const txn = this.db
      .transaction((txnVisitorUuid: string): number => {
        this.db
          .prepare('DELETE FROM payments WHERE entry_id IN (SELECT id FROM entries WHERE visitor_uuid = ?)')
          .run(txnVisitorUuid);
        this.db
          .prepare('DELETE FROM files WHERE entry_id IN (SELECT id FROM entries WHERE visitor_uuid = ?)')
          .run(txnVisitorUuid);
        const result = this.db.prepare('DELETE FROM entries WHERE visitor_uuid = ?').run(txnVisitorUuid);
        return result.changes;
      });
    return txn.immediate(visitorUuid);
  }

  /** Retention purge (PRIV-02) — only 'abandoned' rows are ever expired; submitted/converted rows are funnel data and survive. */
  async purgeExpired(retentionDays: number): Promise<number> {
    const cutoff = Date.now() - retentionDays * 86_400_000;
    const result = this.db.prepare(`DELETE FROM entries WHERE status = 'abandoned' AND updated_at < ?`).run(cutoff);
    return result.changes;
  }

  // -------------------------------------------------------------------------
  // ANLY-01 analytics + admin entry-detail primitives (Plan 02-01). Signatures
  // pinned on the StorageAdapter interface in Task 1; getFunnel/getTopDropOff
  // land in Task 3.
  // -------------------------------------------------------------------------

  /** Idempotent counter ping (D1) — INSERT OR IGNORE against the unique (site_id, form_id, visitor_uuid) index. */
  async recordFormStart(siteId: string, formId: string, visitorUuid: string): Promise<void> {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO form_starts (id, site_id, form_id, visitor_uuid, created_at) VALUES (?,?,?,?,?)`,
      )
      .run(ulid(), siteId, formId, visitorUuid, Date.now());
  }

  /**
   * started = COUNT(*) over form_starts; abandoned/submitted/converted =
   * entries.status GROUP BY, folded into fixed keys (default 0 when a
   * status is absent from the seeded data; 'spam' rows are ignored). Both
   * queries share site/form/date scoping via buildAnalyticsWhere; the
   * entries side is covered by idx_entries_status_created.
   */
  async getFunnel(filter: AnalyticsFilter): Promise<FunnelCounts> {
    const { clause, params } = buildAnalyticsWhere(filter);

    const startedRow = this.db
      .prepare(`SELECT COUNT(*) as count FROM form_starts ${clause}`)
      .get(...params) as { count: number };

    const statusRows = this.db
      .prepare(`SELECT status, COUNT(*) as count FROM entries ${clause} GROUP BY status`)
      .all(...params) as { status: EntryStatus; count: number }[];

    const counts: FunnelCounts = { started: startedRow.count, abandoned: 0, submitted: 0, converted: 0 };
    for (const row of statusRows) {
      if (row.status === 'abandoned') counts.abandoned = row.count;
      else if (row.status === 'submitted') counts.submitted = row.count;
      else if (row.status === 'converted') counts.converted = row.count;
      // 'spam' rows are not part of the funnel — ignored.
    }
    return counts;
  }

  /** Abandoned-row counts grouped by last_field, highest first, excluding NULL last_field. */
  async getTopDropOff(filter: AnalyticsFilter): Promise<DropOffRow[]> {
    const { clause, params } = buildAnalyticsWhere(filter);
    const extra = "status = 'abandoned' AND last_field IS NOT NULL";
    const where = clause ? `${clause} AND ${extra}` : `WHERE ${extra}`;

    const rows = this.db
      .prepare(`SELECT last_field AS field, COUNT(*) AS count FROM entries ${where} GROUP BY last_field ORDER BY count DESC`)
      .all(...params) as DropOffRow[];
    return rows;
  }

  /** Admin entry-detail read (ADMN-02) — reuses getRawById/mapRow so a corrupted row also reads back undefined. */
  async getEntryById(id: string): Promise<Entry | undefined> {
    const row = this.getRawById(id);
    return row ? mapRow(row) : undefined;
  }

  /**
   * HARD delete of one entry (the admin per-entry delete) plus its
   * payments/files rows, in one transaction — mirrors purgeVisitor's
   * cascade but scoped to a single entry_id. Returns whether a row was
   * actually removed so callers can surface a no-op on repeat calls.
   */
  async deleteEntry(id: string): Promise<boolean> {
    const txn = this.db.transaction((txnId: string): boolean => {
      this.db.prepare('DELETE FROM payments WHERE entry_id = ?').run(txnId);
      this.db.prepare('DELETE FROM files WHERE entry_id = ?').run(txnId);
      const result = this.db.prepare('DELETE FROM entries WHERE id = ?').run(txnId);
      return result.changes > 0;
    });
    return txn.immediate(id);
  }

  // -------------------------------------------------------------------------
  // Payments read/write surface (Phase 3, Plan 01).
  // -------------------------------------------------------------------------

  private getRawPaymentById(id: string): RawPaymentRow | undefined {
    return this.db.prepare('SELECT * FROM payments WHERE id = ?').get(id) as RawPaymentRow | undefined;
  }

  private updatePaymentRow(id: string, merged: Payment): void {
    this.db
      .prepare(
        `UPDATE payments SET provider=?, amount_cents=?, currency=?, status=?, pay_link_url=?, provider_ref=?, provider_ids=?, events=?, updated_at=?
         WHERE id=?`,
      )
      .run(
        merged.provider ?? null,
        merged.amountCents ?? null,
        merged.currency ?? null,
        merged.status ?? null,
        merged.payLinkUrl ?? null,
        merged.providerRef ?? null,
        merged.providerIds !== undefined ? JSON.stringify(merged.providerIds) : null,
        merged.events !== undefined ? JSON.stringify(merged.events) : null,
        merged.updatedAt,
        id,
      );
  }

  async getPaymentByProviderRef(providerRef: string): Promise<Payment | undefined> {
    const row = this.db.prepare('SELECT * FROM payments WHERE provider_ref = ?').get(providerRef) as
      | RawPaymentRow
      | undefined;
    return row ? mapPaymentRow(row) : undefined;
  }

  async getPaymentsByEntry(entryId: string): Promise<Payment[]> {
    const rows = this.db
      .prepare('SELECT * FROM payments WHERE entry_id = ? ORDER BY created_at DESC, id DESC')
      .all(entryId) as RawPaymentRow[];
    const payments: Payment[] = [];
    for (const row of rows) {
      const payment = mapPaymentRow(row);
      if (payment) payments.push(payment);
    }
    return payments;
  }

  async updatePayment(id: string, patch: Partial<Payment>): Promise<Payment> {
    const existingRaw = this.getRawPaymentById(id);
    if (!existingRaw) throw new Error(`updatePayment: no payment with id "${id}"`);
    const existing = mapPaymentRowOrThrow(existingRaw);
    // updatePayment always bumps updated_at to now, mirroring updateEntry.
    const merged: Payment = { ...existing, ...patch, id: existing.id, updatedAt: Date.now() };
    this.updatePaymentRow(id, merged);
    return mapPaymentRowOrThrow(this.getRawPaymentById(id));
  }

  /**
   * Atomic inbound-webhook idempotency primitive (checker W1): SELECT ->
   * check events[] for eventId -> append + optional patch, all inside ONE
   * `db.transaction(...).immediate()` (BEGIN IMMEDIATE) — the exact
   * upsertAbandoned atomicity pattern. The optional patch rides the SAME
   * transaction as the append so a crash can never leave the event recorded
   * without its accompanying status change.
   */
  async appendPaymentEventIfAbsent(
    paymentId: string,
    eventId: string,
    event: PaymentEvent,
    patch?: Partial<Payment>,
  ): Promise<boolean> {
    const txn = this.db.transaction(
      (
        txnPaymentId: string,
        txnEventId: string,
        txnEvent: PaymentEvent,
        txnPatch: Partial<Payment> | undefined,
      ): boolean => {
        const raw = this.getRawPaymentById(txnPaymentId);
        if (!raw) throw new Error(`appendPaymentEventIfAbsent: no payment with id "${txnPaymentId}"`);
        const existing = mapPaymentRowOrThrow(raw);
        const events = existing.events ?? [];
        if (events.some((e) => e.id === txnEventId)) {
          // Already recorded — zero writes, at-most-once delivery wins.
          return false;
        }
        const merged: Payment = {
          ...existing,
          ...txnPatch,
          id: existing.id,
          events: [...events, txnEvent],
          updatedAt: Date.now(),
        };
        this.updatePaymentRow(txnPaymentId, merged);
        return true;
      },
    );
    return txn.immediate(paymentId, eventId, event, patch);
  }

  async listPayments(filter: PaymentFilter): Promise<Payment[]> {
    const { clause, params } = buildPaymentWhere(filter);
    let sql = `SELECT * FROM payments ${clause} ORDER BY created_at DESC, id DESC`;
    const allParams = [...params];
    if (filter.limit !== undefined || filter.offset !== undefined) {
      sql += ' LIMIT ?';
      // SQLite treats a negative LIMIT as "no limit" — lets offset-only
      // filters page through the full result set (same trick as listEntries).
      allParams.push(filter.limit ?? -1);
      if (filter.offset !== undefined) {
        sql += ' OFFSET ?';
        allParams.push(filter.offset);
      }
    }
    const rows = this.db.prepare(sql).all(...allParams) as RawPaymentRow[];
    const payments: Payment[] = [];
    for (const row of rows) {
      const payment = mapPaymentRow(row);
      if (payment) payments.push(payment);
    }
    return payments;
  }

  async countPayments(filter: PaymentFilter): Promise<number> {
    const { clause, params } = buildPaymentWhere(filter);
    const row = this.db.prepare(`SELECT COUNT(*) as count FROM payments ${clause}`).get(...params) as {
      count: number;
    };
    return row.count;
  }

  // -------------------------------------------------------------------------
  // Drive files + lead recovery read/write surface (Phase 4, Plan 01).
  // -------------------------------------------------------------------------

  /** All file rows attached to one entry (admin entry-detail Files section), oldest first. */
  async getFilesByEntry(entryId: string): Promise<FileRecord[]> {
    const rows = this.db
      .prepare('SELECT * FROM files WHERE entry_id = ? ORDER BY created_at ASC')
      .all(entryId) as RawFileRow[];
    return rows.map(mapFileRow);
  }

  /**
   * RCV-01 sweep query (T-04-02): status='abandoned' AND consent_at IS NOT
   * NULL AND recovery_sent_at IS NULL AND past the delay cutoff AND not in
   * recovery_suppressions. This WHERE clause is the only thing standing
   * between a converted/non-consenting/unsubscribed visitor and an
   * unwanted email — every exclusion is contract-tested.
   */
  async findRecoverableEntries(delayMins: number, now: number, limit: number): Promise<Entry[]> {
    const cutoff = now - delayMins * 60_000;
    const rows = this.db
      .prepare(
        `SELECT * FROM entries
         WHERE status = 'abandoned' AND consent_at IS NOT NULL AND recovery_sent_at IS NULL AND updated_at <= ?
           AND visitor_uuid NOT IN (SELECT visitor_uuid FROM recovery_suppressions)
         ORDER BY updated_at ASC LIMIT ?`,
      )
      .all(cutoff, limit) as RawEntryRow[];
    const entries: Entry[] = [];
    for (const row of rows) {
      const entry = mapRow(row);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  /** Idempotent fill-if-null (D3) — the FIRST consent basis timestamp wins; a repeat call is a no-op. */
  async markConsent(entryId: string, now: number): Promise<void> {
    this.db.prepare('UPDATE entries SET consent_at = ? WHERE id = ? AND consent_at IS NULL').run(now, entryId);
  }

  /**
   * Atomic double-send gate (T-04-04): SELECT + UPDATE run inside ONE
   * `db.transaction(...).immediate()` (BEGIN IMMEDIATE) — the exact
   * appendPaymentEventIfAbsent atomicity pattern. The CLAIM happens before
   * the send (CONTEXT D3 supersedes RESEARCH's write-after-success
   * phrasing): the sweep branches on this boolean and never read-check-
   * writes recovery_sent_at itself.
   */
  async markRecoverySent(entryId: string, now: number): Promise<boolean> {
    const txn = this.db.transaction((txnEntryId: string, txnNow: number): boolean => {
      const raw = this.getRawById(txnEntryId);
      if (!raw || raw.recovery_sent_at !== null) {
        // Already claimed (or the row vanished) — zero writes.
        return false;
      }
      this.db.prepare('UPDATE entries SET recovery_sent_at = ? WHERE id = ?').run(txnNow, txnEntryId);
      return true;
    });
    return txn.immediate(entryId, now);
  }

  /** Idempotent one-click unsubscribe target (D4) — INSERT OR IGNORE keyed by visitor_uuid. */
  async suppressRecovery(visitorUuid: string, now: number): Promise<void> {
    this.db
      .prepare('INSERT OR IGNORE INTO recovery_suppressions (visitor_uuid, created_at) VALUES (?, ?)')
      .run(visitorUuid, now);
  }

  /** Whether a visitor has ever suppressed recovery email. Survives purgeVisitor (D4a). */
  async isRecoverySuppressed(visitorUuid: string): Promise<boolean> {
    const row = this.db.prepare('SELECT 1 FROM recovery_suppressions WHERE visitor_uuid = ? LIMIT 1').get(visitorUuid);
    return Boolean(row);
  }

  // -------------------------------------------------------------------------
  // Rate limiting persistent surface (Phase 5, Plan 02, D2 fix #1, ADPT-01).
  // -------------------------------------------------------------------------

  /**
   * Atomic token-bucket claim (T-05-06): SELECT the bucket (or seed it at
   * full capacity when absent), refill by elapsed*refillPerSec clamped to
   * capacity, decrement-if->=1, then UPSERT the result — all inside ONE
   * `db.transaction(...).immediate()` (BEGIN IMMEDIATE) — the exact
   * markRecoverySent/appendPaymentEventIfAbsent atomicity pattern, so
   * concurrent same-key callers serialize and can never both win the last
   * token. Refill arithmetic mirrors rate-limit.ts's in-process bucket:
   * `elapsedSec = max(0, (now - lastRefillMs) / 1000)`,
   * `tokens = min(capacity, tokens + elapsedSec * refillPerSec)`.
   */
  async consumeRateLimitToken(
    bucketKey: string,
    capacity: number,
    refillPerSec: number,
    nowMs: number,
  ): Promise<boolean> {
    const txn = this.db.transaction(
      (txnBucketKey: string, txnCapacity: number, txnRefillPerSec: number, txnNow: number): boolean => {
        const row = this.db
          .prepare('SELECT tokens, last_refill_ms FROM rate_limits WHERE bucket_key = ?')
          .get(txnBucketKey) as { tokens: number; last_refill_ms: number } | undefined;

        let tokens: number;
        if (!row) {
          tokens = txnCapacity;
        } else {
          const elapsedSec = Math.max(0, (txnNow - row.last_refill_ms) / 1000);
          tokens = Math.min(txnCapacity, row.tokens + elapsedSec * txnRefillPerSec);
        }

        const allowed = tokens >= 1;
        if (allowed) tokens -= 1;

        this.db
          .prepare(
            `INSERT INTO rate_limits (bucket_key, tokens, last_refill_ms) VALUES (?, ?, ?)
             ON CONFLICT(bucket_key) DO UPDATE SET tokens = excluded.tokens, last_refill_ms = excluded.last_refill_ms`,
          )
          .run(txnBucketKey, tokens, txnNow);

        return allowed;
      },
    );
    return txn.immediate(bucketKey, capacity, refillPerSec, nowMs);
  }
}
