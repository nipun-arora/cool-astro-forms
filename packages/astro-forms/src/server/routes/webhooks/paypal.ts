/**
 * POST /api/forms/webhooks/paypal (PAY-03) — inbound PayPal payment
 * webhook. NOT under /forms-admin: like stripe.ts, there is no session
 * guard here — the verify-webhook-signature postback IS the access
 * control (RESEARCH.md Architectural Responsibility Map, V4). Reads the
 * RAW body via `readBodyCapped` (RESEARCH Pitfall 1) BEFORE any use —
 * `verifyPaypalWebhookSignature` needs the untouched bytes to build the
 * postback's `webhook_event` field. Delegates the atomic-idempotent-flip
 * -> notify -> deliver pipeline entirely to `handleInboundPayment`
 * (../../webhooks/handle-inbound.js) — this file only adapts the
 * Request/Response boundary, verifies, and does the PayPal-specific
 * order-id linkage extraction (checker B3, PINNED).
 *
 * Checker B3 (docs/LESSONS.md #19): a PAYMENT.CAPTURE.COMPLETED event's
 * `resource` IS THE CAPTURE OBJECT — `resource.id` is the CAPTURE id, NOT
 * the order id this package stores as `payments.provider_ref`. The order
 * id lives at `resource.supplementary_data.related_ids.order_id`
 * (PRIMARY). When `supplementary_data` is absent, this route falls back
 * to scanning stored PayPal payments' `provider_ids` for a previously
 * recorded capture id — and to make that fallback reliable, the primary
 * path below ALSO records the capture id onto the payment's `provider_ids`
 * whenever it resolves the order id directly.
 *
 * PAY-04: inert (404, mirrors routes/canary.ts / routes/webhooks/stripe.ts)
 * without PAYPAL_WEBHOOK_ID + the PayPal API keys — checked FIRST, before
 * any body read.
 *
 * Clean-room: written fresh against 03-CONTEXT.md/03-RESEARCH.md, not
 * derived from any WPForms source.
 */
import type { APIRoute } from 'astro';
import config from 'virtual:cool-astro-forms/config';
import { log, logError } from '../../log.js';
import type { CafTemplates } from '../../notify.js';
import { sendPaymentReceivedEmail } from '../../notify.js';
import { MAX_WEBHOOK_PAYLOAD_BYTES } from '../../payment-constants.js';
import { paypalConfigured, verifyPaypalWebhookSignature } from '../../payments/paypal.js';
import { contentLengthWithinCap, readBodyCapped } from '../../security/size-cap.js';
import { getStorageAdapter } from '../../storage/index.js';
import { deliverWebhook } from '../../webhooks/deliver.js';
import { handleInboundPayment, type PaymentReceivedNotifyData } from '../../webhooks/handle-inbound.js';
import { adminUrl } from '../../admin/_shared.js';

export const prerender = false;

/** `trailingSlash`/`templates` ride on the virtual config module (checker B1/W3 cast precedent — middleware.ts/admin/*.astro/routes/abandon.ts/routes/webhooks/stripe.ts). */
type ConfigWithExtras = typeof config & {
  trailingSlash?: 'always' | 'never' | 'ignore';
  templates?: CafTemplates;
};

const COMPLETED_EVENT_TYPE = 'PAYMENT.CAPTURE.COMPLETED';

interface PaypalCaptureAmount {
  value?: string;
  currency_code?: string;
}

/** The CAPTURE resource shape a PAYMENT.CAPTURE.COMPLETED event's `resource` field carries. */
interface PaypalCaptureResource {
  id: string;
  amount?: PaypalCaptureAmount;
  supplementary_data?: { related_ids?: { order_id?: string } };
}

interface PaypalWebhookEvent {
  id: string;
  event_type: string;
  resource: PaypalCaptureResource;
}

/** Dollars-string PayPal amount (e.g. "20.00") -> cents. Never throws — a malformed/absent value resolves undefined. */
function parseAmountCents(amount?: PaypalCaptureAmount): number | undefined {
  if (!amount?.value) return undefined;
  const dollars = Number(amount.value);
  if (!Number.isFinite(dollars)) return undefined;
  return Math.round(dollars * 100);
}

