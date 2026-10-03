/**
 * Public `cool-astro-forms/server` entry — the surface a host site imports
 * from its OWN submit endpoint (PKG-03): `import { recordSubmission } from
 * 'cool-astro-forms/server'`. This is the concrete target of the
 * package.json `"./server"` export map entry (Plan 01).
 *
 * Export-only — importing this module has NO side effects (no top-level
 * DB open, no top-level network call). `recordSubmission`'s production
 * default (`getStorageAdapter()`, 05-04 — env-selected via
 * `CAF_STORAGE_KIND`/`CAF_DB_PATH`, defaulting to `new
 * SqliteStorage(getDb())` for the 'sqlite' backend) only runs when the
 * function is actually called.
 */
export { recordSubmission } from './record-submission.js';
export type { RecordSubmissionArgs, RecordSubmissionDeps, RecordSubmissionResult } from './record-submission.js';

export type { StorageAdapter } from './storage/adapter.js';
export { SqliteStorage } from './storage/sqlite.js';
export { getDb } from './storage/db.js';

export type { Entry, EntryStatus, JourneyStep, WebhookEventType, WebhookTarget } from '../types.js';

/**
 * File-upload contract (DRV-01, D1) — a host types its own recordSubmission
 * call with `FileInput`, then branches its own email code on the returned
 * `FileUploadOutcome[]` (link vs attach). `FileRecord` is the
 * getFilesByEntry read shape (admin Files section).
 */
export type { FileInput, FileRecord, FileUploadOutcome } from '../types.js';

/**
 * Payments for host pages (0.1.15): a card-only Stripe Checkout Session for
 * an existing entry, recorded so the package's webhook can match it, and the
 * admin-session check for a host's own admin pages and routes.
 */
export { createCheckoutForEntry } from './payments/checkout-for-entry.js';
export type {
  CreateCheckoutForEntryDeps,
  CreateCheckoutForEntryErrorCode,
  CreateCheckoutForEntryInput,
  CreateCheckoutForEntryResult,
} from './payments/checkout-for-entry.js';
export { isAdminRequest } from './security/is-admin-request.js';
export type { AdminRequestContext, IsAdminRequestOptions } from './security/is-admin-request.js';

/**
 * Email template building blocks (0.1.15) for a host's `templatesModule`:
 * the same HTML escaper and currency-aware money formatter the default
 * templates use, plus the data and result types of every template key.
 */
export { escapeHtml, formatMoney } from './templates.js';
export type {
  AbandonedLeadEmailData,
  CafTemplates,
  NotifyTemplateResult,
  PaymentQuoteEmailData,
  PaymentReceivedEmailData,
  RecoveryEmailData,
} from './notify.js';

export { verifyTurnstile } from './turnstile.js';
export type { VerifyTurnstileOptions, VerifyTurnstileOutcome, VerifyTurnstileResult } from './turnstile.js';

/**
 * Receiver-side helper (HOOK-01): a host's own n8n/Astro receiver imports
 * this to authenticate our outbound `X-Caf-Signature` POSTs — the same
 * `t=,v1=` HMAC scheme `deliverWebhook` signs with internally.
 */
export { verifyWebhookSignature } from './webhooks/sign.js';
export type { WebhookEvent } from './webhooks/deliver.js';
