#!/usr/bin/env node
// Boots the BUILT playground artifact (server.mjs -> dist/server/entry.mjs)
// via a real Express process and drills one abandon POST against it —
// closes RESEARCH.md A2 (injectRoute under @astrojs/node middleware mode,
// wrapped by Express — a typical Phusion Passenger deployment shape).
//
// The built artifact has NO _debug-entries endpoint (it compile-time 404s
// in production — T-01-31), so this script resets state by deleting the
// SQLite data directory directly, rather than hitting a debug reset route.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';

const PLAYGROUND_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = path.join(PLAYGROUND_DIR, 'data');
const DB_PATH = path.join(DATA_DIR, 'forms.db');
const ORIGIN = 'http://localhost:4321';
const PORT = '4321';

function log(...args) {
  // eslint-disable-next-line no-console
  console.log('[smoke:built]', ...args);
}

function resetDb() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}

async function waitForServer(url, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // not up yet — keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server did not become ready within ${timeoutMs}ms`);
}

function startServer() {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: PLAYGROUND_DIR,
    env: { ...process.env, PORT },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => log('[server]', chunk.toString().trim()));
  child.stderr.on('data', (chunk) => log('[server:err]', chunk.toString().trim()));
  return child;
}

function abandonPayload(overrides = {}) {
  return {
    siteId: 'playground',
    formId: 'demo',
    visitorUuid: 'smoke-visitor-0000000000000000',
    fields: { name: 'Smoke Test', email: 'smoke@example.com' },
    journey: [],
    ...overrides,
  };
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    child.once('exit', resolve);
    setTimeout(resolve, 2000);
  });
}

async function main() {
  resetDb();

  const child = startServer();
  let exitCode = 0;

  try {
    await waitForServer(`${ORIGIN}/`);

    // 1. Genuine same-origin POST -> HTTP 200 + {saved:true}.
    const okRes = await fetch(`${ORIGIN}/api/forms/abandon`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify(abandonPayload()),
    });
    const okBody = await okRes.json();
    if (okRes.status !== 200 || okBody.saved !== true) {
      throw new Error(`expected 200 {saved:true}, got ${okRes.status} ${JSON.stringify(okBody)}`);
    }
    log('same-origin abandon POST OK:', okRes.status, okBody);

    // 2. A real row landed in the built artifact's SQLite file.
    const db = new Database(DB_PATH, { readonly: true });
    const row = db
      .prepare(
        `SELECT COUNT(*) as count FROM entries WHERE site_id = ? AND form_id = ? AND status = 'abandoned'`,
      )
      .get('playground', 'demo');
    db.close();
    if (!row || row.count < 1) {
      throw new Error(`expected an abandoned row in ${DB_PATH}, found ${row?.count ?? 0}`);
    }
    log('DB row confirmed:', row.count, 'abandoned row(s)');

    // 3. Mismatched-Origin POST -> 403 (SEC-01, proven against the BUILT artifact).
    const badRes = await fetch(`${ORIGIN}/api/forms/abandon`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify(abandonPayload({ visitorUuid: 'smoke-visitor-cross-origin' })),
    });
    if (badRes.status !== 403) {
      throw new Error(`expected 403 for mismatched Origin, got ${badRes.status}`);
    }
    log('cross-origin abandon POST correctly rejected:', badRes.status);

    log('PASSED');
  } catch (err) {
    exitCode = 1;
    console.error('[smoke:built] FAILED:', err instanceof Error ? err.message : err);
  } finally {
    await stopServer(child);
  }

  process.exit(exitCode);
}

main();
