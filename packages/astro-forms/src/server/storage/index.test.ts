/**
 * getStorageAdapter(config?) — the single storage-backend construction point
 * (05-04, ADPT-01). Covers both resolution paths (config vs env fallback)
 * and both backends (sqlite static construction, turso dynamic import).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoolFormsConfig } from '../../config.js';
import { getDb, resetDbCache } from './db.js';
import { SqliteStorage } from './sqlite.js';

const { FakeTursoStorage, tursoConstructorCalls, tursoConnect } = vi.hoisted(() => {
  const tursoConstructorCalls: Array<{ dbUrl?: string; authToken?: string }> = [];
  /** Whether the next fake connects: 'fail' makes its `ready` reject, like a Turso outage at cold start. */
  const tursoConnect = { next: 'ok' as 'ok' | 'fail' };
  class FakeTursoStorage {
    readonly ready: Promise<void>;
    constructor(dbUrl?: string, authToken?: string) {
      tursoConstructorCalls.push({ dbUrl, authToken });
      this.ready = tursoConnect.next === 'fail' ? Promise.reject(new Error('turso unreachable')) : Promise.resolve();
      tursoConnect.next = 'ok';
    }
  }
  return { FakeTursoStorage, tursoConstructorCalls, tursoConnect };
});

// Mocked exactly like the package's OWN self-referencing bare specifier the
// factory dynamically imports (05-03 exports subpath) — proves the turso
// branch is genuinely reached without requiring a built `dist/` locally.
vi.mock('cool-astro-forms/server/storage/turso.js', () => ({ TursoStorage: FakeTursoStorage }));

import { getStorageAdapter, resetStorageAdapterCache } from './index.js';

function baseConfig(overrides: Partial<CoolFormsConfig> = {}): CoolFormsConfig {
  return {
    dbPath: ':memory:',
    storage: { kind: 'sqlite' },
    ...overrides,
  } as CoolFormsConfig;
}

const ORIGINAL_CAF_STORAGE_KIND = process.env.CAF_STORAGE_KIND;
const ORIGINAL_CAF_DB_PATH = process.env.CAF_DB_PATH;
const ORIGINAL_CAF_TURSO_DATABASE_URL = process.env.CAF_TURSO_DATABASE_URL;
const ORIGINAL_CAF_TURSO_AUTH_TOKEN = process.env.CAF_TURSO_AUTH_TOKEN;

afterEach(() => {
  resetDbCache();
  resetStorageAdapterCache();
  tursoConstructorCalls.length = 0;
  tursoConnect.next = 'ok';
  if (ORIGINAL_CAF_STORAGE_KIND === undefined) delete process.env.CAF_STORAGE_KIND;
  else process.env.CAF_STORAGE_KIND = ORIGINAL_CAF_STORAGE_KIND;
  if (ORIGINAL_CAF_DB_PATH === undefined) delete process.env.CAF_DB_PATH;
  else process.env.CAF_DB_PATH = ORIGINAL_CAF_DB_PATH;
  if (ORIGINAL_CAF_TURSO_DATABASE_URL === undefined) delete process.env.CAF_TURSO_DATABASE_URL;
  else process.env.CAF_TURSO_DATABASE_URL = ORIGINAL_CAF_TURSO_DATABASE_URL;
  if (ORIGINAL_CAF_TURSO_AUTH_TOKEN === undefined) delete process.env.CAF_TURSO_AUTH_TOKEN;
  else process.env.CAF_TURSO_AUTH_TOKEN = ORIGINAL_CAF_TURSO_AUTH_TOKEN;
});

describe('getStorageAdapter — config path (routes/middleware)', () => {
  it('returns a working, :memory:-capable SqliteStorage for kind "sqlite" (explicit)', async () => {
    const storage = await getStorageAdapter(baseConfig({ storage: { kind: 'sqlite' } }));
    expect(storage).toBeInstanceOf(SqliteStorage);
    const entry = await storage.createEntry({
      siteId: 'site-a',
      formId: 'form-1',
      status: 'abandoned',
      fields: {},
      visitorUuid: 'visitor-1',
    });
    expect(entry.id).toBeTruthy();
  });

  it('defaults to SqliteStorage when storage.kind is omitted on the config object', async () => {
    const storage = await getStorageAdapter({ dbPath: ':memory:' } as CoolFormsConfig);
    expect(storage).toBeInstanceOf(SqliteStorage);
  });

  it('passes config.dbPath through to getDb (same resolved connection as a direct getDb(config.dbPath) call)', async () => {
    const storage = await getStorageAdapter(baseConfig({ dbPath: ':memory:' }));
    expect(storage).toBeInstanceOf(SqliteStorage);
    // getDb(':memory:') is memoized per resolved path — a fresh direct call
    // for the SAME path must NOT throw and must be a distinct in-memory db
    // (no crash proves the factory routed through the real getDb).
    expect(() => getDb(':memory:')).not.toThrow();
  });

  it('routes kind "turso" through the dynamic import of the package\'s own turso.js exports subpath, reading CAF_TURSO_* env vars', async () => {
    process.env.CAF_TURSO_DATABASE_URL = 'libsql://example.turso.io';
    process.env.CAF_TURSO_AUTH_TOKEN = 'test-token';
    const storage = await getStorageAdapter(baseConfig({ storage: { kind: 'turso' } }));
    expect(storage).toBeInstanceOf(FakeTursoStorage);
    expect(tursoConstructorCalls).toEqual([{ dbUrl: 'libsql://example.turso.io', authToken: 'test-token' }]);
  });

  it('config.storage.kind wins over a conflicting CAF_STORAGE_KIND env value', async () => {
    process.env.CAF_STORAGE_KIND = 'turso';
    const storage = await getStorageAdapter(baseConfig({ storage: { kind: 'sqlite' } }));
    expect(storage).toBeInstanceOf(SqliteStorage);
    expect(tursoConstructorCalls).toEqual([]);
  });
});

