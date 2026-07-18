/**
 * honeypot.ts tests — anti-automation honeypot field detection (SEC-01,
 * T-01-11). Clean-room, written fresh.
 */
import { describe, expect, it } from 'vitest';
import { HONEYPOT_FIELD_NAME } from '../../types.js';
import { isHoneypotTripped } from './honeypot.js';

describe('isHoneypotTripped', () => {
  it('returns true when an explicit honeypotValue is non-empty', () => {
    expect(isHoneypotTripped({}, 'bot-filled')).toBe(true);
  });

  it('returns false when an explicit honeypotValue is an empty string', () => {
    expect(isHoneypotTripped({}, '')).toBe(false);
  });

  it('returns false when honeypotValue is undefined and no honeypot field is present', () => {
    expect(isHoneypotTripped({})).toBe(false);
  });

  it('returns true when the reserved honeypot field is present and filled in fields', () => {
    expect(isHoneypotTripped({ [HONEYPOT_FIELD_NAME]: 'i-am-a-bot' })).toBe(true);
  });

  it('returns false when the reserved honeypot field is present but empty', () => {
    expect(isHoneypotTripped({ [HONEYPOT_FIELD_NAME]: '' })).toBe(false);
  });

  it('returns false when the reserved honeypot field value is not a string', () => {
    expect(isHoneypotTripped({ [HONEYPOT_FIELD_NAME]: 123 })).toBe(false);
  });
});
