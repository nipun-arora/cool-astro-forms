import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runStorageContract } from './adapter.contract.js';
import { SqliteStorage } from './sqlite.js';
import { getDb, resetDbCache } from './db.js';
import { MIGRATIONS } from './migrations.js';

// ---------------------------------------------------------------------------
// Generic contract — every case here exercises ONLY the public
// StorageAdapter interface. A fresh in-memory db is created per test.
// ---------------------------------------------------------------------------

runStorageContract(() => {
  resetDbCache();
  return new SqliteStorage(getDb(':memory:'));
});

// ---------------------------------------------------------------------------
// SQLite-specific behavior not covered by the generic contract.
// ---------------------------------------------------------------------------

describe('SqliteStorage — SQLite-specific behavior', () => {
  let db: Database.Database;
  let adapter: SqliteStorage;

  beforeEach(() => {
    resetDbCache();
    db = getDb(':memory:');
    adapter = new SqliteStorage(db);
  });

  afterEach(() => {
    resetDbCache();
  });

  it('throws when inserting a row with an out-of-enum status (CHECK constraint enforced)', async () => {
    await expect(
      adapter.createEntry({
        siteId: 'site-a',
        formId: 'form-1',
        status: 'bogus' as never,
        fields: {},
        visitorUuid: 'visitor-1',
      }),
    ).rejects.toThrow();
  });

  it('round-trips fields/journey JSON (object in -> equal object out)', async () => {
    const journey = [{ url: '/a', title: 'A', ts: 1, durationMs: 500 }];
    const entry = await adapter.createEntry({
      siteId: 'site-a',
      formId: 'form-1',
      status: 'abandoned',
      fields: { name: 'Ada', nested: { a: 1 } },
      visitorUuid: 'visitor-1',
      journey,
    });
    expect(entry.fields).toEqual({ name: 'Ada', nested: { a: 1 } });
    expect(entry.journey).toEqual(journey);
  });

  it('upsertAbandoned runs inside a single db.transaction(...).immediate() call (source assertion)', () => {
    const source = fs.readFileSync(new URL('./sqlite.ts', import.meta.url), 'utf8');
    const start = source.indexOf('async upsertAbandoned');
    const end = source.indexOf('async convertAndCreateSubmitted');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);
    expect(body).toContain('.transaction(');
    expect(body).toContain('.immediate(');
  });

  it('prefixes a formula-leading field value with a single quote in exportCsv', async () => {
    await adapter.createEntry({
      siteId: 'site-a',
      formId: 'form-1',
      status: 'abandoned',
      fields: { note: '=cmd|calc' },
      visitorUuid: 'visitor-1',
    });
    const csv = await adapter.exportCsv({ siteId: 'site-a' });
    expect(csv).toContain("'=cmd|calc");
  });

  it('skips a corrupted JSON row and logs storage.corrupt-row instead of throwing', async () => {
    const entry = await adapter.createEntry({
      siteId: 'site-a',
      formId: 'form-1',
      status: 'abandoned',
      fields: {},
      visitorUuid: 'visitor-1',
    });
    db.prepare('UPDATE entries SET fields = ? WHERE id = ?').run('{not valid json', entry.id);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const results = await adapter.listEntries({ siteId: 'site-a' });
    expect(results.map((e) => e.id)).not.toContain(entry.id);

    expect(errorSpy).toHaveBeenCalled();
    const firstCallArg = errorSpy.mock.calls[0]?.[0] as string;
    const logged = JSON.parse(firstCallArg);
    expect(logged.event).toBe('storage.corrupt-row');
    errorSpy.mockRestore();
  });

  it('cascades payments and files deletion in the same transaction as purgeVisitor', async () => {
    const entry = await adapter.createEntry({
      siteId: 'site-a',
      formId: 'form-1',
      status: 'abandoned',
      fields: {},
      visitorUuid: 'visitor-cascade',
    });
    await adapter.attachPayment(entry.id, { provider: 'stripe', status: 'paid' });
    await adapter.attachFiles(entry.id, [{ filename: 'a.pdf' }]);

    const beforePayments = db.prepare('SELECT COUNT(*) as c FROM payments').get() as { c: number };
    const beforeFiles = db.prepare('SELECT COUNT(*) as c FROM files').get() as { c: number };
    expect(beforePayments.c).toBe(1);
    expect(beforeFiles.c).toBe(1);

    const deleted = await adapter.purgeVisitor('visitor-cascade');
    expect(deleted).toBe(1);

    const afterPayments = db.prepare('SELECT COUNT(*) as c FROM payments').get() as { c: number };
    const afterFiles = db.prepare('SELECT COUNT(*) as c FROM files').get() as { c: number };
    expect(afterPayments.c).toBe(0);
    expect(afterFiles.c).toBe(0);
  });

  describe('last_field persistence', () => {
    it('createEntry persists lastField and reads it back on the mapped Entry', async () => {
      const entry = await adapter.createEntry({
        siteId: 'site-a',
        formId: 'form-1',
        status: 'abandoned',
        fields: { email: 'jane@example.com' },
        visitorUuid: 'visitor-1',
        lastField: 'email',
      });
      expect(entry.lastField).toBe('email');

      const raw = db.prepare('SELECT last_field FROM entries WHERE id = ?').get(entry.id) as {
        last_field: string | null;
      };
      expect(raw.last_field).toBe('email');
    });

    it('createEntry without lastField reads back undefined (null column, matching ip/geo null-handling)', async () => {
      const entry = await adapter.createEntry({
        siteId: 'site-a',
        formId: 'form-1',
        status: 'abandoned',
        fields: {},
        visitorUuid: 'visitor-1',
      });
      expect(entry.lastField).toBeUndefined();
    });

    it('updateEntry patches last_field', async () => {
      const entry = await adapter.createEntry({
        siteId: 'site-a',
        formId: 'form-1',
        status: 'abandoned',
        fields: {},
        visitorUuid: 'visitor-1',
        lastField: 'name',
      });
      const updated = await adapter.updateEntry(entry.id, { lastField: 'email' });
      expect(updated.lastField).toBe('email');
    });

    it('upsertAbandoned UPDATE branch overwrites last_field with the newer edited field', async () => {
      await adapter.upsertAbandoned(
        { siteId: 'site-a', formId: 'form-1', fields: { email: 'a@example.com' }, visitorUuid: 'visitor-1', lastField: 'email' },
        60,
      );
      const second = await adapter.upsertAbandoned(
        {
          siteId: 'site-a',
          formId: 'form-1',
          fields: { email: 'a@example.com', phone: '555-0100' },
          visitorUuid: 'visitor-1',
          lastField: 'phone',
        },
        60,
      );
      expect(second.outcome).toBe('updated');
      expect(second.entry?.lastField).toBe('phone');
    });
  });

  describe('recordFormStart', () => {
    it('is idempotent: two calls for the same (site,form,visitor) triple leave exactly one row', async () => {
      await adapter.recordFormStart('site-a', 'form-1', 'visitor-1');
      await adapter.recordFormStart('site-a', 'form-1', 'visitor-1');
      const count = db.prepare('SELECT COUNT(*) as c FROM form_starts').get() as { c: number };
      expect(count.c).toBe(1);
    });

    it('a different visitor adds a second row', async () => {
      await adapter.recordFormStart('site-a', 'form-1', 'visitor-1');
      await adapter.recordFormStart('site-a', 'form-1', 'visitor-2');
      const count = db.prepare('SELECT COUNT(*) as c FROM form_starts').get() as { c: number };
      expect(count.c).toBe(2);
    });
  });

  describe('getEntryById', () => {
    it('returns the mapped Entry for an existing id', async () => {
      const created = await adapter.createEntry({
        siteId: 'site-a',
        formId: 'form-1',
        status: 'abandoned',
        fields: { email: 'jane@example.com' },
        visitorUuid: 'visitor-1',
      });
      const found = await adapter.getEntryById(created.id);
      expect(found?.id).toBe(created.id);
      expect(found?.fields).toEqual({ email: 'jane@example.com' });
    });

    it('returns undefined for a missing id', async () => {
      expect(await adapter.getEntryById('does-not-exist')).toBeUndefined();
    });
  });

  describe('deleteEntry', () => {
    it('hard-deletes the entry plus its payments/files rows, returns true; a repeat call returns false; other rows untouched', async () => {
      const entry = await adapter.createEntry({
        siteId: 'site-a',
        formId: 'form-1',
        status: 'abandoned',
        fields: {},
        visitorUuid: 'visitor-delete',
      });
      await adapter.attachPayment(entry.id, { provider: 'stripe', status: 'paid' });
      await adapter.attachFiles(entry.id, [{ filename: 'a.pdf' }]);
      const other = await adapter.createEntry({
        siteId: 'site-a',
        formId: 'form-1',
        status: 'abandoned',
        fields: {},
        visitorUuid: 'visitor-other',
      });

      const deleted = await adapter.deleteEntry(entry.id);
      expect(deleted).toBe(true);

      expect(await adapter.getEntryById(entry.id)).toBeUndefined();
      const payments = db.prepare('SELECT COUNT(*) as c FROM payments WHERE entry_id = ?').get(entry.id) as {
        c: number;
      };
      const files = db.prepare('SELECT COUNT(*) as c FROM files WHERE entry_id = ?').get(entry.id) as {
        c: number;
      };
      expect(payments.c).toBe(0);
      expect(files.c).toBe(0);

      expect(await adapter.getEntryById(other.id)).toBeDefined();

      const again = await adapter.deleteEntry(entry.id);
      expect(again).toBe(false);
    });
  });

  describe('consumeRateLimitToken — atomicity + source assertion', () => {
    it('runs inside a single db.transaction(...).immediate() call (source assertion, mirrors markRecoverySent)', () => {
      const source = fs.readFileSync(new URL('./sqlite.ts', import.meta.url), 'utf8');
      const start = source.indexOf('async consumeRateLimitToken');
      expect(start).toBeGreaterThan(-1);
      const body = source.slice(start, start + 1600);
      expect(body).toContain('.transaction(');
      expect(body).toContain('.immediate(');
    });

    it('two overlapping calls against the same key with exactly one token left resolve to exactly one true (BEGIN IMMEDIATE serialization)', async () => {
      const results = await Promise.all([
        adapter.consumeRateLimitToken('concurrent-key', 1, 0, 1_000_000),
        adapter.consumeRateLimitToken('concurrent-key', 1, 0, 1_000_000),
      ]);
      const trueCount = results.filter(Boolean).length;
      expect(trueCount).toBe(1);
    });

    it('persists tokens/last_refill_ms as a real row in the rate_limits table', async () => {
      await adapter.consumeRateLimitToken('bucket-persist', 5, 1, 2_000_000);
      const row = db.prepare('SELECT * FROM rate_limits WHERE bucket_key = ?').get('bucket-persist') as
        | { bucket_key: string; tokens: number; last_refill_ms: number }
        | undefined;
      expect(row).toBeDefined();
      expect(row?.tokens).toBe(4);
      expect(row?.last_refill_ms).toBe(2_000_000);
    });
  });
});

