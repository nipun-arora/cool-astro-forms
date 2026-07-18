/**
 * rate-limit.ts tests — in-memory per-IP token-bucket rate limiter.
 *
 * RESEARCH.md "Don't Hand-Roll": this hand-rolled token bucket is the ONE
 * documented, deliberate exception (single-process, no external dependency).
 * Clean-room, written fresh — not derived from any commercial form-plugin source.
 */
import { describe, expect, it } from 'vitest';
import { createRateLimiter, defaultRateLimiter, resetDefaultRateLimiter } from './rate-limit.js';

describe('createRateLimiter', () => {
  it('allows up to capacity immediate calls from one IP, then denies the next', () => {
    const limiter = createRateLimiter({ capacity: 3, refillPerSec: 1 });
    const now = 1_000_000;
    expect(limiter.allow('1.2.3.4', now)).toBe(true);
    expect(limiter.allow('1.2.3.4', now)).toBe(true);
    expect(limiter.allow('1.2.3.4', now)).toBe(true);
    expect(limiter.allow('1.2.3.4', now)).toBe(false);
  });

  it('refills tokens after elapsed time (deterministic via injected now) and allows again', () => {
    const limiter = createRateLimiter({ capacity: 3, refillPerSec: 1 });
    const start = 1_000_000;
    limiter.allow('1.2.3.4', start);
    limiter.allow('1.2.3.4', start);
    limiter.allow('1.2.3.4', start);
    expect(limiter.allow('1.2.3.4', start)).toBe(false);

    // Advance 2s at refillPerSec=1 -> ~2 tokens refilled -> allowed again.
    expect(limiter.allow('1.2.3.4', start + 2_000)).toBe(true);
  });

  it('gives distinct IPs independent buckets', () => {
    const limiter = createRateLimiter({ capacity: 1, refillPerSec: 1 });
    const now = 1_000_000;
    expect(limiter.allow('1.1.1.1', now)).toBe(true);
    expect(limiter.allow('1.1.1.1', now)).toBe(false);
    expect(limiter.allow('2.2.2.2', now)).toBe(true);
  });

  it('is fully deterministic given an identical injected now (no real timers)', () => {
    const limiter = createRateLimiter({ capacity: 1, refillPerSec: 1 });
    expect(limiter.allow('9.9.9.9', 0)).toBe(true);
    expect(limiter.allow('9.9.9.9', 0)).toBe(false);
  });

  it('opportunistically evicts stale buckets past the TTL, bounding Map size under rotating-IP floods', () => {
    const limiter = createRateLimiter({ capacity: 1, refillPerSec: 1, ttlMs: 10_000 });
    const start = 1_000_000;
    for (let i = 0; i < 50; i += 1) {
      limiter.allow(`10.0.0.${i}`, start);
    }
    expect(limiter.size()).toBe(50);

    // Advance the injected `now` past the TTL and hit the limiter with a
    // fresh IP — the sweep must run and shrink the Map.
    limiter.allow('fresh-ip', start + 20_000);
    expect(limiter.size()).toBeLessThan(50);
  });
});

describe('defaultRateLimiter / resetDefaultRateLimiter', () => {
  it('resetDefaultRateLimiter empties the shared default limiter buckets', () => {
    resetDefaultRateLimiter();
    expect(defaultRateLimiter.size()).toBe(0);

    defaultRateLimiter.allow('5.5.5.5', 1_000_000);
    expect(defaultRateLimiter.size()).toBeGreaterThan(0);

    resetDefaultRateLimiter();
    expect(defaultRateLimiter.size()).toBe(0);
  });
});
