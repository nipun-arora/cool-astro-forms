/**
 * Currency minor units. Every stored amount in this package (`amountCents`
 * on a payment row, Stripe's `unit_amount`/`amount_total`) is an integer in
 * the currency's smallest unit, and that unit is not always 1/100: Stripe
 * treats some currencies as zero-decimal (500 JPY is `500`) and some as
 * three-decimal (1.500 KWD is `1500`). Anything that converts between a
 * displayed amount and a stored one reads the exponent from here.
 *
 * Source: docs.stripe.com/currencies (zero-decimal list, three-decimal
 * currencies, and the special cases), checked 2026-10-03. ISK and UGX are
 * zero-decimal in ISO 4217 but Stripe still represents them as two-decimal
 * values ("the decimal amount is always 00"), so they are deliberately NOT
 * in the zero-decimal set below.
 */

/** Stripe's zero-decimal currencies (the amount IS the major unit). UGX is left out on purpose, see the module docstring. */
export const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  'bif',
  'clp',
  'djf',
  'gnf',
  'jpy',
  'kmf',
  'krw',
  'mga',
  'pyg',
  'rwf',
  'vnd',
  'vuv',
  'xaf',
  'xof',
  'xpf',
]);

/** Stripe's three-decimal currencies (the amount is in thousandths). */
export const THREE_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set(['bhd', 'jod', 'kwd', 'omr', 'tnd']);

/** Number of decimal places between the major unit and the stored integer amount: 0, 2 or 3. Any letter case. */
export function minorUnitExponent(currency: string): 0 | 2 | 3 {
  const code = currency.trim().toLowerCase();
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(code)) return 3;
  return 2;
}

/** True when 1 major unit is 100 stored units, the only shape the built-in admin quote form parses. */
export function isTwoDecimalCurrency(currency: string): boolean {
  return minorUnitExponent(currency) === 2;
}
