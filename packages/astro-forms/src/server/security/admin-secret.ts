/**
 * Resolves the HMAC signing key for admin sessions (T-02-11): env-first
 * (`FORMS_ADMIN_SECRET`), else generated once and persisted beside `dbPath`
 * — mirrors db.ts's `data/` persistence convention (recursive mkdir, same
 * directory as the SQLite file) so a redeploy that preserves `data/` also
 * preserves the secret and doesn't invalidate every open session.
 *
 * D2 fix #2 (05-01, ADPT-01): when `CAF_REQUIRE_EXPLICIT_SECRETS` is
 * truthy, the generate-and-persist fallback is disabled — an absent
 * `FORMS_ADMIN_SECRET` FAILS LOUD instead. On an ephemeral/serverless
 * filesystem the persisted file regenerates on every cold start, silently
 * invalidating every open admin session on each redeploy (05-RESEARCH.md
 * Pitfall 2). Default (flag unset) is byte-for-byte the pre-05-01 behavior.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SECRET_FILENAME = '.forms-admin-secret';

function secretPathFor(dbPath: string): string {
  return path.join(path.dirname(dbPath), SECRET_FILENAME);
}

/**
 * Truthiness reader for `CAF_REQUIRE_EXPLICIT_SECRETS`. `'1'` and `'true'`
 * (case-insensitive) are on; unset/`''`/`'0'`/`'false'`/anything else is
 * off. Shared by both secret resolvers (this file, recovery/unsubscribe-
 * token.ts's `resolveRecoverySecret`) and the middleware preflight
 * (security/secrets-preflight.ts) so all three read the exact same on/off
 * boundary.
 */
export function explicitSecretsRequired(): boolean {
  const raw = process.env.CAF_REQUIRE_EXPLICIT_SECRETS;
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
}

/**
 * Builds the fail-loud message for a missing required secret: names the env
 * var and states the ephemeral-FS rationale (05-RESEARCH.md Pitfall 2).
 * Shared by both resolvers and secrets-preflight.ts so the wording never
 * drifts between the three call sites.
 */
export function explicitSecretMissingMessage(envVar: string): string {
  return (
    `${envVar} is required because CAF_REQUIRE_EXPLICIT_SECRETS is enabled. ` +
    'On an ephemeral/serverless filesystem, auto-generating and persisting a ' +
    'secret regenerates on every cold start, silently invalidating every ' +
    `signed session/token on each redeploy. Set ${envVar} explicitly.`
  );
}

/**
 * Returns `FORMS_ADMIN_SECRET` when set. Otherwise, when
 * `CAF_REQUIRE_EXPLICIT_SECRETS` is truthy, THROWS instead of touching disk
 * (D2 fix #2). Otherwise reads the persisted secret beside `dbPath` if one
 * already exists, or generates `randomBytes(32)` (base64url), persists it,
 * and returns it — never regenerating once a file is present, so sessions
 * signed before a process restart stay valid.
 */
export function resolveAdminSecret(dbPath: string): string {
  const envSecret = process.env.FORMS_ADMIN_SECRET;
  if (envSecret) return envSecret;

  if (explicitSecretsRequired()) {
    throw new Error(explicitSecretMissingMessage('FORMS_ADMIN_SECRET'));
  }

  const secretPath = secretPathFor(dbPath);
  if (fs.existsSync(secretPath)) {
    return fs.readFileSync(secretPath, 'utf8').trim();
  }

  const generated = randomBytes(32).toString('base64url');
  fs.mkdirSync(path.dirname(secretPath), { recursive: true });
  // mode 0o600 (owner read/write only, CWE-732): without it, a file freshly
  // created under a permissive default umask (e.g. 022) is world-readable,
  // exposing the HMAC signing key to any other local user/process. The
  // owning process still reads it back fine (fs.readFileSync above).
  fs.writeFileSync(secretPath, generated, { encoding: 'utf8', mode: 0o600 });
  return generated;
}