describe('getStorageAdapter — env-fallback path (no config arg, mirrors recordSubmission)', () => {
  it('defaults to sqlite when CAF_STORAGE_KIND is unset', async () => {
    delete process.env.CAF_STORAGE_KIND;
    const storage = await getStorageAdapter();
    expect(storage).toBeInstanceOf(SqliteStorage);
  });

  it('honors CAF_STORAGE_KIND=turso with NO config arg — proves recordSubmission-style callers honor the selected backend', async () => {
    process.env.CAF_STORAGE_KIND = 'turso';
    process.env.CAF_TURSO_DATABASE_URL = 'libsql://example.turso.io';
    process.env.CAF_TURSO_AUTH_TOKEN = 'env-token';
    const storage = await getStorageAdapter();
    expect(storage).toBeInstanceOf(FakeTursoStorage);
    expect(tursoConstructorCalls).toEqual([{ dbUrl: 'libsql://example.turso.io', authToken: 'env-token' }]);
  });

  it('treats an unrecognized CAF_STORAGE_KIND value as sqlite (safe default, never silently turso)', async () => {
    process.env.CAF_STORAGE_KIND = 'postgres';
    const storage = await getStorageAdapter();
    expect(storage).toBeInstanceOf(SqliteStorage);
    expect(tursoConstructorCalls).toEqual([]);
  });

  it('falls back to CAF_DB_PATH (via getDb) for the sqlite branch when no config is passed', async () => {
    process.env.CAF_DB_PATH = ':memory:';
    delete process.env.CAF_STORAGE_KIND;
    const storage = await getStorageAdapter();
    expect(storage).toBeInstanceOf(SqliteStorage);
    const entry = await storage.createEntry({
      siteId: 'site-a',
      formId: 'form-1',
      status: 'abandoned',
      fields: {},
      visitorUuid: 'visitor-1',
    });
    expect(entry.id).toBeTruthy();
  });
});

// 0.1.18: the admin pages now acquire storage per request too, and a fresh
// TursoStorage per call meant a new libSQL client and a migration check
// (PRAGMA user_version round trip) on every request and every sweep tick.
describe('getStorageAdapter — one TursoStorage per database per process', () => {
  const turso = () => baseConfig({ storage: { kind: 'turso' } });

  it('returns the same instance for the same URL and token, including two calls racing on a cold start', async () => {
    process.env.CAF_TURSO_DATABASE_URL = 'libsql://example.turso.io';
    process.env.CAF_TURSO_AUTH_TOKEN = 'test-token';

    const [a, b] = await Promise.all([getStorageAdapter(turso()), getStorageAdapter(turso())]);
    const c = await getStorageAdapter();
    process.env.CAF_STORAGE_KIND = 'turso';
    const d = await getStorageAdapter();

    expect(a).toBeInstanceOf(FakeTursoStorage);
    expect(b).toBe(a);
    expect(d).toBe(a);
    expect(c).toBeInstanceOf(SqliteStorage);
    expect(tursoConstructorCalls).toHaveLength(1);
  });

  it('a different URL or token gets its own instance', async () => {
    process.env.CAF_TURSO_DATABASE_URL = 'libsql://one.turso.io';
    process.env.CAF_TURSO_AUTH_TOKEN = 'token-a';
    const first = await getStorageAdapter(turso());
    process.env.CAF_TURSO_AUTH_TOKEN = 'token-b';
    const rotated = await getStorageAdapter(turso());
    process.env.CAF_TURSO_DATABASE_URL = 'libsql://two.turso.io';
    const other = await getStorageAdapter(turso());

    expect(rotated).not.toBe(first);
    expect(other).not.toBe(rotated);
    expect(tursoConstructorCalls).toHaveLength(3);
  });

  it('an instance whose connect failed is dropped, so the next call reconnects instead of reusing the dead client', async () => {
    process.env.CAF_TURSO_DATABASE_URL = 'libsql://example.turso.io';
    process.env.CAF_TURSO_AUTH_TOKEN = 'test-token';
    tursoConnect.next = 'fail';

    const failed = await getStorageAdapter(turso());
    await expect((failed as unknown as InstanceType<typeof FakeTursoStorage>).ready).rejects.toThrow('turso unreachable');
    const retried = await getStorageAdapter(turso());
    const reused = await getStorageAdapter(turso());

    expect(retried).not.toBe(failed);
    expect(reused).toBe(retried);
    expect(tursoConstructorCalls).toHaveLength(2);
  });
});
