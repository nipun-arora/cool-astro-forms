import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Client } from '@libsql/client';
import { runStorageContract } from './adapter.contract.js';
import { TursoStorage } from './turso.js';
import { MIGRATION_SQL } from './migrations.js';

// ---------------------------------------------------------------------------
// Generic contract — the EXACT same suite sqlite.test.ts runs, unmodified,
// against a fresh @libsql/client `:memory:` TursoStorage per test (05-03
// Task 1). `runStorageContract`'s factory is SYNCHRONOUS; TursoStorage
// constructs synchronously and gates every method on a private #ready
// migration promise (see turso.ts docstring) so this call site needs no
// `await` — identical shape to sqlite.test.ts's `() => new SqliteStorage(...)`.
// ---------------------------------------------------------------------------

runStorageContract(() => new TursoStorage(':memory:'));

// ---------------------------------------------------------------------------
// Turso-specific: boot/migration assertions not covered by the generic
// contract (mirrors sqlite.test.ts's own "SQLite-specific behavior" block).
// ---------------------------------------------------------------------------

describe('TursoStorage — boot/migration', () => {
  it('constructs synchronously (no throw, no pending microtask required to obtain the instance)', () => {
    expect(() => new TursoStorage(':memory:')).not.toThrow();
  });

  it('a fresh :memory: client boots at the latest MIGRATION_SQL version with every table present', async () => {
    const adapter = new TursoStorage(':memory:');
    // Drive the #ready gate to completion via any public method, then
    // inspect the underlying client directly through a second entry point:
    // createEntry only succeeds once every migration table exists.
    const entry = await adapter.createEntry({
      siteId: 'site-a',
      formId: 'form-1',
      status: 'abandoned',
      fields: {},
      visitorUuid: 'visitor-1',
    });
    expect(entry.id).toBeTruthy();

    // consumeRateLimitToken only succeeds if the v5 rate_limits table
    // (the LAST migration entry) exists — a proxy for "booted to latest".
    const allowed = await adapter.consumeRateLimitToken('boot-check', 1, 0, Date.now());
    expect(allowed).toBe(true);
  });

  it('MIGRATION_SQL is the single source both backends walk (source assertion, mirrors sqlite.test.ts)', () => {
    expect(MIGRATION_SQL.length).toBe(6);
    expect(MIGRATION_SQL[4]).toContain('rate_limits');
    expect(MIGRATION_SQL[4]).toContain('bucket_key');
    // 0.1.17: the Stripe customer columns ride the same list, so Turso gets them without its own DDL.
    expect(MIGRATION_SQL[5]).toContain('customer_ref');
    expect(MIGRATION_SQL[5]).toContain('payer_email');
  });

  it('two independent :memory: TursoStorage instances do not share state (each gets its own private in-process database)', async () => {
    const a = new TursoStorage(':memory:');
    const b = new TursoStorage(':memory:');
    await a.createEntry({ siteId: 'site-a', formId: 'form-1', status: 'abandoned', fields: {}, visitorUuid: 'visitor-1' });
    const countA = await a.countEntries({ siteId: 'site-a' });
    const countB = await b.countEntries({ siteId: 'site-a' });
    expect(countA).toBe(1);
    expect(countB).toBe(0);
  });

  it('parameterized queries only — turso.ts never interpolates a value into a SQL string (T-05-08 grep gate)', async () => {
    const fs = await import('node:fs');
    const source = fs.readFileSync(new URL('./turso.ts', import.meta.url), 'utf8');
    const nonCommentLines = source.split('\n').filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'));
    const interpolations = nonCommentLines.filter((line) => line.includes('${'));
    expect(interpolations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Concurrency (05-03 Task 2) — the sequential contract suite above proves
// BEHAVIORAL correctness only (RESEARCH Anti-Pattern: "treating the contract
// suite's pass as sufficient proof of concurrency-safety" is exactly what
// NOT to do for a non-SQLite adapter). These `Promise.all` races prove
// `withWriteTransaction`'s serialization actually holds under real
// concurrent callers against `:memory:` — exactly-one-winner for every
// atomic-claim method (T-05-09).
// ---------------------------------------------------------------------------

describe('TursoStorage — concurrency (exactly-one-winner)', () => {
  it('attachPayment: overlapping writes of the same providerRef leave exactly one row (the existence check and the insert are one statement)', async () => {
    const adapter = new TursoStorage(':memory:');
    const entry = await adapter.createEntry({
      siteId: 'site-a',
      formId: 'form-1',
      status: 'submitted',
      fields: {},
      visitorUuid: 'visitor-1',
    });

    await Promise.all(
      Array.from({ length: 4 }, () =>
        adapter.attachPayment(entry.id, {
          provider: 'stripe',
          amountCents: 500,
          currency: 'usd',
          status: 'link_created',
          providerRef: 'cs_concurrent_attach',
        }),
      ),
    );

    const rows = await adapter.getPaymentsByEntry(entry.id);
    expect(rows.map((row) => row.providerRef)).toEqual(['cs_concurrent_attach']);
  });

  it('markRecoverySent: two overlapping calls for the same entry resolve to exactly one true', async () => {
    const adapter = new TursoStorage(':memory:');
    const entry = await adapter.createEntry({
      siteId: 'site-a',
      formId: 'form-1',
      status: 'abandoned',
      fields: {},
      visitorUuid: 'visitor-1',
    });
    const now = Date.now();
    await adapter.markConsent(entry.id, now);

    const results = await Promise.all([
      adapter.markRecoverySent(entry.id, now),
      adapter.markRecoverySent(entry.id, now),
      adapter.markRecoverySent(entry.id, now),
      adapter.markRecoverySent(entry.id, now),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);

    const after = await adapter.getEntryById(entry.id);
    expect(after?.recoverySentAt).toBe(now);
  });

  it('appendPaymentEventIfAbsent: two overlapping calls with the SAME eventId resolve to exactly one true, and the events array gains exactly one entry', async () => {
    const adapter = new TursoStorage(':memory:');
    const entry = await adapter.createEntry({
      siteId: 'site-a',
      formId: 'form-1',
      status: 'abandoned',
      fields: {},
      visitorUuid: 'visitor-1',
    });
    await adapter.attachPayment(entry.id, {
      provider: 'stripe',
      amountCents: 500,
      currency: 'usd',
      status: 'link_created',
      providerRef: 'cs_concurrent_1',
    });
    const [payment] = await adapter.getPaymentsByEntry(entry.id);
    expect(payment).toBeDefined();

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        adapter.appendPaymentEventIfAbsent(
          payment!.id,
          'evt_concurrent_1',
          { id: 'evt_concurrent_1', type: 'checkout.session.completed', at: 1000 },
          { status: 'paid' },
        ),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);

    const [after] = await adapter.getPaymentsByEntry(entry.id);
    expect(after?.events).toHaveLength(1);
    expect(after?.status).toBe('paid');
  });

  it('appendPaymentEventIfAbsent: overlapping redeliveries of one event each carrying a different Stripe customer record exactly one customer (the customer columns ride the same atomic patch)', async () => {
    const adapter = new TursoStorage(':memory:');
    const entry = await adapter.createEntry({
      siteId: 'site-a',
      formId: 'form-1',
      status: 'abandoned',
      fields: {},
      visitorUuid: 'visitor-1',
    });
    await adapter.attachPayment(entry.id, {
      provider: 'stripe',
      amountCents: 500,
      currency: 'usd',
      status: 'link_created',
      providerRef: 'cs_concurrent_cust',
    });
    const [payment] = await adapter.getPaymentsByEntry(entry.id);

    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        adapter.appendPaymentEventIfAbsent(
          payment!.id,
          'evt_concurrent_cust',
          { id: 'evt_concurrent_cust', type: 'checkout.session.completed', at: 1000 + i },
          { status: 'paid', customerRef: `cus_${i}`, payerEmail: `payer${i}@example.com` },
        ),
      ),
    );
    const winner = results.findIndex(Boolean);
    expect(results.filter(Boolean)).toHaveLength(1);

    const [after] = await adapter.getPaymentsByEntry(entry.id);
    expect(after?.customerRef).toBe(`cus_${winner}`);
    expect(after?.payerEmail).toBe(`payer${winner}@example.com`);
    expect(after?.events).toHaveLength(1);
  });

  it('consumeRateLimitToken: N overlapping calls against a single-token bucket resolve to exactly one true', async () => {
    const adapter = new TursoStorage(':memory:');
    const results = await Promise.all(
      Array.from({ length: 8 }, () => adapter.consumeRateLimitToken('concurrent-bucket', 1, 0, 1_000_000)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Migration atomicity (0.1.17 audit, LOW) — every MIGRATION_SQL block and its
// `user_version` bump commit as ONE write transaction, the version is re-
// checked inside that transaction, and an ADD COLUMN whose column already
// exists counts as applied. Without that, a crash between v6's two ALTERs
// (or two cold starts racing the same database) re-ran v6 on the next boot
// and failed on "duplicate column name" forever. These run against a real
// FILE database: two clients cannot share one `:memory:` database, and a
// half-applied file is exactly what a crash leaves behind.
// ---------------------------------------------------------------------------

describe('TursoStorage — migration atomicity', () => {
  let tmpDir: string;
  let url: string;
  let clients: Client[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caf-turso-migrate-'));
    url = 'file:' + path.join(tmpDir, 'forms.db');
    clients = [];
  });

  afterEach(() => {
    for (const client of clients) client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function openClient(): Promise<Client> {
    const { createClient } = await import('@libsql/client');
    const client = createClient({ url });
    clients.push(client);
    return client;
  }

  /** A deployed database at `version`, plus whatever half-finished DDL a crash left behind. */
  async function seedAtVersion(version: number, leftovers: string[] = []): Promise<void> {
    const client = await openClient();
    for (let i = 0; i < version; i++) await client.executeMultiple(MIGRATION_SQL[i]!);
    await client.execute('PRAGMA user_version = ' + String(version));
    for (const sql of leftovers) await client.execute(sql);
  }

  async function userVersion(): Promise<number> {
    const rs = await (await openClient()).execute('PRAGMA user_version');
    return Number(rs.rows[0]?.user_version);
  }

  async function columns(table: string): Promise<string[]> {
    const rs = await (await openClient()).execute({ sql: 'SELECT name FROM pragma_table_info(?)', args: [table] });
    return rs.rows.map((row) => String(row.name));
  }

  it('recovers a v5 database a crash left half-way through v6 (customer_ref added, payer_email and the version bump missing): boots to v6 with both columns', async () => {
    await seedAtVersion(5, ['ALTER TABLE payments ADD COLUMN customer_ref TEXT']);

    const adapter = new TursoStorage(url);
    await expect(adapter.countEntries({ siteId: 'site-a' })).resolves.toBe(0);

    expect(await userVersion()).toBe(6);
    const cols = await columns('payments');
    expect(cols.filter((name) => name === 'customer_ref')).toHaveLength(1);
    expect(cols).toContain('payer_email');
  });

  it('two adapters cold-starting against the same fresh database at once both boot to the latest version without error', async () => {
    const a = new TursoStorage(url);
    const b = new TursoStorage(url);

    await expect(Promise.all([a.countEntries({ siteId: 'site-a' }), b.countEntries({ siteId: 'site-a' })])).resolves.toEqual([0, 0]);
    expect(await userVersion()).toBe(MIGRATION_SQL.length);

    // One database, not two: a write through one adapter reads back through the other.
    await a.createEntry({ siteId: 'site-a', formId: 'form-1', status: 'abandoned', fields: {}, visitorUuid: 'visitor-1' });
    expect(await b.countEntries({ siteId: 'site-a' })).toBe(1);
  });

  it('a block that fails part-way leaves neither its earlier statements nor its version bump behind (block + bump are one transaction)', async () => {
    // v2 runs ALTER entries ADD last_field, then CREATE TABLE form_starts. A
    // stray form_starts table makes the second statement fail after the
    // first has already run.
    await seedAtVersion(1, ['CREATE TABLE form_starts (id TEXT PRIMARY KEY)']);

    const adapter = new TursoStorage(url);
    await expect(adapter.countEntries({ siteId: 'site-a' })).rejects.toThrow(/form_starts/);

    expect(await userVersion()).toBe(1);
    expect(await columns('entries')).not.toContain('last_field');
  });
});
