/**
 * constant-time-compare.ts tests — the shared timing-safe compare extracted
 * from canary.ts's private tokensMatch() (T-01-41 length-guard convention).
 * Clean-room, not derived from any WPForms source.
 */
import { describe, expect, it } from 'vitest';
import { tokensMatch } from './constant-time-compare.js';

describe('tokensMatch', () => {
  it('returns true for byte-equal strings', () => {
    expect(tokensMatch('correct-horse', 'correct-horse')).toBe(true);
  });

  it('returns false for a content mismatch of equal length', () => {
    expect(tokensMatch('correct-horsE', 'correct-horse')).toBe(false);
  });

  it('returns false for a length mismatch instead of throwing', () => {
    expect(() => tokensMatch('x', 'correct-horse')).not.toThrow();
    expect(tokensMatch('x', 'correct-horse')).toBe(false);
  });

  it('returns false when provided is empty and expected is not', () => {
    expect(tokensMatch('', 'correct-horse')).toBe(false);
  });

  it('never throws on zero-length buffers (equal-length empty strings are length-guard-equal)', () => {
    expect(() => tokensMatch('', '')).not.toThrow();
  });
});
