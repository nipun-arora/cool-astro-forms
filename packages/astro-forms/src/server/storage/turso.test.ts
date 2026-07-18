import { describe, it, expect } from 'vitest';
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
    expect(MIGRATION_SQL.length).toBe(5);
    expect(MIGRATION_SQL[4]).toContain('rate_limits');
    expect(MIGRATION_SQL[4]).toContain('bucket_key');
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

  it('consumeRateLimitToken: N overlapping calls against a single-token bucket resolve to exactly one true', async () => {
    const adapter = new TursoStorage(':memory:');
    const results = await Promise.all(
      Array.from({ length: 8 }, () => adapter.consumeRateLimitToken('concurrent-bucket', 1, 0, 1_000_000)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
