# Serverless deploys

This package's zero-config default is a **persistent-disk, long-lived
process**: SQLite on disk (`dbPath`, default `data/forms.db`), an
auto-generated-and-persisted HMAC secret for admin sessions/unsubscribe
links, and an in-process `Map` for rate-limit buckets. That default is
correct and unchanged for a VPS, a Docker container with a volume, a
Node-on-Hostinger/Render/Railway box — anywhere `data/` survives between
requests and the process itself survives for more than one request.

**Serverless hosts (Vercel, Netlify Functions, Cloudflare Workers/Pages
Functions, and similar) break that assumption on two axes**, both because
the filesystem is ephemeral and the process can be torn down and a fresh
one spun up ("cold start") between any two requests. This package does not
detect "serverless" for you and does not silently patch around it — it
requires you to opt in explicitly to the fixes below. Skipping this section
does not error at build time; it fails quietly in production the first time
a cold start hits, which is worse.

## 1. The two serverless gaps, stated bluntly

### Gap 1 — the in-memory rate limiter resets every cold start

The default `rateLimit.store: 'memory'` limiter is a module-level `Map` on
the process that handled the request. On a serverless host, a fresh cold
start means a fresh, empty `Map` — every burst-abuse window silently
resets, and the abandon route's rate limiting **no-ops** exactly when a
serverless host is most likely to be hit by a burst (every cold start is,
by definition, a fresh worker with zero memory of prior traffic). This is
not a crash and produces no error — it just quietly stops protecting you.

**Fix:** set `rateLimit.store: 'storage'` in your `coolForms()` config.
This routes token-bucket state through `StorageAdapter.consumeRateLimitToken`
(an atomic, transaction-serialized claim — both the SQLite and Turso
backends implement it), so bucket state survives a cold start the same way
your form entries do. The in-memory `'memory'` store remains the default
for long-lived hosts — this is opt-in, not automatic, because a storage-backed
limiter costs one extra DB round-trip per request on hosts that don't need it.

```ts
coolForms({
  // ...
  rateLimit: { store: 'storage' },
});
```

### Gap 2 — an auto-generated secret regenerates on every cold start

By default, `FORMS_ADMIN_SECRET` (admin session HMAC key) and
`CAF_RECOVERY_SECRET` (unsubscribe-token HMAC key, only relevant when
`recovery.enabled`) fall back to a value this package generates once and
**persists beside `dbPath`** — fine on a host where `data/` survives
restarts. On an ephemeral serverless filesystem, that persisted file never
survives past the request that wrote it: the next cold start finds no file,
generates a brand-new secret, and every signed admin session and every
unsubscribe link issued before that moment silently stops validating. No
error is logged anywhere — a visitor's unsubscribe link just quietly starts
returning "invalid or expired", and an admin's session just quietly starts
requiring re-login, at a moment with no correlated deploy or config change
to point at.

**Fix:** set `CAF_REQUIRE_EXPLICIT_SECRETS=1` and set `FORMS_ADMIN_SECRET`
(and `CAF_RECOVERY_SECRET` if recovery is enabled) explicitly in your host's
environment panel. With the flag on, boot **fails loud** the moment either
required secret is absent — a startup error naming the missing variable and
the ephemeral-FS rationale, instead of a silent regenerate-and-drift. With
the flag off (the default, unchanged for long-lived hosts), the
generate-and-persist fallback behaves exactly as it always has.

```bash
# serverless host env panel
CAF_REQUIRE_EXPLICIT_SECRETS=1
FORMS_ADMIN_SECRET=a-long-random-value-you-generate-once
CAF_RECOVERY_SECRET=a-second-long-random-value   # only if recovery.enabled
```

