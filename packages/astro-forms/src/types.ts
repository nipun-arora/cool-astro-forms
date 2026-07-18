/**
 * Shared wire/domain types and reserved runtime constants.
 *
 * Dependency-free by design: client scripts import from this module without
 * pulling in zod or any other package. Server code imports the same types
 * so the client/server contract never drifts.
 */

// ---------------------------------------------------------------------------
// Reserved field/global names (pinned — consumed by client capture, journey,
// the abandon handler, and the integration's injected scripts)
// ---------------------------------------------------------------------------

/** Reserved honeypot input name. Stays a separate plain input; the bait must look real. */
export const HONEYPOT_FIELD_NAME = '_caf_hp';

/**
 * Machine-data envelope key riding inside submission fields. JSON-encoded.
 * Current shape: `{ journey: JourneyStep[] }`. Reserved for future payload
 * additions (e.g. a Turnstile token) without adding new top-level fields.
 * Phase 2 (D3) reserves `_caf.turnstileToken` inside this same envelope for
 * the Turnstile verification token — no new top-level field is added.
 */
export const CAF_FIELD_NAME = '_caf';

/** Name of the `window.caf` client API carrying the submit-success signal. */
export const CLIENT_API_GLOBAL = 'caf';

/**
 * PAYMENT_REQUEST_FORM_ID (D-PAY-05) — the reserved synthetic-entry `formId`
 * a standalone `/forms-pay` payment-request link is recorded under — moved
 * to `./server/payment-constants.js`. This module is imported by client
 * entries (capture.ts/journey.ts), and a real `export const` emits bytes
 * into every importer's bundle even though this value is server-only. See
 * payment-constants.ts's own docstring.
 */

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type EntryStatus = 'abandoned' | 'submitted' | 'converted' | 'spam';

export type GateMode = 'email-or-phone' | 'always';

/**
 * A single client-recorded journey step. Query-stripped `url` (JRNY-01).
 * Deliberately has NO `duration` field — the server recomputes durations
 * from `ts` deltas; client-supplied durations are never trusted (JRNY-02).
 */
export interface JourneyStep {
  url: string;
  title: string;
  ts: number;
  params?: Record<string, string>;
}

/** Server-recomputed shape. Stored and notified journeys are always this type. */
export type ServerJourneyStep = JourneyStep & { durationMs: number };

/** IP-geolocation lookup result (D2). All fields optional — a lookup failure or partial provider response never blocks save. */
export interface Geo {
  city?: string;
  region?: string;
  country?: string;
  lat?: number;
  lon?: number;
  postal?: string;
  isp?: string;
}

