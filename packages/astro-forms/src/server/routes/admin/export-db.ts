/**
 * GET /forms-admin/export.db (ADMN-03) — full SQLite snapshot download via
 * better-sqlite3's native ASYNC db.backup() (WAL-consistent, non-blocking --
 * re-reads pages a concurrent writer modifies mid-backup; T-02-29). This is
 * deliberately NOT the synchronous VACUUM INTO db.ts already uses for its
 * pre-migration ops backup, which blocks the event loop and defragments --
 * the wrong tradeoff for a request-path download (Research Alternatives
 * Considered).
 *
 * The snapshot is written to a unique path in os.tmpdir(), read into memory,
 * and unlinked in a `finally` so the temp file NEVER lingers on disk -- even
 * when the backup or read step throws (T-02-27, temp .db snapshot on disk).
 * Route injection consolidated in Task 3 (integration.ts).
 *
 * BACKEND GATE (05-04 B2, ADPT-01/T-05-30): the 29-method `StorageAdapter`
 * has no `backup()`/export equivalent — `db.backup()` is a better-sqlite3
 * NATIVE call with nothing to route through `getStorageAdapter`. When
 * `config.storage.kind !== 'sqlite'` this route returns a clear 501 BEFORE
 * ever touching `getDb`/`backup()` — never a 500, and never a silently
 * stale/absent local-file download on a turso host. `docs/serverless.md`
 * (05-07) documents this as a sqlite-only limitation; keep the message text
 * consistent with that doc.
 */
import type { APIRoute } from 'astro';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import config from 'virtual:cool-astro-forms/config';
import { logError } from '../../log.js';
import { getDb } from '../../storage/db.js';

export const prerender = false;

function uniqueTmpPath(): string {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return path.join(os.tmpdir(), `caf-export-db-${unique}.db`);
}

function backendGateResponse(): Response {
  return new Response(
    JSON.stringify({ error: 'database snapshot download is only available on the sqlite storage backend' }),
    { status: 501, headers: { 'content-type': 'application/json' } },
  );
}

export const GET: APIRoute = async () => {
  // Absent storage.kind (older/unparsed config fixtures) behaves exactly
  // like the explicit 'sqlite' default — only a non-sqlite kind gates.
  const storageKind = config.storage?.kind;
  if (storageKind && storageKind !== 'sqlite') {
    return backendGateResponse();
  }

  const tmpPath = uniqueTmpPath();
  try {
    await getDb(config.dbPath).backup(tmpPath);
    const bytes = await fs.readFile(tmpPath);
    return new Response(bytes, {
      status: 200,
      headers: {
        'content-type': 'application/vnd.sqlite3',
        'content-disposition': 'attachment; filename="forms.db"',
      },
    });
  } catch (err) {
    logError('admin.export-db-failed', err);
    return new Response(null, { status: 500 });
  } finally {
    await fs.unlink(tmpPath).catch(() => undefined);
  }
};
