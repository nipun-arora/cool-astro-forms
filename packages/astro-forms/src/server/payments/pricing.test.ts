import { describe, expect, it } from 'vitest';
import {
  AMOUNT_DOLLARS_PATTERN,
  PAY_CENTS_PATTERN,
  parseAmountParam,
  resolveFeeLines,
  computeBreakdown,
  validatePaymentRequest,
} from './pricing.js';
import type { FeeLine } from '../../types.js';

function qs(params: Record<string, string>): URLSearchParams {
  return new URLSearchParams(params);
}

describe('parseAmountParam — ?amount= (dollars, D4)', () => {
  it('"200" -> 20000 cents', () => {
    expect(parseAmountParam(qs({ amount: '200' }))).toBe(20000);
  });

  it('"199.50" -> 19950 cents', () => {
    expect(parseAmountParam(qs({ amount: '199.50' }))).toBe(19950);
  });

  it('"0.5" -> 50 cents', () => {
    expect(parseAmountParam(qs({ amount: '0.5' }))).toBe(50);
  });

  it('"200.5" -> 20050 cents', () => {
    expect(parseAmountParam(qs({ amount: '200.5' }))).toBe(20050);
  });
});

describe('parseAmountParam — ?pay= (cents, legacy alias, D4)', () => {
  it('"20000" -> 20000 cents', () => {
    expect(parseAmountParam(qs({ pay: '20000' }))).toBe(20000);
  });
});

describe('parseAmountParam — amount wins when both params are present', () => {
  it('a valid amount takes precedence over a valid pay', () => {
    expect(parseAmountParam(qs({ amount: '200', pay: '99999' }))).toBe(20000);
  });

  it('an invalid amount does NOT fall back to a valid pay (amount governs when present)', () => {
    expect(parseAmountParam(qs({ amount: '+200', pay: '99999' }))).toBeUndefined();
  });
});

describe('parseAmountParam — strict-grammar reject cases (-> undefined, never a coerced number)', () => {
  it('pay="200.5" (fractional cents) -> undefined', () => {
    expect(parseAmountParam(qs({ pay: '200.5' }))).toBeUndefined();
  });

  it('pay="-200" (sign) -> undefined', () => {
    expect(parseAmountParam(qs({ pay: '-200' }))).toBeUndefined();
  });

  it('amount="-200" (sign) -> undefined', () => {
    expect(parseAmountParam(qs({ amount: '-200' }))).toBeUndefined();
  });

  it('amount="+200" (plus sign) -> undefined', () => {
    expect(parseAmountParam(qs({ amount: '+200' }))).toBeUndefined();
  });

  it('amount=" 200" (leading whitespace) -> undefined', () => {
    expect(parseAmountParam(qs({ amount: ' 200' }))).toBeUndefined();
  });

  it('amount="200 " (trailing whitespace) -> undefined', () => {
    expect(parseAmountParam(qs({ amount: '200 ' }))).toBeUndefined();
  });

  it('amount="1e3" (exponent) -> undefined', () => {
    expect(parseAmountParam(qs({ amount: '1e3' }))).toBeUndefined();
  });

  it('amount="200.999" (>2 decimals) -> undefined', () => {
    expect(parseAmountParam(qs({ amount: '200.999' }))).toBeUndefined();
  });

  it('amount="" (empty) -> undefined', () => {
    expect(parseAmountParam(qs({ amount: '' }))).toBeUndefined();
  });

  it('absent (neither param present) -> undefined', () => {
    expect(parseAmountParam(new URLSearchParams())).toBeUndefined();
  });

  it('amount="0x10" (hex) -> undefined', () => {
    expect(parseAmountParam(qs({ amount: '0x10' }))).toBeUndefined();
  });

  it('amount="2,000" (thousands separator) -> undefined', () => {
    expect(parseAmountParam(qs({ amount: '2,000' }))).toBeUndefined();
  });
});

describe('AMOUNT_DOLLARS_PATTERN / PAY_CENTS_PATTERN — pinned grammar intent', () => {
  it('AMOUNT_DOLLARS_PATTERN matches whole dollars and up-to-2-decimal amounts only', () => {
    expect(AMOUNT_DOLLARS_PATTERN.test('200')).toBe(true);
    expect(AMOUNT_DOLLARS_PATTERN.test('200.5')).toBe(true);
    expect(AMOUNT_DOLLARS_PATTERN.test('200.50')).toBe(true);
    expect(AMOUNT_DOLLARS_PATTERN.test('200.999')).toBe(false);
    expect(AMOUNT_DOLLARS_PATTERN.test('+200')).toBe(false);
    expect(AMOUNT_DOLLARS_PATTERN.test('-200')).toBe(false);
  });

  it('PAY_CENTS_PATTERN matches non-negative integers only', () => {
    expect(PAY_CENTS_PATTERN.test('20000')).toBe(true);
    expect(PAY_CENTS_PATTERN.test('200.5')).toBe(false);
    expect(PAY_CENTS_PATTERN.test('-200')).toBe(false);
  });
});

