/**
 * 0.1.18: the five admin view pages (.astro) must obtain storage through
 * getStorageAdapter(config) — the single construction point — never by
 * hard-coding the SQLite adapter. A direct `new SqliteStorage(getDb(...))` in
 * a page silently reads an empty local SQLite file while every route writes
 * to Turso on `storage.kind: 'turso'` (T-05-29 data-split; contradicts
 * docs/serverless.md). .astro frontmatter can't be imported under vitest, so
 * this is a source-level guard, like the other file-shape gates in the repo.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const adminDir = here;
const routesAdminDir = path.join(here, '..', 'routes', 'admin');

const VIEW_PAGES = ['entries', 'abandoned', 'analytics', 'entry-detail', 'payments'] as const;

function astroFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.astro'))
    .map((name) => path.join(dir, name));
}

function frontmatter(source: string): string {
  const match = source.match(/^---\n([\s\S]*?)\n---/);
  return match ? match[1]! : '';
}

describe('admin pages obtain storage via getStorageAdapter (0.1.18)', () => {
  it('no admin .astro page constructs SqliteStorage directly', () => {
    const files = [...astroFiles(adminDir), ...astroFiles(routesAdminDir)];
    expect(files.length).toBeGreaterThanOrEqual(VIEW_PAGES.length);
    const offenders = files.filter((file) => /new\s+SqliteStorage\s*\(/.test(readFileSync(file, 'utf8')));
    expect(offenders.map((f) => path.basename(f))).toEqual([]);
  });

  it.each(VIEW_PAGES)('%s.astro imports getStorageAdapter and not the sqlite/db modules', (page) => {
    const front = frontmatter(readFileSync(path.join(adminDir, `${page}.astro`), 'utf8'));
    expect(front).toMatch(/import\s*\{\s*getStorageAdapter\s*\}\s*from\s*'\.\.\/storage\/index\.js'/);
    expect(front).not.toMatch(/from\s*'\.\.\/storage\/sqlite\.js'/);
    expect(front).not.toMatch(/from\s*'\.\.\/storage\/db\.js'/);
  });

  it.each(VIEW_PAGES)(
    '%s.astro acquires storage with getStorageAdapter(config) INSIDE its try block (failure renders the error state, not a raw 500)',
    (page) => {
      const front = frontmatter(readFileSync(path.join(adminDir, `${page}.astro`), 'utf8'));
      const tryIdx = front.indexOf('try {');
      const acquireIdx = front.indexOf('await getStorageAdapter(config)');
      const catchIdx = front.indexOf('} catch (err)');
      expect(tryIdx).toBeGreaterThan(-1);
      expect(acquireIdx).toBeGreaterThan(tryIdx);
      expect(catchIdx).toBeGreaterThan(acquireIdx);
    },
  );
});
