/**
 * handlePaypalReturn (0.1.18) — the server-side capture behind
 * GET /forms-pay/paypal-return, as a framework-free function (the
 * payment-request.ts / handle-abandon.ts pattern). `pay/paypal-return.astro`
 * is the thin page around it.
 *
 * The bug it closes: the package created PayPal orders with `intent:
 * CAPTURE` and never captured them once the buyer approved, so no money
 * moved and PAYMENT.CAPTURE.COMPLETED never fired. PayPal sends the buyer
 * back to the order's `return_url` with `?token=<order id>&PayerID=…`; this
 * handler captures that order there.
 *
 * What it guarantees, in order:
 *  1. Only an order this install created is captured: the token must be
 *     shaped like a PayPal order id AND match a stored PayPal payments row
 *     (`providerRef`) whose status is `link_created`. An id from the query
 *     string is never sent to PayPal on trust.
 *  2. A reload or double hit cannot capture twice, and a retry is not a
 *     replay: `captureOrder` sends a fresh `PayPal-Request-Id` per attempt
 *     (a reused id would replay a stored INSTRUMENT_DECLINED or
 *     ORDER_NOT_APPROVED after the payer fixed it in PayPal). PayPal allows
 *     one capture per CAPTURE-intent order, so a second attempt is answered
 *     `ORDER_ALREADY_CAPTURED`, read here as "already done", and
 *     `PREVIOUS_REQUEST_IN_PROGRESS` as "still processing".
 *  3. Nothing is written. The verified PAYMENT.CAPTURE.COMPLETED webhook
 *     (routes/webhooks/paypal.ts, matched through
 *     `resource.supplementary_data.related_ids.order_id`) stays the single
 *     writer of `paid`; a row it already marked paid is reported as received
 *     without a second capture.
 *  4. The payer is told what happened: `captured`, `pending`, `declined` /
 *     `needs-approval` (with the stored approval URL, so they can go back to
 *     PayPal: PayPal's documented handling for INSTRUMENT_DECLINED and
 *     ORDER_NOT_APPROVED), or a generic `error` / `unknown-order`.
 *
 * Logs carry the payment id, the outcome, PayPal's issue code, HTTP status
 * and debug id: never the token of an unknown order, never payer data
 * (captureOrder never hands the response body back).
 *
 * Unverified against live PayPal (sandbox drill pending): that a fresh-id
 * capture after INSTRUMENT_DECLINED and a re-approval goes through, and what
 * PayPal answers the losing request when two hits capture at the same moment
 * under different ids (anything other than ORDER_ALREADY_CAPTURED or
 * PREVIOUS_REQUEST_IN_PROGRESS shows that tab the generic error, while the
 * order is still captured once). The declined copy also tells the payer to
 * ask for a new link if the retry fails.
 *
 * Clean-room: written against developer.paypal.com (Orders v2 capture, its
 * error list, the idempotency reference and the funding-failure guide,
 * fetched 2026-10-16), not derived from any commercial form-plugin source.
 */
import type { Payment } from '../../types.js';
import { logError } from '../log.js';
import type { StorageAdapter } from '../storage/adapter.js';
import { isPaypalOrderId, type CaptureOrderResult } from './paypal.js';

/** Matches src/server/log.ts's `log()` signature (handle-abandon.ts precedent). */
export type Logger = (event: string, data?: Record<string, unknown>) => void;

export type PaypalReturnOutcome =
  /** Captured now, captured earlier (ORDER_ALREADY_CAPTURED), or already marked paid by the webhook. */
  | 'captured'
  /** PayPal holds the capture as PENDING, or another request for the same order is capturing right now. */
  | 'pending'
  /** The payer's funding source was declined; `retryUrl` (when present) lets them choose another in PayPal. */
  | 'declined'
  /** PayPal needs the payer back (order not approved yet, or payer action required); `retryUrl` when present. */
  | 'needs-approval'
  /** No usable token, or no stored PayPal row for it. Nothing was sent to PayPal. */
  | 'unknown-order'
  /** Anything else: storage or network failure, an expired or voided order, an unexpected answer. */
  | 'error';

export interface PaypalReturnResult {
  outcome: PaypalReturnOutcome;
  /** The order's stored approval URL (https only), for `declined` / `needs-approval`. */
  retryUrl?: string;
  /** The order id, once it is known to be shaped like one: safe to show as the payer's reference. */
  reference?: string;
}

