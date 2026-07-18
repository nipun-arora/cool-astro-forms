/**
 * Embedded SQL migrations, applied once at boot via the `user_version` pragma
 * (see db.ts). Each entry is a plain function that mutates the schema; the
 * array index + 1 becomes the resulting `user_version`.
 *
 * MIGRATION POLICY (additive-only, binding for all future phases — review S9):
 * migrations may only ADD nullable columns or new tables. Never rename or
 * drop a column/table, and never change a CHECK constraint on a table that
 * may already hold rows. A `git revert` cannot roll back a `user_version`
 * bump already applied to a deployed `data/forms.db` file, so any migration
 * that isn't safely re-appliable/forward-only would strand production
 * databases. If a column's meaning must change, add a new column and
 * migrate data forward in application code instead of altering the old one.
 *
 * DIALECT-NEUTRAL EXTRACTION (Phase 5, Plan 02): `MIGRATION_SQL` is the
 * single source of the raw DDL, identical SQLite dialect across v1..v5.
 * `MIGRATIONS` (the better-sqlite3 function array `getDb()`/db.ts walks) is
 * mechanically derived from it — each entry just does `db.exec(sql)`, so
 * db.ts's boot/migration semantics are byte-for-byte unchanged. This is the
 * source 05-03's Turso adapter walks via `client.executeMultiple` inside its
 * `#ready` gate — one list of migration SQL, both backends apply it against
 * `user_version`.
 */
import type Database from 'better-sqlite3';

export type Migration = (db: Database.Database) => void;

export const MIGRATION_SQL: string[] = [
  // v1 — initial schema: entries, payments, files (spec §4).
  `
    CREATE TABLE entries (
      id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL,
      form_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('abandoned','submitted','converted','spam')),
      fields TEXT NOT NULL,
      visitor_uuid TEXT NOT NULL,
      ip TEXT,
      user_agent TEXT,
      geo TEXT,
      journey TEXT,
      page_url TEXT,
      referrer TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- site_id leads: it joins the dedupe key (upsertAbandoned/findAbandoned).
    CREATE INDEX idx_entries_dedupe ON entries (site_id, visitor_uuid, form_id, status, updated_at);

    -- Phase 2 listEntries/analytics access path; free to create now while empty.
    CREATE INDEX idx_entries_status_created ON entries (site_id, status, created_at);

    -- Unused until Phase 3 (payments) — created now so the CHECK constraint
    -- exists before the table ever holds rows (SQLite cannot cheaply add a
    -- CHECK constraint after the fact).
    CREATE TABLE payments (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL,
      provider TEXT,
      amount_cents INTEGER,
      currency TEXT,
      status TEXT CHECK (status IN ('link_created','link_sent','paid','failed','refunded')),
      pay_link_url TEXT,
      provider_ids TEXT,
      events TEXT,
      created_at INTEGER,
      updated_at INTEGER
    );

    -- Unused until Phase 4 (Google Drive file storage) — same rationale.
    CREATE TABLE files (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL,
      filename TEXT,
      size_bytes INTEGER,
      mime TEXT,
      storage TEXT CHECK (storage IN ('drive','email-only')),
      drive_file_id TEXT,
      drive_link TEXT,
      created_at INTEGER
    );
  `,

  // v2 — ANLY-01 analytics foundation (Phase 2, Plan 01): last-edited-field
  // tracking on entries + a form_starts counter table. Additive-only per the
  // policy above: a nullable column and a brand-new table, nothing renamed
  // or dropped, no CHECK constraint touched on a table that may hold rows.
  `
    ALTER TABLE entries ADD COLUMN last_field TEXT;

    -- Counter-only table (D1): visitor_uuid + site_id + form_id + ts, no
    -- PII, no field values. Funnel "started" denominator.
    CREATE TABLE form_starts (
      id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL,
      form_id TEXT NOT NULL,
      visitor_uuid TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    -- Enforces idempotent recordFormStart via INSERT OR IGNORE.
    CREATE UNIQUE INDEX idx_form_starts_unique ON form_starts (site_id, form_id, visitor_uuid);
  `,

  // v3 — Payments read/write surface (Phase 3, Plan 01): the inbound-webhook
  // find key + two access-path indexes. Additive-only per the policy above:
  // one nullable column, two new indexes, nothing renamed/dropped, the
  // status CHECK and entry_id NOT NULL from v1 are untouched.
  `
    ALTER TABLE payments ADD COLUMN provider_ref TEXT;

    -- Inbound webhook lookup key (getPaymentByProviderRef).
    CREATE INDEX idx_payments_provider_ref ON payments (provider_ref);

    -- Entry-detail payment list (getPaymentsByEntry) + listPayments ordering.
    CREATE INDEX idx_payments_created ON payments (entry_id, created_at);
  `,

  // v4 — Lead recovery read/write surface (Phase 4, Plan 01): the double-
  // send gate + consent-basis timestamp on entries, a brand-new per-visitor
  // suppression table, and the sweep-query index. Additive-only per the
  // policy above: two nullable columns, one new table, one new index,
  // nothing renamed/dropped, the status CHECK from v1 is untouched.
  `
    ALTER TABLE entries ADD COLUMN recovery_sent_at INTEGER;
    ALTER TABLE entries ADD COLUMN consent_at INTEGER;

    -- Per-visitor never-email-again suppression (D4) — a brand-new table
    -- keyed by visitor_uuid, NOT a per-entry column, so it survives every
    -- FUTURE abandon row from the same visitor. Excluded from
    -- purgeVisitor's erasure cascade (D4a, sqlite.ts docstring) because
    -- the visitor UUID persists client-side through an erasure; deleting
    -- this row would re-enable contact on the visitor's next abandon.
    CREATE TABLE recovery_suppressions (
      visitor_uuid TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );

    -- Backs findRecoverableEntries' sweep query (status + consent_at +
    -- recovery_sent_at + updated_at, in that filter order).
    CREATE INDEX idx_entries_recovery ON entries (status, consent_at, recovery_sent_at, updated_at);
  `,

  // v5 — D2 fix #1 (Phase 5, Plan 02): persistent (adapter-backed) token-
  // bucket state for the OPT-IN StorageBackedRateLimiter, so rate limits
  // survive serverless cold starts (RESEARCH Pitfall 1). Additive-only per
  // the policy above: a brand-new table, nothing renamed/dropped, no CHECK
  // touched on a populated table. `bucket_key` is an arbitrary namespaced
  // string (e.g. 'abandon:<ip>') so future call sites can share this table
  // without colliding. This is also the FIRST migration entry Turso (05-03)
  // walks via the same dialect-neutral MIGRATION_SQL — no SQLite-only syntax
  // used here (no AUTOINCREMENT, no WITHOUT ROWID).
  `
    CREATE TABLE rate_limits (
      bucket_key TEXT PRIMARY KEY,
      tokens REAL NOT NULL,
      last_refill_ms INTEGER NOT NULL
    );
  `,
];

export const MIGRATIONS: Migration[] = MIGRATION_SQL.map((sql) => (db: Database.Database) => db.exec(sql));
