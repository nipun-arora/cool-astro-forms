/**
 * Shared constant-time compare (T-02-14). Extracted verbatim from
 * canary.ts's original private `tokensMatch()` (T-01-41) so every password/
 * token comparison in this package — canary auth, admin login — goes
 * through one convention instead of two independently-maintained copies.
 */
import { timingSafeEqual } from 'node:crypto';

/** Constant-time compare. Length-guarded first — timingSafeEqual throws on unequal-length buffers (T-01-41). */
export function tokensMatch(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}
