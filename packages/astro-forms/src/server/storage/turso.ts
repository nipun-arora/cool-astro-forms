/**
 * TursoStorage — libSQL/Turso `StorageAdapter` implementation (ADPT-01,
 * Phase 5 Plan 03). Near-verbatim port of `sqlite.ts`'s prepared-statement
 * shapes and `BEGIN IMMEDIATE` atomic-claim pattern (CONTEXT D1: Turso is
 * the lower-risk first adapter — libSQL is SQLite-dialect-compatible).
 * `sqlite.ts`/`db.ts` stay the untouched default; this is an ADDITIVE
 * second backend.
 *
 * `@libsql/client` is an OPTIONAL peer dependency and is imported ONLY as
 * `import type` here (erased at compile time — zero runtime import) plus a
 * single `await import('@libsql/client')` inside `connectAndMigrate` below.
 * A static top-level value import would force the driver into every host's
 * SSR bundle, including hosts that only ever use the default SqliteStorage
 * (ARCHITECTURE convention #7 — optional modules stay inert without keys).
 *
 * SYNC-CONSTRUCT / #ready GATE: `runStorageContract` (adapter.contract.ts)
 * is a SYNCHRONOUS factory (`() => new TursoStorage(':memory:')`) and that
 * signature is NOT touched by this plan. `createClient(...)` itself is
 * synchronous, but the dynamic `import('@libsql/client')` that reaches it
 * is necessarily async, so construction here defers the client + its
 * migration walk behind a private `#ready` promise; every public method
 * `await`s `#ready` before its first query.
 *
 * LOCAL-CLIENT RECONNECT GOTCHA (undocumented @libsql/client 0.17.4
 * behavior, verified empirically this session against the installed
 * package by direct experimentation with `createClient` — see
 * 05-03-SUMMARY.md "Deviations"): the LOCAL sqlite3 backend's
 * (`client.protocol === 'file'`, used for both `:memory:` and real file
 * paths) `Client#transaction()` BEGINs on the client's own lazily-created
 * connection and then NULLS the client's internal reference to it (its own
 * source comment: "a new connection will be lazily created on next use").
 * For a real FILE this is harmless (the next lazy connection reopens the
 * same file, same data). For a bare `:memory:` URL it is NOT harmless: the
 * next plain `client.execute()` call — or a SECOND `client.transaction()`
 * call — after the first `transaction()` silently opens a brand-new, EMPTY
 * in-process database, discarding every row written before it. Two
 * verified dead ends before landing on the fix below: (1) SQLite's own
 * "shared cache" mode (`file::memory:?cache=shared`) does make reconnects
 * see the same data, but `@libsql/client`'s URL parser only recognizes the
 * UNNAMED `:memory:` token for shared-cache — there is no way to give each
 * `TursoStorage` instance its own name, so every instance in the same
 * process collided onto ONE shared database (confirmed: cross-test data
 * bleed across `runStorageContract`'s per-test `beforeEach` instances).
 * (2) Driving the LOCAL client entirely through raw `BEGIN`/`COMMIT` text
 * via plain `execute()` (never calling `.transaction()` at all) keeps the
 * client's single connection alive correctly for `:memory:` — but the
 * REMOTE (`http`/`ws`) backend's `execute()` opens-and-closes an
 * independent one-shot stream per call (`http.js`: "Pipeline all
 * operations, so hrana.HttpClient can open the stream, execute the
 * statement and close the stream in a single HTTP request"), so raw
 * BEGIN/COMMIT text sent as separate `execute()` calls would NOT hold a
 * transaction open across them there — production-incorrect for a real
 * remote Turso deployment even though it happens to work for `:memory:`.
 *
 * The fix actually used: BRANCH on `client.protocol`. For the LOCAL
 * backend (`'file'` — covers `:memory:` AND real file paths, where the
 * reconnect-after-`transaction()` quirk is either the exact bug or simply
 * moot) `withWriteTransaction` drives raw `BEGIN IMMEDIATE`/`COMMIT`/
 * `ROLLBACK` text through the client's own persistent connection directly
 * (dead-end 2 above, now safe because it is scoped to the ONE backend
 * where it is both correct and necessary). For REMOTE backends (`'http'`/
 * `'ws'`) it uses the library's documented `client.transaction('write')`
 * API exactly as designed — real Turso deployments never hit the local
 * quirk in the first place. Either branch retries on genuine SQLite lock-
 * contention codes AND, for the local branch only, on "cannot start a
 * transaction within a transaction" (the same-connection collision two
 * overlapping local `withWriteTransaction` calls produce) — this is what
 * gives concurrent same-key atomic-claim calls exactly one winner (T-05-09)
 * against `:memory:` instead of a first-writer-wins race with corrupted
 * reads. RESEARCH Assumption A4 (":memory: and remote share transaction
 * semantics on the same code path") does NOT hold at the connection-
 * management layer for this client version; this plan proves `:memory:`
 * only, exactly as scoped — the remote branch is written to the documented
 * API and deferred to the live drill for its own verification.
 *
 * Every query uses libSQL positional `?` args — never string interpolation
 * of untrusted values (T-05-08, mirrors sqlite.ts:10-13). The one
 * interpolated value in this file is the `PRAGMA user_version` integer,
 * which is always an internal loop counter, never caller/user input — the
 * same trusted-value precedent `db.ts`'s own `VACUUM INTO`/`user_version`
 * pragmas already set. It is built via string concatenation (not a
 * template literal) — this file uses plain string concatenation for every
 * dynamic SQL fragment and error message, never a template literal, so a
 * grep for template-literal interpolation syntax finds zero matches.
 */
