/**
 * handleInboundPayment — the provider-agnostic verify->atomic-idempotent-
 * flip->notify->deliver pipeline (PAY-03, checker W1). Framework-free,
 * injected deps only (network-free) — mirrors handle-abandon.ts's shape.
 * The provider-specific signature verification + raw-body reading stay in
 * the thin route adapters (routes/webhooks/stripe.ts, .../paypal.ts); this
 * module is the shared core BOTH routes call once a signature has already
 * verified.
 *
 * Idempotency (checker W1, docs/LESSONS.md #33): the atomic
 * `storage.appendPaymentEventIfAbsent` primitive (one BEGIN IMMEDIATE
 * transaction: duplicate check + event append + optional status patch) is
 * the ONLY gate on side effects — this handler NEVER performs its own
 * read-check-write against a payment's `events[]` array (RESEARCH.md
 * Pitfall 2).
 *
 * Clean-room: written fresh against 03-CONTEXT.md/03-RESEARCH.md, not
 * derived from any commercial form-plugin source.
 */
import type { Entry, EntryStatus, Payment, PaymentEvent, PaymentProvider, WebhookEventType } from '../../types.js';
import { logError } from '../log.js';
import type { StorageAdapter } from '../storage/adapter.js';

/** Matches src/server/log.ts's `log()` signature (handle-abandon.ts precedent). */
export type Logger = (event: string, data?: Record<string, unknown>) => void;

/**
 * Provider event-type strings this handler treats as a real paid
 * transition — Stripe's Checkout completion and PayPal's capture
 * completion (checker B3 pins the PayPal linkage extraction, done by the
 * paypal.ts route BEFORE this handler is ever called). Any other event
 * type (e.g. a refund) appends via the same atomic primitive WITHOUT a
 * status patch and without a re-notify.
 */
const COMPLETED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'checkout.session.completed',
  // 0.1.15: a delayed payment method completes the session unpaid and
  // settles later with this event; the settlement check below decides.
  'checkout.session.async_payment_succeeded',
  'PAYMENT.CAPTURE.COMPLETED',
]);

/**
 * What the provider says actually settled, read off the verified event by
 * the calling route (Stripe: `payment_status === 'paid'`, `amount_total`,
 * `currency`). Optional: PayPal's route passes none and keeps its 0.1.14
 * behaviour.
 */
export interface PaymentSettlement {
  paid: boolean;
  amountCents: number | null | undefined;
  currency: string | null | undefined;
}

type SettlementVerdict = { ok: true } | { ok: false; reason: 'not-paid' | 'amount' | 'currency' };

/**
 * The stored row is the contract: every session this package (or a host
 * through `createCheckoutForEntry`) creates records its amount and currency
 * at creation time, so a completion for anything else is not this payment.
 */
function judgeSettlement(payment: Payment, settlement: PaymentSettlement): SettlementVerdict {
  if (!settlement.paid) return { ok: false, reason: 'not-paid' };
  if (
    typeof settlement.amountCents !== 'number' ||
    typeof payment.amountCents !== 'number' ||
    settlement.amountCents !== payment.amountCents
  ) {
    return { ok: false, reason: 'amount' };
  }
  if ((settlement.currency ?? '').toLowerCase() !== (payment.currency ?? '').toLowerCase() || !settlement.currency) {
    return { ok: false, reason: 'currency' };
  }
  return { ok: true };
}

/**
 * Entry statuses a payment-paid flip must NEVER downgrade or re-write:
 * 'submitted' is the flip TARGET itself (every PAY-05 synthetic entry
 * already starts 'submitted' at creation — see payments/payment-request.ts
 * — so a repeat/second payment against it is correctly a no-op here);
 * 'converted' is strictly further along; 'spam' is an explicit owner
 * exclusion. Only 'abandoned' is a legitimate promotion target — an
 * owner-quoted lead (03-06 admin quote-flow) who pays without ever
 * formally submitting the form.
 */
const TERMINAL_ENTRY_STATUSES: ReadonlySet<EntryStatus> = new Set(['submitted', 'converted', 'spam']);

