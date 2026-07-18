/**
 * POST /forms-admin/payments/action (PAY-01/PAY-02) — the admin quote-first
 * flow: creates a Stripe Payment Link (or, when provider==='paypal', a
 * PayPal order) for an entry, stores a `link_created` payments row, and
 * auto-sends the branded quote email (fire-and-forget — a copy-link is
 * always shown on entry-detail regardless of the email outcome).
 *
 * isSameOrigin (CSRF, T-03-24) is the ONLY origin check this route needs of
 * its own — the admin session guard already covers every /forms-admin/*
 * path in middleware.ts (mirrors entry-action.ts). Storage acquisition
 * happens INSIDE the try/catch (mirrors entry-action.ts / abandon.ts — a
 * migration/open failure resolves a logged 500-equivalent redirect, not an
 * unlogged crash). On any provider/create failure this route logs and
 * redirects back with NO partial paid state — attachPayment only ever runs
 * after a link/order was actually created.
 *
 * Route injection (integration.ts) is 03-08's responsibility (the phase's
 * chokepoint-consolidation plan) — this plan ships only the handler + tests.
 */
import type { APIRoute } from 'astro';
import config from 'virtual:cool-astro-forms/config';
import type { CafTemplates } from '../../notify.js';
import { sendPaymentQuoteEmail } from '../../notify.js';
import { logError } from '../../log.js';
import { createOrder, paypalConfigured } from '../../payments/paypal.js';
import { parseAmountParam } from '../../payments/pricing.js';
import { createPaymentLink } from '../../payments/stripe.js';
import { isSameOrigin } from '../../security/origin-check.js';
import { getStorageAdapter } from '../../storage/index.js';
import { adminUrl } from '../../admin/_shared.js';

export const prerender = false;

type ConfigWithTrailingSlash = typeof config & { trailingSlash?: 'always' | 'never' | 'ignore' };
/** Narrow-cast for the resolved-from-`templatesModule` seam (mirrors routes/abandon.ts's own ConfigWithTemplates precedent). */
type ConfigWithTemplates = typeof config & { templates?: CafTemplates };

type PaymentProviderChoice = 'stripe' | 'paypal';

/** The admin quote-flow never applies fee lines to an owner-set amount — always USD unless a future plan adds a currency selector to the create-payment-link form. */
const DEFAULT_CURRENCY = 'usd';

/** Reads a form-urlencoded/multipart or JSON body into a flat string map. Never throws. Mirrors entry-action.ts's own helper (each admin action route keeps its own small copy — no shared body-parsing module exists yet). */
async function extractFields(request: Request): Promise<Record<string, string>> {
  const contentType = request.headers.get('content-type') ?? '';
  const out: Record<string, string> = {};
  try {
    if (contentType.includes('application/json')) {
      const body = (await request.json()) as Record<string, unknown>;
      for (const [k, v] of Object.entries(body)) if (typeof v === 'string') out[k] = v;
      return out;
    }
    const formData = await request.formData();
    for (const [k, v] of formData.entries()) if (typeof v === 'string') out[k] = v;
    return out;
  } catch {
    return out;
  }
}

function badRequest(): Response {
  return new Response(null, { status: 400 });
}

/** Same email-detection convention as handle-abandon.ts's hasValidEmailOrPhone (a key name containing "email"). Used to find the entry's captured address to send the quote to; falls back to the form's configured notifyTo. */
const EMAIL_KEY_PATTERN = /email/i;

function extractEntryEmail(fields: Record<string, unknown>): string | undefined {
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed && EMAIL_KEY_PATTERN.test(key)) return trimmed;
  }
  return undefined;
}

export const POST: APIRoute = async ({ request }) => {
  const trailingSlash = (config as ConfigWithTrailingSlash).trailingSlash;

  // 1. CSRF (T-03-24) — the ONLY origin protection this route gets of its
  // own; the auth session guard already covers this whole path prefix.
  if (!isSameOrigin(request.headers, config.siteUrl)) {
    return new Response(null, { status: 403 });
  }

  const fields = await extractFields(request);
  const entryId = fields.entryId;
  const provider = fields.provider as PaymentProviderChoice | undefined;
  const memo = fields.memo || undefined;

  if (!entryId || (provider !== 'stripe' && provider !== 'paypal')) {
    return badRequest();
  }

  // Dollars -> cents via the ONE shared pricing dollar-parse convention
  // (parseAmountParam over an `amount` param) — never a second money-parse
  // implementation (T-03-26).
  const amountCents = parseAmountParam(new URLSearchParams({ amount: fields.amount ?? '' }));
  if (amountCents === undefined || !Number.isInteger(amountCents) || amountCents <= 0) {
    return badRequest();
  }

  const redirectTarget = adminUrl(`/forms-admin/entries/${entryId}`, trailingSlash);
  const redirectBack = (): Response => new Response(null, { status: 302, headers: { Location: redirectTarget } });

  try {
    const storage = await getStorageAdapter(config);
    const entry = await storage.getEntryById(entryId);
    if (!entry) return badRequest();

    let link: { url: string; providerRef: string } | undefined;

    if (provider === 'stripe') {
      const result = await createPaymentLink({ amountCents, currency: DEFAULT_CURRENCY, memo, entryId });
      link = { url: result.url, providerRef: result.providerRef };
    } else if (paypalConfigured()) {
      // No dedicated payment-confirmation page exists in this plan's scope
      // (that lands with 03-05's /forms-pay/success) — both return/cancel
      // land on the site root, computed trailingSlash-aware (B1). The
      // inbound webhook (03-07) remains the sole source of payment truth,
      // never this browser redirect.
      const returnUrl = `${config.siteUrl}${adminUrl('/', trailingSlash)}`;
      const order = await createOrder({
        totalCents: amountCents,
        currency: DEFAULT_CURRENCY,
        entryId,
        returnUrl,
        cancelUrl: returnUrl,
      });
      if (order) link = { url: order.approvalUrl, providerRef: order.providerRef };
    }

    if (!link) {
      logError('admin.payment-action-failed', new Error(`${provider} payment link creation failed`), {
        entryId,
        provider,
      });
      return redirectBack();
    }

    await storage.attachPayment(entryId, {
      provider,
      amountCents,
      currency: DEFAULT_CURRENCY,
      status: 'link_created',
      payLinkUrl: link.url,
      providerRef: link.providerRef,
    });

    // Auto-send the quote (PAY-02) fire-and-forget — a copy-link is always
    // shown on entry-detail regardless of email success (T-03-27 caveat:
    // only the public pay-link URL, never a secret, is ever stored/shown).
    const notifyTo = extractEntryEmail(entry.fields) ?? config.forms[entry.formId]?.notifyTo;
    if (notifyTo) {
      const templateOverride = (config as ConfigWithTemplates).templates?.paymentQuote;
      sendPaymentQuoteEmail(
        {
          siteId: config.siteId,
          formId: entry.formId,
          notifyTo,
          amountCents,
          currency: DEFAULT_CURRENCY,
          memo,
          payLinkUrl: link.url,
        },
        { template: templateOverride },
      ).catch((err) => logError('admin.payment-quote-email-failed', err, { entryId }));
    }

    return redirectBack();
  } catch (err) {
    logError('admin.payment-action-failed', err, { entryId, provider });
    return redirectBack();
  }
};
