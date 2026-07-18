/**
 * rate-limit-store.ts tests — the OPT-IN, adapter-backed (persistent)
 * token-bucket limiter (D2 fix #1, ADPT-01). Mirrors rate-limit.test.ts's
 * assertions one-for-one (same algorithm, async surface) so the two
 * limiters stay behaviorally interchangeable from the caller's point of
 * view. Deterministic via injected `now` — no real clock, no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorageAdapter } from '../storage/adapter.js';
import { getDb, resetDbCache } from '../storage/db.js';
import { SqliteStorage } from '../storage/sqlite.js';
import { StorageBackedRateLimiter } from './rate-limit-store.js';

describe('StorageBackedRateLimiter — against a real :memory: SqliteStorage', () => {
  beforeEach(() => {
    resetDbCache();
  });

  afterEach(() => {
    resetDbCache();
  });

  it('allows up to capacity immediate calls from one IP, then denies the next', async () => {
    const storage = new SqliteStorage(getDb(':memory:'));
    const limiter = new StorageBackedRateLimiter(storage, { capacity: 3, refillPerSec: 1 });
    const now = 1_000_000;
    expect(await limiter.allow('1.2.3.4', now)).toBe(true);
    expect(await limiter.allow('1.2.3.4', now)).toBe(true);
    expect(await limiter.allow('1.2.3.4', now)).toBe(true);
    expect(await limiter.allow('1.2.3.4', now)).toBe(false);
  });

  it('refills tokens after elapsed time (deterministic via injected now) and allows again', async () => {
    const storage = new SqliteStorage(getDb(':memory:'));
    const limiter = new StorageBackedRateLimiter(storage, { capacity: 3, refillPerSec: 1 });
    const start = 1_000_000;
    await limiter.allow('1.2.3.4', start);
    await limiter.allow('1.2.3.4', start);
    await limiter.allow('1.2.3.4', start);
    expect(await limiter.allow('1.2.3.4', start)).toBe(false);

    // Advance 2s at refillPerSec=1 -> ~2 tokens refilled -> allowed again.
    expect(await limiter.allow('1.2.3.4', start + 2_000)).toBe(true);
  });

  it('gives distinct IPs independent buckets', async () => {
    const storage = new SqliteStorage(getDb(':memory:'));
    const limiter = new StorageBackedRateLimiter(storage, { capacity: 1, refillPerSec: 1 });
    const now = 1_000_000;
    expect(await limiter.allow('1.1.1.1', now)).toBe(true);
    expect(await limiter.allow('1.1.1.1', now)).toBe(false);
    expect(await limiter.allow('2.2.2.2', now)).toBe(true);
  });

  it('is fully deterministic given an identical injected now (no real timers)', async () => {
    const storage = new SqliteStorage(getDb(':memory:'));
    const limiter = new StorageBackedRateLimiter(storage, { capacity: 1, refillPerSec: 1 });
    expect(await limiter.allow('9.9.9.9', 0)).toBe(true);
    expect(await limiter.allow('9.9.9.9', 0)).toBe(false);
  });

  it('defaults now to Date.now() when the second arg is omitted', async () => {
    const storage = new SqliteStorage(getDb(':memory:'));
    const limiter = new StorageBackedRateLimiter(storage, { capacity: 1, refillPerSec: 1 });
    expect(await limiter.allow('3.3.3.3')).toBe(true);
  });
});

describe('StorageBackedRateLimiter — bucket-key namespacing (fake adapter)', () => {
  it('delegates to storage.consumeRateLimitToken with a bucket key namespaced under "abandon:" plus the capacity/refillPerSec options', async () => {
    const consumeRateLimitToken = vi.fn(async () => true);
    const fakeStorage = { consumeRateLimitToken } as unknown as StorageAdapter;

    const limiter = new StorageBackedRateLimiter(fakeStorage, { capacity: 7, refillPerSec: 2.5 });
    const allowed = await limiter.allow('9.9.9.9', 1_000);

    expect(allowed).toBe(true);
    expect(consumeRateLimitToken).toHaveBeenCalledWith('abandon:9.9.9.9', 7, 2.5, 1_000);
  });

  it('two different IPs never collide on the same bucket key', async () => {
    const calls: string[] = [];
    const fakeStorage = {
      consumeRateLimitToken: vi.fn(async (bucketKey: string) => {
        calls.push(bucketKey);
        return true;
      }),
    } as unknown as StorageAdapter;

    const limiter = new StorageBackedRateLimiter(fakeStorage, { capacity: 1, refillPerSec: 1 });
    await limiter.allow('1.1.1.1', 1_000);
    await limiter.allow('2.2.2.2', 1_000);

    expect(calls).toEqual(['abandon:1.1.1.1', 'abandon:2.2.2.2']);
  });
});