export interface HandleInboundPaymentInput {
  /** Stripe Checkout Session id / PayPal Order id — the payments.provider_ref find key. */
  providerRef: string;
  /** Provider's own event id — the idempotency key (Stripe event.id / PayPal webhook_event.id). */
  eventId: string;
  /** Provider's event type string, e.g. 'checkout.session.completed' / 'PAYMENT.CAPTURE.COMPLETED'. */
  eventType: string;
  provider: PaymentProvider;
  /**
   * Best-effort amount/currency read off the webhook event's own resource
   * by the calling route. Used only for the notify/deliver payload (falls
   * back to the stored payment row's own amountCents/currency when
   * absent) — NEVER patched onto the payment row itself; the row's
   * amount/currency are set once at checkout-session/order creation time.
   */
  amountCents?: number;
  currency?: string;
  /**
   * A second find key tried only when `providerRef` matches no row (0.1.15,
   * fleet bug F1): the Stripe Payment Link id (`plink_…`) the session came
   * from. The admin quote flow can only record the link id, because the
   * session id does not exist until someone pays.
   */
  alternateProviderRef?: string;
  /**
   * Provider-confirmed settlement (0.1.15). When present on a completed
   * event, the row flips to paid only if the provider says paid AND the
   * amount and currency equal the stored row; otherwise the event is
   * recorded without the paid patch and `webhook.settlement-mismatch` is
   * logged. Absent = the 0.1.14 behaviour (PayPal today).
   */
  settlement?: PaymentSettlement;
}

/**
 * The minimal storage-derived data this handler can resolve WITHOUT any
 * config access — siteId/formId come from the payment's anchor entry
 * (`storage.getEntryById`), never a config lookup. "sendPaymentReceivedEmail
 * -shaped": the caller's bound `notify` dep resolves the config-dependent
 * notifyTo (`config.forms[formId]?.notifyTo`), the `templates.paymentReceived`
 * override (W3), and the entryUrl before ultimately calling the real
 * `sendPaymentReceivedEmail` — this handler stays framework/config-free.
 */
export interface PaymentReceivedNotifyData {
  siteId: string;
  formId: string;
  entryId: string;
  provider: PaymentProvider;
  amountCents?: number;
  currency?: string;
}

export interface HandleInboundPaymentDeps {
  storage: StorageAdapter;
  /**
   * sendPaymentReceivedEmail-shaped fn (W3) — fire-and-forget, never
   * awaited before this handler returns; a rejection is caught + logged
   * here, never propagated (mirrors handle-abandon.ts's own `deps.notify`
   * contract).
   */
  notify: (data: PaymentReceivedNotifyData) => Promise<unknown>;
  /**
   * deliverWebhook-shaped fn (HOOK-01) — same generic `(type, data) => void`
   * signature as webhooks/deliver.ts's `deliverWebhook`, reference-pass-
   * through-able from a route. Optional (mirrors handle-abandon.ts's own
   * `deps.deliverWebhook?`) so a caller with no outbound-webhook seam
   * configured never needs to pass a no-op stub.
   */
  deliver?: (type: WebhookEventType, data: unknown) => void;
  /** Structured logger for reject/no-op branches — injectable, spy in tests. */
  log: Logger;
  now?: () => number;
}

export interface HandleInboundPaymentResult {
  status: number;
}

