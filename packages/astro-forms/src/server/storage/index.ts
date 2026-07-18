/**
 * getStorageAdapter(config?) — the single storage-backend CONSTRUCTION POINT
 * (05-04, ADPT-01). Every route/middleware/recordSubmission call site that
 * used to `new SqliteStorage(getDb(...))` directly now goes through this
 * factory so `storage.kind: 'turso'` can select the libSQL backend
 * end-to-end, with NO silent SQLite/Turso data-split (T-05-29).
 *
 * Two resolution paths, mirroring `db.ts`'s own `CAF_DB_PATH` precedent:
 *
 *   1. CONFIG path (routes/middleware) — `config.storage.kind` is read
 *      directly off the validated `CoolFormsConfig` reachable via the
 *      virtual config module.
 *   2. ENV-FALLBACK path (the public `recordSubmission` export) — that
 *      function has NO `CoolFormsConfig` parameter (pinned Phase 1 public
 *      signature) and so CANNOT see the virtual config module. It calls
 *      `getStorageAdapter()` with no argument, and this factory falls back
 *      to `process.env.CAF_STORAGE_KIND` — published by
 *      `registerRuntimeConfig` (middleware.ts) from `cfg.storage.kind`,
 *      exactly the same bridge mechanism `CAF_DB_PATH`/`CAF_GEO_*` already
 *      use. Without this bridge a host on `storage.kind:'turso'` would
 *      write abandons/admin to Turso but SUBMISSIONS to SQLite — a silent
 *      data-split that falsifies ADPT-01.
 *
 * 'sqlite' (default, omitted, or any unrecognized value) statically
 * constructs `SqliteStorage(getDb(config?.dbPath))` — `getDb`'s own
 * `CAF_DB_PATH` fallback applies when `config` is absent too, so the
 * env-fallback path stays byte-identical to the pre-05-04 default.
 *
 * 'turso' DYNAMICALLY imports `TursoStorage` via the package's OWN bare
 * specifier + exports subpath (05-03) — resolved through a non-literal
 * variable (not a literal string directly inside `import(...)`) so
 * TypeScript's module-resolution special-case for dynamic-import literals
 * never fires: a default sqlite host that never sets `storage.kind:'turso'`
 * must typecheck and build cleanly even before `npm run build` has ever
 * produced `dist/server/storage/turso.js` locally (that resolvability is
 * proven for real at the npm-pack/quickstart gates, 05-06/05-08 — T-05-13).
 * A static top-level import would force `@libsql/client` into every host's
 * SSR bundle, including hosts that only ever use the default SqliteStorage.
 */
import type { CoolFormsConfig } from '../../config.js';
import type { StorageAdapter } from './adapter.js';
import { getDb } from './db.js';
import { SqliteStorage } from './sqlite.js';

type StorageKind = 'sqlite' | 'turso';

/** Minimal shape this factory needs from the dynamically imported turso.js module. */
interface TursoModule {
  TursoStorage: new (dbUrl?: string, authToken?: string) => StorageAdapter;
}

/** The package's own bare specifier for its Turso adapter (05-03 exports subpath). Kept as a non-literal so `import()` below never triggers TS's literal-specifier module resolution (see file docstring). */
const TURSO_MODULE_SPECIFIER = 'cool-astro-forms/server/storage/turso.js';

/** config wins when present; else the CAF_STORAGE_KIND env bridge; else 'sqlite'. Any value other than the literal 'turso' resolves to 'sqlite' (safe default, mirrors the config schema's own enum). */
function resolveKind(config?: CoolFormsConfig): StorageKind {
  const raw = config?.storage?.kind ?? process.env.CAF_STORAGE_KIND;
  return raw === 'turso' ? 'turso' : 'sqlite';
}

/**
 * Resolves the `StorageAdapter` for the current backend selection.
 *
 * - `getStorageAdapter(config)` — routes/middleware, which have the
 *   validated config in hand.
 * - `getStorageAdapter()` — `recordSubmission`'s production default;
 *   resolves purely from the `CAF_STORAGE_KIND`/`CAF_DB_PATH` env bridge.
 */
export async function getStorageAdapter(config?: CoolFormsConfig): Promise<StorageAdapter> {
  const kind = resolveKind(config);

  if (kind === 'turso') {
    const { TursoStorage } = (await import(TURSO_MODULE_SPECIFIER)) as TursoModule;
    return new TursoStorage(process.env.CAF_TURSO_DATABASE_URL, process.env.CAF_TURSO_AUTH_TOKEN);
  }

  return new SqliteStorage(getDb(config?.dbPath));
}
