/**
 * export-db.ts tests — GET /forms-admin/export.db (ADMN-03): full SQLite
 * snapshot download via better-sqlite3's native ASYNC db.backup()
 * (WAL-consistent, non-blocking -- T-02-29). The downloaded bytes must
 * re-open as a valid, schema-complete SQLite database (entries/payments/
 * files/form_starts); the intermediate tmp file must always be cleaned up
 * (T-02-27), even on a backup/read failure.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Mutable, shared across tests (mirrors middleware.test.ts's mockConfig
 * convention) so the storage-backend-gate tests below (05-04 B2) can flip
 * `storage.kind` per test without re-mocking the virtual module. `storage`
 * starts `undefined` — the existing three tests never set it, exercising
 * the "absent = sqlite" branch the gate must preserve byte-identically.
 */
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    siteId: 'demo-site',
    siteUrl: 'https://example.com',
    dbPath: ':memory:',
    storage: undefined as { kind: 'sqlite' | 'turso' } | undefined,
  },
}));

vi.mock('virtual:cool-astro-forms/config', () => ({ default: mockConfig }));
vi.mock('../../log.js', () => ({ log: vi.fn(), logError: vi.fn() }));

import { getDb, resetDbCache } from '../../storage/db.js';
import { SqliteStorage } from '../../storage/sqlite.js';
import { GET } from './export-db.js';

const TMP_PREFIX = 'caf-export-db-';

async function tmpFilesSnapshot(): Promise<string[]> {
  const names = await fs.readdir(os.tmpdir());
  return names.filter((n) => n.startsWith(TMP_PREFIX));
}

describe('GET /forms-admin/export.db', () => {
  beforeEach(() => {
    resetDbCache();
    mockConfig.storage = undefined;
  });

  afterEach(() => {
    resetDbCache();
    mockConfig.storage = undefined;
  });

  it('returns a 200 application/vnd.sqlite3 attachment with a re-openable, schema-complete snapshot including seeded rows', async () => {
    const storage = new SqliteStorage(getDb(':memory:'));
    const entry = await storage.createEntry({
      siteId: 'demo-site',
      formId: 'contact',
      status: 'submitted',
      fields: { name: 'Ada' },
      visitorUuid: 'visitor-1',
    });

    const res = await GET({} as unknown as Parameters<typeof GET>[0]);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/vnd.sqlite3');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="forms.db"');

    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(0);

    const reopenPath = path.join(os.tmpdir(), `export-db-reopen-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    await fs.writeFile(reopenPath, bytes);
    try {
      const reopened = new Database(reopenPath, { readonly: true });
      const tables = (reopened.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
        (r) => r.name,
      );
      expect(tables).toEqual(expect.arrayContaining(['entries', 'payments', 'files', 'form_starts']));
      const row = reopened.prepare('SELECT id FROM entries WHERE id = ?').get(entry.id);
      expect(row).toBeTruthy();
      reopened.close();
    } finally {
      await fs.unlink(reopenPath).catch(() => undefined);
    }
  });

  it('cleans up the intermediate tmp file after a successful backup (no lingering caf-export-db-* files)', async () => {
    getDb(':memory:');
    const before = await tmpFilesSnapshot();
    await GET({} as unknown as Parameters<typeof GET>[0]);
    const after = await tmpFilesSnapshot();
    expect(after.length).toBe(before.length);
  });

  it('resolves a logged 500 when db.backup() throws, and still cleans up any tmp artifact', async () => {
    const db = getDb(':memory:');
    vi.spyOn(db, 'backup').mockRejectedValueOnce(new Error('backup failed'));

    const before = await tmpFilesSnapshot();
    const res = await GET({} as unknown as Parameters<typeof GET>[0]);
    expect(res.status).toBe(500);
    const after = await tmpFilesSnapshot();
    expect(after.length).toBe(before.length);
  });

  // ---------------------------------------------------------------------
  // Storage backend gate (05-04 B2, ADPT-01/T-05-30) — better-sqlite3's
  // native db.backup() has no adapter equivalent, so a turso host must get
  // a clear non-500 response instead of a 500 or a stale local-file download.
  // ---------------------------------------------------------------------
  describe('storage backend gate (05-04 B2)', () => {
    it('returns a clear, non-500 501 and NEVER calls getDb().backup() when storage.kind is "turso"', async () => {
      mockConfig.storage = { kind: 'turso' };
      const db = getDb(':memory:');
      const backupSpy = vi.spyOn(db, 'backup');

      const res = await GET({} as unknown as Parameters<typeof GET>[0]);

      expect(res.status).toBe(501);
      expect(res.status).not.toBe(500);
      expect(backupSpy).not.toHaveBeenCalled();
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/sqlite storage backend/i);
    });

    it('still serves the sqlite snapshot when storage.kind is explicitly "sqlite" (not just absent)', async () => {
      mockConfig.storage = { kind: 'sqlite' };
      getDb(':memory:');

      const res = await GET({} as unknown as Parameters<typeof GET>[0]);

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/vnd.sqlite3');
    });

    it('leaves no tmp artifact behind for the gated (turso) response — the tmp-file machinery is never entered', async () => {
      mockConfig.storage = { kind: 'turso' };
      const before = await tmpFilesSnapshot();
      await GET({} as unknown as Parameters<typeof GET>[0]);
      const after = await tmpFilesSnapshot();
      expect(after.length).toBe(before.length);
    });
  });
});