export interface HandlePaypalReturnDeps {
  /** Read only: the handler never calls a write method. */
  storage: Pick<StorageAdapter, 'getPaymentByProviderRef'>;
  /** `captureOrder`-shaped (payments/paypal.ts); injected so tests never reach PayPal. */
  capture: (orderId: string) => Promise<CaptureOrderResult>;
  log: Logger;
}

/** PayPal issues meaning "the payer must pick another funding source" (Orders v2 capture errors, funding-failure guide). */
const DECLINED_ISSUES: ReadonlySet<string> = new Set(['INSTRUMENT_DECLINED', 'REDIRECT_PAYER_FOR_ALTERNATE_FUNDING']);

/** PayPal issues meaning "send the payer back to PayPal to approve / act". */
const NEEDS_APPROVAL_ISSUES: ReadonlySet<string> = new Set(['ORDER_NOT_APPROVED', 'PAYER_ACTION_REQUIRED']);

/** The stored approval URL, only when it is an https URL (it came from PayPal's create-order answer). */
function retryUrlOf(payment: Payment): string | undefined {
  const url = payment.payLinkUrl;
  if (typeof url !== 'string') return undefined;
  try {
    return new URL(url).protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

/** Maps PayPal's answer to what the payer is told. Pure. */
function judgeCapture(result: CaptureOrderResult): Exclude<PaypalReturnOutcome, 'unknown-order'> {
  if (result.ok) {
    switch (result.captureStatus) {
      case 'COMPLETED':
        return 'captured';
      case 'PENDING':
        return 'pending';
      case 'DECLINED':
      case 'FAILED':
        return 'declined';
      default:
        // A minimal answer without the capture: a COMPLETED order is captured.
        return result.captureStatus === undefined && result.orderStatus === 'COMPLETED' ? 'captured' : 'error';
    }
  }
  const issue = result.issue ?? '';
  if (issue === 'ORDER_ALREADY_CAPTURED') return 'captured';
  if (issue === 'PREVIOUS_REQUEST_IN_PROGRESS') return 'pending';
  if (DECLINED_ISSUES.has(issue)) return 'declined';
  if (NEEDS_APPROVAL_ISSUES.has(issue)) return 'needs-approval';
  return 'error';
}

export async function handlePaypalReturn(
  input: { token: string | null | undefined },
  deps: HandlePaypalReturnDeps,
): Promise<PaypalReturnResult> {
  const token = input.token;
  if (!isPaypalOrderId(token)) {
    deps.log('paypal-return.ignored', { reason: 'invalid-token' });
    return { outcome: 'unknown-order' };
  }

  let payment: Payment | undefined;
  try {
    payment = await deps.storage.getPaymentByProviderRef(token);
  } catch (err) {
    logError('paypal-return.lookup-failed', err);
    return { outcome: 'error', reference: token };
  }

  if (!payment || payment.provider !== 'paypal') {
    deps.log('paypal-return.ignored', { reason: 'unknown-order' });
    return { outcome: 'unknown-order' };
  }

  if (payment.status === 'paid') {
    // The webhook got here first: nothing to capture, nothing to write.
    deps.log('paypal-return.already-paid', { paymentId: payment.id });
    return { outcome: 'captured', reference: token };
  }

  if (payment.status !== 'link_created') {
    deps.log('paypal-return.ignored', { reason: 'status', paymentId: payment.id, status: payment.status });
    return { outcome: 'error', reference: token };
  }

  const result = await deps.capture(token);
  const outcome = judgeCapture(result);

  deps.log('paypal-return.capture', {
    paymentId: payment.id,
    outcome,
    ...(!result.ok && result.httpStatus !== undefined ? { httpStatus: result.httpStatus } : {}),
    ...(!result.ok && result.issue ? { issue: result.issue } : {}),
    ...(!result.ok && result.debugId ? { debugId: result.debugId } : {}),
    ...(result.ok && result.captureStatus ? { captureStatus: result.captureStatus } : {}),
  });

  // Only PayPal's restartable answers get the way back; a capture that came
  // back DECLINED inside a 2xx has spent the order.
  const offerRetry = !result.ok && (outcome === 'declined' || outcome === 'needs-approval');
  const retryUrl = offerRetry ? retryUrlOf(payment) : undefined;

  return { outcome, ...(retryUrl ? { retryUrl } : {}), reference: token };
}
