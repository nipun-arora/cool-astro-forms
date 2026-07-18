/**
 * Notification module (NTFY-01): nodemailer transport + the instant
 * abandoned-lead email (ABND-05).
 *
 * Reads SMTP config from the common EMAIL_* env var convention
 * (`EMAIL_HOST`/`EMAIL_PORT`/`EMAIL_USER`/`EMAIL_PASS`) so
 * adopting sites need zero new email config. Outside production, a missing
 * config falls back to nodemailer's `jsonTransport` (used by this module's
 * own tests — zero network). In production, a missing config never throws;
 * it logs one loud line and skips the send (review S7.1: the handler calls
 * this fire-and-forget and must never see an unhandled rejection just
 * because the site forgot to configure SMTP).
 */
import nodemailer, { type Transporter } from 'nodemailer';
import type { FeeBreakdown, PaymentProvider, ServerJourneyStep } from '../types.js';
import { log, logError } from './log.js';
import {
  defaultAbandonedLeadTemplate,
  renderPaymentQuoteTemplate,
  renderPaymentReceivedTemplate,
  renderRecoveryEmailTemplate,
} from './templates.js';

export interface AbandonedLeadEmailData {
  siteId: string;
  formId: string;
  notifyTo: string;
  fields: Record<string, unknown>;
  journey?: ServerJourneyStep[];
  pageUrl?: string;
  referrer?: string;
  /** Deep link into the future /forms-admin entry view (Phase 2 supplies it). */
  entryUrl?: string;
  /** Null this phase (Phase 2 adds IP geolocation). */
  geo?: unknown;
}

export interface NotifyTemplateResult {
  subject: string;
  text: string;
  html?: string;
}

export type NotifyTemplateFn = (data: AbandonedLeadEmailData) => NotifyTemplateResult;

export interface NotifyOptions<TTemplate = NotifyTemplateFn> {
  /** Override the default template — the config-supplied `templatesModule` seam wires through here. */
  template?: TTemplate;
  /** Override the transport entirely (tests only). */
  transport?: Transporter;
}

// ---------------------------------------------------------------------------
// Payment emails (PAY-02, W3) — sendPaymentQuoteEmail / sendPaymentReceivedEmail
// ---------------------------------------------------------------------------

export interface PaymentQuoteEmailData {
  siteId: string;
  formId: string;
  notifyTo: string;
  amountCents: number;
  currency: string;
  memo?: string;
  payLinkUrl: string;
  /** Omitted for the admin quote-flow (no fee lines applied to an owner-set amount) — the template renders a trivial subtotal-only breakdown when absent. */
  breakdown?: FeeBreakdown;
}

export type PaymentQuoteTemplateFn = (data: PaymentQuoteEmailData) => NotifyTemplateResult;

export interface PaymentReceivedEmailData {
  siteId: string;
  formId: string;
  notifyTo: string;
  amountCents: number;
  currency: string;
  provider: PaymentProvider;
  entryUrl?: string;
}

export type PaymentReceivedTemplateFn = (data: PaymentReceivedEmailData) => NotifyTemplateResult;

// ---------------------------------------------------------------------------
// Recovery email (RCV-01, D3/D4) — sendRecoveryEmail, the FIRST package
// email addressed to the VISITOR (data.to) rather than the owner (every
// email above targets notifyTo). Consumed by recovery/sweep.ts, which
// resolves the visitor's email + builds the resume/unsubscribe URLs.
// ---------------------------------------------------------------------------

export interface RecoveryEmailData {
  to: string;
  siteId: string;
  formId: string;
  /** Where the follow-up sends the visitor back to (entry.pageUrl ?? config.siteUrl). */
  resumeUrl: string;
  /** D4 one-click HMAC unsubscribe link — trailingSlash-computed, built by recovery/sweep.ts. */
  unsubscribeUrl: string;
}

export type RecoveryTemplateFn = (data: RecoveryEmailData) => NotifyTemplateResult;

/**
 * The full documented shape of a host's `templatesModule` default export
 * (checker W3) — extends the original abandonedLead-only override seam
 * (config.ts's `templatesModule` doc comment) to cover all four
 * transactional email kinds this package sends. Every key is optional; an
 * omitted key falls back to this module's own default template for that
 * email.
 */
export interface CafTemplates {
  abandonedLead?: NotifyTemplateFn;
  paymentQuote?: PaymentQuoteTemplateFn;
  paymentReceived?: PaymentReceivedTemplateFn;
  recovery?: RecoveryTemplateFn;
}

