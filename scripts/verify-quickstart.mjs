#!/usr/bin/env node
/**
 * ROLL-01 — the machine-checkable quickstart validation.
 *
 * This is NOT a smoke test against the monorepo's own installed copy of the
 * package (that's what apps/playground/scripts/smoke-built.mjs does, and it
 * proves the injectRoute()/adapter wiring inside the workspace). This script
 * proves the PUBLISHED ARTIFACT works: it `npm pack`s packages/astro-forms
 * into a real tarball, installs that tarball into a brand-new scratch Astro
 * project that has never seen this monorepo's node_modules, builds it, runs
 * the built standalone server, and drives a real abandon POST against it —
 * exactly mirroring what a stranger following the README Quickstart would
 * experience (builds on the ad-hoc npm-pack-scratch-install pattern proven
 * in 03-08/04-08, persisted here as a committed, CI-able script).
 *
 * The README's "Quickstart" section documents EXACTLY these steps and EXACTLY
 * this config/markup — this script is the source of truth; if you change one,
 * change the other (CONTEXT.md: "the script IS the validation").
 *
 * Deterministic + local-only: no remote host is ever contacted at RUNTIME
 * (the scratch `astro dev`/build's own `npm install` does hit the npm
 * registry/cache, same as any real `npm install` — there is no way to prove
 * a *published* package installs without installing it). The scratch
 * server binds its own dedicated port, never 4322-4329 or 4390-4395 (all
 * claimed by the Playwright suite — see playwright.config.ts).
 *
 * Usage: node scripts/verify-quickstart.mjs
 * Exit code 0 = every step passed. Exit code 1 = a step failed; stderr names
 * exactly which step and why, and (on failure only) the scratch directory is
 * left on disk for inspection instead of being cleaned up.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PKG_DIR = join(REPO_ROOT, 'packages', 'astro-forms');

// Fresh, dedicated port — 4322-4329 and 4390-4395 are all claimed by the
// Playwright e2e suite (playwright.config.ts); this script must never
// collide with a suite that may be running concurrently (LESSONS #25).
const PORT = 4396;
const SITE_URL = `http://localhost:${PORT}`;

// Pinned to the SAME versions this monorepo already tests against
// (apps/playground/package.json) rather than a floating `^` range — a
// scratch project resolving a brand-new, untested Astro major on every run
// would make this script's pass/fail depend on upstream releases instead of
// on this package. Bump these alongside apps/playground/package.json.
const ASTRO_VERSION = '6.4.8';
const ASTROJS_NODE_VERSION = '10.1.4';

const SERVER_READY_TIMEOUT_MS = 30_000;

/**
 * The EXACT astro.config.mjs the README Quickstart shows (Task 2) — byte
 * for byte, including the siteUrl. A real deployment swaps siteUrl for its
 * own origin; this script's whole point is to actually RUN the snippet, so
 * it points siteUrl at the same origin it serves on rather than a
 * non-resolvable https://example.com placeholder.
 */
function astroConfigSource() {
  return `import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import coolForms from 'cool-astro-forms';

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  integrations: [
    coolForms({
      siteId: 'my-site',
      siteUrl: '${SITE_URL}', // must match the origin you actually serve on
      forms: {
        contact: { notifyTo: 'owner@example.com' },
      },
    }),
  ],
});
`;
}

/** The EXACT tagged form the README Quickstart shows (Task 2). */
function indexPageSource() {
  return `---
---
<html lang="en">
  <body>
    <h1>Contact</h1>
    <form data-caf="contact" method="post" action="/api/upload">
      <input type="text" name="name" />
      <input type="email" name="email" />
      <button type="submit">Send</button>
    </form>
  </body>
</html>
`;
}

function log(step, msg) {
  process.stdout.write(`[verify-quickstart] ${step}: ${msg}\n`);
}

function fail(step, err) {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`\n[verify-quickstart] FAILED at step: ${step}\n${detail}\n`);
  process.exitCode = 1;
}

async function waitForServer(url, timeoutMs) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `server did not become ready within ${timeoutMs}ms${lastErr ? ` (last error: ${lastErr.message ?? lastErr})` : ''}`,
  );
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    child.once('exit', resolve);
    setTimeout(resolve, 2000);
  });
}

/** Runs `node <script>` with cwd=projectDir so bare imports resolve against
 * the SCRATCH project's own node_modules (its real installed
 * better-sqlite3), not this monorepo's. */
function runInScratchNode(projectDir, scriptSource, args) {
  const scriptPath = join(projectDir, '__caf_check.mjs');
  writeFileSync(scriptPath, scriptSource, 'utf8');
  const out = execFileSync(process.execPath, [scriptPath, ...args], { cwd: projectDir, encoding: 'utf8' });
  return out;
}

