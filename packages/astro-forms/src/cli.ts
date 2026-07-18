#!/usr/bin/env node
/**
 * `npx cool-astro-forms init` (CLI-01, D5 — scaffold-and-print).
 *
 * Writes `.env.example` (full env inventory, incl. serverless vars),
 * appends `data/` to `.gitignore` (creating it if absent), and PRINTS the
 * `coolForms()` config snippet + data-caf tagging instructions + the
 * `astro add` empty-args caveat + docs links. NEVER writes or edits
 * `astro.config.mjs` (two prior Astro-compiler landmines — docs/LESSONS.md
 * #4/#5) and never silently clobbers an existing file (T-05-14/T-05-15).
 *
 * The literal shebang above MUST stay the first line: esbuild (tsup's
 * bundler) preserves a per-entry leading hashbang in THAT entry's output
 * only (tsup.config.ts `cli` entry, Task 2) — never add a tsup `banner`,
 * which would prepend to every other emitted file.
 *
 * Imports below use `.ts` extensions (not this package's usual `.js`
 * convention) because this file is also run directly by Node — via its
 * native TypeScript type-stripping, with no build step — in this plan's
 * own e2e test (`cli.test.ts`) and whenever a contributor runs it from
 * source. Node's loader has no `.js`-resolves-to-`.ts` fallback (unlike
 * Vite/esbuild, which every other module in this package relies on), so a
 * `.js`-suffixed specifier here would throw ERR_MODULE_NOT_FOUND before a
 * build ever runs. See `tsconfig.json`'s `allowImportingTsExtensions`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configSnippet, envExampleTemplate, postInitInstructions } from './cli/templates.ts';
import { confirmOverwrite, isInteractive } from './cli/prompts.ts';

interface ParsedArgs {
  command: string | undefined;
  yes: boolean;
  force: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const command = args.find((arg) => !arg.startsWith('-'));
  return {
    command,
    yes: args.includes('--yes') || args.includes('-y'),
    force: args.includes('--force'),
  };
}

type WriteEnvResult = 'created' | 'overwritten' | 'skipped';

/** Confirm-before-overwrite (T-05-14): never clobbers a pre-existing .env.example without --force or an explicit interactive "yes". */
async function writeEnvExample(cwd: string, opts: { yes: boolean; force: boolean }): Promise<WriteEnvResult> {
  const targetPath = join(cwd, '.env.example');
  const exists = existsSync(targetPath);

  if (!exists) {
    writeFileSync(targetPath, envExampleTemplate(), 'utf8');
    return 'created';
  }
  if (opts.force) {
    writeFileSync(targetPath, envExampleTemplate(), 'utf8');
    return 'overwritten';
  }
  if (!opts.yes && isInteractive()) {
    const overwrite = await confirmOverwrite('.env.example already exists. Overwrite?');
    if (overwrite) {
      writeFileSync(targetPath, envExampleTemplate(), 'utf8');
      return 'overwritten';
    }
  }
  return 'skipped';
}

type GitignoreResult = 'created' | 'appended' | 'already-present';

/** Creates .gitignore if absent, appends `data/` if missing, never duplicates an existing `data/` entry. */
function ensureGitignoreHasDataDir(cwd: string): GitignoreResult {
  const gitignorePath = join(cwd, '.gitignore');
  const exists = existsSync(gitignorePath);
  const existing = exists ? readFileSync(gitignorePath, 'utf8') : '';

  const alreadyPresent = existing.split(/\r?\n/).some((line) => line.trim() === 'data/');
  if (alreadyPresent) {
    return 'already-present';
  }

  const needsLeadingNewline = existing.length > 0 && !existing.endsWith('\n');
  const next = `${existing}${needsLeadingNewline ? '\n' : ''}data/\n`;
  writeFileSync(gitignorePath, next, 'utf8');
  return exists ? 'appended' : 'created';
}

function describeEnvResult(result: WriteEnvResult): string {
  switch (result) {
    case 'created':
      return '  .env.example created.';
    case 'overwritten':
      return '  .env.example overwritten (--force).';
    case 'skipped':
      return '  .env.example already exists — left untouched (rerun with --force to overwrite).';
  }
}

function describeGitignoreResult(result: GitignoreResult): string {
  switch (result) {
    case 'created':
      return '  .gitignore created with a data/ entry.';
    case 'appended':
      return '  data/ appended to .gitignore.';
    case 'already-present':
      return '  .gitignore already ignores data/ — left untouched.';
  }
}

async function runInit(cwd: string, opts: { yes: boolean; force: boolean }): Promise<void> {
  const envResult = await writeEnvExample(cwd, opts);
  const gitignoreResult = ensureGitignoreHasDataDir(cwd);

  const lines: string[] = [
    'cool-astro-forms init',
    '',
    describeEnvResult(envResult),
    describeGitignoreResult(gitignoreResult),
    '',
    'Paste this into astro.config.mjs (see the astro add caveat below):',
    '',
    configSnippet(),
    '',
    postInitInstructions(),
  ];

  process.stdout.write(lines.join('\n'));
}

function printUsage(): void {
  process.stdout.write('Usage: cool-astro-forms init [--yes] [--force]\n');
}

async function main(): Promise<void> {
  const { command, yes, force } = parseArgs(process.argv);

  if (command !== 'init') {
    printUsage();
    process.exitCode = command === undefined ? 0 : 1;
    return;
  }

  await runInit(process.cwd(), { yes, force });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