// ---------------------------------------------------------------------------
// db.ts — boot guard, pre-migration backup, journal-mode visibility.
// ---------------------------------------------------------------------------

describe('db.ts — boot guard, backup, journal mode', () => {
  let tmpDir: string;

  beforeEach(() => {
    resetDbCache();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caf-db-'));
  });

  afterEach(() => {
    resetDbCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.NODE_ENV;
  });

  it('refuses to boot when user_version exceeds known migrations, naming both versions', () => {
    const dbPath = path.join(tmpDir, 'forms.db');
    const raw = new Database(dbPath);
    raw.pragma(`user_version = ${MIGRATIONS.length + 1}`);
    raw.close();

    expect(() => getDb(dbPath)).toThrow(
      new RegExp(`v${MIGRATIONS.length + 1}.*v${MIGRATIONS.length}`),
    );
  });

  it('sets journal_mode=WAL and busy_timeout=5000, and logs storage.boot with the achieved journal mode', () => {
    const dbPath = path.join(tmpDir, 'forms.db');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const opened = getDb(dbPath);
    expect(opened.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(opened.pragma('busy_timeout', { simple: true })).toBe(5000);

    const bootLogCall = logSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string))
      .find((record) => record.event === 'storage.boot');
    expect(bootLogCall).toBeDefined();
    expect(bootLogCall.journalMode).toBe('wal');
    expect(bootLogCall.dbPath).toBe(dbPath);
    logSpy.mockRestore();
  });

  it('resolves CAF_DB_PATH env var and falls back to data/forms.db by default (source assertion)', () => {
    const source = fs.readFileSync(new URL('./db.ts', import.meta.url), 'utf8');
    expect(source).toContain('process.env.CAF_DB_PATH');
    expect(source).toContain("'data/forms.db'");
  });

  it('backs up via VACUUM INTO before a pending migration in production, pruning to the 3 most recent backups', () => {
    process.env.NODE_ENV = 'production';
    const dbPath = path.join(tmpDir, 'forms.db');

    // Pre-seed 4 stale backup files with small, distinctly-ordered embedded
    // timestamps so a single real backup event plus retention pruning is
    // enough to prove both "a backup appears" and "prune keeps only 3".
    for (let i = 0; i < 4; i++) {
      fs.writeFileSync(path.join(tmpDir, `forms.db.backup-v0-${1000 + i}`), '');
    }

    getDb(dbPath); // fresh db, pending migration -> triggers a real backup + prune

    const backups = fs.readdirSync(tmpDir).filter((f) => f.startsWith('forms.db.backup-'));
    expect(backups.length).toBe(3);
  });

  it('escapes an embedded single quote in the db path before VACUUM INTO (does not throw)', () => {
    process.env.NODE_ENV = 'production';
    const quotedDir = path.join(tmpDir, "it's-a-test");
    fs.mkdirSync(quotedDir, { recursive: true });
    const dbPath = path.join(quotedDir, 'forms.db');

    expect(() => getDb(dbPath)).not.toThrow();

    const backups = fs.readdirSync(quotedDir).filter((f) => f.startsWith('forms.db.backup-'));
    expect(backups.length).toBeGreaterThan(0);
  });

  it('source: db.ts doubles embedded single quotes before interpolating into VACUUM INTO', () => {
    const source = fs.readFileSync(new URL('./db.ts', import.meta.url), 'utf8');
    expect(source).toContain(".replace(/'/g");
  });
});

