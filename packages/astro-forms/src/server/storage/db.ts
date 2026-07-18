/**
 * Boot-time SQLite opener: WAL + busy_timeout + `user_version` migrations,
 * plus three ops safeguards (review S9):
 *
 *   1. BOOT GUARD — refuses to open a database whose `user_version` is newer
 *      than this package's known migrations (never crashes opaquely at the
 *      first `prepare()` against an unknown future schema).
 *   2. PRE-MIGRATION AUTO-BACKUP — in production, snapshots the database via
 *      `VACUUM INTO` before applying any pending migration, retaining the 3
 *      most recent backups.
 *   3. JOURNAL-MODE VISIBILITY — logs the pragma-confirmed achieved journal
 *      mode at boot; WAL silently downgrades on some network filesystems and
 *      that must be visible in production logs, not assumed.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS } from './migrations.js';
import { log } from '../log.js';

const dbCache = new Map<string, Database.Database>();

/** Test helper — closes and forgets every cached connection. */
export function resetDbCache(): void {
  for (const db of dbCache.values()) {
    try {
      db.close();
    } catch {
      // already closed — ignore
    }
  }
  dbCache.clear();
}

function resolveDbPath(dbPath?: string): string {
  return dbPath ?? process.env.CAF_DB_PATH ?? 'data/forms.db';
}

/**
 * Opens (or returns the memoized) better-sqlite3 connection for the resolved
 * path. Safe to call repeatedly — connections are memoized per resolved path
 * so callers never accidentally open the same file twice.
 */
export function getDb(dbPath?: string): Database.Database {
  const resolvedPath = resolveDbPath(dbPath);

  const cached = dbCache.get(resolvedPath);
  if (cached) return cached;

  if (resolvedPath !== ':memory:') {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  }

  const db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  const currentVersion = db.pragma('user_version', { simple: true }) as number;

  if (currentVersion > MIGRATIONS.length) {
    db.close();
    throw new Error(
      `forms.db schema v${currentVersion} is newer than this package supports (v${MIGRATIONS.length}) — upgrade cool-astro-forms or restore a backup`,
    );
  }

  if (currentVersion < MIGRATIONS.length) {
    if (process.env.NODE_ENV === 'production' && resolvedPath !== ':memory:') {
      backupBeforeMigration(db, resolvedPath, currentVersion);
    }
    for (let v = currentVersion; v < MIGRATIONS.length; v++) {
      const migration = MIGRATIONS[v];
      if (!migration) throw new Error(`missing migration at index ${v}`);
      db.transaction(() => {
        migration(db);
        db.pragma(`user_version = ${v + 1}`);
      })();
    }
  }

  const journalMode = db.pragma('journal_mode', { simple: true }) as string;
  log('storage.boot', { journalMode, userVersion: MIGRATIONS.length, dbPath: resolvedPath });

  dbCache.set(resolvedPath, db);
  return db;
}

function backupBeforeMigration(db: Database.Database, dbPath: string, currentVersion: number): void {
  const ts = Date.now();
  const backupPath = `${dbPath}.backup-v${currentVersion}-${ts}`;
  // Embedded single quotes must be doubled before interpolation into the SQL
  // string — VACUUM INTO takes a string literal, not a bound parameter.
  const escapedPath = backupPath.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escapedPath}'`);
  pruneOldBackups(dbPath, 3);
}

function pruneOldBackups(dbPath: string, keep: number): void {
  const dir = path.dirname(dbPath);
  const base = path.basename(dbPath);
  const prefix = `${base}.backup-`;

  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((f) => f.startsWith(prefix));
  } catch {
    return;
  }

  const parsed = names
    .map((name) => {
      const match = /-(\d+)$/.exec(name);
      return { name, ts: match ? Number(match[1]) : 0 };
    })
    .sort((a, b) => b.ts - a.ts);

  for (const stale of parsed.slice(keep)) {
    fs.unlinkSync(path.join(dir, stale.name));
  }
}
