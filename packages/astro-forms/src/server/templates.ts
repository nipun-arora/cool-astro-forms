/**
 * Overridable email templates. Pure functions — no I/O, no env reads, so
 * they stay trivially unit-testable and safely reusable from a site's own
 * `templatesModule` override (see notify.ts's NotifyOptions.template seam).
 */
import type { FeeBreakdown, ServerJourneyStep } from '../types.js';
import type {
  AbandonedLeadEmailData,
  NotifyTemplateResult,
  PaymentQuoteEmailData,
  PaymentReceivedEmailData,
  RecoveryEmailData,
} from './notify.js';

/**
 * Escapes &, <, >, ", ' for safe interpolation into HTML. Exported for reuse
 * by Phase 2 admin views (review T-01-36) — every interpolated value in the
 * html output of this module passes through this helper.
 */
export function escapeHtml(value: unknown): string {
  const str = value === null || value === undefined ? '' : String(value);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stringifyFieldValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function renderFieldsText(fields: Record<string, unknown>): string {
  const entries = Object.entries(fields);
  if (entries.length === 0) return '(no fields captured)';
  return entries.map(([key, value]) => `- ${key}: ${stringifyFieldValue(value)}`).join('\n');
}

/** Exported for reuse by Phase 2 admin views (P05, W1) — no behavior change. */
export function renderFieldsHtml(fields: Record<string, unknown>): string {
  const entries = Object.entries(fields);
  if (entries.length === 0) return '<p>(no fields captured)</p>';
  const rows = entries
    .map(
      ([key, value]) =>
        `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(stringifyFieldValue(value))}</td></tr>`
    )
    .join('');
  return `<table>${rows}</table>`;
}

/** One line per step: title, path, and the server-recomputed per-step duration. */
function renderJourneyTimelineText(journey: ServerJourneyStep[] | undefined): string {
  const steps = journey ?? [];
  if (steps.length === 0) return '(no journey recorded)';
  const lines = steps.map((step, index) => {
    const time = new Date(step.ts).toISOString();
    const title = step.title || '(untitled)';
    return `${index + 1}. [${time}] ${title} — ${step.url} (${formatDuration(step.durationMs)})`;
  });
  const totalMs = steps.reduce((sum, step) => sum + step.durationMs, 0);
  lines.push(`Total steps: ${steps.length}, total elapsed: ${formatDuration(totalMs)}`);
  return lines.join('\n');
}

/** Exported for reuse by Phase 2 admin views (P05, W1) — no behavior change. */
export function renderJourneyTimelineHtml(journey: ServerJourneyStep[] | undefined): string {
  const steps = journey ?? [];
  if (steps.length === 0) return '<p>(no journey recorded)</p>';
  const items = steps
    .map((step, index) => {
      const time = new Date(step.ts).toISOString();
      const title = step.title || '(untitled)';
      return `<li>${escapeHtml(`${index + 1}. [${time}]`)} ${escapeHtml(title)} — ${escapeHtml(step.url)} (${escapeHtml(formatDuration(step.durationMs))})</li>`;
    })
    .join('');
  const totalMs = steps.reduce((sum, step) => sum + step.durationMs, 0);
  return `<ul>${items}</ul><p>${escapeHtml(`Total steps: ${steps.length}, total elapsed: ${formatDuration(totalMs)}`)}</p>`;
}

/**
 * Renders gracefully when geo is absent (Phase 1: always absent; Phase 2
 * populates it). Exported for reuse by Phase 2 admin views (P05, W1) — no
 * behavior change.
 */
export function renderGeoLine(geo: unknown): string {
  if (!geo || typeof geo !== 'object') return '';
  const g = geo as Record<string, unknown>;
  const parts = [g.city, g.region, g.country].filter(
    (part): part is string => typeof part === 'string' && part.length > 0
  );
  return parts.length > 0 ? `Location: ${parts.join(', ')}` : '';
}

export function defaultAbandonedLeadTemplate(data: AbandonedLeadEmailData): NotifyTemplateResult {
  const subject = `Abandoned lead: ${data.formId} (${data.siteId})`;
  const geoLine = renderGeoLine(data.geo);

  const textLines = [
    `A visitor abandoned form "${data.formId}" on site "${data.siteId}".`,
    '',
    'Captured fields:',
    renderFieldsText(data.fields),
    '',
    'Journey:',
    renderJourneyTimelineText(data.journey),
  ];
  if (geoLine) textLines.push('', geoLine);
  if (data.pageUrl) textLines.push('', `Page: ${data.pageUrl}`);
  if (data.referrer) textLines.push(`Referrer: ${data.referrer}`);
  if (data.entryUrl) textLines.push('', `View entry: ${data.entryUrl}`);
  const text = textLines.join('\n');

  const htmlParts = [
    `<h1>${escapeHtml(subject)}</h1>`,
    `<p>A visitor abandoned form <strong>${escapeHtml(data.formId)}</strong> on site <strong>${escapeHtml(data.siteId)}</strong>.</p>`,
    '<h2>Captured fields</h2>',
    renderFieldsHtml(data.fields),
    '<h2>Journey</h2>',
    renderJourneyTimelineHtml(data.journey),
  ];
  if (geoLine) htmlParts.push(`<p>${escapeHtml(geoLine)}</p>`);
  if (data.pageUrl) htmlParts.push(`<p>Page: ${escapeHtml(data.pageUrl)}</p>`);
  if (data.referrer) htmlParts.push(`<p>Referrer: ${escapeHtml(data.referrer)}</p>`);
  if (data.entryUrl) {
    htmlParts.push(`<p><a href="${escapeHtml(data.entryUrl)}">View entry</a></p>`);
  }
  const html = htmlParts.join('\n');

  return { subject, text, html };
}

// ---------------------------------------------------------------------------
// Payment templates (PAY-02, W3) — renderPaymentQuoteTemplate and
// renderPaymentReceivedTemplate. Pure functions, same contract as
// defaultAbandonedLeadTemplate: no I/O, every interpolated value escaped in
// html, safely overridable via a host's `templatesModule` (CafTemplates,
// notify.ts).
// ---------------------------------------------------------------------------

/**
 * Formats cents as a locale-aware currency string (e.g. 20000/'usd' ->
 * "$200.00"). Reused by the payment email templates and the admin
 * entry-detail payments section — never re-implemented per-caller. Falls
 * back to a plain "<dollars> <CODE>" string for a currency code
 * `Intl.NumberFormat` rejects as malformed — never throws.
 */
export function formatMoney(amountCents: number, currency: string): string {
  const dollars = amountCents / 100;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(dollars);
  } catch {
    return `${dollars.toFixed(2)} ${currency.toUpperCase()}`;
  }
}

