/**
 * cleanPaymentLabel (0.1.18): what a visitor-typed label becomes before it
 * reaches Stripe or an entry memo. Lone surrogate halves are removed because
 * the Stripe SDK form-encodes the name with encodeURIComponent, which throws a
 * URIError on them, and createCheckoutForEntry would then report a
 * provider-error for a booking the payer did nothing wrong on.
 */
import { describe, expect, it } from 'vitest';
import { MAX_PAYMENT_LABEL_LENGTH, cleanPaymentLabel } from './label.js';

/** The Stripe SDK's own failure: encodeURIComponent throws a URIError on a lone surrogate. */
const encodes = (text: string) => {
  try {
    encodeURIComponent(text);
    return true;
  } catch {
    return false;
  }
};

describe('cleanPaymentLabel', () => {
  it('removes a lone high surrogate (a split emoji)', () => {
    expect(cleanPaymentLabel('Tour \uD83E')).toBe('Tour');
  });

  it('removes a lone low surrogate', () => {
    expect(cleanPaymentLabel('\uDD81Tour')).toBe('Tour');
  });

  it('keeps a valid surrogate pair', () => {
    expect(cleanPaymentLabel('Lion \u{1F981} safari')).toBe('Lion \u{1F981} safari');
  });

  it('returns a well-formed string whatever lone halves it was given', () => {
    const cleaned = cleanPaymentLabel('a\uD83Eb\uDD81c\u{1F981}d');

    expect(encodes('a\uD83Eb')).toBe(false);
    expect(cleaned).toBe('abc\u{1F981}d');
    expect(encodes(cleaned!)).toBe(true);
  });

  it('is undefined when only a lone surrogate was given, so the caller applies its default name', () => {
    expect(cleanPaymentLabel('\uD83E')).toBeUndefined();
  });

  it('collapses whitespace and removes control characters', () => {
    expect(cleanPaymentLabel('  Serengeti\u0000 tour\r\n2\t')).toBe('Serengeti tour 2');
  });

  it('caps at the maximum in code points without splitting an emoji', () => {
    const cleaned = cleanPaymentLabel('\u{1F981}'.repeat(MAX_PAYMENT_LABEL_LENGTH + 5));

    expect(Array.from(cleaned!)).toHaveLength(MAX_PAYMENT_LABEL_LENGTH);
    expect(encodes(cleaned!)).toBe(true);
  });

  it('is undefined for a non-string', () => {
    expect(cleanPaymentLabel(42)).toBeUndefined();
  });
});
