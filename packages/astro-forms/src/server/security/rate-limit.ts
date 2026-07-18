/**
 * In-memory per-IP token-bucket rate limiter (SEC-01, T-01-09).
 *
 * RESEARCH.md "Don't Hand-Roll": this is the ONE deliberate hand-roll
 * exception in this project — a single-process, well-understood algorithm
 * where pulling in a rate-limiting library would add a dependency without
 * removing meaningful risk. Clean-room, written fresh, not derived from any
 * commercial form-plugin source.
 *
 * T-01-35 (accepted risk): per-IP limiting is best-effort under an
 * unverified proxy topology (Hostinger/Passenger `clientAddress` trust is a
 * MANDATORY Phase 6 pre-flight item, not solved here).
 */

export interface RateLimiterOptions {
  /** Maximum tokens (and therefore maximum immediate burst) per bucket. */
  capacity: number;
  /** Tokens restored per second of elapsed time. */
  refillPerSec: number;
  /** Bucket idle time (ms) after which it is opportunistically evicted. Default 10 minutes. */
  ttlMs?: number;
}

export interface RateLimiter {
  /** Returns true if the call is allowed (a token was consumed), false if throttled. */
  allow(ip: string, now?: number): boolean;
  /** Current number of tracked IP buckets — exposed for eviction-bound tests. */
  size(): number;
  /** Empties all buckets. Consumed by resetDefaultRateLimiter (Plan 09 DEV-only debug reset). */
  clear(): void;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

const DEFAULT_TTL_MS = 600_000; // 10 minutes

export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const { capacity, refillPerSec, ttlMs = DEFAULT_TTL_MS } = opts;
  const buckets = new Map<string, Bucket>();

  function sweep(now: number): void {
    for (const [ip, bucket] of buckets) {
      if (now - bucket.lastRefillMs > ttlMs) {
        buckets.delete(ip);
      }
    }
  }

  return {
    allow(ip: string, now: number = Date.now()): boolean {
      // Opportunistic eviction on every call bounds Map memory under
      // rotating-IP floods (T-01-09) — acceptable O(n) cost at this scale.
      sweep(now);

      let bucket = buckets.get(ip);
      if (!bucket) {
        bucket = { tokens: capacity, lastRefillMs: now };
        buckets.set(ip, bucket);
      } else {
        const elapsedSec = Math.max(0, (now - bucket.lastRefillMs) / 1000);
        bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSec * refillPerSec);
        bucket.lastRefillMs = now;
      }

      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return true;
      }
      return false;
    },
    size(): number {
      return buckets.size;
    },
    clear(): void {
      buckets.clear();
    },
  };
}

/**
 * Shared per-process limiter the abandon handler (Plan 06) reuses across
 * requests. ~20 requests/minute steady-state, burst up to 20.
 */
export const defaultRateLimiter: RateLimiter = createRateLimiter({
  capacity: 20,
  refillPerSec: 20 / 60,
});

/**
 * Test/DEV-only hook: empties the shared default limiter's bucket map
 * in place (does not replace its identity) so callers holding a reference
 * to `defaultRateLimiter` observe the reset. Consumed by the playground's
 * DEV-only debug reset endpoint (Plan 09).
 */
export function resetDefaultRateLimiter(): void {
  defaultRateLimiter.clear();
}
