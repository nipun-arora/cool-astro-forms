/**
 * Who gets the "payment received" email (0.1.18). The bug this pins: a
 * payment made on /forms-pay (or through POST /api/forms/pay/create-session
 * from a host's own /secure page) is anchored on a `_payment_request` entry,
 * and up to 0.1.17 both webhook routes looked the owner's address up only as
 * `config.forms[formId].notifyTo`. No host registers a `_payment_request`
 * form, so a live site's main payment flow sent the owner nothing, and
 * nothing was logged. Order now: the row's own form (a host-registered
 * `_payment_request` form counts), then `payments.notifyTo`, then the first
 * configured form's notifyTo; when none resolves, the skip is logged.
 */
import { describe, expect, it, vi } from 'vitest';
import { PAYMENT_REQUEST_FORM_ID } from '../payment-constants.js';
import type { PaymentReceivedNotifyData } from './handle-inbound.js';
import { createPaymentReceivedNotifier, resolvePaymentNotifyTo } from './payment-notify.js';

const form = (notifyTo: string) => ({ notifyTo });

describe('resolvePaymentNotifyTo', () => {
  it('a pay-page payment (no _payment_request form) goes to payments.notifyTo', () => {
    const config = { forms: { contact: form('contact@example.com') }, payments: { notifyTo: 'billing@example.com' } };
    expect(resolvePaymentNotifyTo(config, PAYMENT_REQUEST_FORM_ID)).toEqual({
      notifyTo: 'billing@example.com',
      source: 'payments',
    });
  });

  it('a pay-page payment on a config without payments.notifyTo goes to the FIRST configured form, in config order', () => {
    const config = { forms: { booking: form('desk@example.com'), contact: form('contact@example.com') }, payments: {} };
    expect(resolvePaymentNotifyTo(config, PAYMENT_REQUEST_FORM_ID)).toEqual({
      notifyTo: 'desk@example.com',
      source: 'first-form',
    });
  });

  it('a host that registered a _payment_request form keeps getting it: the explicit form wins over payments.notifyTo', () => {
    const config = {
      forms: { contact: form('contact@example.com'), [PAYMENT_REQUEST_FORM_ID]: form('payments-form@example.com') },
      payments: { notifyTo: 'billing@example.com' },
    };
    expect(resolvePaymentNotifyTo(config, PAYMENT_REQUEST_FORM_ID)).toEqual({
      notifyTo: 'payments-form@example.com',
      source: 'form',
    });
  });

  it("a payment on a configured form's entry goes to that form, never to payments.notifyTo", () => {
    const config = {
      forms: { contact: form('contact@example.com'), booking: form('desk@example.com') },
      payments: { notifyTo: 'billing@example.com' },
    };
    expect(resolvePaymentNotifyTo(config, 'booking')).toEqual({ notifyTo: 'desk@example.com', source: 'form' });
  });

  it('a row whose form is no longer configured (renamed or removed) falls back to payments.notifyTo, then the first form', () => {
    expect(
      resolvePaymentNotifyTo(
        { forms: { contact: form('contact@example.com') }, payments: { notifyTo: 'billing@example.com' } },
        'old-form',
      ),
    ).toEqual({ notifyTo: 'billing@example.com', source: 'payments' });
    expect(resolvePaymentNotifyTo({ forms: { contact: form('contact@example.com') } }, 'old-form')).toEqual({
      notifyTo: 'contact@example.com',
      source: 'first-form',
    });
  });

  it("an anchor entry the handler could not read (formId '') still reaches the owner through the fallbacks", () => {
    expect(resolvePaymentNotifyTo({ forms: { contact: form('contact@example.com') } }, '')).toEqual({
      notifyTo: 'contact@example.com',
      source: 'first-form',
    });
  });

  // The anchor entry's formId is whatever the host's form posted, so an
  // Object.prototype key must never be read as a configured form.
  it('never treats an inherited object key (constructor, __proto__, toString) as a configured form', () => {
    const config = { forms: { contact: form('contact@example.com') }, payments: { notifyTo: 'billing@example.com' } };
    for (const formId of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(resolvePaymentNotifyTo(config, formId)).toEqual({ notifyTo: 'billing@example.com', source: 'payments' });
    }
  });

  it('resolves nothing when no form is configured and payments.notifyTo is unset', () => {
    expect(resolvePaymentNotifyTo({ forms: {}, payments: {} }, PAYMENT_REQUEST_FORM_ID)).toBeUndefined();
    expect(resolvePaymentNotifyTo({ forms: {} }, 'contact')).toBeUndefined();
  });
});

describe('createPaymentReceivedNotifier', () => {
  const data = (overrides: Partial<PaymentReceivedNotifyData> = {}): PaymentReceivedNotifyData => ({
    siteId: 'demo-site',
    formId: PAYMENT_REQUEST_FORM_ID,
    entryId: 'entry-9',
    provider: 'stripe',
    amountCents: 2500,
    currency: 'usd',
    ...overrides,
  });

  function setup(config: Parameters<typeof createPaymentReceivedNotifier>[0]['config']) {
    const send = vi.fn(async () => undefined);
    const log = vi.fn();
    const notify = createPaymentReceivedNotifier({ config, send, log });
    return { send, log, notify };
  }

  it('emails the resolved owner address with the admin entry link and the paymentReceived template override', async () => {
    const template = vi.fn();
    const { send, log, notify } = setup({
      siteUrl: 'https://example.com',
      trailingSlash: 'always',
      templates: { paymentReceived: template },
      forms: { contact: form('contact@example.com') },
      payments: { notifyTo: 'billing@example.com' },
    });

    await notify(data());

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      {
        siteId: 'demo-site',
        formId: PAYMENT_REQUEST_FORM_ID,
        notifyTo: 'billing@example.com',
        amountCents: 2500,
        currency: 'usd',
        provider: 'stripe',
        entryUrl: 'https://example.com/forms-admin/entries/entry-9/',
      },
      { template },
    );
    expect(log).not.toHaveBeenCalled();
  });

  it('defaults a missing amount/currency the same way as before (0, usd) and passes no template when none is configured', async () => {
    const { send, notify } = setup({ siteUrl: 'https://example.com', forms: { contact: form('contact@example.com') } });

    await notify(data({ amountCents: undefined, currency: undefined, provider: 'paypal' }));

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ notifyTo: 'contact@example.com', amountCents: 0, currency: 'usd', provider: 'paypal' }),
      { template: undefined },
    );
  });

  it('when no address resolves: sends nothing, never throws, and logs payment.notify-skipped with the reason only', async () => {
    const { send, log, notify } = setup({ siteUrl: 'https://example.com', forms: {}, payments: {} });

    await expect(notify(data())).resolves.toBeUndefined();

    expect(send).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('payment.notify-skipped', { reason: 'no-notify-to' });
  });
});