/** Per-process module state (review-flagged caveat): see getNotifyHealth() below. */
let lastSuccessAt: number | null = null;

interface TransportCacheEntry {
  transport: Transporter | null;
  signature: string;
}

let transportCache: TransportCacheEntry | null = null;

function envSignature(): string {
  const { NODE_ENV, EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASS } = process.env;
  return [NODE_ENV, EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASS].join('|');
}

/**
 * Builds (and memoizes) the SMTP transport from `process.env.EMAIL_*`.
 *
 * - EMAIL_* fully configured -> real SMTP transport with hard connection/
 *   socket timeouts (5s) so a hung SMTP endpoint can never pin a request
 *   worker (review S7.1 / threat T-01-42).
 * - EMAIL_* missing, NOT production -> `jsonTransport` fallback (this is
 *   what makes this module's own tests network-free).
 * - EMAIL_* missing, production (`NODE_ENV === 'production'`) -> no throw;
 *   logs exactly one `notify.smtp-unconfigured` line (memoized per env
 *   signature) and returns null so sends are skipped.
 */
export function buildTransport(): Transporter | null {
  const signature = envSignature();
  if (transportCache && transportCache.signature === signature) {
    return transportCache.transport;
  }

  const { EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASS } = process.env;
  const isProduction = process.env.NODE_ENV === 'production';
  const missingConfig = !EMAIL_HOST || !EMAIL_PORT || !EMAIL_USER || !EMAIL_PASS;

  let transport: Transporter | null;
  if (missingConfig) {
    if (isProduction) {
      logError(
        'notify.smtp-unconfigured',
        new Error('EMAIL_HOST/EMAIL_PORT/EMAIL_USER/EMAIL_PASS are not fully configured'),
        { hasHost: Boolean(EMAIL_HOST), hasPort: Boolean(EMAIL_PORT), hasUser: Boolean(EMAIL_USER) }
      );
      transport = null;
    } else {
      transport = nodemailer.createTransport({ jsonTransport: true });
    }
  } else {
    transport = nodemailer.createTransport({
      host: EMAIL_HOST,
      port: Number(EMAIL_PORT),
      auth: { user: EMAIL_USER, pass: EMAIL_PASS },
      connectionTimeout: 5_000,
      socketTimeout: 5_000,
    });
  }

  transportCache = { transport, signature };
  return transport;
}

/**
 * Sends the instant abandoned-lead email. Never throws merely because SMTP
 * is unconfigured (resolves `null` — a documented skip, not a failure).
 * Internal send failures (a configured transport that errors while sending)
 * reject cleanly with the underlying Error — the caller (Plan 06's handler)
 * invokes this fire-and-forget (`.catch(log)`) and must be able to log a
 * real rejection when one occurs.
 */