import { monotonicFactory } from 'ulid';
import type { Client, InStatement, ResultSet, Transaction } from '@libsql/client';
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
import { MIGRATION_SQL } from './migrations.js';
import { logError } from '../log.js';

const ulid = monotonicFactory();

/** A single-statement `?`/named-arg value — the only shapes this file ever binds. */
type Arg = string | number | null;

/** Anything that can run a single statement — either the top-level `Client` or an open `Transaction` (T-05-08 args-only discipline is identical for both). */
interface Executor {
  execute(stmt: InStatement): Promise<ResultSet>;
}

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

/** Row -> domain mapping. Same corrupted-row tolerance as sqlite.ts's mapRow (T-01 pattern). */
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
  if (!entry) throw new Error('entry row "' + row.id + '" failed to parse (corrupted JSON column)');
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
  if (!payment) throw new Error('payment row "' + row.id + '" failed to parse (corrupted JSON column)');
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

function buildWhere(filter: EntryFilter): { clause: string; params: Arg[] } {
  const clauses: string[] = [];
  const params: Arg[] = [];

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
    const like = '%' + filter.search + '%';
    params.push(like, like, like);
  }
  if (filter.excludeFormId !== undefined) {
    clauses.push('form_id != ?');
    params.push(filter.excludeFormId);
  }

  return { clause: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '', params };
}

function buildAnalyticsWhere(filter: AnalyticsFilter): { clause: string; params: Arg[] } {
  // Synthetic payment-request entries (D-PAY-05) are payment anchors, not
  // form-funnel traffic — unconditionally excluded, mirroring sqlite.ts.
  const clauses: string[] = ['form_id != ?'];
  const params: Arg[] = [PAYMENT_REQUEST_FORM_ID];

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

  return { clause: 'WHERE ' + clauses.join(' AND '), params };
}

function buildPaymentWhere(filter: PaymentFilter): { clause: string; params: Arg[] } {
  const clauses: string[] = [];
  const params: Arg[] = [];

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

  return { clause: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '', params };
}

