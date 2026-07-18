/**
 * D4 one-click unsubscribe token: `${visitorUuid}.${hmacHex(visitorUuid,
 * secret)}`. Reuses the ONE HMAC convention in this package — mirrors
 * webhooks/sign.ts's private `hmacHex` helper + security/constant-time-
 * compare.ts's `tokensMatch` — never a second signing scheme (RESEARCH.md
 * Don't Hand-Roll). The token carries NO raw email — only the visitor UUID,
 * so a leaked/forwarded unsubscribe link never discloses an address.
 *
 * Clean-room: written fresh against the documented HMAC-token pattern, not
 * derived from any commercial form-plugin source.
 */
import { createHmac } from 'node:crypto';
import { explicitSecretMissingMessage, explicitSecretsRequired, resolveAdminSecret } from '../security/admin-secret.js';
import { tokensMatch } from '../security/constant-time-compare.js';

function hmacHex(message: string, secret: string): string {
  return createHmac('sha256', secret).update(message).digest('hex');
}

/** Signs `visitorUuid` -> the token value baked into the unsubscribe link's `?token=` query param. */
export function signUnsubscribeToken(visitorUuid: string, secret: string): string {
  return `${visitorUuid}.${hmacHex(visitorUuid, secret)}`;
}

/**
 * Verifies an unsubscribe token against `secret`, returning the visitorUuid
 * on success. Never throws — a null/undefined/empty/malformed/tampered
 * token, or the wrong secret, all resolve `undefined`. Splits on the LAST
 * dot (visitor UUIDs never contain a dot, but the split is defensive) and
 * constant-time-compares the recomputed hmac via `tokensMatch` so a forged
 * token can never be distinguished from a wrong one by timing.
 */
export function verifyUnsubscribeToken(token: string | null | undefined, secret: string): string | undefined {
  if (!token) return undefined;

  const dotIndex = token.lastIndexOf('.');
  if (dotIndex === -1) return undefined;

  const visitorUuid = token.slice(0, dotIndex);
  const providedSig = token.slice(dotIndex + 1);
  if (!visitorUuid || !providedSig) return undefined;

  const expectedSig = hmacHex(visitorUuid, secret);
  if (!tokensMatch(providedSig, expectedSig)) return undefined;

  return visitorUuid;
}

/**
 * Resolves the HMAC signing key for unsubscribe tokens: `CAF_RECOVERY_SECRET`
 * when set, else the SAME generated-and-persisted secret admin sessions use
 * (`resolveAdminSecret(dbPath)`, security/admin-secret.ts) — so a host never
 * needs a new env var to get a working, stable unsubscribe link. A future
 * host that wants a separate rotation boundary for unsubscribe tokens can
 * set `CAF_RECOVERY_SECRET` explicitly.
 *
 * D2 fix #2 (05-01, ADPT-01): when `CAF_REQUIRE_EXPLICIT_SECRETS` is
 * truthy, the resolveAdminSecret fallback is disabled — an absent
 * `CAF_RECOVERY_SECRET` FAILS LOUD instead of silently reusing the admin
 * secret. On an ephemeral/serverless filesystem that fallback rotates on
 * every cold start, silently invalidating every unsubscribe link on each
 * redeploy (05-RESEARCH.md Pitfall 2). Default (flag unset) is
 * byte-for-byte the pre-05-01 behavior.
 */
export function resolveRecoverySecret(dbPath: string): string {
  const envSecret = process.env.CAF_RECOVERY_SECRET;
  if (envSecret) return envSecret;

  if (explicitSecretsRequired()) {
    throw new Error(explicitSecretMissingMessage('CAF_RECOVERY_SECRET'));
  }

  return resolveAdminSecret(dbPath);
}
