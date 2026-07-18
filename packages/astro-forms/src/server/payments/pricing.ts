/**
 * Payment-request pricing + validation (PAY-05, D3/D4) — pure, dependency-
 * free money math. No zod, no fetch, no Date, no storage import: the caller
 * (the future PAY-05 route/handler, 03-05) passes plain `URLSearchParams`
 * plus the already-parsed `config.payments.*` subtrees.
 *
 * This is the single place a 100x amount-unit bug (T-03-06) or a client-
 * trusted total (T-03-05) could originate, so every entry point is
 * exhaustively TDD'd against LESSONS.md's money rules: strict regexes only
 * (never `Number()` coercion), deterministic `Math.round` fee rounding, and
 * reject-never-clamp validation.
 *
 * Clean-room: written fresh against 03-CONTEXT.md's D3/D4 decisions and
 * 03-RESEARCH.md's Query-Amount Security Model, not derived from any
 * WPForms/legacy source.
 */
import type { FeeLine, FeeBreakdown, FeeBreakdownLine } from '../../types.js';

/**
 * `?amount=` grammar (D4) — DOLLARS. Whole dollars or up to 2 decimal
 * places. No sign, no leading/trailing whitespace, no exponent notation, no
 * thousands separators, no hex. The raw param string is matched as-is.
 */
export const AMOUNT_DOLLARS_PATTERN = /^\d+(\.\d{1,2})?$/;

/**
 * `?pay=` grammar (D4) — CENTS, legacy alias (muscle-memory compat with the
 * old-style `?pay=` payment pages). Non-negative integers only — no
 * fractional cents, no sign.
 */
export const PAY_CENTS_PATTERN = /^\d+$/;

/**
 * Resolves the base amount in cents from `?amount=` (dollars) or `?pay=`
 * (cents, legacy alias). Distinct param names make unit confusion
 * structurally impossible (D4) — `amount` governs whenever it is present in
 * the query string (valid or not), so an invalid `amount` never silently
 * falls through to a `pay` value in different units. Any non-match against
 * the pinned strict regex above (signs, whitespace, exponents, hex,
 * thousands separators, >2 decimal places on `amount`, fractional cents on
 * `pay`) resolves `undefined` so the caller can surface a clean 400 — never
 * a `Number()`-coerced guess (LESSONS.md #32).
 */
export function parseAmountParam(searchParams: URLSearchParams): number | undefined {
  const amount = searchParams.get('amount');
  if (amount !== null) {
    return AMOUNT_DOLLARS_PATTERN.test(amount) ? Math.round(parseFloat(amount) * 100) : undefined;
  }

  const pay = searchParams.get('pay');
  if (pay !== null) {
    return PAY_CENTS_PATTERN.test(pay) ? parseInt(pay, 10) : undefined;
  }

  return undefined;
}

/** The subset of `config.payments` resolveFeeLines needs — structurally compatible with `CoolFormsConfig['payments']`. */
export interface FeeLineConfig {
  payLinkFees: FeeLine[];
  feePresets?: Record<string, FeeLine[]>;
}

/**
 * Resolves the `FeeLine[]` to apply for a payment request per the `?fee=`
 * override (D3):
 * - `?fee=0` disables fees entirely -> `[]`.
 * - `?fee=<key>` present in `config.feePresets` -> that preset array.
 * - `?fee=<unknown-key>` -> falls back to the default `payLinkFees` (never
 *   throws — an unrecognized preset key degrades to "no override", not an
 *   error).
 * - No `?fee` param -> `config.payLinkFees` as-is.
 */
export function resolveFeeLines(searchParams: URLSearchParams, config: FeeLineConfig): FeeLine[] {
  const fee = searchParams.get('fee');
  if (fee === null) return config.payLinkFees;
  if (fee === '0') return [];
  return config.feePresets?.[fee] ?? config.payLinkFees;
}

/**
 * Server-side fee breakdown (D3) — rendered like the legacy `/secure` page
 * (Subtotal / fee lines / Total due). `subtotalCents` is always the base
 * amount unchanged; each `FeeLine` resolves to a `FeeBreakdownLine` whose
 * `amountCents` is `flatCents` when set, else `Math.round(base * percent)`
 * (deterministic rounding — LESSONS.md money rules); `totalCents` is the
 * subtotal plus every line's amount, in the same order the fee lines were
 * given (config order). An empty `feeLines` array yields `totalCents ===
 * subtotalCents`.
 */
export function computeBreakdown(baseAmountCents: number, feeLines: FeeLine[]): FeeBreakdown {
  const lines: FeeBreakdownLine[] = feeLines.map((line) => ({
    label: line.label,
    amountCents: line.flatCents ?? Math.round(baseAmountCents * (line.percent ?? 0)),
  }));

  const totalCents = lines.reduce((sum, line) => sum + line.amountCents, baseAmountCents);

  return { subtotalCents: baseAmountCents, lines, totalCents };
}

/** The subset of `config.payments.requestPage` validatePaymentRequest needs. */
export interface PaymentRequestCaps {
  minAmountCents: number;
  maxAmountCents: number;
  allowedCurrencies: string[];
}

export interface PaymentRequestInput {
  /** `undefined` when upstream `parseAmountParam` failed to match the strict grammar. */
  baseAmountCents: number | undefined;
  currency: string;
}

export type PaymentValidationResult =
  | { ok: true }
  | { ok: false; reason: 'amount-range' | 'currency' | 'invalid' };

/**
 * Validates a payment request against the server-held caps (D4 / Query-
 * Amount Security Model). REJECTS — never clamps — an amount outside
 * `[minAmountCents, maxAmountCents]` or a currency outside the whitelist; a
 * silently-adjusted amount would be both a worse UX and a worse audit trail
 * than a clear 400. There is no `totalCents`/`feeCents` field in this
 * signature (or anywhere in this module's inputs) for a client to lie
 * about — the total is always computed server-side by `computeBreakdown`.
 *
 * `currency` is lowercased before the whitelist comparison so
 * `?currency=USD` and `?currency=usd` are treated identically.
 */
export function validatePaymentRequest(
  input: PaymentRequestInput,
  requestPage: PaymentRequestCaps,
): PaymentValidationResult {
  const { baseAmountCents, currency } = input;

  if (baseAmountCents === undefined || !Number.isInteger(baseAmountCents)) {
    return { ok: false, reason: 'invalid' };
  }

  if (baseAmountCents < requestPage.minAmountCents || baseAmountCents > requestPage.maxAmountCents) {
    return { ok: false, reason: 'amount-range' };
  }

  if (!requestPage.allowedCurrencies.includes(currency.toLowerCase())) {
    return { ok: false, reason: 'currency' };
  }

  return { ok: true };
}
