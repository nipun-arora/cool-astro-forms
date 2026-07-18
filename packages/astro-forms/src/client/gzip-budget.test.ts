/**
 * Codified client-bundle gzip budget (closes 02-RESEARCH.md Pitfall 4). The
 * "capture.js + journey.js" bundle is NOT just those two dist entry files —
 * tsup/esbuild's code-splitting extracts their actual logic (plus any
 * modules they exclusively import, e.g. capture.ts's own use of visitor.ts)
 * into shared local `chunk-*.js` files with content-addressed hashes that
 * change on every build. Measuring only the two thin re-export shim files
 * would trivially "pass" at a few hundred bytes without ever reflecting the
 * real payload a visitor's browser has to fetch. This test resolves the
 * FULL transitive closure of local (relative-path) imports reachable from
 * `dist/client/capture.js` and `dist/client/journey.js` — deduped, since a
 * shared chunk is only downloaded once — and gzips the concatenation of the
 * whole set. `turnstile-loader.js` is intentionally excluded (it only loads
 * when TURNSTILE_SITE_KEY/TURNSTILE_SECRET_KEY are configured — a separate
 * optional bundle, not part of every page's always-loaded payload).
 *
 * D1 (fail loud, never a silent scope cut): Phase 1 measured this bundle at
 * 3609/4096 bytes (~487B headroom). Turnstile's client token-holder
 * (02-04) and this plan's own lastField tracking + form_started ping
 * (ANLY-01) together pushed the real measured size to ~5026 bytes — a
 * genuine, owner-sanctioned overage, not a hypothetical one. Per D1 the
 * ceiling is raised here to 5120 with this rationale recorded directly
 * alongside the constant, rather than silently trimming ANLY-01's scope to
 * fit the old number.
 *
 * D1 re-applied (04-07, RCV-01): before this plan, the same measured closure
 * was 5054 bytes (94B headroom under 5120). The minimal capture.ts recovery
 * seam this plan adds — setRecoveryConsent()/recoveryOptIn threaded through
 * BuildAbandonPayloadInput + buildAbandonPayload, the recoveryActive flag,
 * and transmitReadingSaved() (the fetch-reads-{saved} transport the RCV-01
 * eng lock requires) — pushed the measured closure to 5246 bytes, 126 bytes
 * over the 5120 ceiling. The standalone recovery-widget.ts toast/checkbox
 * module is DELIBERATELY EXCLUDED from this number: it is never imported by
 * capture.ts or journey.ts (confirmed by resolveLocalClosure's closure walk
 * below finding no `recovery-widget` chunk), so it never entered this
 * measurement. Per D1 the ceiling is raised to 5376 (130B headroom, in line
 * with the earlier 94B precedent) rather than trimming the seam RCV-01
 * requires. Measured before/after: 5054 -> 5246 (+192B, capture.ts only).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DIST_CLIENT = path.join(PACKAGE_ROOT, 'dist/client');
const ENTRY_FILES = ['capture.js', 'journey.js'].map((f) => path.join(DIST_CLIENT, f));

/** D1-sanctioned raise: 4096 -> 5120 (02-04/ANLY-01) -> 5376 (04-07/RCV-01); see this file's own docstring for the measured rationale. */
const GZIP_BUDGET_BYTES = 5376;

/** Matches both `export {...} from './x.js'` and bare `import './x.js'` — the only two import shapes tsup's ESM output emits for local chunk references. */
const LOCAL_IMPORT_RE = /(?:from|import)\s+['"](\.[^'"]+\.js)['"]/g;

/**
 * Resolves the full transitive closure of local (relative-path) JS modules
 * reachable from `entryFiles`, deduped by absolute path. Never follows a
 * bare-specifier import (there are none in this output — the client bundle
 * has zero runtime dependencies).
 */
function resolveLocalClosure(entryFiles: string[]): string[] {
  const visited = new Set<string>();
  const queue = [...entryFiles.map((f) => path.resolve(f))];

  while (queue.length > 0) {
    const abs = queue.pop()!;
    if (visited.has(abs)) continue;
    visited.add(abs);

    const source = fs.readFileSync(abs, 'utf8');
    for (const match of source.matchAll(LOCAL_IMPORT_RE)) {
      const resolved = path.resolve(path.dirname(abs), match[1]!);
      if (!visited.has(resolved)) queue.push(resolved);
    }
  }

  return [...visited].sort();
}

describe('client bundle gzip budget (02-RESEARCH.md Pitfall 4)', () => {
  beforeAll(() => {
    if (!ENTRY_FILES.every((f) => fs.existsSync(f))) {
      execFileSync('npm', ['run', 'build'], { cwd: PACKAGE_ROOT, stdio: 'inherit' });
    }
  });

  it('capture.js + journey.js (and their full local chunk closure) gzip within the codified ceiling', () => {
    const files = resolveLocalClosure(ENTRY_FILES);
    expect(files.length).toBeGreaterThan(0);

    const combined = Buffer.concat(files.map((f) => fs.readFileSync(f)));
    const gzipped = gzipSync(combined);

    expect(gzipped.length).toBeLessThanOrEqual(GZIP_BUDGET_BYTES);
  });

  it('excludes turnstile-loader.js from the measured closure (separate optional bundle)', () => {
    const files = resolveLocalClosure(ENTRY_FILES);
    expect(files.some((f) => f.endsWith('turnstile-loader.js'))).toBe(false);
  });
});