async function main() {
  let scratchRoot;
  let serverChild;
  let currentStep = 'setup';

  try {
    currentStep = 'Step 1: build + npm pack packages/astro-forms';
    log(currentStep, 'starting');
    scratchRoot = mkdtempSync(join(tmpdir(), 'caf-quickstart-'));
    // Guarantee dist/ is fresh — npm pack's `files` whitelist ships only
    // dist/ (+ two .astro source dirs), so a stale/missing build would pack
    // an empty or outdated tarball and silently pass a validation that
    // proves nothing.
    execFileSync('npm', ['run', 'build', '-w', 'packages/astro-forms'], { cwd: REPO_ROOT, stdio: 'inherit' });
    const packOut = execFileSync(
      'npm',
      ['pack', '--workspace', 'packages/astro-forms', '--pack-destination', scratchRoot, '--json'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    const packInfo = JSON.parse(packOut);
    const tarballName = packInfo[0]?.filename;
    if (!tarballName) throw new Error(`npm pack produced no tarball (raw output: ${packOut})`);
    const tarballPath = join(scratchRoot, tarballName);
    log(currentStep, `packed ${tarballName}`);

    currentStep = 'Step 2: create a minimal scratch Astro project';
    log(currentStep, 'starting');
    const projectDir = join(scratchRoot, 'project');
    mkdirSync(join(projectDir, 'src', 'pages'), { recursive: true });
    writeFileSync(
      join(projectDir, 'package.json'),
      JSON.stringify(
        {
          name: 'caf-quickstart-scratch-project',
          private: true,
          type: 'module',
          scripts: { build: 'astro build' },
          dependencies: {
            astro: ASTRO_VERSION,
            '@astrojs/node': ASTROJS_NODE_VERSION,
            'cool-astro-forms': `file:${tarballPath}`,
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    log(currentStep, `scratch project at ${projectDir}`);

    currentStep = 'Step 3: install the tarball (+ astro + @astrojs/node) into the scratch project';
    log(currentStep, 'starting — this hits the npm registry/cache, may take a while');
    execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: projectDir, stdio: 'inherit' });
    log(currentStep, 'installed');

    currentStep = 'Step 4: write astro.config.mjs (the coolForms() snippet the README shows)';
    writeFileSync(join(projectDir, 'astro.config.mjs'), astroConfigSource(), 'utf8');
    log(currentStep, 'written');

    currentStep = 'Step 5: add a data-caf form (the exact markup the README shows)';
    writeFileSync(join(projectDir, 'src', 'pages', 'index.astro'), indexPageSource(), 'utf8');
    log(currentStep, 'written');

    currentStep = 'Step 6: astro build + run the built standalone server';
    log(currentStep, 'building');
    execFileSync('npm', ['run', 'build'], { cwd: projectDir, stdio: 'inherit' });
    log(currentStep, `starting server on ${SITE_URL}`);
    serverChild = spawn(process.execPath, [join(projectDir, 'dist', 'server', 'entry.mjs')], {
      cwd: projectDir,
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverChild.stdout.on('data', (chunk) => log('server', chunk.toString().trim()));
    serverChild.stderr.on('data', (chunk) => log('server:err', chunk.toString().trim()));
    await waitForServer(SITE_URL, SERVER_READY_TIMEOUT_MS);
    log(currentStep, 'server ready');

    currentStep = 'Step 6b: drive a real abandon POST (the "leave without submitting" round trip)';
    const visitorUuid = crypto.randomUUID();
    const abandonRes = await fetch(`${SITE_URL}/api/forms/abandon`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: SITE_URL },
      body: JSON.stringify({
        siteId: 'my-site',
        formId: 'contact',
        visitorUuid,
        fields: { name: 'Quickstart Bot', email: 'lead@example.com' },
        journey: [],
      }),
    });
    const abandonBody = await abandonRes.json();
    if (abandonRes.status !== 200 || abandonBody.saved !== true) {
      throw new Error(`expected 200 {saved:true}, got ${abandonRes.status} ${JSON.stringify(abandonBody)}`);
    }
    log(currentStep, `abandon POST OK: ${abandonRes.status} ${JSON.stringify(abandonBody)}`);

    currentStep = 'Step 7: assert a row landed in the scratch project data/forms.db';
    const dbPath = join(projectDir, 'data', 'forms.db');
    const checkScript = `
import Database from 'better-sqlite3';
const db = new Database(process.argv[2], { readonly: true });
const row = db
  .prepare("SELECT COUNT(*) as count FROM entries WHERE site_id = ? AND form_id = ? AND status = 'abandoned'")
  .get(process.argv[3], process.argv[4]);
db.close();
process.stdout.write(JSON.stringify(row));
`;
    const rowOut = runInScratchNode(projectDir, checkScript, [dbPath, 'my-site', 'contact']);
    const row = JSON.parse(rowOut);
    if (!row || row.count < 1) {
      throw new Error(`expected an abandoned row in ${dbPath}, found ${row?.count ?? 0}`);
    }
    log(currentStep, `DB row confirmed: ${row.count} abandoned row(s) in ${dbPath}`);

    await stopServer(serverChild);
    serverChild = undefined;

    currentStep = 'Step 8: clean up the scratch directory';
    rmSync(scratchRoot, { recursive: true, force: true });
    log(currentStep, 'removed');

    log('done', 'PASSED — the README Quickstart is proven against a real tarball install.');
    process.exitCode = 0;
  } catch (err) {
    fail(currentStep, err);
    if (scratchRoot) {
      process.stderr.write(`[verify-quickstart] scratch directory left on disk for inspection: ${scratchRoot}\n`);
    }
  } finally {
    await stopServer(serverChild);
  }
}

main();
