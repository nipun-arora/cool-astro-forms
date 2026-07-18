/**
 * Honeypot field detection (SEC-01, T-01-11). Clean-room, written fresh.
 */
import { HONEYPOT_FIELD_NAME } from '../../types.js';

function isFilled(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

/**
 * A submission is spam if either an explicitly-passed `honeypotValue` is
 * non-empty, or the reserved honeypot field name is present and filled
 * directly inside `fields`.
 */
export function isHoneypotTripped(fields: Record<string, unknown>, honeypotValue?: string): boolean {
  if (isFilled(honeypotValue)) return true;
  return isFilled(fields[HONEYPOT_FIELD_NAME]);
}
