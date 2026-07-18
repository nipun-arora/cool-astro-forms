/**
 * admin-session.ts tests — HMAC-signed HttpOnly session token (D4, 7-day
 * default TTL). Research Pattern 2: `${exp}.${hmacSha256(String(exp), secret)}`.
 * Clean-room, not derived from any WPForms source.
 */
import { describe, expect, it } from 'vitest';
import { issueSession, verifySession } from './admin-session.js';

const SECRET = 'test-secret-do-not-use-in-prod';

describe('issueSession / verifySession', () => {
  it('issueSession returns an "exp.sig" shaped string', () => {
    const token = issueSession(SECRET, 60_000);
    const parts = token.split('.');
    expect(parts).toHaveLength(2);
    expect(Number(parts[0])).toBeGreaterThan(Date.now());
  });

  it('verifies a freshly issued session as valid', () => {
    const token = issueSession(SECRET, 60_000);
    expect(verifySession(token, SECRET)).toBe(true);
  });

  it('is false once the expiry has passed (deterministic via injected now)', () => {
    const issuedAt = 1_000_000;
    const token = issueSession(SECRET, 1_000, issuedAt);
    expect(verifySession(token, SECRET, issuedAt + 500)).toBe(true);
    expect(verifySession(token, SECRET, issuedAt + 1_000)).toBe(false);
    expect(verifySession(token, SECRET, issuedAt + 5_000)).toBe(false);
  });

  it('is false for a tampered expiry (payload) even with a structurally valid signature format', () => {
    const token = issueSession(SECRET, 60_000);
    const [exp, sig] = token.split('.');
    const tampered = `${Number(exp) + 1_000_000}.${sig}`;
    expect(verifySession(tampered, SECRET)).toBe(false);
  });

  it('is false for a tampered signature', () => {
    const token = issueSession(SECRET, 60_000);
    const [exp] = token.split('.');
    const tampered = `${exp}.not-the-real-signature`;
    expect(verifySession(tampered, SECRET)).toBe(false);
  });

  it('is false when the cookie value has no dot separator', () => {
    expect(verifySession('no-dot-here', SECRET)).toBe(false);
  });

  it('is false when verified against the wrong secret', () => {
    const token = issueSession(SECRET, 60_000);
    expect(verifySession(token, 'a-different-secret')).toBe(false);
  });

  it('is false for an empty cookie value', () => {
    expect(verifySession('', SECRET)).toBe(false);
  });
});
