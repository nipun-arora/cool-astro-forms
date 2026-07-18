/**
 * CLI-01 e2e (05-05 T1): `npx cool-astro-forms init` scaffold-and-print.
 *
 * Spawns the CLI as a real child process against a fresh `os.tmpdir()`
 * directory for every case — this is the honest test for a CLI that
 * touches the filesystem of a directory it doesn't own (T-05-14/T-05-15).
 * The entry is invoked directly as `src/cli.ts` via Node's built-in
 * TypeScript type-stripping (no `tsx`, no prior build — this task's own
 * verify command never runs `npm run build`; that's Task 2's job once the
 * tsup entry + shebang exist). `cli.ts`'s own imports of `./cli/templates.ts`
 * and `./cli/prompts.ts` therefore use literal `.ts` extensions (see
 * `tsconfig.json`'s `allowImportingTsExtensions`) — Node's native loader has
 * no `.js`-maps-to-`.ts` fallback the way Vite/esbuild do for every other
 * module in this package, so the usual `.js`-suffixed convention would
 * ERR_MODULE_NOT_FOUND when this file is run standalone by `node`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { configSnippet, envExampleTemplate, postInitInstructions } from './cli/templates.js';

const CLI_ENTRY = fileURLToPath(new URL('./cli.ts', import.meta.url));

const FULL_ENV_INVENTORY = [
  'CAF_DB_PATH',
  'FORMS_ADMIN_PASSWORD',
  'FORMS_ADMIN_SECRET',
  'CAF_REQUIRE_EXPLICIT_SECRETS',
  'CAF_RECOVERY_SECRET',
  'EMAIL_HOST',
  'EMAIL_PORT',
  'EMAIL_USER',
  'EMAIL_PASS',
  'GEO_PROVIDER',
  'TURNSTILE_SITE_KEY',
  'TURNSTILE_SECRET_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'PAYPAL_CLIENT_ID',
  'PAYPAL_CLIENT_SECRET',
  'PAYPAL_ENV',
  'PAYPAL_WEBHOOK_ID',
  'GOOGLE_DRIVE_CLIENT_ID',
  'GOOGLE_DRIVE_CLIENT_SECRET',
  'GOOGLE_DRIVE_REFRESH_TOKEN',
  'CANARY_TOKEN',
  'CAF_TURSO_DATABASE_URL',
  'CAF_TURSO_AUTH_TOKEN',
];

const createdDirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'caf-cli-test-'));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** Spawns the CLI with no TTY/stdin (matches a real CI runner) — `input: ''` closes stdin immediately so a would-be prompt can never hang the test. */
function runInit(cwd: string, args: string[] = ['init', '--yes']): string {
  return execFileSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: 'utf8',
    input: '',
  });
}

describe('cli.ts init', () => {
  it('writes a full .env.example inventory (incl. serverless vars)', () => {
    const dir = freshDir();
    const stdout = runInit(dir);

    const envPath = join(dir, '.env.example');
    expect(existsSync(envPath)).toBe(true);
    const content = readFileSync(envPath, 'utf8');

    for (const key of FULL_ENV_INVENTORY) {
      expect(content).toContain(key);
    }
    expect(content).toBe(envExampleTemplate());
    expect(stdout).toContain('.env.example');
  });

  it('appends data/ to .gitignore, creating it if absent', () => {
    const dir = freshDir();
    runInit(dir);
    const gitignorePath = join(dir, '.gitignore');
    expect(existsSync(gitignorePath)).toBe(true);
    const content = readFileSync(gitignorePath, 'utf8');
    expect(content.split(/\r?\n/).filter((l) => l.trim() === 'data/')).toHaveLength(1);
  });

  it('does not duplicate data/ when .gitignore already has it', () => {
    const dir = freshDir();
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\ndata/\n', 'utf8');
    runInit(dir);
    const content = readFileSync(join(dir, '.gitignore'), 'utf8');
    expect(content.split(/\r?\n/).filter((l) => l.trim() === 'data/')).toHaveLength(1);
  });

  it('appends data/ (with a leading newline) when .gitignore exists without a trailing newline', () => {
    const dir = freshDir();
    writeFileSync(join(dir, '.gitignore'), 'node_modules/', 'utf8');
    runInit(dir);
    const content = readFileSync(join(dir, '.gitignore'), 'utf8');
    expect(content).toBe('node_modules/\ndata/\n');
  });

  it('never clobbers a pre-seeded .env.example without --force (non-interactive, no TTY)', () => {
    const dir = freshDir();
    const seeded = '# my custom env file\nCUSTOM_VAR=1\n';
    writeFileSync(join(dir, '.env.example'), seeded, 'utf8');
    // No --yes, no --force, no TTY (spawned child stdin closed) -> must skip, never clobber.
    runInit(dir, ['init']);
    const content = readFileSync(join(dir, '.env.example'), 'utf8');
    expect(content).toBe(seeded);
  });

  it('overwrites a pre-seeded .env.example when --force is passed', () => {
    const dir = freshDir();
    writeFileSync(join(dir, '.env.example'), 'old-content', 'utf8');
    runInit(dir, ['init', '--yes', '--force']);
    const content = readFileSync(join(dir, '.env.example'), 'utf8');
    expect(content).toBe(envExampleTemplate());
  });

  it('never creates or edits astro.config.mjs (D5, LESSONS #4/#5)', () => {
    const dir = freshDir();
    runInit(dir);
    expect(existsSync(join(dir, 'astro.config.mjs'))).toBe(false);
    expect(existsSync(join(dir, 'astro.config.ts'))).toBe(false);
  });

  it('prints the coolForms() config snippet with REQUIRED fields marked, data-caf tagging, the astro add caveat, and docs links', () => {
    const dir = freshDir();
    const stdout = runInit(dir);

    expect(stdout).toContain(configSnippet());
    expect(stdout).toContain('siteId');
    expect(stdout).toContain('siteUrl');
    expect(stdout).toContain('notifyTo');
    expect(stdout.match(/REQUIRED/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(stdout).toContain('data-caf');
    expect(stdout).toContain('astro add cool-astro-forms');
    expect(stdout).toContain(postInitInstructions());
  });

  it('emits no tool-generated boilerplate markers in its output', () => {
    const dir = freshDir();
    const stdout = runInit(dir);
    expect(stdout).not.toMatch(/co-authored-by/i);
    expect(stdout).not.toMatch(/generated with/i);
    expect(stdout).not.toContain('🤖');
  });

  it('runs non-interactively under --yes with no TTY/stdin (CI mode)', () => {
    const dir = freshDir();
    expect(() => runInit(dir, ['init', '--yes'])).not.toThrow();
  });
});
