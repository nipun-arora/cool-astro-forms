/**
 * StorageBackedRateLimiter — an OPT-IN, adapter-backed (persistent) token-
 * bucket rate limiter (D2 fix #1, RESEARCH Pitfall 1, ADPT-01).
 *
 * The in-process `defaultRateLimiter` (rate-limit.ts) is a module-level
 * `Map` — empty on every serverless cold start, so abuse protection on
 * `/api/forms/abandon` silently no-ops on Vercel/Netlify Functions. This
 * class delegates the atomic refill/consume arithmetic to
 * `StorageAdapter.consumeRateLimitToken` (BEGIN IMMEDIATE-serialized in the
 * SqliteStorage implementation), so the bucket state survives a cold start.
 *
 * The in-memory limiter remains the DEFAULT for long-lived hosts — this
 * class only activates when a host sets `rateLimit.store: 'storage'` in
 * `coolForms(config)` (routes/abandon.ts wiring).
 */
import type { StorageAdapter } from '../storage/adapter.js';

export interface StorageBackedRateLimiterOptions {
  /** Maximum tokens (and therefore maximum immediate burst) per bucket. */
  capacity: number;
  /** Tokens restored per second of elapsed time. */
  refillPerSec: number;
}

/**
 * Namespaces bucket keys per call-site so a future second caller of
 * `consumeRateLimitToken` (sharing the same `rate_limits` table) can never
 * collide with the abandon route's buckets.
 */
const BUCKET_PREFIX = 'abandon:';

export class StorageBackedRateLimiter {
  constructor(
    private readonly storage: StorageAdapter,
    private readonly opts: StorageBackedRateLimiterOptions,
  ) {}

  /** Returns true if the call is allowed (a token was consumed), false if throttled. */
  async allow(ip: string, now: number = Date.now()): Promise<boolean> {
    return this.storage.consumeRateLimitToken(
      `${BUCKET_PREFIX}${ip}`,
      this.opts.capacity,
      this.opts.refillPerSec,
      now,
    );
  }
}
