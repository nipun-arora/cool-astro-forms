/**
 * Free-text payment labels (0.1.18). The pay page's `label` field, and a
 * host's `productName` for createCheckoutForEntry, become the Stripe
 * Checkout line item name and the PaymentIntent description, which the payer
 * and the Stripe dashboard read. Either can be text a visitor typed, so it is
 * cleaned before it reaches Stripe or an entry: unpaired surrogate halves and
 * control characters removed (tab, CR and LF count as whitespace), whitespace
 * runs collapsed to one space, trimmed, and cut to `MAX_PAYMENT_LABEL_LENGTH`
 * characters.
 *
 * No dependencies on purpose: payment-request.ts and checkout-for-entry.ts
 * both import it, and neither may load the Stripe SDK just to clean a label.
 */

/** Longest label sent to Stripe or stored as an entry memo, in characters (code points). */
export const MAX_PAYMENT_LABEL_LENGTH = 100;

/**
 * The cleaned label, or `undefined` when nothing is left (or the value is not
 * a string), so the caller applies its own default name. The cap counts code
 * points, so it never leaves half of a surrogate pair. Unpaired halves (a
 * split emoji) are dropped first: the Stripe SDK form-encodes the name with
 * encodeURIComponent, which throws a URIError on them. Under the `u` flag
 * `\p{Cs}` matches only a lone half, so a valid pair is kept.
 */
export function cleanPaymentLabel(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const collapsed = raw
    .replace(/\p{Cs}/gu, '')
    .replace(/\p{Cc}/gu, (char) => (/\s/.test(char) ? ' ' : ''))
    .replace(/\s+/gu, ' ')
    .trim();
  const capped = Array.from(collapsed).slice(0, MAX_PAYMENT_LABEL_LENGTH).join('').trim();
  return capped || undefined;
}
