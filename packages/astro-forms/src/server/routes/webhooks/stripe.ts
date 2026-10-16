/**
 * POST /api/forms/webhooks/stripe (PAY-03) — inbound Stripe payment
 * webhook. NOT under /forms-admin: unlike every admin route, there is no
 * session guard here — the Stripe signature IS the access control
 * (RESEARCH.md Architectural Responsibility Map, V4). Reads the RAW body
 * via `readBodyCapped` (RESEARCH Pitfall 1) BEFORE any JSON parsing —
 * `verifyStripeWebhook`'s `constructEvent` needs the exact untouched bytes
 * Stripe itself signed. Delegates the verify -> atomic-idempotent-flip ->
 * notify -> deliver pipeline entirely to `handleInboundPayment`
 * (../../webhooks/handle-inbound.js) — this file only adapts the
 * Request/Response boundary and does the Stripe-specific event field
 * extraction + config-dependent notify wiring (notifyTo, template
 * override, entryUrl).
 *
 * PAY-04: inert (404, mirrors routes/canary.ts) without
 * STRIPE_WEBHOOK_SECRET — checked FIRST, before any body read.
 *
 * 0.1.15: handles `checkout.session.completed` and
 * `checkout.session.async_payment_succeeded`, forwards the session's
 * Payment Link id as a second find key (fleet bug F1), and passes the
 * provider-confirmed settlement (`payment_status`, amount, currency) so the
 * handler only marks a row paid when those match it. Refunds, disputes and
 * expired sessions are acknowledged without changing the row.
 *
 * 0.1.17: also reads the Stripe Customer id and the payer's email off the
 * verified session (plus `event.livemode`) and passes them to the handler,
 * which records them on the payment row in the same atomic write that marks
 * it paid. Neither value is logged here.
 *
 * 0.1.17 (security): checkout never creates or writes a Stripe Customer from
 * visitor input; a new payer's session makes Stripe create one when the
 * payer confirms. When the handler reports that THIS delivery marked the row
 * paid (`markedPaid`), the route ADOPTS `session.customer`: it tags it
 * `metadata.source: 'cool-astro-forms'` (`adoptStripeCustomer`), which makes
 * it reusable for the same payer's next payment (payments/customers.ts). An
 * unpaid or mismatched session, a refund and a duplicate delivery are never
 * adopted. Adoption is best effort: it never throws and never changes the
 * status Stripe gets, and a failure is logged (`stripe.customer-adopt-failed`)
 * with the event id only. One Stripe client per delivery verifies the
 * signature and makes that update.
 *
 * Clean-room: written fresh against 03-CONTEXT.md/03-RESEARCH.md, not
 * derived from any commercial form-plugin source.
 */
import type { APIRoute } from 'astro';
import type Stripe from 'stripe';
import config from 'virtual:cool-astro-forms/config';
import { log, logError } from '../../log.js';
import type { CafTemplates } from '../../notify.js';
import { sendPaymentReceivedEmail } from '../../notify.js';
import { MAX_WEBHOOK_PAYLOAD_BYTES } from '../../payment-constants.js';
import { adoptStripeCustomer } from '../../payments/customers.js';
import { getStripeClient, verifyStripeWebhook } from '../../payments/stripe.js';
import { contentLengthWithinCap, readBodyCapped } from '../../security/size-cap.js';
import { getStorageAdapter } from '../../storage/index.js';
import { deliverWebhook } from '../../webhooks/deliver.js';
import { handleInboundPayment, type PaymentReceivedNotifyData } from '../../webhooks/handle-inbound.js';
import { adminUrl } from '../../admin/_shared.js';

export const prerender = false;

/** `trailingSlash`/`templates` ride on the virtual config module (checker B1/W3 cast precedent — middleware.ts/admin/*.astro/routes/abandon.ts). */
type ConfigWithExtras = typeof config & {
  trailingSlash?: 'always' | 'never' | 'ignore';
  templates?: CafTemplates;
};

/**
 * Session events that can settle a payment: the normal completion, and
 * (0.1.15) the later success of a delayed payment method, whose session
 * completes with `payment_status: 'unpaid'` first. The handler's settlement
 * check, not the event type, decides whether either marks the row paid.
 */
const SETTLING_EVENT_TYPES: ReadonlySet<string> = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
]);

/**
 * Amount and currency in the integration currency the row was created in.
 * Sessions created before Stripe's 2025-03-31 API change that used Adaptive
 * Pricing report the customer's presentment currency at the top level and
 * the original under `currency_conversion`.
 */
function integrationAmount(session: Stripe.Checkout.Session): { amountCents: number | null; currency: string | null } {
  const conversion = session.currency_conversion;
  if (conversion && typeof conversion.amount_total === 'number' && conversion.source_currency) {
    return { amountCents: conversion.amount_total, currency: conversion.source_currency };
  }
  return { amountCents: session.amount_total ?? null, currency: session.currency ?? null };
}

/** The Payment Link a session came from (`plink_…`), id or expanded object; undefined for sessions created directly. */
function paymentLinkId(session: Stripe.Checkout.Session): string | undefined {
  const link = session.payment_link;
  if (typeof link === 'string') return link;
  return link?.id;
}

/**
 * The Stripe Customer id (`cus_…`) a session belongs to, whether Stripe sent
 * the bare id or an expanded object; null for a session with no customer
 * (a guest checkout from a Payment Link that does not create customers).
 */