/** One row of a rendered payment breakdown — label + already-money-formatted amount string. */
function paymentBreakdownRows(breakdown: FeeBreakdown, currency: string): { label: string; amount: string }[] {
  const rows = [{ label: 'Subtotal', amount: formatMoney(breakdown.subtotalCents, currency) }];
  for (const line of breakdown.lines) {
    rows.push({ label: line.label, amount: formatMoney(line.amountCents, currency) });
  }
  rows.push({ label: 'Total due', amount: formatMoney(breakdown.totalCents, currency) });
  return rows;
}

/** Renders the "Subtotal / fee lines / Total due" breakdown as plain text lines. */
function renderPaymentBreakdownText(breakdown: FeeBreakdown, currency: string): string {
  return paymentBreakdownRows(breakdown, currency)
    .map((row) => `${row.label}: ${row.amount}`)
    .join('\n');
}

/** Renders the "Subtotal / fee lines / Total due" breakdown as an escaped `<ul>`. */
function renderPaymentBreakdownHtml(breakdown: FeeBreakdown, currency: string): string {
  const items = paymentBreakdownRows(breakdown, currency)
    .map((row) => `<li>${escapeHtml(row.label)}: ${escapeHtml(row.amount)}</li>`)
    .join('');
  return `<ul>${items}</ul>`;
}

/** A subtotal-only breakdown (no fee lines) used when the caller omits `breakdown` — the admin quote-flow (03-06 payment-action route) never applies fee lines, only the owner-set amount. */
function trivialBreakdown(amountCents: number): FeeBreakdown {
  return { subtotalCents: amountCents, lines: [], totalCents: amountCents };
}

/**
 * Auto-sent when the owner creates a pay link from an entry (PAY-02).
 * Subject names the total amount + site; body renders the memo (if any),
 * the Subtotal/fee-line/Total breakdown (defaulting to a trivial
 * subtotal-only breakdown when `data.breakdown` is omitted), and the pay
 * link — an escaped anchor in html, a plain copy-able URL in text.
 */
