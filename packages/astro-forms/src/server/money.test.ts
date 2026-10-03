/**
 * money.ts tests: the minor-unit exponent table every amount conversion in
 * the package reads. Stripe takes `unit_amount` in the currency's smallest
 * unit, and that unit is not always 1/100 (docs.stripe.com/currencies:
 * zero-decimal list, three-decimal currencies, and the ISK/UGX special
 * cases that stay two-decimal in the API). A wrong exponent shows a guest a
 * price 100x off, so each class is pinned here with a real code.
 */
import { describe, expect, it } from 'vitest';
import { isTwoDecimalCurrency, minorUnitExponent } from './money.js';

describe('minorUnitExponent', () => {
  it('is 2 for ordinary two-decimal currencies, in any letter case (AED is the fleet case)', () => {
    expect(minorUnitExponent('usd')).toBe(2);
    expect(minorUnitExponent('AED')).toBe(2);
    expect(minorUnitExponent('eur')).toBe(2);
  });

  it("is 0 for Stripe's zero-decimal currencies: 500 JPY is unit_amount 500", () => {
    for (const code of ['jpy', 'krw', 'vnd', 'clp', 'xof', 'XAF']) {
      expect(minorUnitExponent(code)).toBe(0);
    }
  });

  it('is 3 for the three-decimal currencies Stripe supports', () => {
    for (const code of ['bhd', 'jod', 'kwd', 'omr', 'tnd']) {
      expect(minorUnitExponent(code)).toBe(3);
    }
  });

  it('keeps ISK and UGX at 2: Stripe represents both as two-decimal values for backwards compatibility, although ISO lists them as zero-decimal', () => {
    expect(minorUnitExponent('isk')).toBe(2);
    expect(minorUnitExponent('ugx')).toBe(2);
  });
});

describe('isTwoDecimalCurrency', () => {
  it('accepts two-decimal codes and rejects zero- and three-decimal ones', () => {
    expect(isTwoDecimalCurrency('aed')).toBe(true);
    expect(isTwoDecimalCurrency('usd')).toBe(true);
    expect(isTwoDecimalCurrency('jpy')).toBe(false);
    expect(isTwoDecimalCurrency('kwd')).toBe(false);
  });
});