function customerId(session: Stripe.Checkout.Session): string | null {
  const customer = session.customer;
  const id = typeof customer === 'string' ? customer : customer?.id;
  return id ? id : null;
}

/**
 * The payer's email, normalised (trimmed, lowercased) so the same person
 * typing different casing is one payer. The email the payer used at checkout
 * (`customer_details.email`) wins over the one the host prefilled
 * (`customer_email`); a blank value falls through to the next. Null when the
 * session carries neither.
 */
function payerEmail(session: Stripe.Checkout.Session): string | null {
  for (const candidate of [session.customer_details?.email, session.customer_email]) {
    const email = candidate?.trim().toLowerCase();
    if (email) return email;
  }
  return null;
}

export const POST: APIRoute = async ({ request }) => {
  // PAY-04: module stays inert without the webhook secret (mirrors canary.ts's own env-gated 404).
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    return new Response(null, { status: 404 });
  }

  // Fast path: reject via Content-Length before ever buffering the body.
  // Dwarfs abandon.ts's MAX_PAYLOAD_BYTES — Stripe event bodies are far
  // larger than a form submission.
  if (!contentLengthWithinCap(request.headers, MAX_WEBHOOK_PAYLOAD_BYTES)) {
    log('webhook.stripe.reject', { reason: 'payload' });
    return new Response('Payload Too Large', { status: 413 });
  }

  // Raw body FIRST (Pitfall 1) — read exactly once, before any parsing.
  // The signature Stripe computed covers these exact bytes; a JSON parse/
  // re-stringify anywhere before verification would silently break every
  // signature check.
  const readResult = await readBodyCapped(request.body, MAX_WEBHOOK_PAYLOAD_BYTES);
  if (!readResult.ok) {
    log('webhook.stripe.reject', { reason: 'payload' });
    return new Response('Payload Too Large', { status: 413 });
  }
  const rawBody = readResult.text;

  const signature = request.headers.get('stripe-signature') ?? '';
  // One client per delivery: it verifies the signature here and, after a
  // paid flip, adopts the paying Customer below (0.1.17).
  const client = getStripeClient();
  const verified = verifyStripeWebhook(rawBody, signature, { client });
  if (!verified.ok) {
    log('webhook.stripe.invalid-signature', {});
    return new Response('Webhook Error', { status: 400 });
  }

  const event = verified.event;
  if (!SETTLING_EVENT_TYPES.has(event.type)) {
    // Always 200 once the signature is valid, even for unhandled event
    // types (ack) — Stripe should never retry a type we deliberately don't act on.
    log('webhook.stripe.unhandled-event', { type: event.type });
    return new Response(null, { status: 200 });
  }

  try {
    const session = event.data.object as Stripe.Checkout.Session;
    const storage = await getStorageAdapter(config);
    const trailingSlash = (config as ConfigWithExtras).trailingSlash;
    const templateOverride = (config as ConfigWithExtras).templates?.paymentReceived;

    const { amountCents, currency } = integrationAmount(session);
    const alternateProviderRef = paymentLinkId(session);
    const sessionCustomerRef = customerId(session);
    const sessionPayerEmail = payerEmail(session);

    const result = await handleInboundPayment(
      {
        providerRef: session.id,
        eventId: event.id,
        eventType: event.type,
        provider: 'stripe',
        amountCents: amountCents ?? undefined,
        currency: currency ?? undefined,
        // F1 (0.1.15): admin Payment Link rows are keyed by the link id.
        ...(alternateProviderRef ? { alternateProviderRef } : {}),
        // 0.1.15: only a paid session for the stored amount and currency
        // marks the row paid (handle-inbound.ts judgeSettlement).
        settlement: { paid: session.payment_status === 'paid', amountCents, currency },
        // 0.1.17: recorded on the row by the handler only when this call marks it paid.
        ...(sessionCustomerRef ? { customerRef: sessionCustomerRef } : {}),
        ...(sessionPayerEmail ? { payerEmail: sessionPayerEmail } : {}),
        ...(typeof event.livemode === 'boolean' ? { livemode: event.livemode } : {}),
      },
      {
        storage,
        notify: (data: PaymentReceivedNotifyData) => {
          const notifyTo = data.formId ? config.forms[data.formId]?.notifyTo : undefined;
          if (!notifyTo) return Promise.resolve(undefined);
          return sendPaymentReceivedEmail(
            {
              siteId: data.siteId,
              formId: data.formId,
              notifyTo,
              amountCents: data.amountCents ?? 0,
              currency: data.currency ?? 'usd',
              provider: data.provider,
              entryUrl: `${config.siteUrl}${adminUrl(`/forms-admin/entries/${data.entryId}`, trailingSlash)}`,
            },
            { template: templateOverride },
          );
        },
        deliver: deliverWebhook,
        log,
      },
    );

    // 0.1.17: only the delivery that marked the row paid adopts, so the
    // Customer is one Stripe made (or one already tagged) for a payer whose
    // payment for this row was verified. Never throws, never changes status.
    if (result.markedPaid && sessionCustomerRef && client) {
      await adoptStripeCustomer(sessionCustomerRef, client, { eventId: event.id });
    }

    return new Response(null, { status: result.status });
  } catch (err) {
    // Storage acquisition (getStorageAdapter) can reject on a
    // migration/open/backend-selection failure — mirrors routes/abandon.ts's
    // own try/catch-wraps-storage-acquisition convention (review S2-4).
    logError('webhook.stripe.route-failed', err, { eventId: event.id });
    return new Response(null, { status: 500 });
  }
};
