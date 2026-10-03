/**
 * Notification module (NTFY-01): nodemailer transport + the instant
 * abandoned-lead email (ABND-05).
 *
 * Reads SMTP config from the common EMAIL_* env var convention
 * (`EMAIL_HOST`/`EMAIL_PORT`/`EMAIL_USER`/`EMAIL_PASS`) so
 * adopting sites need zero new email config. `EMAIL_AUTH=ip` (0.1.15) selects
 * relay mode for an IP-allowlisted relay (Google Workspace SMTP relay and
 * similar): only `EMAIL_HOST`/`EMAIL_PORT` are needed and the transport never
 * authenticates. The From address is `EMAIL_FROM`, else `EMAIL_USER` when it
 * is an address, else `NOTIFY_EMAIL`, else a noreply fallback, with an
 * optional display name from `EMAIL_FROM_NAME`. Outside production, a missing
 * config falls back to nodemailer's `jsonTransport` (used by this module's
 * own tests — zero network). In production, a missing config never throws;
 * it logs one loud line and skips the send (review S7.1: the handler calls
 * this fire-and-forget and must never see an unhandled rejection just
 * because the site forgot to configure SMTP).
 */
import nodemailer, { type Transporter } from 'nodemailer';
import { z } from 'zod';
import type { FeeBreakdown, PaymentProvider, ServerJourneyStep } from '../types.js';
import { log, logError, warn } from './log.js';
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
  /** Where the follow-up sends the visitor back to: entry.pageUrl when it is an http(s) URL on the siteUrl origin, else config.siteUrl (recovery/sweep.ts safeResumeUrl). */
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
  const { NODE_ENV, EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASS, EMAIL_AUTH } = process.env;
  return [NODE_ENV, EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASS, EMAIL_AUTH].join('|');
}

/**
 * `EMAIL_AUTH=ip` (any case, surrounding spaces ignored) selects relay mode:
 * the relay trusts the server's IP, so the transport sends no AUTH command
 * even when stale EMAIL_USER/EMAIL_PASS values are still set. Any other
 * value, or none, keeps credential mode exactly as before 0.1.15.
 */
function isRelayMode(): boolean {
  return (process.env.EMAIL_AUTH ?? '').trim().toLowerCase() === 'ip';
}

/** Hard connection/socket timeouts shared by both SMTP modes (review S7.1 / T-01-42). */
const SMTP_TIMEOUTS = { connectionTimeout: 5_000, socketTimeout: 5_000 } as const;

/**
 * Relay-mode TLS: 465 is implicit TLS (`secure`); 587 must upgrade with
 * STARTTLS before any mail is sent (`requireTLS`), which is what a Google
 * Workspace relay set to "require TLS" expects. Other ports keep nodemailer's
 * default of upgrading when the server offers STARTTLS.
 */
function relayTlsOptions(port: number): { secure?: true; requireTLS?: true } {
  if (port === 465) return { secure: true };
  if (port === 587) return { requireTLS: true };
  return {};
}

const FALLBACK_FROM = 'noreply@cool-astro-forms.local';

function isEmailAddress(value: string | undefined): value is string {
  return value !== undefined && z.email().safeParse(value).success;
}

/** Warn-once memo for the two From diagnostics below (per process, per value). */
const fromWarnings = new Set<string>();

function warnOnce(key: string, event: string, data: Record<string, unknown>): void {
  if (fromWarnings.has(key)) return;
  fromWarnings.add(key);
  warn(event, data);
}

/**
 * The sender address, first usable of: `EMAIL_FROM`, `EMAIL_USER` (only when
 * it is an email address; providers such as SendGrid use a literal username
 * like "apikey"), `NOTIFY_EMAIL`, then the noreply fallback. An `EMAIL_FROM`
 * that is set but is not a bare address (for example the "Name <addr>" form;
 * the display name has its own variable) is skipped with one
 * `notify.from-invalid` warning rather than handed to the relay.
 */
function resolveFromAddress(): string {
  const emailFrom = process.env.EMAIL_FROM?.trim();
  if (emailFrom) {
    if (isEmailAddress(emailFrom)) return emailFrom;
    warnOnce(`invalid:${emailFrom}`, 'notify.from-invalid', {
      variable: 'EMAIL_FROM',
      effect: 'EMAIL_FROM is not a bare email address; set the display name in EMAIL_FROM_NAME. Falling back to EMAIL_USER/NOTIFY_EMAIL.',
    });
  }
  const user = process.env.EMAIL_USER?.trim();
  if (isEmailAddress(user)) return user;
  const notify = process.env.NOTIFY_EMAIL?.trim();
  if (isEmailAddress(notify)) return notify;
  return FALLBACK_FROM;
}

/** `EMAIL_FROM_NAME` with CR/LF collapsed to spaces (a header value must stay on one line), or undefined when unset/blank. */
function resolveFromName(): string | undefined {
  const raw = process.env.EMAIL_FROM_NAME;
  if (!raw) return undefined;
  const name = raw.replace(/[\r\n]+/g, ' ').trim();
  return name || undefined;
}

function normalizeDomain(domain: string): string {
  const lower = domain.trim().toLowerCase().replace(/\.$/, '');
  return lower.startsWith('www.') ? lower.slice(4) : lower;
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost') || /^[\d.]+$/.test(hostname) || hostname.includes(':');
}

