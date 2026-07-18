/**
 * HMAC-signed session token for /forms-admin (ADMN-01, D4: 7-day default
 * TTL). Research Pattern 2: `${exp}.${hmacSha256(String(exp), secret)}` —
 * the expiry itself is the signed payload, so verification is a single
 * signature check plus a numeric comparison, no JSON parsing on the hot
 * path. Clean-room, reusing the canary.ts node:crypto convention
 * (createHmac / tokensMatch), not derived from any WPForms source.
 */
import { createHmac } from 'node:crypto';
import { tokensMatch } from './constant-time-compare.js';

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** Issues a `"exp.sig"` session token expiring `ttlMs` after `now` (default: real time). */
export function issueSession(secret: string, ttlMs: number, now: number = Date.now()): string {
  const exp = now + ttlMs;
  const expStr = String(exp);
  return `${expStr}.${sign(expStr, secret)}`;
}

/**
 * Verifies a session token: well-formed shape, constant-time signature
 * match against `secret`, and not-yet-expired against `now` (default: real
 * time). Never throws — any malformed input resolves to `false`.
 */
export function verifySession(cookieValue: string, secret: string, now: number = Date.now()): boolean {
  const dotIndex = cookieValue.indexOf('.');
  if (dotIndex === -1) return false;

  const expStr = cookieValue.slice(0, dotIndex);
  const sig = cookieValue.slice(dotIndex + 1);
  if (!expStr || !sig) return false;

  if (!tokensMatch(sig, sign(expStr, secret))) return false;

  const exp = Number(expStr);
  if (!Number.isFinite(exp)) return false;

  return exp > now;
}