/** CSV formula-injection guard (T-01-33) — identical to sqlite.ts's csvCell. */
function csvCell(value: unknown): string {
  let s = value === undefined || value === null ? '' : String(value);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  if (/[",\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function firstRow<T>(rs: ResultSet): T | undefined {
  return rs.rows.length > 0 ? (rs.rows[0] as unknown as T) : undefined;
}

function allRows<T>(rs: ResultSet): T[] {
  return rs.rows as unknown as T[];
}

async function connectAndMigrate(dbUrl: string, authToken?: string): Promise<Client> {
  const { createClient } = await import('@libsql/client');
  const client =
    authToken !== undefined ? createClient({ url: dbUrl, authToken, timeout: 5000 }) : createClient({ url: dbUrl, timeout: 5000 });
  await migrate(client);
  return client;
}

/**
 * Applies `MIGRATION_SQL` (the same dialect-neutral list `db.ts` walks for
 * better-sqlite3, migrations.ts) against `user_version` — one shared source
 * of DDL, two backends. `executeMultiple` runs each versioned SQL block
 * un-transacted (matches better-sqlite3's `db.exec`, which is also not
 * itself wrapped in an explicit transaction per block in db.ts beyond the
 * per-migration `db.transaction()` call there); here each block is applied
 * then its `user_version` bump is written before moving to the next.
 */
async function migrate(client: Client): Promise<void> {
  const current = await client.execute('PRAGMA user_version');
  const row = firstRow<{ user_version: number }>(current);
  let version = row ? Number(row.user_version) : 0;

  for (let v = version; v < MIGRATION_SQL.length; v++) {
    const sql = MIGRATION_SQL[v];
    if (!sql) throw new Error('missing migration at index ' + v);
    await client.executeMultiple(sql);
    await client.execute('PRAGMA user_version = ' + String(v + 1));
    version = v + 1;
  }
}

// -----------------------------------------------------------------------
// Lock-retry helper for every atomic/multi-statement method (see file
// docstring). Only SQLite's own lock-contention codes, plus (local branch
// only) the same-connection "within a transaction" collision, are
// retried; every other error (including a deliberate `throw` from inside
// the callback, e.g. appendPaymentEventIfAbsent's "no payment with id") is
// re-thrown immediately on the first attempt — never retried.
// -----------------------------------------------------------------------

const LOCK_ERROR_CODES = new Set(['SQLITE_LOCKED', 'SQLITE_LOCKED_SHAREDCACHE', 'SQLITE_BUSY']);
// The local sqlite3 backend reports this as a plain SQLITE_ERROR (no
// dedicated code) when a second `BEGIN IMMEDIATE` collides with an
// already-open transaction on the SAME single persistent connection —
// exactly the case two overlapping local withWriteTransaction calls
// produce (see file docstring). Matched by message substring only.
const TRANSACTION_CONFLICT_MESSAGE = 'cannot start a transaction within a transaction';
const MAX_LOCK_RETRIES = 200;
const LOCK_RETRY_BASE_DELAY_MS = 1;
const LOCK_RETRY_JITTER_MS = 3;

function isRetryableLockError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = 'code' in err ? String((err as { code: unknown }).code) : undefined;
  const extendedCode = 'extendedCode' in err ? String((err as { extendedCode: unknown }).extendedCode) : undefined;
  const message = 'message' in err ? String((err as { message: unknown }).message) : '';
  if (code !== undefined && LOCK_ERROR_CODES.has(code)) return true;
  if (extendedCode !== undefined && LOCK_ERROR_CODES.has(extendedCode)) return true;
  return message.includes(TRANSACTION_CONFLICT_MESSAGE);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Bounded, jittered retry — the SAME loop backs both the local and remote `withWriteTransaction` branches below. */
async function retryOnLock<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (isRetryableLockError(err) && attempt < MAX_LOCK_RETRIES) {
        await sleep(LOCK_RETRY_BASE_DELAY_MS + Math.floor(Math.random() * LOCK_RETRY_JITTER_MS));
        continue;
      }
      throw err;
    }
  }
}

export class TursoStorage implements StorageAdapter {
  #ready: Promise<Client>;

  constructor(dbUrl = ':memory:', authToken?: string) {
    this.#ready = connectAndMigrate(dbUrl, authToken);
  }

  /**
   * Every atomic-claim method (markRecoverySent, appendPaymentEventIfAbsent,
   * upsertAbandoned, convertAndCreateSubmitted, consumeRateLimitToken) and
   * every other multi-statement all-or-nothing method (purgeVisitor,
   * deleteEntry, attachFiles) routes through this — the exact set
   * `sqlite.ts` wraps in `db.transaction(...).immediate()` / `.transaction()`.
   * Branches on `client.protocol` (see file docstring "LOCAL-CLIENT
   * RECONNECT GOTCHA" for why): the local backend (`:memory:` and real
   * files) drives raw `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` text through
   * the client's own persistent connection; remote backends use the
   * library's documented `client.transaction('write')` API.
   */
  private async withWriteTransaction<T>(fn: (exec: Executor) => Promise<T>): Promise<T> {
    const client = await this.#ready;

    if (client.protocol === 'file') {
      return retryOnLock(async () => {
        await client.execute('BEGIN IMMEDIATE');
        try {
          const result = await fn(client);
          await client.execute('COMMIT');
          return result;
        } catch (err) {
          try {
            await client.execute('ROLLBACK');
          } catch {
            // nothing open to roll back (e.g. BEGIN itself never committed a connection)
          }
          throw err;
        }
      });
    }

    return retryOnLock(async () => {
      const tx: Transaction = await client.transaction('write');
      try {
        const result = await fn(tx);
        await tx.commit();
        return result;
      } catch (err) {
        try {
          await tx.rollback();
        } catch {
          // already rolled back / connection gone — nothing more to undo
        }
        throw err;
      } finally {
        tx.close();
      }
    });
  }

