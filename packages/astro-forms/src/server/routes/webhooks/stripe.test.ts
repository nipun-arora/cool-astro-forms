import Stripe from 'stripe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_WEBHOOK_PAYLOAD_BYTES } from '../../payment-constants.js';

const { handleInboundPaymentMock, sendPaymentReceivedEmailMock, sqliteStorageMock, deliverWebhookMock, stripeClientHolder } = vi.hoisted(
  () => ({
    handleInboundPaymentMock: vi.fn(
      async (_input: unknown, _deps: unknown): Promise<{ status: number; markedPaid?: boolean }> => ({ status: 200 }),
    ),
    sendPaymentReceivedEmailMock: vi.fn(async () => undefined),
    sqliteStorageMock: vi.fn(function FakeSqliteStorage() {
      return {};
    }),
    deliverWebhookMock: vi.fn(),
    /** The client `getStripeClient` hands the route (a real Stripe instance whose `customers.update` is a spy). */
    stripeClientHolder: { current: undefined as unknown },
  }),
);

vi.mock('virtual:cool-astro-forms/config', () => ({
  default: {
    siteId: 'demo-site',
    siteUrl: 'https://example.com',
    forms: {
      'contact-form': {
        abandonment: { require: 'email-or-phone', dedupeWindowMins: 60, notifyOnUpdate: false },
        notifyTo: 'owner@example.com',
      },
    },
    requireConsent: false,
    journeyParams: false,
    retentionDays: 90,
    dbPath: 'data/forms.db',
    geo: { enabled: false, providerUrl: 'https://ipwho.is/{ip}', timeoutMs: 3000 },
    admin: { sessionTtlDays: 7 },
    payments: {
      payLinkFees: [],
      requestPage: { minAmountCents: 100, maxAmountCents: 1_000_000, allowedCurrencies: ['usd'] },
    },
    webhooks: [],
    trailingSlash: 'never',
  },
}));
vi.mock('../../webhooks/handle-inbound.js', () => ({ handleInboundPayment: handleInboundPaymentMock }));
vi.mock('../../notify.js', () => ({ sendPaymentReceivedEmail: sendPaymentReceivedEmailMock }));
vi.mock('../../storage/db.js', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('../../storage/sqlite.js', () => ({ SqliteStorage: sqliteStorageMock }));
vi.mock('../../webhooks/deliver.js', () => ({ deliverWebhook: deliverWebhookMock }));
vi.mock('../../log.js', () => ({ log: vi.fn(), logError: vi.fn() }));
// Only the client factory is replaced: verifyStripeWebhook stays real, and
// the client the route gets verifies signatures for real (pure crypto) while
// its customers.update is a spy, so no test reaches Stripe's network.
vi.mock('../../payments/stripe.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../payments/stripe.js')>()),
  getStripeClient: vi.fn(() => (process.env.STRIPE_SECRET_KEY ? stripeClientHolder.current : undefined)),
}));

import { log, logError } from '../../log.js';
import { getStripeClient } from '../../payments/stripe.js';
import { POST } from './stripe.js';

// verifyStripeWebhook itself is NEVER mocked — real (network-free) signature
// verification via generateTestHeaderString, exactly like payments/stripe.test.ts's
// own precedent (constructEvent/generateTestHeaderString are pure crypto).

const ORIGINAL_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const ORIGINAL_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const WEBHOOK_SECRET = 'whsec_test_secret';

function makeCtx(body: string, headers: Record<string, string> = {}): Parameters<typeof POST>[0] {
  const request = new Request('https://example.com/api/forms/webhooks/stripe', {
    method: 'POST',
    headers,
    body,
  });
  return { request } as unknown as Parameters<typeof POST>[0];
}