// ---------------------------------------------------------------------------
// migrations.ts — v2 (last_field column + form_starts table, additive-only)
// ---------------------------------------------------------------------------

describe('migrations — v2 (last_field + form_starts)', () => {
  beforeEach(() => {
    resetDbCache();
  });

  afterEach(() => {
    resetDbCache();
  });

  it('boots a fresh :memory: db at the latest user_version with a nullable last_field column and a form_starts table with a unique (site_id, form_id, visitor_uuid) index', () => {
    const db = getDb(':memory:');
    // A fresh boot always lands on the latest schema (MIGRATIONS.length) —
    // this test only asserts v2's artifacts exist, not that v2 is the ceiling
    // (v3 added its own dedicated migration test in the block below).
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);

    const entryCols = db.prepare('PRAGMA table_info(entries)').all() as {
      name: string;
      notnull: number;
    }[];
    const lastField = entryCols.find((c) => c.name === 'last_field');
    expect(lastField).toBeDefined();
    expect(lastField?.notnull).toBe(0);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='form_starts'")
      .all();
    expect(tables).toHaveLength(1);

    const indexes = db.prepare("PRAGMA index_list('form_starts')").all() as {
      name: string;
      unique: number;
    }[];
    const uniqueIdx = indexes.find((i) => i.name === 'idx_form_starts_unique');
    expect(uniqueIdx).toBeDefined();
    expect(uniqueIdx?.unique).toBe(1);
  });

  it('migrates an existing v1 db forward to the latest version without error, and old rows survive with last_field undefined on read-back', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caf-migrate-'));
    const dbPath = path.join(tmpDir, 'forms.db');

    // Build a v1-only db, applying ONLY the first migration (simulates a
    // deployed forms.db that predates v2).
    const raw = new Database(dbPath);
    MIGRATIONS[0]!(raw);
    raw.pragma('user_version = 1');
    raw
      .prepare(
        `INSERT INTO entries (id, site_id, form_id, status, fields, visitor_uuid, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run('legacy-1', 'site-a', 'form-1', 'abandoned', '{}', 'visitor-1', Date.now(), Date.now());
    raw.close();

    expect(() => getDb(dbPath)).not.toThrow();
    const migrated = getDb(dbPath);
    // getDb always runs ALL pending migrations, not just v2 — this db lands
    // on the latest version (MIGRATIONS.length), same reasoning as above.
    expect(migrated.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);

    const row = migrated.prepare('SELECT * FROM entries WHERE id = ?').get('legacy-1') as
      | { last_field: unknown }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.last_field).toBeNull();

    const legacyAdapter = new SqliteStorage(migrated);
    expect(legacyAdapter).toBeDefined();

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a db at a future/unknown user_version (MIGRATIONS.length + 1) still refuses to boot', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caf-future-'));
    const dbPath = path.join(tmpDir, 'forms.db');
    const raw = new Database(dbPath);
    raw.pragma(`user_version = ${MIGRATIONS.length + 1}`);
    raw.close();

    expect(() => getDb(dbPath)).toThrow(
      new RegExp(`v${MIGRATIONS.length + 1}.*v${MIGRATIONS.length}`),
    );

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// migrations.ts — v3 (payments.provider_ref + indexes, additive-only)
// ---------------------------------------------------------------------------

describe('migrations — v3 (provider_ref + indexes)', () => {
  beforeEach(() => {
    resetDbCache();
  });

  afterEach(() => {
    resetDbCache();
  });

  it('migrates a v2 db forward to v3 additively: provider_ref column + both indexes appear, pre-existing payments row survives with provider_ref NULL', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caf-migrate-v3-'));
    const dbPath = path.join(tmpDir, 'forms.db');

    // Build a v2-only db, applying ONLY migrations[0] and migrations[1]
    // (simulates a deployed forms.db that predates v3).
    const raw = new Database(dbPath);
    MIGRATIONS[0]!(raw);
    MIGRATIONS[1]!(raw);
    raw.pragma('user_version = 2');
    raw
      .prepare(
        `INSERT INTO entries (id, site_id, form_id, status, fields, visitor_uuid, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run('legacy-entry-1', 'site-a', 'form-1', 'abandoned', '{}', 'visitor-1', Date.now(), Date.now());
    raw
      .prepare(
        `INSERT INTO payments (id, entry_id, provider, amount_cents, currency, status, pay_link_url, provider_ids, events, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        'legacy-payment-1',
        'legacy-entry-1',
        'stripe',
        500,
        'usd',
        'link_created',
        null,
        null,
        null,
        Date.now(),
        Date.now(),
      );
    raw.close();

    expect(() => getDb(dbPath)).not.toThrow();
    const migrated = getDb(dbPath);
    // getDb always runs ALL pending migrations, not just v3 — this db lands
    // on the latest version (MIGRATIONS.length), same reasoning as the v2
    // migration test above (now that v4 exists, the ceiling moved past 3).
    expect(migrated.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);

    const paymentCols = migrated.prepare('PRAGMA table_info(payments)').all() as {
      name: string;
      notnull: number;
    }[];
    const providerRef = paymentCols.find((c) => c.name === 'provider_ref');
    expect(providerRef).toBeDefined();
    expect(providerRef?.notnull).toBe(0);

    const row = migrated.prepare('SELECT * FROM payments WHERE id = ?').get('legacy-payment-1') as
      | { provider_ref: unknown; amount_cents: unknown }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.provider_ref).toBeNull();
    expect(row?.amount_cents).toBe(500);

    const indexes = migrated.prepare("PRAGMA index_list('payments')").all() as { name: string }[];
    expect(indexes.some((i) => i.name === 'idx_payments_provider_ref')).toBe(true);
    expect(indexes.some((i) => i.name === 'idx_payments_created')).toBe(true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// migrations.ts — v4 (recovery_sent_at + consent_at + recovery_suppressions
// + idx_entries_recovery, additive-only)
// ---------------------------------------------------------------------------

describe('migrations — v4 (recovery columns + recovery_suppressions + index)', () => {
  beforeEach(() => {
    resetDbCache();
  });

  afterEach(() => {
    resetDbCache();
  });

  it('migrates a v3 db forward to v4 additively: recovery_sent_at + consent_at columns + recovery_suppressions table + idx_entries_recovery appear, pre-existing entries/payments rows survive with the new columns NULL', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caf-migrate-v4-'));
    const dbPath = path.join(tmpDir, 'forms.db');

    // Build a v3-only db, applying ONLY migrations[0..2] (simulates a
    // deployed forms.db that predates v4 — a real production migration shape).
    const raw = new Database(dbPath);
    MIGRATIONS[0]!(raw);
    MIGRATIONS[1]!(raw);
    MIGRATIONS[2]!(raw);
    raw.pragma('user_version = 3');
    raw
      .prepare(
        `INSERT INTO entries (id, site_id, form_id, status, fields, visitor_uuid, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run('legacy-entry-v3', 'site-a', 'form-1', 'abandoned', '{}', 'visitor-1', Date.now(), Date.now());
    raw
      .prepare(
        `INSERT INTO payments (id, entry_id, provider, amount_cents, currency, status, pay_link_url, provider_ref, provider_ids, events, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        'legacy-payment-v3',
        'legacy-entry-v3',
        'stripe',
        500,
        'usd',
        'link_created',
        null,
        null,
        null,
        null,
        Date.now(),
        Date.now(),
      );
    raw.close();

    expect(() => getDb(dbPath)).not.toThrow();
    const migrated = getDb(dbPath);
    // getDb always runs ALL pending migrations, not just v4 — this db lands
    // on the latest version (MIGRATIONS.length), same reasoning as the v2/v3
    // migration tests above (now that v5 exists, the ceiling moved past 4).
    expect(migrated.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);

    const entryCols = migrated.prepare('PRAGMA table_info(entries)').all() as {
      name: string;
      notnull: number;
    }[];
    const recoverySentAt = entryCols.find((c) => c.name === 'recovery_sent_at');
    const consentAt = entryCols.find((c) => c.name === 'consent_at');
    expect(recoverySentAt).toBeDefined();
    expect(recoverySentAt?.notnull).toBe(0);
    expect(consentAt).toBeDefined();
    expect(consentAt?.notnull).toBe(0);

    const tables = migrated
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='recovery_suppressions'")
      .all();
    expect(tables).toHaveLength(1);

    const entryIndexes = migrated.prepare("PRAGMA index_list('entries')").all() as { name: string }[];
    expect(entryIndexes.some((i) => i.name === 'idx_entries_recovery')).toBe(true);

    const entryRow = migrated.prepare('SELECT * FROM entries WHERE id = ?').get('legacy-entry-v3') as
      | { recovery_sent_at: unknown; consent_at: unknown }
      | undefined;
    expect(entryRow).toBeDefined();
    expect(entryRow?.recovery_sent_at).toBeNull();
    expect(entryRow?.consent_at).toBeNull();

    const paymentRow = migrated.prepare('SELECT * FROM payments WHERE id = ?').get('legacy-payment-v3') as
      | { amount_cents: unknown }
      | undefined;
    expect(paymentRow).toBeDefined();
    expect(paymentRow?.amount_cents).toBe(500);

    const legacyAdapter = new SqliteStorage(migrated);
    expect(legacyAdapter).toBeDefined();

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// migrations.ts — v5 (rate_limits table, additive-only, Phase 5 Plan 02)
// ---------------------------------------------------------------------------

describe('migrations — v5 (rate_limits table)', () => {
  beforeEach(() => {
    resetDbCache();
  });

  afterEach(() => {
    resetDbCache();
  });

  it('boots a fresh :memory: db at user_version 5 with the rate_limits table present (bucket_key PK, tokens/last_refill_ms NOT NULL)', () => {
    const db = getDb(':memory:');
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(MIGRATIONS.length).toBe(5);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rate_limits'")
      .all();
    expect(tables).toHaveLength(1);

    const cols = db.prepare('PRAGMA table_info(rate_limits)').all() as {
      name: string;
      notnull: number;
      pk: number;
    }[];
    const bucketKey = cols.find((c) => c.name === 'bucket_key');
    const tokens = cols.find((c) => c.name === 'tokens');
    const lastRefillMs = cols.find((c) => c.name === 'last_refill_ms');
    expect(bucketKey?.pk).toBe(1);
    expect(tokens).toBeDefined();
    expect(tokens?.notnull).toBe(1);
    expect(lastRefillMs).toBeDefined();
    expect(lastRefillMs?.notnull).toBe(1);
  });

  it('migrates a v4 db forward to v5 additively: rate_limits table appears, pre-existing entries/payments rows survive untouched', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caf-migrate-v5-'));
    const dbPath = path.join(tmpDir, 'forms.db');

    // Build a v4-only db, applying ONLY migrations[0..3] (simulates a
    // deployed forms.db that predates v5).
    const raw = new Database(dbPath);
    MIGRATIONS[0]!(raw);
    MIGRATIONS[1]!(raw);
    MIGRATIONS[2]!(raw);
    MIGRATIONS[3]!(raw);
    raw.pragma('user_version = 4');
    raw
      .prepare(
        `INSERT INTO entries (id, site_id, form_id, status, fields, visitor_uuid, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run('legacy-entry-v4', 'site-a', 'form-1', 'abandoned', '{}', 'visitor-1', Date.now(), Date.now());
    raw
      .prepare(
        `INSERT INTO payments (id, entry_id, provider, amount_cents, currency, status, pay_link_url, provider_ref, provider_ids, events, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run('legacy-payment-v4', 'legacy-entry-v4', 'stripe', 500, 'usd', 'link_created', null, null, null, null, Date.now(), Date.now());
    raw.close();

    expect(() => getDb(dbPath)).not.toThrow();
    const migrated = getDb(dbPath);
    expect(migrated.pragma('user_version', { simple: true })).toBe(5);

    const tables = migrated
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rate_limits'")
      .all();
    expect(tables).toHaveLength(1);

    const entryRow = migrated.prepare('SELECT * FROM entries WHERE id = ?').get('legacy-entry-v4') as
      | { id: string }
      | undefined;
    expect(entryRow).toBeDefined();

    const paymentRow = migrated.prepare('SELECT * FROM payments WHERE id = ?').get('legacy-payment-v4') as
      | { amount_cents: unknown }
      | undefined;
    expect(paymentRow).toBeDefined();
    expect(paymentRow?.amount_cents).toBe(500);

    const legacyAdapter = new SqliteStorage(migrated);
    expect(legacyAdapter).toBeDefined();

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('MIGRATION_SQL single-sources the DDL: MIGRATIONS has the same length and each entry db.exec()s the matching MIGRATION_SQL string (source assertion)', async () => {
    const { MIGRATION_SQL } = await import('./migrations.js');
    expect(MIGRATION_SQL).toHaveLength(MIGRATIONS.length);
    expect(MIGRATION_SQL[4]).toContain('rate_limits');
    expect(MIGRATION_SQL[4]).toContain('bucket_key');
  });
});