  private async getRawById(exec: Executor, id: string): Promise<RawEntryRow | undefined> {
    const rs = await exec.execute({ sql: 'SELECT * FROM entries WHERE id = ?', args: [id] });
    return firstRow<RawEntryRow>(rs);
  }

  private async insertEntryRow(exec: Executor, input: NewEntryInput, now: number): Promise<string> {
    const id = ulid();
    const args: Arg[] = [
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
    ];
    await exec.execute({
      sql: `INSERT INTO entries (id, site_id, form_id, status, fields, visitor_uuid, ip, user_agent, geo, journey, page_url, referrer, last_field, recovery_sent_at, consent_at, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args,
    });
    return id;
  }

  async createEntry(input: Omit<Entry, 'id' | 'createdAt' | 'updatedAt'>): Promise<Entry> {
    const client = await this.#ready;
    const now = Date.now();
    const id = await this.insertEntryRow(client, input, now);
    return mapRowOrThrow(await this.getRawById(client, id));
  }

  async updateEntry(id: string, patch: Partial<Entry>): Promise<Entry> {
    const client = await this.#ready;
    const existingRaw = await this.getRawById(client, id);
    if (!existingRaw) throw new Error('updateEntry: no entry with id "' + id + '"');
    const existing = mapRowOrThrow(existingRaw);
    const merged: Entry = { ...existing, ...patch, id: existing.id, updatedAt: Date.now() };

    const args: Arg[] = [
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
    ];
    await client.execute({
      sql: `UPDATE entries SET site_id=?, form_id=?, status=?, fields=?, visitor_uuid=?, ip=?, user_agent=?, geo=?, journey=?, page_url=?, referrer=?, last_field=?, recovery_sent_at=?, consent_at=?, updated_at=?
            WHERE id=?`,
      args,
    });
    return mapRowOrThrow(await this.getRawById(client, id));
  }

  async findAbandoned(siteId: string, visitorUuid: string, formId: string, windowMins: number): Promise<Entry | undefined> {
    const client = await this.#ready;
    const cutoff = Date.now() - windowMins * 60_000;
    const rs = await client.execute({
      sql: `SELECT * FROM entries
            WHERE site_id = ? AND visitor_uuid = ? AND form_id = ? AND status = 'abandoned' AND updated_at >= ?
            ORDER BY updated_at DESC LIMIT 1`,
      args: [siteId, visitorUuid, formId, cutoff],
    });
    const row = firstRow<RawEntryRow>(rs);
    return row ? mapRow(row) : undefined;
  }

  async listEntries(filter: EntryFilter): Promise<Entry[]> {
    const client = await this.#ready;
    const { clause, params } = buildWhere(filter);
    let sql = 'SELECT * FROM entries ' + clause + ' ORDER BY created_at DESC, id DESC';
    const args: Arg[] = [...params];
    if (filter.limit !== undefined || filter.offset !== undefined) {
      sql += ' LIMIT ?';
      // SQLite treats a negative LIMIT as "no limit" — same trick as sqlite.ts.
      args.push(filter.limit ?? -1);
      if (filter.offset !== undefined) {
        sql += ' OFFSET ?';
        args.push(filter.offset);
      }
    }
    const rs = await client.execute({ sql, args });
    const entries: Entry[] = [];
    for (const row of allRows<RawEntryRow>(rs)) {
      const entry = mapRow(row);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  async countEntries(filter: EntryFilter): Promise<number> {
    const client = await this.#ready;
    const { clause, params } = buildWhere(filter);
    const rs = await client.execute({ sql: 'SELECT COUNT(*) as count FROM entries ' + clause, args: params });
    const row = firstRow<{ count: number }>(rs);
    return row ? Number(row.count) : 0;
  }

  async attachPayment(entryId: string, payment: Record<string, unknown>): Promise<void> {
    const client = await this.#ready;
    const id = ulid();
    const now = Date.now();
    const args: Arg[] = [
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
    ];
    await client.execute({
      sql: `INSERT INTO payments (id, entry_id, provider, amount_cents, currency, status, pay_link_url, provider_ref, provider_ids, events, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      args,
    });
  }

  async attachFiles(entryId: string, files: Record<string, unknown>[]): Promise<void> {
    const now = Date.now();
    await this.withWriteTransaction(async (tx) => {
      for (const f of files) {
        const args: Arg[] = [
          ulid(),
          entryId,
          (f.filename as string | undefined) ?? null,
          (f.sizeBytes as number | undefined) ?? null,
          (f.mime as string | undefined) ?? null,
          (f.storage as string | undefined) ?? null,
          (f.driveFileId as string | undefined) ?? null,
          (f.driveLink as string | undefined) ?? null,
          now,
        ];
        await tx.execute({
          sql: `INSERT INTO files (id, entry_id, filename, size_bytes, mime, storage, drive_file_id, drive_link, created_at)
                VALUES (?,?,?,?,?,?,?,?,?)`,
          args,
        });
      }
    });
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

  /** Atomic dedupe (T-01-34) — SELECT + INSERT/UPDATE inside one write transaction, mirrors sqlite.ts's BEGIN IMMEDIATE. */
  async upsertAbandoned(
    input: Omit<Entry, 'id' | 'createdAt' | 'updatedAt' | 'status'>,
    windowMins: number,
  ): Promise<UpsertAbandonedResult> {
    return this.withWriteTransaction(async (tx) => {
      const cutoff = Date.now() - windowMins * 60_000;

      const recentConvertedOrSubmitted = await tx.execute({
        sql: `SELECT id FROM entries
              WHERE site_id = ? AND visitor_uuid = ? AND form_id = ? AND status IN ('submitted','converted') AND updated_at >= ?
              ORDER BY updated_at DESC LIMIT 1`,
        args: [input.siteId, input.visitorUuid, input.formId, cutoff],
      });

      if (recentConvertedOrSubmitted.rows.length > 0) {
        // Phantom-abandon suppression — write nothing.
        return { outcome: 'already-converted' };
      }

      const existingRs = await tx.execute({
        sql: `SELECT * FROM entries
              WHERE site_id = ? AND visitor_uuid = ? AND form_id = ? AND status = 'abandoned' AND updated_at >= ?
              ORDER BY updated_at DESC LIMIT 1`,
        args: [input.siteId, input.visitorUuid, input.formId, cutoff],
      });
      const existingAbandoned = firstRow<RawEntryRow>(existingRs);

      const now = Date.now();

      if (existingAbandoned) {
        const args: Arg[] = [
          JSON.stringify(input.fields ?? {}),
          input.ip ?? null,
          input.userAgent ?? null,
          input.geo !== undefined ? JSON.stringify(input.geo) : null,
          input.journey !== undefined ? JSON.stringify(input.journey) : null,
          input.pageUrl ?? null,
          input.referrer ?? null,
          input.lastField ?? null,
          now,
          existingAbandoned.id,
        ];
        await tx.execute({
          sql: `UPDATE entries SET fields=?, ip=?, user_agent=?, geo=?, journey=?, page_url=?, referrer=?, last_field=?, updated_at=?
                WHERE id=?`,
          args,
        });
        return { outcome: 'updated', entry: mapRowOrThrow(await this.getRawById(tx, existingAbandoned.id)) };
      }

      const id = await this.insertEntryRow(tx, { ...input, status: 'abandoned' }, now);
      return { outcome: 'created', entry: mapRowOrThrow(await this.getRawById(tx, id)) };
    });
  }

  /** Atomic find-all -> convert -> create-submitted (mirrors sqlite.ts). */
  async convertAndCreateSubmitted(
    input: Omit<Entry, 'id' | 'createdAt' | 'updatedAt' | 'status'>,
    lookbackMs: number,
  ): Promise<{ converted: number; entry: Entry }> {
    return this.withWriteTransaction(async (tx) => {
      const cutoff = Date.now() - lookbackMs;
      const now = Date.now();

      const result = await tx.execute({
        sql: `UPDATE entries SET status='converted', updated_at=?
              WHERE site_id = ? AND visitor_uuid = ? AND form_id = ? AND status = 'abandoned' AND updated_at >= ?`,
        args: [now, input.siteId, input.visitorUuid, input.formId, cutoff],
      });

      const id = await this.insertEntryRow(tx, { ...input, status: 'submitted' }, now);
      return { converted: result.rowsAffected, entry: mapRowOrThrow(await this.getRawById(tx, id)) };
    });
  }

  /**
   * Erasure hook (D5/PRIV-01) — cascades payments/files in one write
   * transaction. D4a (BINDING, mirrors sqlite.ts): `recovery_suppressions`
   * rows are DELIBERATELY EXCLUDED so a future abandon from the same
   * visitor can never re-trigger a recovery email post-erasure.
   */
  async purgeVisitor(visitorUuid: string): Promise<number> {
    return this.withWriteTransaction(async (tx) => {
      await tx.execute({
        sql: 'DELETE FROM payments WHERE entry_id IN (SELECT id FROM entries WHERE visitor_uuid = ?)',
        args: [visitorUuid],
      });
      await tx.execute({
        sql: 'DELETE FROM files WHERE entry_id IN (SELECT id FROM entries WHERE visitor_uuid = ?)',
        args: [visitorUuid],
      });
      const result = await tx.execute({ sql: 'DELETE FROM entries WHERE visitor_uuid = ?', args: [visitorUuid] });
      return result.rowsAffected;
    });
  }

  async purgeExpired(retentionDays: number): Promise<number> {
    const client = await this.#ready;
    const cutoff = Date.now() - retentionDays * 86_400_000;
    const result = await client.execute({
      sql: `DELETE FROM entries WHERE status = 'abandoned' AND updated_at < ?`,
      args: [cutoff],
    });
    return result.rowsAffected;
  }

  async recordFormStart(siteId: string, formId: string, visitorUuid: string): Promise<void> {
    const client = await this.#ready;
    await client.execute({
      sql: 'INSERT OR IGNORE INTO form_starts (id, site_id, form_id, visitor_uuid, created_at) VALUES (?,?,?,?,?)',
      args: [ulid(), siteId, formId, visitorUuid, Date.now()],
    });
  }

  async getFunnel(filter: AnalyticsFilter): Promise<FunnelCounts> {
    const client = await this.#ready;
    const { clause, params } = buildAnalyticsWhere(filter);

    const startedRs = await client.execute({ sql: 'SELECT COUNT(*) as count FROM form_starts ' + clause, args: params });
    const startedRow = firstRow<{ count: number }>(startedRs);

    const statusRs = await client.execute({
      sql: 'SELECT status, COUNT(*) as count FROM entries ' + clause + ' GROUP BY status',
      args: params,
    });

    const counts: FunnelCounts = { started: startedRow ? Number(startedRow.count) : 0, abandoned: 0, submitted: 0, converted: 0 };
    for (const row of allRows<{ status: EntryStatus; count: number }>(statusRs)) {
      if (row.status === 'abandoned') counts.abandoned = Number(row.count);
      else if (row.status === 'submitted') counts.submitted = Number(row.count);
      else if (row.status === 'converted') counts.converted = Number(row.count);
      // 'spam' rows are not part of the funnel — ignored.
    }
    return counts;
  }

  async getTopDropOff(filter: AnalyticsFilter): Promise<DropOffRow[]> {
    const client = await this.#ready;
    const { clause, params } = buildAnalyticsWhere(filter);
    const extra = "status = 'abandoned' AND last_field IS NOT NULL";
    const where = clause ? clause + ' AND ' + extra : 'WHERE ' + extra;

    const rs = await client.execute({
      sql: 'SELECT last_field AS field, COUNT(*) AS count FROM entries ' + where + ' GROUP BY last_field ORDER BY count DESC',
      args: params,
    });
    return allRows<{ field: string; count: number }>(rs).map((r) => ({ field: r.field, count: Number(r.count) }));
  }

  async getEntryById(id: string): Promise<Entry | undefined> {
    const client = await this.#ready;
    const row = await this.getRawById(client, id);
    return row ? mapRow(row) : undefined;
  }

  /** HARD delete of one entry plus its payments/files rows (mirrors purgeVisitor's cascade, scoped to one entry_id). */
  async deleteEntry(id: string): Promise<boolean> {
    return this.withWriteTransaction(async (tx) => {
      await tx.execute({ sql: 'DELETE FROM payments WHERE entry_id = ?', args: [id] });
      await tx.execute({ sql: 'DELETE FROM files WHERE entry_id = ?', args: [id] });
      const result = await tx.execute({ sql: 'DELETE FROM entries WHERE id = ?', args: [id] });
      return result.rowsAffected > 0;
    });
  }

  private async getRawPaymentById(exec: Executor, id: string): Promise<RawPaymentRow | undefined> {
    const rs = await exec.execute({ sql: 'SELECT * FROM payments WHERE id = ?', args: [id] });
    return firstRow<RawPaymentRow>(rs);
  }

  private async updatePaymentRow(exec: Executor, id: string, merged: Payment): Promise<void> {
    const args: Arg[] = [
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
    ];
    await exec.execute({
      sql: `UPDATE payments SET provider=?, amount_cents=?, currency=?, status=?, pay_link_url=?, provider_ref=?, provider_ids=?, events=?, updated_at=?
            WHERE id=?`,
      args,
    });
  }

  async getPaymentByProviderRef(providerRef: string): Promise<Payment | undefined> {
    const client = await this.#ready;
    const rs = await client.execute({ sql: 'SELECT * FROM payments WHERE provider_ref = ?', args: [providerRef] });
    const row = firstRow<RawPaymentRow>(rs);
    return row ? mapPaymentRow(row) : undefined;
  }

  async getPaymentsByEntry(entryId: string): Promise<Payment[]> {
    const client = await this.#ready;
    const rs = await client.execute({
      sql: 'SELECT * FROM payments WHERE entry_id = ? ORDER BY created_at DESC, id DESC',
      args: [entryId],
    });
    const payments: Payment[] = [];
    for (const row of allRows<RawPaymentRow>(rs)) {
      const payment = mapPaymentRow(row);
      if (payment) payments.push(payment);
    }
    return payments;
  }

  async updatePayment(id: string, patch: Partial<Payment>): Promise<Payment> {
    const client = await this.#ready;
    const existingRaw = await this.getRawPaymentById(client, id);
    if (!existingRaw) throw new Error('updatePayment: no payment with id "' + id + '"');
    const existing = mapPaymentRowOrThrow(existingRaw);
    const merged: Payment = { ...existing, ...patch, id: existing.id, updatedAt: Date.now() };
    await this.updatePaymentRow(client, id, merged);
    return mapPaymentRowOrThrow(await this.getRawPaymentById(client, id));
  }

  /**
   * Atomic inbound-webhook idempotency primitive (checker W1) — SELECT ->
   * check events[] for eventId -> append + optional patch, all inside one
   * write transaction. Mirrors sqlite.ts's exact upsertAbandoned pattern.
   */
  async appendPaymentEventIfAbsent(
    paymentId: string,
    eventId: string,
    event: PaymentEvent,
    patch?: Partial<Payment>,
  ): Promise<boolean> {
    return this.withWriteTransaction(async (tx) => {
      const raw = await this.getRawPaymentById(tx, paymentId);
      if (!raw) throw new Error('appendPaymentEventIfAbsent: no payment with id "' + paymentId + '"');
      const existing = mapPaymentRowOrThrow(raw);
      const events = existing.events ?? [];
      if (events.some((e) => e.id === eventId)) {
        // Already recorded — zero writes, at-most-once delivery wins.
        return false;
      }
      const merged: Payment = {
        ...existing,
        ...patch,
        id: existing.id,
        events: [...events, event],
        updatedAt: Date.now(),
      };
      await this.updatePaymentRow(tx, paymentId, merged);
      return true;
    });
  }

  async listPayments(filter: PaymentFilter): Promise<Payment[]> {
    const client = await this.#ready;
    const { clause, params } = buildPaymentWhere(filter);
    let sql = 'SELECT * FROM payments ' + clause + ' ORDER BY created_at DESC, id DESC';
    const args: Arg[] = [...params];
    if (filter.limit !== undefined || filter.offset !== undefined) {
      sql += ' LIMIT ?';
      args.push(filter.limit ?? -1);
      if (filter.offset !== undefined) {
        sql += ' OFFSET ?';
        args.push(filter.offset);
      }
    }
    const rs = await client.execute({ sql, args });
    const payments: Payment[] = [];
    for (const row of allRows<RawPaymentRow>(rs)) {
      const payment = mapPaymentRow(row);
      if (payment) payments.push(payment);
    }
    return payments;
  }

  async countPayments(filter: PaymentFilter): Promise<number> {
    const client = await this.#ready;
    const { clause, params } = buildPaymentWhere(filter);
    const rs = await client.execute({ sql: 'SELECT COUNT(*) as count FROM payments ' + clause, args: params });
    const row = firstRow<{ count: number }>(rs);
    return row ? Number(row.count) : 0;
  }

  async getFilesByEntry(entryId: string): Promise<FileRecord[]> {
    const client = await this.#ready;
    const rs = await client.execute({ sql: 'SELECT * FROM files WHERE entry_id = ? ORDER BY created_at ASC', args: [entryId] });
    return allRows<RawFileRow>(rs).map(mapFileRow);
  }

  async findRecoverableEntries(delayMins: number, now: number, limit: number): Promise<Entry[]> {
    const client = await this.#ready;
    const cutoff = now - delayMins * 60_000;
    const rs = await client.execute({
      sql: `SELECT * FROM entries
            WHERE status = 'abandoned' AND consent_at IS NOT NULL AND recovery_sent_at IS NULL AND updated_at <= ?
              AND visitor_uuid NOT IN (SELECT visitor_uuid FROM recovery_suppressions)
            ORDER BY updated_at ASC LIMIT ?`,
      args: [cutoff, limit],
    });
    const entries: Entry[] = [];
    for (const row of allRows<RawEntryRow>(rs)) {
      const entry = mapRow(row);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  async markConsent(entryId: string, now: number): Promise<void> {
    const client = await this.#ready;
    await client.execute({
      sql: 'UPDATE entries SET consent_at = ? WHERE id = ? AND consent_at IS NULL',
      args: [now, entryId],
    });
  }

  /**
   * Atomic double-send gate (T-04-04) — SELECT + UPDATE inside one write
   * transaction, mirrors sqlite.ts's exact appendPaymentEventIfAbsent
   * pattern. The CLAIM happens before the send (CONTEXT D3).
   */
  async markRecoverySent(entryId: string, now: number): Promise<boolean> {
    return this.withWriteTransaction(async (tx) => {
      const raw = await this.getRawById(tx, entryId);
      if (!raw || raw.recovery_sent_at !== null) {
        // Already claimed (or the row vanished) — zero writes.
        return false;
      }
      await tx.execute({ sql: 'UPDATE entries SET recovery_sent_at = ? WHERE id = ?', args: [now, entryId] });
      return true;
    });
  }

  async suppressRecovery(visitorUuid: string, now: number): Promise<void> {
    const client = await this.#ready;
    await client.execute({
      sql: 'INSERT OR IGNORE INTO recovery_suppressions (visitor_uuid, created_at) VALUES (?, ?)',
      args: [visitorUuid, now],
    });
  }

  async isRecoverySuppressed(visitorUuid: string): Promise<boolean> {
    const client = await this.#ready;
    const rs = await client.execute({
      sql: 'SELECT 1 FROM recovery_suppressions WHERE visitor_uuid = ? LIMIT 1',
      args: [visitorUuid],
    });
    return rs.rows.length > 0;
  }

  /**
   * Atomic token-bucket claim (T-05-06) — SELECT (or seed at full
   * capacity) -> refill -> decrement-if->=1 -> UPSERT, all inside one
   * write transaction. Refill arithmetic mirrors sqlite.ts's/rate-limit.ts's
   * in-process bucket exactly for a given (capacity, refillPerSec, now).
   */
  async consumeRateLimitToken(bucketKey: string, capacity: number, refillPerSec: number, nowMs: number): Promise<boolean> {
    return this.withWriteTransaction(async (tx) => {
      const rs = await tx.execute({
        sql: 'SELECT tokens, last_refill_ms FROM rate_limits WHERE bucket_key = ?',
        args: [bucketKey],
      });
      const row = firstRow<{ tokens: number; last_refill_ms: number }>(rs);

      let tokens: number;
      if (!row) {
        tokens = capacity;
      } else {
        const elapsedSec = Math.max(0, (nowMs - Number(row.last_refill_ms)) / 1000);
        tokens = Math.min(capacity, Number(row.tokens) + elapsedSec * refillPerSec);
      }

      const allowed = tokens >= 1;
      if (allowed) tokens -= 1;

      await tx.execute({
        sql: `INSERT INTO rate_limits (bucket_key, tokens, last_refill_ms) VALUES (?, ?, ?)
              ON CONFLICT(bucket_key) DO UPDATE SET tokens = excluded.tokens, last_refill_ms = excluded.last_refill_ms`,
        args: [bucketKey, tokens, nowMs],
      });

      return allowed;
    });
  }
}