export async function sendAbandonedLeadEmail(
  data: AbandonedLeadEmailData,
  opts: NotifyOptions = {}
): Promise<unknown> {
  const template = opts.template ?? defaultAbandonedLeadTemplate;
  const rendered = template(data);
  const transport = opts.transport ?? buildTransport();
  if (!transport) {
    return null;
  }

  try {
    const info = await transport.sendMail({
      from: process.env.EMAIL_USER || 'noreply@cool-astro-forms.local',
      to: data.notifyTo,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });
    lastSuccessAt = Date.now();
    // Success visibility (T-01-Plan09-demo): prior to this, only send
    // FAILURES were ever logged — a qualifying abandon's notification had no
    // observable trace on success, so a local dev demo (jsonTransport, no
    // real SMTP) had no way to confirm content without reaching into
    // nodemailer's return value directly. Production logs only to/subject
    // (no field/journey PII); non-production also includes the rendered
    // text so `notify.sent` doubles as the jsonTransport content log.
    if (process.env.NODE_ENV === 'production') {
      log('notify.sent', { siteId: data.siteId, formId: data.formId, to: data.notifyTo, subject: rendered.subject });
    } else {
      log('notify.sent', {
        siteId: data.siteId,
        formId: data.formId,
        to: data.notifyTo,
        subject: rendered.subject,
        text: rendered.text,
      });
    }
    return info;
  } catch (err) {
    logError('notify.send-failed', err, { siteId: data.siteId, formId: data.formId });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Payment sends (PAY-02, W3)
// ---------------------------------------------------------------------------

/**
 * Shared send path for sendPaymentQuoteEmail/sendPaymentReceivedEmail/
 * sendRecoveryEmail — the SAME never-throws-on-unconfigured / rejects-on-
 * real-failure contract as sendAbandonedLeadEmail above (mirrored rather
 * than shared code, so that already-tested function stays untouched).
 *
 * `resolveTo` (rather than a hardcoded `data.notifyTo`) is what lets
 * sendRecoveryEmail reuse this same helper while addressing the VISITOR
 * (`data.to`) instead of the owner — every other caller passes
 * `(d) => d.notifyTo`, byte-identical to this helper's previous behavior.
 */
async function sendTemplatedEmail<TData extends { siteId: string; formId: string }>(
  data: TData,
  resolveTo: (data: TData) => string,
  defaultTemplate: (data: TData) => NotifyTemplateResult,
  opts: NotifyOptions<(data: TData) => NotifyTemplateResult>,
  logEvent: string,
): Promise<unknown> {
  const to = resolveTo(data);
  const template = opts.template ?? defaultTemplate;
  const rendered = template(data);
  const transport = opts.transport ?? buildTransport();
  if (!transport) {
    return null;
  }

  try {
    const info = await transport.sendMail({
      from: process.env.EMAIL_USER || 'noreply@cool-astro-forms.local',
      to,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });
    lastSuccessAt = Date.now();
    if (process.env.NODE_ENV === 'production') {
      log(logEvent, { siteId: data.siteId, formId: data.formId, to, subject: rendered.subject });
    } else {
      log(logEvent, {
        siteId: data.siteId,
        formId: data.formId,
        to,
        subject: rendered.subject,
        text: rendered.text,
      });
    }
    return info;
  } catch (err) {
    logError(`${logEvent}-failed`, err, { siteId: data.siteId, formId: data.formId });
    throw err;
  }
}

/**
 * Auto-sends the branded pay-link quote (PAY-02) once the owner creates a
 * payment link from an entry. Never throws merely because SMTP is
 * unconfigured — mirrors sendAbandonedLeadEmail's contract exactly. A
 * configured-transport send failure rejects with the underlying error (the
 * payment-action route invokes this fire-and-forget, `.catch(logError)`).
 */
export async function sendPaymentQuoteEmail(
  data: PaymentQuoteEmailData,
  opts: NotifyOptions<PaymentQuoteTemplateFn> = {},
): Promise<unknown> {
  return sendTemplatedEmail(data, (d) => d.notifyTo, renderPaymentQuoteTemplate, opts, 'notify.payment-quote-sent');
}

/**
 * Sends the "payment received" confirmation once an inbound webhook
 * confirms a payment (consumed by 03-07). Same never-throws-on-unconfigured
 * contract as the other two sends.
 */
export async function sendPaymentReceivedEmail(
  data: PaymentReceivedEmailData,
  opts: NotifyOptions<PaymentReceivedTemplateFn> = {},
): Promise<unknown> {
  return sendTemplatedEmail(
    data,
    (d) => d.notifyTo,
    renderPaymentReceivedTemplate,
    opts,
    'notify.payment-received-sent',
  );
}

/**
 * Sends the D3 recovery follow-up to the VISITOR (`data.to`) — the FIRST
 * package email that does not target notifyTo. Same never-throws-on-
 * unconfigured / rejects-on-real-failure contract as every other send here.
 * The caller (recovery/sweep.ts) invokes this AFTER atomically claiming the
 * row via `markRecoverySent` (T-04-15) and `.catch(logError)`s the result —
 * a send failure must never crash the sweep or re-attempt the same row.
 */
export async function sendRecoveryEmail(
  data: RecoveryEmailData,
  opts: NotifyOptions<RecoveryTemplateFn> = {},
): Promise<unknown> {
  return sendTemplatedEmail(data, (d) => d.to, renderRecoveryEmailTemplate, opts, 'notify.recovery-sent');
}

/**
 * Notify health for the Plan 08 canary endpoint.
 *
 * CAVEAT: `lastSuccessAt` is PER-PROCESS module state. Under multi-process
 * Passenger, each worker reports only its own value — this is not a
 * cross-process/shared health signal. Documented again in canary docs.
 */
export function getNotifyHealth(): { lastSuccessAt: number | null } {
  return { lastSuccessAt };
}

/** Test hook (also used by the Plan 09 DEV debug reset). */
export function resetNotifyHealth(): void {
  lastSuccessAt = null;
}