Generate each secret once, on your own machine, e.g.
`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
— then paste the output into your host's env panel and never regenerate it
(regenerating invalidates every session/link signed with the old value,
exactly like rotating any other HMAC key).

## 2. Storage backend: Turso (libSQL)

SQLite-on-disk (the default) does not exist on a serverless host — there is
no persistent disk to put `data/forms.db` on. **Turso** is this package's
serverless-compatible storage backend: a hosted, SQLite-dialect-compatible
database reached over `@libsql/client`, with the same `BEGIN IMMEDIATE`
atomic-claim semantics the SQLite adapter already relies on for exactly-once
guarantees (`markRecoverySent`, `appendPaymentEventIfAbsent`,
`consumeRateLimitToken`). It passes the identical adapter contract suite the
SQLite backend does — there is no reduced-functionality "serverless mode",
every method works the same way against either backend.

### Setup

1. Create a Turso database (`turso db create <name>` via the
   [Turso CLI](https://docs.turso.tech/cli/introduction), or through the
   Turso dashboard) and grab its connection URL and an auth token.
2. Install the optional peer dependency in your host project:
   `npm install @libsql/client`. This package never bundles it into your
   SSR output unless you actually select the Turso backend — a default
   SQLite host pulls in zero Turso-related code.
3. Set `storage.kind: 'turso'` in your `coolForms()` config:

   ```ts
   coolForms({
     // ...
     storage: { kind: 'turso' },
   });
   ```

4. Set the connection details as **environment variables only** — never in
   `astro.config.mjs`, never anywhere client-reachable. This mirrors the
   same server-secret boundary `STRIPE_SECRET_KEY`/`GOOGLE_DRIVE_CLIENT_SECRET`
   already sit behind:

   | Variable | Required | Purpose |
   |---|---|---|
   | `CAF_TURSO_DATABASE_URL` | To use the Turso backend | libSQL/Turso connection URL, read server-side only. |
   | `CAF_TURSO_AUTH_TOKEN` | For a remote Turso database | Turso auth token. Optional for a local embedded/file URL, required for a real remote Turso database. |

`storage.kind` picks the backend for **everything** this package writes —
submissions, abandons, admin actions, rate-limit buckets, all land in the
same backend. There is no split-brain mode where some writes go to SQLite
and others to Turso.

### Postgres pooling guidance (for the future v2 path)

`pg.Pool` connection pooling guidance for a future Postgres backend: cap
`max` low (e.g. `max: 1` per serverless function instance, or use a host
connection pooler like PgBouncer/Neon's/Supabase's built-in pooler) — a
serverless function that opens a fresh unbounded pool on every cold start
exhausts a traditional Postgres `max_connections` limit far faster than a
long-lived server ever would. This is forward-looking guidance only; see
§3 below — Postgres is not a shipped backend in this version.

## 3. Postgres — not shipped in v1, starting notes for v2

**Postgres is not a supported storage backend in this version.** Turso was
chosen as the first serverless-compatible adapter specifically because its
SQLite-dialect compatibility let the existing single-writer, `BEGIN
IMMEDIATE`-based atomic-claim pattern (`markRecoverySent`,
`appendPaymentEventIfAbsent`, `consumeRateLimitToken`) port with almost no
redesign. Postgres does not have an equivalent single-writer serialization
primitive, so a Postgres adapter cannot just reuse that pattern — it needs
its own transactional design. These are the starting notes for whoever
builds that adapter next, recorded here so they start right instead of
rediscovering the same tradeoffs:

- **Concurrency primitive:** Postgres's MVCC model allows genuine concurrent
  writers, so the SQLite single-writer assumption doesn't hold. The two
  realistic options are `pg_advisory_xact_lock` (an explicit advisory lock
  scoped to the transaction, held for the duration of the atomic claim) or a
  single conditional `UPDATE ... WHERE <not-already-claimed> RETURNING *`
  (relying on Postgres's own row-level locking instead of an app-level
  advisory lock). Either is a legitimate choice; a conditional `UPDATE` is
  usually the lower-overhead option when the claim is a single-row
  compare-and-set (exactly the shape `markRecoverySent`/
  `appendPaymentEventIfAbsent`/`consumeRateLimitToken` all need), while an
  advisory lock is more appropriate if a future method needs to hold a lock
  across multiple statements.
- **Offline contract testing:** `@electric-sql/pglite` (an in-process,
  WASM-compiled Postgres) is the offline-testable equivalent of what
  `@libsql/client`'s `:memory:` mode gives the Turso adapter today — it lets
  the existing `runStorageContract` suite run against a real Postgres engine
  with zero external services and zero Docker, the same "no live network in
  any test, ever" invariant this package holds everywhere else.
- **Migration SQL:** the existing `MIGRATION_SQL` constant
  (`src/server/storage/migrations.ts`) is written to be dialect-neutral
  where the two shipped backends already agree, but a Postgres adapter will
  likely need its own migration list — SQLite/libSQL and Postgres diverge on
  enough DDL specifics (autoincrement syntax, `JSON` vs `JSONB`, etc.) that
  forcing one literal SQL string across three dialects is not worth the
  contortion. Keep the *shape* (an ordered list walked against a version
  counter) even if the SQL text itself forks per backend.

No `pg`, `@electric-sql/pglite`, or `@types/pg` dependency ships with this
version — adding any of them is exactly the first step whoever picks up the
Postgres backend takes.

## 4. `/forms-admin/export.db` is SQLite-only

The full-database `.db` snapshot download available from every admin page
uses better-sqlite3's own native `db.backup()` call — there is no adapter-level
equivalent of "give me a binary snapshot of the whole database" in the
29-method `StorageAdapter` interface, because that's a SQLite-file-specific
operation, not a portable storage primitive. On the Turso backend (or any
future non-sqlite backend), `GET /forms-admin/export.db` returns a clean
`501` with `{"error":"database snapshot download is only available on the
sqlite storage backend"}` — **never** a `500`, and never a silently stale
or empty local `.db` file pretending to be current data.

If you're on Turso, use one of these instead:

- The per-view **CSV export** (works identically on every backend — it goes
  through `exportCsv()` on the `StorageAdapter`, not through `db.backup()`).
- A Turso-native dump: `turso db shell <name> .dump`, or the equivalent
  export command in the Turso dashboard/CLI, gives you a full snapshot
  directly from the database itself.

## 5. Live deploy drills are a human item

Everything above is proven by this package's own automated test suite: the
Turso adapter's entire contract suite (including the concurrency races for
every atomic-claim method) runs against `@libsql/client`'s `:memory:` mode —
in-process, zero external services, zero Docker, no live network call ever
made to a real Turso database in this repository's tests. A real Vercel or
Netlify deploy pointed at a real remote Turso database, with a real cold
start actually observed, is a deferred owner-gated human verification item —
the same category as this package's live-Cloudflare-Turnstile and live-Stripe/PayPal
drills. It is not required for this package's automated tests to pass, and
not something a CI pipeline should attempt.
