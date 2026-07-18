import Stripe from 'stripe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_WEBHOOK_PAYLOAD_BYTES } from '../../payment-constants.js';

const { handleInboundPaymentMock, sendPaymentReceivedEmailMock, sqliteStorageMock, deliverWebhookMock } = vi.hoisted(
  () => ({
    handleInboundPaymentMock: vi.fn(async (_input: unknown, _deps: unknown) => ({ status: 200 })),
    sendPaymentReceivedEmailMock: vi.fn(async () => undefined),
    sqliteStorageMock: vi.fn(function FakeSqliteStorage() {
      return {};
    }),
    deliverWebhookMock: vi.fn(),
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
  });

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

  it('a validly-signed checkout.session.completed event resolves 200 and invokes handleInboundPayment with session.id', async () => {
    const client = new Stripe('sk_test_dummy');
    const payload = JSON.stringify({
      id: 'evt_test_1',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_1', amount_total: 2500, currency: 'usd' } },
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