describe('resolveFeeLines — ?fee= override (D3)', () => {
  const payLinkFees: FeeLine[] = [{ label: 'Processing fee', percent: 0.03 }];
  const feePresets: Record<string, FeeLine[]> = {
    noFee: [],
    creditCard: [{ label: 'Card fee', flatCents: 50 }],
  };

  it('no ?fee param -> default payLinkFees', () => {
    expect(resolveFeeLines(qs({}), { payLinkFees, feePresets })).toBe(payLinkFees);
  });

  it('?fee=0 -> [] (fees disabled)', () => {
    expect(resolveFeeLines(qs({ fee: '0' }), { payLinkFees, feePresets })).toEqual([]);
  });

  it('?fee=<known-key> -> that preset array', () => {
    expect(resolveFeeLines(qs({ fee: 'creditCard' }), { payLinkFees, feePresets })).toEqual(
      feePresets.creditCard,
    );
  });

  it('?fee=<known-key> resolving to an empty preset (noFee) -> []', () => {
    expect(resolveFeeLines(qs({ fee: 'noFee' }), { payLinkFees, feePresets })).toEqual([]);
  });

  it('?fee=<unknown-key> -> falls back to default payLinkFees (never throws)', () => {
    expect(resolveFeeLines(qs({ fee: 'bogus' }), { payLinkFees, feePresets })).toBe(payLinkFees);
  });

  it('?fee=<key> with no feePresets configured at all -> falls back to default (never throws)', () => {
    expect(resolveFeeLines(qs({ fee: 'creditCard' }), { payLinkFees })).toBe(payLinkFees);
  });
});

describe('computeBreakdown — server-side fee breakdown (D3)', () => {
  it('empty fee list -> total === subtotal', () => {
    expect(computeBreakdown(10000, [])).toEqual({ subtotalCents: 10000, lines: [], totalCents: 10000 });
  });

  it('percent-fee rounding: base=333, percent=0.05 -> 17', () => {
    const result = computeBreakdown(333, [{ label: 'Fee', percent: 0.05 }]);
    expect(result.lines).toEqual([{ label: 'Fee', amountCents: 17 }]);
    expect(result.totalCents).toBe(350);
  });

  it('flat fee line', () => {
    const result = computeBreakdown(10000, [{ label: 'Flat fee', flatCents: 250 }]);
    expect(result.lines).toEqual([{ label: 'Flat fee', amountCents: 250 }]);
    expect(result.totalCents).toBe(10250);
  });

  it('mixed flat + percent fee lines, deterministic config order', () => {
    const result = computeBreakdown(10000, [
      { label: 'Percent fee', percent: 0.03 },
      { label: 'Flat fee', flatCents: 100 },
    ]);
    expect(result.lines).toEqual([
      { label: 'Percent fee', amountCents: 300 },
      { label: 'Flat fee', amountCents: 100 },
    ]);
    expect(result.totalCents).toBe(10400);
  });

  it('subtotalCents always mirrors the input baseAmountCents unchanged', () => {
    const result = computeBreakdown(4242, [{ label: 'Fee', percent: 0.1 }]);
    expect(result.subtotalCents).toBe(4242);
  });
});

describe('validatePaymentRequest — reject out-of-bounds, never clamp', () => {
  const requestPage = { minAmountCents: 100, maxAmountCents: 1_000_000, allowedCurrencies: ['usd'] };

  it('valid amount + currency -> {ok:true}', () => {
    expect(validatePaymentRequest({ baseAmountCents: 20000, currency: 'usd' }, requestPage)).toEqual({
      ok: true,
    });
  });

  it('amount=0 -> rejected (amount-range), never clamped up to the minimum', () => {
    expect(validatePaymentRequest({ baseAmountCents: 0, currency: 'usd' }, requestPage)).toEqual({
      ok: false,
      reason: 'amount-range',
    });
  });

  it('amount one cent over max -> rejected (amount-range), never clamped down to the maximum', () => {
    expect(validatePaymentRequest({ baseAmountCents: 1_000_001, currency: 'usd' }, requestPage)).toEqual({
      ok: false,
      reason: 'amount-range',
    });
  });

  it('amount exactly at min/max boundary -> accepted (inclusive range)', () => {
    expect(validatePaymentRequest({ baseAmountCents: 100, currency: 'usd' }, requestPage)).toEqual({ ok: true });
    expect(validatePaymentRequest({ baseAmountCents: 1_000_000, currency: 'usd' }, requestPage)).toEqual({
      ok: true,
    });
  });

  it('currency not in whitelist -> rejected (currency)', () => {
    expect(validatePaymentRequest({ baseAmountCents: 20000, currency: 'eur' }, requestPage)).toEqual({
      ok: false,
      reason: 'currency',
    });
  });

  it('currency comparison is case-insensitive (lowercased before compare)', () => {
    expect(validatePaymentRequest({ baseAmountCents: 20000, currency: 'USD' }, requestPage)).toEqual({
      ok: true,
    });
  });

  it('undefined baseAmountCents (failed upstream parse) -> rejected (invalid)', () => {
    expect(
      validatePaymentRequest({ baseAmountCents: undefined, currency: 'usd' }, requestPage),
    ).toEqual({ ok: false, reason: 'invalid' });
  });

  it('non-integer baseAmountCents -> rejected (invalid)', () => {
    expect(validatePaymentRequest({ baseAmountCents: 200.5, currency: 'usd' }, requestPage)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });
});