describe('POST /api/forms/webhooks/stripe', () => {
  beforeEach(() => {
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    handleInboundPaymentMock.mockClear();
    handleInboundPaymentMock.mockResolvedValue({ status: 200 });
    sendPaymentReceivedEmailMock.mockClear();
    deliverWebhookMock.mockClear();
    sqliteStorageMock.mockClear();
    sqliteStorageMock.mockImplementation(function FakeSqliteStorage() {
      return {};
    });
    const stripeClient = new Stripe('sk_test_dummy');
    vi.spyOn(stripeClient.customers, 'update').mockResolvedValue({ id: 'cus_x' } as Stripe.Response<Stripe.Customer>);
    stripeClientHolder.current = stripeClient;
    vi.mocked(getStripeClient).mockClear();
    vi.mocked(log).mockClear();
    vi.mocked(logError).mockClear();
  });

  /** The spy standing in for Stripe's customers.update on the route's client. */
  const customersUpdate = () => vi.mocked((stripeClientHolder.current as Stripe).customers.update);

  afterEach(() => {
    if (ORIGINAL_WEBHOOK_SECRET === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = ORIGINAL_WEBHOOK_SECRET;
    if (ORIGINAL_SECRET_KEY === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = ORIGINAL_SECRET_KEY;
  });

  it('PAY-04: returns 404 when STRIPE_WEBHOOK_SECRET is unset, and never calls handleInboundPayment', async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const res = await POST(makeCtx('{}'));
    expect(res.status).toBe(404);
    expect(handleInboundPaymentMock).not.toHaveBeenCalled();
  });

  // 0.1.15: this exact-shape expectation gained `settlement` (and the payload
  // its `payment_status`). Up to 0.1.14 it pinned a handler input carrying
  // no provider-confirmed settlement facts, which is the gap being closed:
  // the handler had nothing to compare with the stored row.
  it('a validly-signed checkout.session.completed event resolves 200 and invokes handleInboundPayment with session.id and the settlement facts', async () => {
    const client = new Stripe('sk_test_dummy');
    const payload = JSON.stringify({
      id: 'evt_test_1',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_1', amount_total: 2500, currency: 'usd', payment_status: 'paid' } },
    });
    const signature = client.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });

    const res = await POST(makeCtx(payload, { 'stripe-signature': signature }));

    expect(res.status).toBe(200);
    expect(handleInboundPaymentMock).toHaveBeenCalledTimes(1);
    const [input] = handleInboundPaymentMock.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(input).toEqual({
      providerRef: 'cs_test_1',
      eventId: 'evt_test_1',
      eventType: 'checkout.session.completed',
      provider: 'stripe',
      amountCents: 2500,
      currency: 'usd',
      settlement: { paid: true, amountCents: 2500, currency: 'usd' },
    });
  });

  it('passes paid:false for a session whose payment_status is not "paid" (a delayed method completes unpaid)', async () => {
    const client = new Stripe('sk_test_dummy');
    const payload = JSON.stringify({
      id: 'evt_unpaid',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_unpaid', amount_total: 2500, currency: 'usd', payment_status: 'unpaid' } },
    });
    const signature = client.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });

    await POST(makeCtx(payload, { 'stripe-signature': signature }));

    const [input] = handleInboundPaymentMock.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(input.settlement).toEqual({ paid: false, amountCents: 2500, currency: 'usd' });
  });

  it('F1: forwards session.payment_link as alternateProviderRef, so a payment made through an admin Payment Link (row keyed plink_…) is found', async () => {
    const client = new Stripe('sk_test_dummy');
    const payload = JSON.stringify({
      id: 'evt_plink',
      type: 'checkout.session.completed',
      data: {
        object: { id: 'cs_plink', payment_link: 'plink_abc', amount_total: 2000, currency: 'usd', payment_status: 'paid' },
      },
    });
    const signature = client.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });

    await POST(makeCtx(payload, { 'stripe-signature': signature }));

    const [input] = handleInboundPaymentMock.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(input).toMatchObject({ providerRef: 'cs_plink', alternateProviderRef: 'plink_abc' });
  });

  it('compares in the integration currency when Stripe converted the presentment currency (currency_conversion source values)', async () => {
    const client = new Stripe('sk_test_dummy');
    const payload = JSON.stringify({
      id: 'evt_fx',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_fx',
          amount_total: 68100,
          currency: 'usd',
          payment_status: 'paid',
          currency_conversion: { amount_total: 250000, amount_subtotal: 250000, source_currency: 'aed', fx_rate: '0.2724' },
        },
      },
    });
    const signature = client.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });

    await POST(makeCtx(payload, { 'stripe-signature': signature }));

    const [input] = handleInboundPaymentMock.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(input).toMatchObject({
      amountCents: 250000,
      currency: 'aed',
      settlement: { paid: true, amountCents: 250000, currency: 'aed' },
    });
  });

  it('handles checkout.session.async_payment_succeeded (a delayed method settling later) like a completion', async () => {
    const client = new Stripe('sk_test_dummy');
    const payload = JSON.stringify({
      id: 'evt_async',
      type: 'checkout.session.async_payment_succeeded',
      data: { object: { id: 'cs_async', amount_total: 2500, currency: 'usd', payment_status: 'paid' } },
    });
    const signature = client.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });

    const res = await POST(makeCtx(payload, { 'stripe-signature': signature }));

    expect(res.status).toBe(200);
    const [input] = handleInboundPaymentMock.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(input).toMatchObject({ providerRef: 'cs_async', eventType: 'checkout.session.async_payment_succeeded' });
  });

  // 0.1.17: the route reads the Stripe Customer and the payer email off the
  // VERIFIED session and hands them to the handler, which writes them only on
  // a real paid transition. These pin the extraction, not the write.
  describe('payer data (0.1.17)', () => {
    async function postSession(session: Record<string, unknown>, extra: Record<string, unknown> = {}) {
      const client = new Stripe('sk_test_dummy');
      const payload = JSON.stringify({
        id: 'evt_payer',
        type: 'checkout.session.completed',
        ...extra,
        data: { object: { id: 'cs_payer', amount_total: 2500, currency: 'usd', payment_status: 'paid', ...session } },
      });
      const signature = client.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
      const res = await POST(makeCtx(payload, { 'stripe-signature': signature }));
      const [input] = handleInboundPaymentMock.mock.calls[0] as [Record<string, unknown>, unknown];
      return { res, input };
    }

    it('forwards the session customer id and the payer email so a repeat payer can be traced on the payment row', async () => {
      const { res, input } = await postSession({
        customer: 'cus_ABC123',
        customer_details: { email: 'payer@example.com' },
      });
      expect(res.status).toBe(200);
      expect(input).toMatchObject({ customerRef: 'cus_ABC123', payerEmail: 'payer@example.com' });
    });

    it('reads the id off an expanded customer object', async () => {
      const { input } = await postSession({ customer: { id: 'cus_EXPANDED', object: 'customer' } });
      expect(input.customerRef).toBe('cus_EXPANDED');
    });

    it('lowercases and trims the email, so the same payer typing different casing is one payer', async () => {
      const { input } = await postSession({ customer_details: { email: '  Payer@Example.COM ' } });
      expect(input.payerEmail).toBe('payer@example.com');
    });

    it('falls back to customer_email when customer_details has no (or a blank) email', async () => {
      const blank = await postSession({ customer_details: { email: '   ' }, customer_email: 'Prefill@Example.com' });
      expect(blank.input.payerEmail).toBe('prefill@example.com');
    });

    it('prefers the email the payer actually used (customer_details) over the prefilled customer_email', async () => {
      const { input } = await postSession({
        customer_details: { email: 'typed@example.com' },
        customer_email: 'prefill@example.com',
      });
      expect(input.payerEmail).toBe('typed@example.com');
    });

    it('omits both keys for a guest checkout (null customer, no email) instead of sending nulls', async () => {
      const { input } = await postSession({ customer: null, customer_details: null, customer_email: null });
      expect('customerRef' in input).toBe(false);
      expect('payerEmail' in input).toBe(false);
    });

    it('forwards event.livemode so the admin can link the test or live Stripe dashboard', async () => {
      const live = await postSession({}, { livemode: true });
      expect(live.input.livemode).toBe(true);
      handleInboundPaymentMock.mockClear();
      const test = await postSession({}, { livemode: false });
      expect(test.input.livemode).toBe(false);
    });

    it('never logs the payer email or customer id', async () => {
      await postSession({ customer: 'cus_ABC123', customer_details: { email: 'payer@example.com' } });
      const logged = JSON.stringify([
        ...(log as ReturnType<typeof vi.fn>).mock.calls,
        ...(logError as ReturnType<typeof vi.fn>).mock.calls,
      ]);
      expect(logged).not.toContain('payer@example.com');
      expect(logged).not.toContain('cus_ABC123');
    });
  });

  // -------------------------------------------------------------------------
  // 0.1.17 adoption. Checkout never creates or writes a Customer from visitor
  // input: a new payer's session has Stripe create one at confirmation. Once
  // a verified payment has marked the row paid, the route tags that Customer
  // (metadata.source) so the payer's next payment can reuse it. Only a real
  // paid flip by this delivery adopts, and adoption never changes the answer
  // Stripe gets.
  // -------------------------------------------------------------------------
  describe('adopting the paying Customer (0.1.17)', () => {
    async function postPaid(session: Record<string, unknown>, type = 'checkout.session.completed') {
      const payload = JSON.stringify({
        id: 'evt_adopt',
        type,
        data: { object: { id: 'cs_adopt', amount_total: 2500, currency: 'usd', payment_status: 'paid', ...session } },
      });
      const signature = new Stripe('sk_test_dummy').webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
      return POST(makeCtx(payload, { 'stripe-signature': signature }));
    }

    it('tags session.customer with the package source once the handler reports this delivery marked the row paid', async () => {
      handleInboundPaymentMock.mockResolvedValueOnce({ status: 200, markedPaid: true });

      const res = await postPaid({ customer: 'cus_PAYER', customer_details: { email: 'payer@example.com' } });

      expect(res.status).toBe(200);
      expect(customersUpdate()).toHaveBeenCalledTimes(1);
      expect(customersUpdate()).toHaveBeenCalledWith('cus_PAYER', { metadata: { source: 'cool-astro-forms' } });
    });

    it('reads the id off an expanded customer object', async () => {
      handleInboundPaymentMock.mockResolvedValueOnce({ status: 200, markedPaid: true });

      await postPaid({ customer: { id: 'cus_EXPANDED', object: 'customer' } });

      expect(customersUpdate()).toHaveBeenCalledWith('cus_EXPANDED', { metadata: { source: 'cool-astro-forms' } });
    });

    it('verifies and adopts with ONE client for the delivery', async () => {
      handleInboundPaymentMock.mockResolvedValueOnce({ status: 200, markedPaid: true });

      await postPaid({ customer: 'cus_PAYER' });

      expect(getStripeClient).toHaveBeenCalledTimes(1);
    });

    it('also adopts on checkout.session.async_payment_succeeded (a delayed method that settles later)', async () => {
      handleInboundPaymentMock.mockResolvedValueOnce({ status: 200, markedPaid: true });

      await postPaid({ customer: 'cus_ASYNC' }, 'checkout.session.async_payment_succeeded');

      expect(customersUpdate()).toHaveBeenCalledWith('cus_ASYNC', { metadata: { source: 'cool-astro-forms' } });
    });

    // A duplicate delivery, an unpaid session and a session for another
    // amount all reach the handler, which records them without marking the
    // row paid. None of them is a verified payment by this Customer.
    it('adopts nothing when the handler did not mark the row paid (duplicate, unpaid or mismatched session)', async () => {
      handleInboundPaymentMock.mockResolvedValueOnce({ status: 200, markedPaid: false });

      const res = await postPaid({ customer: 'cus_NOT_PAID', payment_status: 'unpaid' });

      expect(res.status).toBe(200);
      expect(customersUpdate()).not.toHaveBeenCalled();
    });

    it('adopts nothing when the handler failed (500), and the 500 still reaches Stripe so it retries', async () => {
      handleInboundPaymentMock.mockResolvedValueOnce({ status: 500, markedPaid: false });

      const res = await postPaid({ customer: 'cus_PAYER' });

      expect(res.status).toBe(500);
      expect(customersUpdate()).not.toHaveBeenCalled();
    });

    it('adopts nothing for a guest checkout (no customer on the session)', async () => {
      handleInboundPaymentMock.mockResolvedValueOnce({ status: 200, markedPaid: true });

      await postPaid({ customer: null });

      expect(customersUpdate()).not.toHaveBeenCalled();
    });

    it('a failed adoption never changes the answer: still 200, logged as stripe.customer-adopt-failed without the customer id or email', async () => {
      handleInboundPaymentMock.mockResolvedValueOnce({ status: 200, markedPaid: true });
      customersUpdate().mockRejectedValueOnce(
        Object.assign(new Error('No such customer: cus_GONE (payer@example.com)'), {
          type: 'StripeInvalidRequestError',
          statusCode: 404,
        }),
      );

      const res = await postPaid({ customer: 'cus_GONE', customer_details: { email: 'payer@example.com' } });

      expect(res.status).toBe(200);
      expect(logError).toHaveBeenCalledWith('stripe.customer-adopt-failed', expect.any(Error), {
        eventId: 'evt_adopt',
        statusCode: 404,
      });
      const logged = JSON.stringify(
        [...vi.mocked(log).mock.calls, ...vi.mocked(logError).mock.calls],
        (_key, value: unknown) => (value instanceof Error ? { message: value.message } : value),
      );
      expect(logged).not.toContain('cus_GONE');
      expect(logged).not.toContain('payer@example.com');
    });

    it('a non-settling event type never adopts', async () => {
      const payload = JSON.stringify({ id: 'evt_refund', type: 'charge.refunded', data: { object: { customer: 'cus_X' } } });
      const signature = new Stripe('sk_test_dummy').webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });

      const res = await POST(makeCtx(payload, { 'stripe-signature': signature }));

      expect(res.status).toBe(200);
      expect(customersUpdate()).not.toHaveBeenCalled();
    });
  });

  it('a bad signature resolves 400 "Webhook Error" and NEVER calls handleInboundPayment (no DB write)', async () => {
    const res = await POST(makeCtx('{"id":"evt_bad"}', { 'stripe-signature': 't=1,v1=deadbeef' }));

    expect(res.status).toBe(400);
    expect(await res.text()).toBe('Webhook Error');
    expect(handleInboundPaymentMock).not.toHaveBeenCalled();
  });

  it('T-03-29: verification sees the EXACT raw bytes — non-canonical JSON whitespace still verifies (proves no parse/re-stringify before verify)', async () => {
    const client = new Stripe('sk_test_dummy');
    // Deliberately non-canonical spacing — a JSON.parse -> JSON.stringify
    // round-trip anywhere before verification would collapse this exact
    // whitespace and break the signature.
    const payload =
      '{ "id": "evt_test_2",  "type": "checkout.session.completed", "data": {"object": {"id": "cs_test_2"} } }';
    const signature = client.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });

    const res = await POST(makeCtx(payload, { 'stripe-signature': signature }));

    expect(res.status).toBe(200);
    expect(handleInboundPaymentMock).toHaveBeenCalledTimes(1);
  });

  it('an unhandled (but validly-signed) event type still acks 200 without calling handleInboundPayment', async () => {
    const client = new Stripe('sk_test_dummy');
    const payload = JSON.stringify({ id: 'evt_test_3', type: 'payment_intent.created', data: { object: {} } });
    const signature = client.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });

    const res = await POST(makeCtx(payload, { 'stripe-signature': signature }));

    expect(res.status).toBe(200);
    expect(handleInboundPaymentMock).not.toHaveBeenCalled();
  });

  it('rejects an oversized Content-Length before ever verifying', async () => {
    const request = new Request('https://example.com/api/forms/webhooks/stripe', {
      method: 'POST',
      headers: { 'Content-Length': String(MAX_WEBHOOK_PAYLOAD_BYTES + 1) },
      body: '{}',
    });
    const res = await POST({ request } as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(413);
    expect(handleInboundPaymentMock).not.toHaveBeenCalled();
  });

  it('wires notify: resolves config.forms[formId].notifyTo + entryUrl before calling sendPaymentReceivedEmail', async () => {
    const client = new Stripe('sk_test_dummy');
    const payload = JSON.stringify({
      id: 'evt_test_4',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_4', amount_total: 1000, currency: 'usd' } },
    });
    const signature = client.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });

    await POST(makeCtx(payload, { 'stripe-signature': signature }));

    const deps = handleInboundPaymentMock.mock.calls[0]![1] as {
      notify: (data: {
        siteId: string;
        formId: string;
        entryId: string;
        provider: string;
        amountCents?: number;
        currency?: string;
      }) => Promise<unknown>;
    };
    await deps.notify({
      siteId: 'demo-site',
      formId: 'contact-form',
      entryId: 'entry-1',
      provider: 'stripe',
      amountCents: 1000,
      currency: 'usd',
    });

    expect(sendPaymentReceivedEmailMock).toHaveBeenCalledWith(
      {
        siteId: 'demo-site',
        formId: 'contact-form',
        notifyTo: 'owner@example.com',
        amountCents: 1000,
        currency: 'usd',
        provider: 'stripe',
        entryUrl: 'https://example.com/forms-admin/entries/entry-1',
      },
      { template: undefined },
    );
  });

  it('notify resolves undefined (never throws, never sends) when the anchor entry formId has no configured notifyTo', async () => {
    const client = new Stripe('sk_test_dummy');
    const payload = JSON.stringify({
      id: 'evt_test_5',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_5' } },
    });
    const signature = client.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });

    await POST(makeCtx(payload, { 'stripe-signature': signature }));

    const deps = handleInboundPaymentMock.mock.calls[0]![1] as { notify: (data: unknown) => Promise<unknown> };
    await expect(
      deps.notify({ siteId: 'demo-site', formId: 'unknown-form', entryId: 'entry-2', provider: 'stripe' }),
    ).resolves.toBeUndefined();
    expect(sendPaymentReceivedEmailMock).not.toHaveBeenCalled();
  });

  it('deliver is wired to the real deliverWebhook (reference pass-through, no wrapper)', async () => {
    const client = new Stripe('sk_test_dummy');
    const payload = JSON.stringify({
      id: 'evt_test_6',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_6' } },
    });
    const signature = client.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });

    await POST(makeCtx(payload, { 'stripe-signature': signature }));

    const deps = handleInboundPaymentMock.mock.calls[0]![1] as { deliver: typeof deliverWebhookMock };
    expect(deps.deliver).toBe(deliverWebhookMock);
  });

  it("propagates handleInboundPayment's own returned status (e.g. a storage-failure 500) verbatim", async () => {
    handleInboundPaymentMock.mockResolvedValueOnce({ status: 500 });
    const client = new Stripe('sk_test_dummy');
    const payload = JSON.stringify({
      id: 'evt_test_7',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_7' } },
    });
    const signature = client.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });

    const res = await POST(makeCtx(payload, { 'stripe-signature': signature }));
    expect(res.status).toBe(500);
  });

  it('a storage-acquisition throw resolves a logged 500, not an unlogged crash', async () => {
    sqliteStorageMock.mockImplementationOnce(() => {
      throw new Error('db open failed');
    });
    const client = new Stripe('sk_test_dummy');
    const payload = JSON.stringify({
      id: 'evt_test_8',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_8' } },
    });
    const signature = client.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });

    const res = await POST(makeCtx(payload, { 'stripe-signature': signature }));
    expect(res.status).toBe(500);
  });
});