export const POST: APIRoute = async ({ request }) => {
  // PAY-04: module stays inert without PAYPAL_WEBHOOK_ID + the PayPal API keys.
  if (!paypalConfigured() || !process.env.PAYPAL_WEBHOOK_ID) {
    return new Response(null, { status: 404 });
  }

  // Fast path: reject via Content-Length before ever buffering the body.
  if (!contentLengthWithinCap(request.headers, MAX_WEBHOOK_PAYLOAD_BYTES)) {
    log('webhook.paypal.reject', { reason: 'payload' });
    return new Response('Payload Too Large', { status: 413 });
  }

  // Raw body FIRST (Pitfall 1) — verifyPaypalWebhookSignature parses this
  // ONLY to build the postback's `webhook_event` field; the raw string
  // itself is never otherwise mutated before verification.
  const readResult = await readBodyCapped(request.body, MAX_WEBHOOK_PAYLOAD_BYTES);
  if (!readResult.ok) {
    log('webhook.paypal.reject', { reason: 'payload' });
    return new Response('Payload Too Large', { status: 413 });
  }
  const rawBody = readResult.text;

  const verified = await verifyPaypalWebhookSignature(rawBody, request.headers);
  if (!verified) {
    log('webhook.paypal.invalid-signature', {});
    return new Response('Webhook Error', { status: 400 });
  }

  let event: PaypalWebhookEvent;
  try {
    event = JSON.parse(rawBody) as PaypalWebhookEvent;
  } catch (err) {
    // Verified-but-unparseable should never happen (the postback itself
    // parses rawBody to build webhook_event) — logged defensively; ack
    // anyway since the signature DID verify (nothing malicious to retry).
    logError('webhook.paypal.parse-failed', err);
    return new Response(null, { status: 200 });
  }

  if (event.event_type !== COMPLETED_EVENT_TYPE) {
    // Always 200 once verified, even for unhandled event types (ack).
    log('webhook.paypal.unhandled-event', { type: event.event_type });
    return new Response(null, { status: 200 });
  }

  try {
    const storage = await getStorageAdapter(config);
    const resource = event.resource;
    const captureId = resource.id;

    // PRIMARY (checker B3, PINNED): resource.supplementary_data.related_ids.order_id.
    let providerRef = resource.supplementary_data?.related_ids?.order_id;

    if (!providerRef) {
      // FALLBACK: scan stored PayPal payments' provider_ids for a
      // previously recorded capture id (reliable only because the
      // primary path below ALSO records it whenever available).
      const candidates = await storage.listPayments({ provider: 'paypal' });
      providerRef = candidates.find((p) => p.providerIds?.captureId === captureId)?.providerRef;
    }

    if (!providerRef) {
      log('webhook.paypal.unresolved-order-id', { captureId });
      return new Response(null, { status: 200 });
    }

    // Record the capture id onto the payment's provider_ids so a FUTURE
    // delivery whose supplementary_data is absent can still resolve via
    // the fallback above.
    try {
      const existing = await storage.getPaymentByProviderRef(providerRef);
      if (existing) {
        await storage.updatePayment(existing.id, {
          providerIds: { ...(existing.providerIds ?? {}), captureId },
        });
      }
    } catch (err) {
      logError('webhook.paypal.provider-ids-update-failed', err, { providerRef, captureId });
    }

    const trailingSlash = (config as ConfigWithExtras).trailingSlash;
    const templateOverride = (config as ConfigWithExtras).templates?.paymentReceived;

    const result = await handleInboundPayment(
      {
        providerRef,
        eventId: event.id,
        eventType: event.event_type,
        provider: 'paypal',
        amountCents: parseAmountCents(resource.amount),
        currency: resource.amount?.currency_code?.toLowerCase(),
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
    // migration/open/backend-selection failure — mirrors routes/abandon.ts
    // and routes/webhooks/stripe.ts's own try/catch-wraps-storage-
    // acquisition convention (review S2-4).
    logError('webhook.paypal.route-failed', err, { eventId: event.id });
    return new Response(null, { status: 500 });
  }
};