export async function handleInboundPayment(
  input: HandleInboundPaymentInput,
  deps: HandleInboundPaymentDeps,
): Promise<HandleInboundPaymentResult> {
  const now = deps.now ? deps.now() : Date.now();

  let payment: Payment | undefined;
  try {
    payment = await deps.storage.getPaymentByProviderRef(input.providerRef);
    if (!payment && input.alternateProviderRef) {
      payment = await deps.storage.getPaymentByProviderRef(input.alternateProviderRef);
    }
  } catch (err) {
    logError('webhook.lookup-failed', err, { providerRef: input.providerRef, provider: input.provider });
    return { status: 500 };
  }

  if (!payment) {
    // Nothing to flip — ack so the provider stops retrying (e.g. a webhook
    // for a session/order this install never created, or one already
    // purged by GDPR erasure). Never a 4xx here: the signature already
    // verified successfully in the calling route.
    deps.log('webhook.unknown-ref', {
      providerRef: input.providerRef,
      ...(input.alternateProviderRef ? { alternateProviderRef: input.alternateProviderRef } : {}),
      provider: input.provider,
    });
    return { status: 200 };
  }
  const paymentId = payment.id;
  const entryId = payment.entryId;

  const isCompletedEvent = COMPLETED_EVENT_TYPES.has(input.eventType);
  const event: PaymentEvent = { id: input.eventId, type: input.eventType, at: now };

  // 0.1.15: judged BEFORE the atomic append so the paid patch is only ever
  // part of the same transaction when the provider's own facts match the
  // stored row. A mismatched completion is still recorded (audit trail,
  // and the same dedupe gate for its retries), just never as paid.
  const verdict: SettlementVerdict =
    isCompletedEvent && input.settlement ? judgeSettlement(payment, input.settlement) : { ok: true };
  const marksPaid = isCompletedEvent && verdict.ok;

  // The checker-W1 atomic primitive: ONE transaction does the duplicate
  // check, the event append, AND the optional paid-status patch. This
  // handler performs NO separate read-check-write against payment.events —
  // see the "no manual events[] read-check-write" test in this module's
  // suite.
  let appended: boolean;
  try {
    appended = await deps.storage.appendPaymentEventIfAbsent(
      paymentId,
      input.eventId,
      event,
      marksPaid ? { status: 'paid' } : undefined,
    );
  } catch (err) {
    logError('webhook.append-event-failed', err, { paymentId, eventId: input.eventId });
    return { status: 500 };
  }

  if (!appended) {
    // Duplicate delivery — the atomic primitive made ZERO writes. ACK,
    // zero further side effects: no re-notify, no re-deliver, no entry flip.
    deps.log('webhook.duplicate-event', { paymentId, eventId: input.eventId });
    return { status: 200 };
  }

  if (!verdict.ok) {
    // A completed event whose provider facts do not match the stored row
    // (unpaid, or a different amount/currency). Appended above WITHOUT the
    // paid patch; no email, no outbound webhook, no entry flip. 200 so the
    // provider does not retry: a retry carries the same facts.
    deps.log('webhook.settlement-mismatch', {
      reason: verdict.reason,
      paymentId,
      eventId: input.eventId,
      eventType: input.eventType,
      provider: input.provider,
      expected: { amountCents: payment.amountCents, currency: payment.currency },
      received: {
        paid: input.settlement?.paid,
        amountCents: input.settlement?.amountCents ?? null,
        currency: input.settlement?.currency ?? null,
      },
    });
    return { status: 200 };
  }

  if (!isCompletedEvent) {
    // e.g. a refund event — appended above WITHOUT a status patch; no
    // notify, no outbound deliver (only a real paid transition notifies).
    deps.log('webhook.event-appended', { paymentId, eventId: input.eventId, eventType: input.eventType });
    return { status: 200 };
  }

  // Real paid transition. Flip the anchor entry (unless it's already
  // terminal), then fire-and-forget notify + the outbound payment.paid
  // webhook. A failure resolving/flipping the entry is logged but never
  // blocks notify/deliver — the payment row's paid status is already
  // durably committed by the atomic call above.
  let entry: Entry | undefined;
  try {
    entry = await deps.storage.getEntryById(entryId);
    if (entry && !TERMINAL_ENTRY_STATUSES.has(entry.status)) {
      await deps.storage.updateEntry(entry.id, { status: 'submitted' });
    }
  } catch (err) {
    logError('webhook.entry-flip-failed', err, { paymentId, entryId });
  }

  const siteId = entry?.siteId ?? '';
  const formId = entry?.formId ?? '';
  const amountCents = input.amountCents ?? payment.amountCents;
  const currency = input.currency ?? payment.currency;

  deps
    .notify({ siteId, formId, entryId, provider: input.provider, amountCents, currency })
    .catch((err: unknown) => {
      logError('webhook.notify-failed', err, { paymentId });
    });

  deps.deliver?.('payment.paid', {
    id: paymentId,
    entryId,
    siteId,
    formId,
    provider: input.provider,
    amountCents,
    currency,
    status: 'paid',
  });

  return { status: 200 };
}