export function renderPaymentQuoteTemplate(data: PaymentQuoteEmailData): NotifyTemplateResult {
  const breakdown = data.breakdown ?? trivialBreakdown(data.amountCents);
  const amountLabel = formatMoney(breakdown.totalCents, data.currency);
  const subject = `Payment request: ${amountLabel} for ${data.siteId}`;

  const textLines = [`A payment link for ${amountLabel} is ready.`];
  if (data.memo) textLines.push('', `Memo: ${data.memo}`);
  textLines.push('', renderPaymentBreakdownText(breakdown, data.currency));
  textLines.push('', `Pay now: ${data.payLinkUrl}`);
  const text = textLines.join('\n');

  const htmlParts = [
    `<h1>${escapeHtml(subject)}</h1>`,
    `<p>A payment link for <strong>${escapeHtml(amountLabel)}</strong> is ready.</p>`,
  ];
  if (data.memo) htmlParts.push(`<p>Memo: ${escapeHtml(data.memo)}</p>`);
  htmlParts.push('<h2>Breakdown</h2>', renderPaymentBreakdownHtml(breakdown, data.currency));
  htmlParts.push(`<p><a href="${escapeHtml(data.payLinkUrl)}">Pay now</a></p>`);
  const html = htmlParts.join('\n');

  return { subject, text, html };
}

/**
 * "Payment received" confirmation (PAY-03/03-07's inbound webhook is the
 * only caller today) — amount + provider in subject/text/html, an optional
 * escaped entry-detail deep link.
 */
export function renderPaymentReceivedTemplate(data: PaymentReceivedEmailData): NotifyTemplateResult {
  const amountLabel = formatMoney(data.amountCents, data.currency);
  const subject = `Payment received: ${amountLabel} (${data.provider})`;

  const textLines = [`A payment of ${amountLabel} was received via ${data.provider}.`];
  if (data.entryUrl) textLines.push('', `View entry: ${data.entryUrl}`);
  const text = textLines.join('\n');

  const htmlParts = [
    `<h1>${escapeHtml(subject)}</h1>`,
    `<p>A payment of <strong>${escapeHtml(amountLabel)}</strong> was received via <strong>${escapeHtml(data.provider)}</strong>.</p>`,
  ];
  if (data.entryUrl) htmlParts.push(`<p><a href="${escapeHtml(data.entryUrl)}">View entry</a></p>`);
  const html = htmlParts.join('\n');

  return { subject, text, html };
}

// ---------------------------------------------------------------------------
// Recovery follow-up template (RCV-01, D3/D4) — renderRecoveryEmailTemplate.
// This is the FIRST package email addressed to the VISITOR rather than the
// owner (every template above targets notifyTo); the caller is
// sendRecoveryEmail (notify.ts), which sends to `data.to`. Same contract as
// every other template: pure function, no I/O, every interpolated value
// escaped in the html branch. The unsubscribeUrl carries the D4 one-click
// HMAC token — the visitor never needs to log in to opt out.
// ---------------------------------------------------------------------------

/**
 * A short nudge back to the abandoned form plus a one-click unsubscribe
 * footer link (D4). `data.resumeUrl`/`data.unsubscribeUrl` are pre-built by
 * the caller (recovery/sweep.ts) — trailingSlash-computed, HMAC-signed —
 * this function only renders them, it never builds a URL itself.
 */
export function renderRecoveryEmailTemplate(data: RecoveryEmailData): NotifyTemplateResult {
  const subject = 'Still want to finish your form?';

  const textLines = [
    "Looks like you didn't quite finish — pick up right where you left off:",
    '',
    data.resumeUrl,
    '',
    `Don't want these emails? Unsubscribe: ${data.unsubscribeUrl}`,
  ];
  const text = textLines.join('\n');

  const htmlParts = [
    `<h1>${escapeHtml(subject)}</h1>`,
    "<p>Looks like you didn't quite finish — pick up right where you left off:</p>",
    `<p><a href="${escapeHtml(data.resumeUrl)}">Resume your form</a></p>`,
    `<p style="font-size:12px;color:#666;">Don't want these emails? <a href="${escapeHtml(data.unsubscribeUrl)}">Unsubscribe</a></p>`,
  ];
  const html = htmlParts.join('\n');

  return { subject, text, html };
}
