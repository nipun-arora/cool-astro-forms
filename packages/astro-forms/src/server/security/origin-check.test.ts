/**
 * origin-check.ts tests — clean-room, written fresh against MDN/Fetch spec
 * semantics for Origin/Referer headers, not derived from any commercial form-plugin source.
 *
 * RESEARCH.md Pitfall 1: Astro's built-in security.checkOrigin does NOT cover
 * application/json requests. This explicit same-origin check is the ONLY
 * origin protection the abandon route gets.
 */
import { describe, expect, it } from 'vitest';
import { isSameOrigin } from './origin-check.js';

const ALLOWED = 'https://site.example';

describe('isSameOrigin', () => {
  it('returns true when the Origin header matches the allowed origin', () => {
    const headers = new Headers({ Origin: 'https://site.example' });
    expect(isSameOrigin(headers, ALLOWED)).toBe(true);
  });

  it('returns false for a cross-site Origin header', () => {
    const headers = new Headers({ Origin: 'https://evil.example' });
    expect(isSameOrigin(headers, ALLOWED)).toBe(false);
  });

  it('returns false on scheme downgrade even though the host matches', () => {
    const headers = new Headers({ Origin: 'http://site.example' });
    expect(isSameOrigin(headers, ALLOWED)).toBe(false);
  });

  it('returns false on port mismatch even though scheme+host match', () => {
    const headers = new Headers({ Origin: 'https://site.example:8443' });
    expect(isSameOrigin(headers, ALLOWED)).toBe(false);
  });

  it('falls back to a matching Referer when Origin is absent', () => {
    const headers = new Headers({ Referer: 'https://site.example/checkout' });
    expect(isSameOrigin(headers, ALLOWED)).toBe(true);
  });

  it('returns false when Referer is absent and only Origin is present but mismatched', () => {
    const headers = new Headers({ Origin: 'https://evil.example', Referer: 'https://site.example/checkout' });
    expect(isSameOrigin(headers, ALLOWED)).toBe(false);
  });

  it('rejects (does not fail-open) when both Origin and Referer are absent', () => {
    const headers = new Headers();
    expect(isSameOrigin(headers, ALLOWED)).toBe(false);
  });

  it('treats an opaque "null" Origin as absent and rejects without a confirming Referer', () => {
    const headers = new Headers({ Origin: 'null' });
    expect(isSameOrigin(headers, ALLOWED)).toBe(false);
  });

  it('treats an opaque "null" Origin as absent and accepts a confirming Referer', () => {
    const headers = new Headers({ Origin: 'null', Referer: 'https://site.example/checkout' });
    expect(isSameOrigin(headers, ALLOWED)).toBe(true);
  });

  it('normalizes case and default ports via URL.origin comparison', () => {
    const headers = new Headers({ Origin: 'HTTPS://SITE.EXAMPLE:443' });
    expect(isSameOrigin(headers, ALLOWED)).toBe(true);
  });

  it('returns false for a malformed Origin header instead of throwing', () => {
    const headers = new Headers({ Origin: 'not-a-url' });
    expect(() => isSameOrigin(headers, ALLOWED)).not.toThrow();
    expect(isSameOrigin(headers, ALLOWED)).toBe(false);
  });

  it('returns false for a malformed Referer header instead of throwing', () => {
    const headers = new Headers({ Referer: 'not-a-url' });
    expect(() => isSameOrigin(headers, ALLOWED)).not.toThrow();
    expect(isSameOrigin(headers, ALLOWED)).toBe(false);
  });
});
