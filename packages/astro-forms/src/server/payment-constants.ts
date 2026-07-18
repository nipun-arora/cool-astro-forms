/**
 * Server-only value constants for payments + webhooks (Phase 3).
 *
 * Moved out of the shared `types.ts`/`limits.ts` modules (which client
 * entries capture.ts/journey.ts import) because a real `export const`
 * emits bytes into every importer's bundle, unlike a type-only export. Left
 * in the shared modules these values inflated the client bundle's local
 * chunk closure past the codified gzip budget even though no client code
 * ever reads them. Every consumer here is already server-only, so this
 * module is safe to import directly without touching the client graph.
 */

/**
 * Reserved synthetic-entry `formId` (D-PAY-05) — the anchor row a standalone
 * `/forms-pay` payment-request link is recorded under (entry_id stays
 * NOT NULL without a breaking migration). A host must never name a real
 * form this, mirroring HONEYPOT_FIELD_NAME's reserved-name comment.
 * buildAnalyticsWhere (sqlite.ts) unconditionally excludes this constant so
 * synthetic payment-request entries can never inflate funnel/analytics
 * counts.
 */
export const PAYMENT_REQUEST_FORM_ID = '_payment_request';

/** Inbound provider webhook payload size cap (~1MB) — dwarfs MAX_PAYLOAD_BYTES because Stripe/PayPal event bodies are far larger than a form submission. */
export const MAX_WEBHOOK_PAYLOAD_BYTES = 1_048_576;

/** Signature timestamp tolerance window (seconds) for inbound webhook verification (replay-attack guard). */
export const WEBHOOK_SIGNATURE_TOLERANCE_SEC = 300;

/** Stripe's minimum allowed Checkout Session expiry window (minutes) — consumed by 03-03's createCheckoutSession, never a magic literal there. */
export const CHECKOUT_SESSION_TTL_MIN = 30;

/** Default minimum payment-request amount (cents) when payments.requestPage.minAmountCents is omitted. */
export const DEFAULT_MIN_AMOUNT_CENTS = 100;

/** Default maximum payment-request amount (cents) when payments.requestPage.maxAmountCents is omitted. */
export const DEFAULT_MAX_AMOUNT_CENTS = 1_000_000;
