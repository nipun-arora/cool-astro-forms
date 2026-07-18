/**
 * sign.ts tests — HMAC-SHA256 `t=,v1=` outbound webhook signature scheme
 * (HOOK-01). Clean-room, not derived from any commercial form-plugin source.
 */
import { describe, expect, it } from 'vitest';
import { signWebhookPayload, verifyWebhookSignature } from './sign.js';

const SECRET = 'whsec_test_do_not_use_in_prod';
const PAYLOAD = JSON.stringify({ id: 'evt_1', type: 'entry.submitted', data: { foo: 'bar' } });

describe('signWebhookPayload', () => {
  it('returns a "t=<unixSec>,v1=<hex>" shaped header', () => {
    const header = signWebhookPayload(PAYLOAD, SECRET, 1_700_000_000_000);
    const match = header.match(/^t=(\d+),v1=([0-9a-f]{64})$/);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe('1700000000');
  });

  it('produces a different signature for a different secret (same payload/timestamp)', () => {
    const a = signWebhookPayload(PAYLOAD, SECRET, 1_700_000_000_000);
    const b = signWebhookPayload(PAYLOAD, 'a-different-secret', 1_700_000_000_000);
    expect(a).not.toBe(b);
  });
});

describe('verifyWebhookSignature — round trip', () => {
  it('verifies a freshly signed payload against the same secret and payload', () => {
    const now = 1_700_000_000_000;
    const header = signWebhookPayload(PAYLOAD, SECRET, now);
    expect(verifyWebhookSignature(PAYLOAD, header, SECRET, now)).toBe(true);
  });

  it('rejects a tampered payload (body changed after signing)', () => {
    const now = 1_700_000_000_000;
    const header = signWebhookPayload(PAYLOAD, SECRET, now);
    const tamperedPayload = JSON.stringify({ id: 'evt_1', type: 'entry.submitted', data: { foo: 'TAMPERED' } });
    expect(verifyWebhookSignature(tamperedPayload, header, SECRET, now)).toBe(false);
  });

  it('rejects the wrong secret', () => {
    const now = 1_700_000_000_000;
    const header = signWebhookPayload(PAYLOAD, SECRET, now);
    expect(verifyWebhookSignature(PAYLOAD, header, 'a-different-secret', now)).toBe(false);
  });

  it('rejects a timestamp older than the tolerance window', () => {
    const now = 1_700_000_000_000;
    const header = signWebhookPayload(PAYLOAD, SECRET, now);
    const toleranceSec = 300;
    // Exactly at the boundary is still within tolerance.
    expect(verifyWebhookSignature(PAYLOAD, header, SECRET, now + toleranceSec * 1000, toleranceSec)).toBe(true);
    // One second past the boundary is stale.
    expect(verifyWebhookSignature(PAYLOAD, header, SECRET, now + (toleranceSec + 1) * 1000, toleranceSec)).toBe(
      false,
    );
  });

  it('uses WEBHOOK_SIGNATURE_TOLERANCE_SEC as the default tolerance when not overridden', () => {
    const now = 1_700_000_000_000;
    const header = signWebhookPayload(PAYLOAD, SECRET, now);
    // WEBHOOK_SIGNATURE_TOLERANCE_SEC is 300s — 301s later must fail with no explicit toleranceSec arg.
    expect(verifyWebhookSignature(PAYLOAD, header, SECRET, now + 301_000)).toBe(false);
  });
});

describe('verifyWebhookSignature — malformed input never throws', () => {
  const now = 1_700_000_000_000;

  it('rejects a null/undefined header', () => {
    expect(verifyWebhookSignature(PAYLOAD, null, SECRET, now)).toBe(false);
    expect(verifyWebhookSignature(PAYLOAD, undefined, SECRET, now)).toBe(false);
  });

  it('rejects an empty-string header', () => {
    expect(verifyWebhookSignature(PAYLOAD, '', SECRET, now)).toBe(false);
  });

  it('rejects a header with no recognizable key=value pairs', () => {
    expect(verifyWebhookSignature(PAYLOAD, 'not-a-valid-header', SECRET, now)).toBe(false);
  });

  it('rejects a header missing v1', () => {
    expect(verifyWebhookSignature(PAYLOAD, 't=1700000000', SECRET, now)).toBe(false);
  });

  it('rejects a header missing t', () => {
    expect(verifyWebhookSignature(PAYLOAD, 'v1=deadbeef', SECRET, now)).toBe(false);
  });

  it('rejects a header with a non-numeric t', () => {
    expect(verifyWebhookSignature(PAYLOAD, 't=not-a-number,v1=deadbeef', SECRET, now)).toBe(false);
  });

  it('never throws for any malformed header shape', () => {
    expect(() => verifyWebhookSignature(PAYLOAD, 'garbage', SECRET, now)).not.toThrow();
    expect(() => verifyWebhookSignature(PAYLOAD, 't=1700000000,v1=', SECRET, now)).not.toThrow();
    expect(() => verifyWebhookSignature('', 't=1700000000,v1=deadbeef', SECRET, now)).not.toThrow();
  });
});
