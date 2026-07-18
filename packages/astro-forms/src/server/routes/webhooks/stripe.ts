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
 * Clean-room: written fresh against 03-CONTEXT.md/03-RESEARCH.md, not
 * derived from any WPForms source.
 */
import type { APIRoute } from 'astro';
import type Stripe from 'stripe';
import config from 'virtual:cool-astro-forms/config';
import { log, logError } from '../../log.js';
import type { CafTemplates } from '../../notify.js';
import { sendPaymentReceivedEmail } from '../../notify.js';
import { MAX_WEBHOOK_PAYLOAD_BYTES } from '../../payment-constants.js';
import { verifyStripeWebhook } from '../../payments/stripe.js';
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

const COMPLETED_EVENT_TYPE = 'checkout.session.completed';

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
  const verified = verifyStripeWebhook(rawBody, signature);
  if (!verified.ok) {
    log('webhook.stripe.invalid-signature', {});
    return new Response('Webhook Error', { status: 400 });
  }

  const event = verified.event;
  if (event.type !== COMPLETED_EVENT_TYPE) {
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

    const result = await handleInboundPayment(
      {
        providerRef: session.id,
        eventId: event.id,
        eventType: event.type,
        provider: 'stripe',
        amountCents: session.amount_total ?? undefined,
        currency: session.currency ?? undefined,
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

    return new Response(null, { status: result.status });
  } catch (err) {
    // Storage acquisition (getStorageAdapter) can reject on a
    // migration/open/backend-selection failure — mirrors routes/abandon.ts's
    // own try/catch-wraps-storage-acquisition convention (review S2-4).
    logError('webhook.stripe.route-failed', err, { eventId: event.id });
    return new Response(null, { status: 500 });
  }
};