export interface Entry {
  id: string;
  siteId: string;
  formId: string;
  status: EntryStatus;
  fields: Record<string, unknown>;
  visitorUuid: string;
  ip?: string;
  userAgent?: string;
  geo?: Geo;
  journey?: ServerJourneyStep[];
  pageUrl?: string;
  referrer?: string;
  /** Name of the last field the visitor edited before abandoning (ANLY-01 D1 top-drop-off metric). */
  lastField?: string;
  /** Lead-recovery consent basis timestamp (RCV-01/D3) — when a qualifying email was captured (auto mode) or the checkbox was ticked. Undefined = no consent recorded yet. */
  consentAt?: number;
  /** Lead-recovery double-send gate (RCV-01/D3) — set atomically by markRecoverySent; undefined = never sent. */
  recoverySentAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface AbandonPayload {
  siteId: string;
  formId: string;
  visitorUuid: string;
  fields: Record<string, unknown>;
  journey?: JourneyStep[];
  pageUrl?: string;
  referrer?: string;
  honeypot?: string;
  /** Name of the last field the visitor edited (ANLY-01 D1). */
  lastField?: string;
  /**
   * Lead-recovery opt-in checkbox state (RCV-01/D3) — rides the existing
   * abandon POST so the checkbox consent mode needs no schema change later.
   * Only honored when the host's `recovery.consentMode` is `'checkbox'`;
   * ignored under the default `'auto'` mode (consent there is basis on a
   * captured valid email, not this field).
   */
  recoveryOptIn?: boolean;
}

/** Pagination fields lock the ADPT-01 adapter surface before Phase 2 admin needs them. */
export interface EntryFilter {
  siteId?: string;
  formId?: string;
  status?: EntryStatus;
  visitorUuid?: string;
  from?: number;
  to?: number;
  search?: string;
  limit?: number;
  offset?: number;
  /**
   * Excludes rows whose formId matches this value (checker B2). The entries
   * admin view passes PAYMENT_REQUEST_FORM_ID here by default so synthetic
   * payment-request rows don't clutter the entries list.
   */
  excludeFormId?: string;
}

// ---------------------------------------------------------------------------
// Analytics (ANLY-01) — funnel + top-drop-off query shapes (Phase 2).
// ---------------------------------------------------------------------------

/** started = form_starts count; abandoned/submitted/converted = entries.status counts. Same site/date scope throughout. */
export interface FunnelCounts {
  started: number;
  abandoned: number;
  submitted: number;
  converted: number;
}

/** One row of the top-drop-off breakdown: last_field name + how many abandoned rows ended there. */
export interface DropOffRow {
  field: string;
  count: number;
}

/** Shared scope for getFunnel/getTopDropOff — site + optional created_at range. */
export interface AnalyticsFilter {
  siteId?: string;
  formId?: string;
  from?: number;
  to?: number;
}

// ---------------------------------------------------------------------------
// Payments + webhooks (Phase 3) — shared wire/domain types. The payments
// table itself has existed since migration v1 (spec §4); this plan extends
// it (provider_ref) and gives it a real read/write surface.
// ---------------------------------------------------------------------------

/**
 * Exactly the deployed `payments.status` CHECK vocabulary (migration v1) —
 * do NOT add values here without a corresponding (impossible, per the
 * additive-only migration policy) CHECK-constraint change. See
 * docs/LESSONS.md Pitfall 4.
 */
export type PaymentStatus = 'link_created' | 'link_sent' | 'paid' | 'failed' | 'refunded';

export type PaymentProvider = 'stripe' | 'paypal';

/** One entry in a payment's `events` JSON column. `type` is provider-event-shaped (e.g. 'checkout.session.completed'). */
export interface PaymentEvent {
  id: string;
  type: string;
  at: number;
  [k: string]: unknown;
}

export interface Payment {
  id: string;
  entryId: string;
  provider?: PaymentProvider;
  amountCents?: number;
  currency?: string;
  status?: PaymentStatus;
  payLinkUrl?: string;
  /** Inbound-webhook find key (Stripe Checkout Session id / PayPal order id). Added by migration v3. */
  providerRef?: string;
  providerIds?: Record<string, unknown>;
  events?: PaymentEvent[];
  createdAt: number;
  updatedAt: number;
}

/** Filter shape for listPayments/countPayments — mirrors EntryFilter's pagination discipline (ADPT-01). */
export interface PaymentFilter {
  provider?: PaymentProvider;
  status?: PaymentStatus;
  entryId?: string;
  from?: number;
  to?: number;
  limit?: number;
  offset?: number;
}

/** A single configured (or per-link-overridden) fee — exactly one of percent/flatCents, enforced by config.ts's zod refine. */
export interface FeeLine {
  label: string;
  percent?: number;
  flatCents?: number;
}

/** One resolved line in a computed FeeBreakdown — the label plus its computed amount for THIS amount. */
export interface FeeBreakdownLine {
  label: string;
  amountCents: number;
}

/** Server-computed fee breakdown (D3) — rendered like the legacy /secure page (Subtotal / fee lines / Total due). */
export interface FeeBreakdown {
  subtotalCents: number;
  lines: FeeBreakdownLine[];
  totalCents: number;
}

/** Outbound webhook event types (HOOK-01) a WebhookTarget may subscribe to. */
export type WebhookEventType = 'entry.submitted' | 'entry.abandoned' | 'payment.paid';

/** One configured outbound webhook target (owner-authored, config.ts webhooks[]). Secret never crosses the client boundary. */
export interface WebhookTarget {
  url: string;
  secret: string;
  events?: WebhookEventType[];
}

// ---------------------------------------------------------------------------
// Drive files + lead recovery (Phase 4) — shared wire/domain types. The
// `files` table itself has existed since migration v1 (spec §4); this phase
// gives it a real upload path + a read surface (getFilesByEntry).
// ---------------------------------------------------------------------------

/**
 * Real-bytes file input for the submission path (DRV-01) — replaces the
 * previous metadata-only `Record<string, unknown>[]` shape `attachFiles`
 * accepted. The abandon path never carries files; this contract is
 * submission-only (recordSubmission -> uploadFilesToDrive).
 */
export interface FileInput {
  filename: string;
  buffer: Buffer;
  mimeType?: string;
}

/**
 * Per-file outcome `recordSubmission()` returns to the HOST after
 * attempting a Drive upload (D1 — the host's OWN email code branches on
 * this shape; the package sends no submission-path email itself).
 * `driveLink` set => link it in the email; `fallbackBuffer` set => attach
 * it directly (Drive upload failed but the file fit under
 * `attachmentFallbackMaxBytes`); `fallbackTooLarge` true => Drive failed
 * AND the file exceeded the fallback ceiling, so it can neither be linked
 * nor attached — the submission entry itself is still saved regardless
 * (DRV-02: a submission is never lost, only a link/attachment may be
 * unavailable).
 */
export interface FileUploadOutcome {
  filename: string;
  driveLink?: string;
  fallbackBuffer?: Buffer;
  fallbackTooLarge?: boolean;
}

/** getFilesByEntry's read shape (admin Files section) — camelCase mirror of the `files` table (migration v1). */
export interface FileRecord {
  id: string;
  entryId: string;
  filename?: string;
  sizeBytes?: number;
  mime?: string;
  storage?: 'drive' | 'email-only';
  driveFileId?: string;
  driveLink?: string;
  createdAt?: number;
}

/** Drive link permission mode (D2) — 'private' is the safe OSS-consumer default; 'anyone' trades safety for login-free email links. */
export type DriveLinkAccess = 'anyone' | 'private';

/** Recovery consent basis (D3) — 'auto' records consent on a captured valid email with no checkbox (owner default); 'checkbox' is reserved for a future explicit opt-in mode. */
export type RecoveryConsentMode = 'auto' | 'checkbox';

// ---------------------------------------------------------------------------
// Client API (window.caf) — carried by CLIENT_API_GLOBAL
// ---------------------------------------------------------------------------

export interface CafClientApi {
  /** Multi-form pages clear only the named form; no-arg clears all staged capture data. */
  submitted(formId?: string): void;
  /** Signals host-granted consent so capture can leave the dormant state (requireConsent). */
  consentGranted(): void;
}

declare global {
  interface Window {
    caf?: CafClientApi;
  }
}
