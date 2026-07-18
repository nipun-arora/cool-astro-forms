/**
 * Shared client+server caps — single source of truth.
 *
 * Dependency-free by design: imported by client AND server so mirrored
 * literal constants (a classic drift bug) are structurally impossible.
 */

/** Maximum number of steps retained in a journey trail. */
export const JOURNEY_MAX_STEPS = 100;

/** Maximum serialized byte size of a journey trail. */
export const JOURNEY_MAX_BYTES = 10_240;

/** Maximum age (ms) of a journey trail before it is considered stale (1 year). */
export const JOURNEY_MAX_AGE_MS = 31_536_000_000;

/** Per-field serialized byte cap. */
export const FIELD_MAX_BYTES = 4_096;

/** Client send margin AND server payload size cap. */
export const MAX_PAYLOAD_BYTES = 50_000;

/** Conversion lookback window (30 days) used by convertAndCreateSubmitted. */
export const CONVERT_LOOKBACK_MS = 2_592_000_000;

/** Per-step server truncation ceiling for `url`. */
export const STEP_URL_MAX = 2_048;

/** Per-step server truncation ceiling for `title`. */
export const STEP_TITLE_MAX = 256;

/** Per-step server duration clamp ceiling (24 hours). */
export const STEP_DURATION_MAX_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Payments + webhooks (Phase 3)
// ---------------------------------------------------------------------------

/**
 * MAX_WEBHOOK_PAYLOAD_BYTES, WEBHOOK_SIGNATURE_TOLERANCE_SEC,
 * CHECKOUT_SESSION_TTL_MIN, DEFAULT_MIN_AMOUNT_CENTS, and
 * DEFAULT_MAX_AMOUNT_CENTS moved to `./server/payment-constants.js` — this
 * module is imported by client entries (capture.ts/journey.ts), and a real
 * `export const` emits bytes into every importer's bundle even though these
 * values are server-only. See payment-constants.ts's own docstring.
 */

/** Default currency whitelist when payments.requestPage.allowedCurrencies is omitted. */
export const DEFAULT_ALLOWED_CURRENCIES: readonly string[] = ['usd'];