/**
 * One loud `notify.from-domain-mismatch` warning per process when the From
 * domain is not the site's own domain (`CAF_SITE_URL`, bridged from
 * `config.siteUrl` by the middleware). Relays that only send for the
 * account's domains reject such mail, and receivers fail SPF/DMARC
 * alignment on it. A subdomain of the site domain (or the reverse) counts as
 * aligned, a leading `www.` is ignored, and a localhost or unknown site URL
 * is never checked.
 */
function checkFromDomain(address: string): void {
  const siteUrl = process.env.CAF_SITE_URL;
  if (!siteUrl) return;
  let siteHost: string;
  try {
    siteHost = new URL(siteUrl).hostname;
  } catch {
    return;
  }
  if (!siteHost || isLocalHost(siteHost)) return;
  const at = address.lastIndexOf('@');
  if (at === -1) return;
  const fromDomain = normalizeDomain(address.slice(at + 1));
  const siteDomain = normalizeDomain(siteHost);
  const aligned =
    fromDomain === siteDomain || fromDomain.endsWith(`.${siteDomain}`) || siteDomain.endsWith(`.${fromDomain}`);
  if (aligned) return;
  warnOnce(`domain:${fromDomain}|${siteDomain}`, 'notify.from-domain-mismatch', {
    from: address,
    fromDomain,
    siteDomain,
    effect:
      'The From domain is not the site domain. A relay that only sends for its own domains will refuse this mail, and receivers can fail SPF/DMARC on it. Set EMAIL_FROM to an address on the site domain.',
  });
}

/**
 * The `from` value handed to nodemailer: the bare address string when no
 * display name is set (0.1.14's exact shape), else `{ name, address }`, which
 * nodemailer quotes and encodes itself. Also runs the domain check.
 */
function resolveFrom(): string | { name: string; address: string } {
  const address = resolveFromAddress();
  checkFromDomain(address);
  const name = resolveFromName();
  return name ? { name, address } : address;
}

/**
 * Builds (and memoizes) the SMTP transport from `process.env.EMAIL_*`.
 *
 * - Credential mode (default), EMAIL_HOST/PORT/USER/PASS all set -> real
 *   SMTP transport with `auth` and hard connection/socket timeouts (5s) so a
 *   hung SMTP endpoint can never pin a request worker (review S7.1 / threat
 *   T-01-42). Byte-identical to 0.1.14.
 * - Relay mode (`EMAIL_AUTH=ip`), EMAIL_HOST/PORT set -> real SMTP transport
 *   with NO `auth` key, the same timeouts, and port-based TLS
 *   (`relayTlsOptions`).
 * - The active mode's config missing, NOT production -> `jsonTransport`
 *   fallback (this is what makes this module's own tests network-free).
 * - The active mode's config missing, production (`NODE_ENV ===
 *   'production'`) -> no throw; logs exactly one `notify.smtp-unconfigured`
 *   line naming the mode and the variables THAT mode needs (memoized per env
 *   signature) and returns null so sends are skipped.
 */
export function buildTransport(): Transporter | null {
  const signature = envSignature();
  if (transportCache && transportCache.signature === signature) {
    return transportCache.transport;
  }

  const { EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASS } = process.env;
  const isProduction = process.env.NODE_ENV === 'production';
  const relay = isRelayMode();
  // Each mode is judged only on what IT needs: relay mode never asks for
  // EMAIL_USER/EMAIL_PASS, so their absence is not "unconfigured" there.
  const missingConfig = relay
    ? !EMAIL_HOST || !EMAIL_PORT
    : !EMAIL_HOST || !EMAIL_PORT || !EMAIL_USER || !EMAIL_PASS;

  let transport: Transporter | null;
  if (missingConfig) {
    if (isProduction) {
      if (relay) {
        logError(
          'notify.smtp-unconfigured',
          new Error('EMAIL_AUTH=ip (relay mode) needs EMAIL_HOST and EMAIL_PORT'),
          { mode: 'relay', hasHost: Boolean(EMAIL_HOST), hasPort: Boolean(EMAIL_PORT) },
        );
      } else {
        logError(
          'notify.smtp-unconfigured',
          new Error('EMAIL_HOST/EMAIL_PORT/EMAIL_USER/EMAIL_PASS are not fully configured'),
          { mode: 'credential', hasHost: Boolean(EMAIL_HOST), hasPort: Boolean(EMAIL_PORT), hasUser: Boolean(EMAIL_USER) },
        );
      }
      transport = null;
    } else {
      transport = nodemailer.createTransport({ jsonTransport: true });
    }
  } else if (relay) {
    const port = Number(EMAIL_PORT);
    transport = nodemailer.createTransport({
      host: EMAIL_HOST,
      port,
      ...relayTlsOptions(port),
      ...SMTP_TIMEOUTS,
    });
  } else {
    transport = nodemailer.createTransport({
      host: EMAIL_HOST,
      port: Number(EMAIL_PORT),
      auth: { user: EMAIL_USER, pass: EMAIL_PASS },
      ...SMTP_TIMEOUTS,
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
      from: resolveFrom(),
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
      from: resolveFrom(),
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
