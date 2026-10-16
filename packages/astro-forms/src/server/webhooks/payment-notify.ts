/**
 * Who receives the "payment received" email (0.1.18) — one resolver and one
 * notify dep shared by BOTH inbound payment webhooks
 * (routes/webhooks/stripe.ts, routes/webhooks/paypal.ts), so the two can
 * never disagree about where a payment is announced.
 *
 * The bug this closes: up to 0.1.17 each route resolved the owner's address
 * only as `config.forms[formId].notifyTo` and silently returned when that was
 * missing. A payment made on `/forms-pay`, or posted to
 * `/api/forms/pay/create-session` from a host's own pay page, is anchored on
 * a `_payment_request` entry (payments/payment-request.ts), which no host
 * registers as a form, so a live site's main payment flow emailed the owner
 * nothing and logged nothing.
 *
 * Resolution order (`resolvePaymentNotifyTo`):
 *  1. the `notifyTo` of the form the payment's anchor entry belongs to. A
 *     host that registered a `_payment_request` form keeps getting it, and a
 *     payment on a real form's entry always goes to that form's owner;
 *  2. `payments.notifyTo` (config.ts), used for `_payment_request` rows and
 *     for any row whose form is not configured (renamed, removed, or an
 *     anchor entry the handler could not read, which arrives as formId '');
 *  3. the `notifyTo` of the FIRST form in `config.forms`, in config order.
 * When none resolves, nothing is sent and `payment.notify-skipped` is logged
 * with the reason only: no address, amount, entry or payer data.
 *
 * Framework-free: the routes pass the virtual config, the real
 * `sendPaymentReceivedEmail` and `log` in; tests inject spies.
 *
 * Clean-room: written fresh for this package, not derived from any
 * commercial form-plugin source.
 */
import { adminUrl } from '../admin/_shared.js';
import type { PaymentReceivedEmailData, PaymentReceivedTemplateFn } from '../notify.js';
import type { Logger, PaymentReceivedNotifyData } from './handle-inbound.js';

/** Which rule produced the address (for tests and callers that want to say why). */
export type PaymentNotifyToSource = 'form' | 'payments' | 'first-form';

export interface ResolvedPaymentNotifyTo {
  notifyTo: string;
  source: PaymentNotifyToSource;
}

/**
 * The slice of the parsed config the resolver reads. Structural, so the
 * routes pass the virtual config as-is and tests pass plain objects.
 */
export interface PaymentNotifyToConfig {
  forms?: Record<string, { notifyTo?: string } | undefined>;
  payments?: { notifyTo?: string };
}

/**
 * The owner address for a payment whose anchor entry has `formId`, by the
 * order in this module's doc comment. `formId` comes from stored entry data
 * the host's form posted, so only an OWN key of `config.forms` counts as a
 * configured form: `constructor` or `__proto__` never resolve to an
 * inherited property.
 */
export function resolvePaymentNotifyTo(
  config: PaymentNotifyToConfig,
  formId: string,
): ResolvedPaymentNotifyTo | undefined {
  const forms = config.forms ?? {};

  if (formId && Object.hasOwn(forms, formId)) {
    const own = forms[formId]?.notifyTo;
    if (own) return { notifyTo: own, source: 'form' };
  }

  const paymentsNotifyTo = config.payments?.notifyTo;
  if (paymentsNotifyTo) return { notifyTo: paymentsNotifyTo, source: 'payments' };

  for (const form of Object.values(forms)) {
    if (form?.notifyTo) return { notifyTo: form.notifyTo, source: 'first-form' };
  }

  return undefined;
}

export interface PaymentReceivedNotifierOptions {
  /** The virtual config: forms/payments for the address, siteUrl + trailingSlash for the admin link, templates for the override (W3). */
  config: PaymentNotifyToConfig & {
    siteUrl: string;
    trailingSlash?: 'always' | 'never' | 'ignore';
    templates?: { paymentReceived?: PaymentReceivedTemplateFn };
  };
  /** `sendPaymentReceivedEmail`-shaped (server/notify.ts). */
  send: (data: PaymentReceivedEmailData, opts: { template?: PaymentReceivedTemplateFn }) => Promise<unknown>;
  log: Logger;
}

/**
 * Builds the `notify` dep `handleInboundPayment` calls once per real paid
 * transition (fire-and-forget; the handler catches and logs a rejection).
 * Resolves the owner address, the admin entry URL and the template override,
 * then sends. Resolves undefined without sending when no address resolves.
 */
export function createPaymentReceivedNotifier(
  options: PaymentReceivedNotifierOptions,
): (data: PaymentReceivedNotifyData) => Promise<unknown> {
  const { config, send, log } = options;
  return (data: PaymentReceivedNotifyData) => {
    const resolved = resolvePaymentNotifyTo(config, data.formId);
    if (!resolved) {
      log('payment.notify-skipped', { reason: 'no-notify-to' });
      return Promise.resolve(undefined);
    }
    return send(
      {
        siteId: data.siteId,
        formId: data.formId,
        notifyTo: resolved.notifyTo,
        amountCents: data.amountCents ?? 0,
        currency: data.currency ?? 'usd',
        provider: data.provider,
        entryUrl: `${config.siteUrl}${adminUrl(`/forms-admin/entries/${data.entryId}`, config.trailingSlash)}`,
      },
      { template: config.templates?.paymentReceived },
    );
  };
}
