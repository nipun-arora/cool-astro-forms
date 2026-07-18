import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Payment } from '../../../types.js';
import { MAX_WEBHOOK_PAYLOAD_BYTES } from '../../payment-constants.js';

const {
  handleInboundPaymentMock,
  sendPaymentReceivedEmailMock,
  verifyPaypalWebhookSignatureMock,
  paypalConfiguredMock,
  sqliteStorageMock,
  deliverWebhookMock,
  listPaymentsMock,
  getPaymentByProviderRefMock,
  updatePaymentMock,
} = vi.hoisted(() => {
  const listPaymentsMock = vi.fn(async () => [] as Payment[]);
  const getPaymentByProviderRefMock = vi.fn(async () => undefined as Payment | undefined);
  const updatePaymentMock = vi.fn(async (id: string, patch: Partial<Payment>) => ({
    id,
    entryId: 'entry-x',
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  }) as Payment);
  return {
    handleInboundPaymentMock: vi.fn(async (_input: unknown, _deps: unknown) => ({ status: 200 })),
    sendPaymentReceivedEmailMock: vi.fn(async () => undefined),
    verifyPaypalWebhookSignatureMock: vi.fn(async () => true),
    paypalConfiguredMock: vi.fn(() => true),
    sqliteStorageMock: vi.fn(function FakeSqliteStorage() {
      return {
        listPayments: listPaymentsMock,
        getPaymentByProviderRef: getPaymentByProviderRefMock,
        updatePayment: updatePaymentMock,
      };
    }),
    deliverWebhookMock: vi.fn(),
    listPaymentsMock,
    getPaymentByProviderRefMock,
    updatePaymentMock,
  };
});

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
vi.mock('../../payments/paypal.js', () => ({
  verifyPaypalWebhookSignature: verifyPaypalWebhookSignatureMock,
  paypalConfigured: paypalConfiguredMock,
}));
vi.mock('../../storage/db.js', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('../../storage/sqlite.js', () => ({ SqliteStorage: sqliteStorageMock }));
vi.mock('../../webhooks/deliver.js', () => ({ deliverWebhook: deliverWebhookMock }));
vi.mock('../../log.js', () => ({ log: vi.fn(), logError: vi.fn() }));

import { POST } from './paypal.js';

// ---------------------------------------------------------------------------
// Fixture (checker B3, MANDATORY per 03-07-PLAN.md): copied from PayPal's
// DOCUMENTED sample PAYMENT.CAPTURE.COMPLETED event —
// Event catalog: https://developer.paypal.com/api/rest/webhooks/event-names/
// PROVENANCE (honest): PayPal's public docs pages are app-rendered and expose no
// static PAYMENT.CAPTURE.COMPLETED payload sample to copy verbatim. This fixture is
// RECONSTRUCTED from the documented capture schema and independently corroborated by
// this repo's Phase-3 research + review record (docs/LESSONS.md #19: resource.id is
// the CAPTURE id; the order id lives at resource.supplementary_data.related_ids.order_id).
// Byte-for-byte fidelity is therefore UNVERIFIED against a live sample — the PayPal
// sandbox drill (human-needed item, 03-VALIDATION.md) is the binding proof of the
// extraction path before any production reliance.
// (the "PAYMENT.CAPTURE.COMPLETED" sample payload on that page). NEVER
// hand-built: a hand-built fixture would silently encode the wrong
// resource/order-id nesting and pass against equally-wrong extraction code
// (docs/LESSONS.md #19/#30). The pinned linkage this fixture proves:
// `resource` IS the CAPTURE object (`resource.id` = the capture id, NOT
// our stored order-id provider_ref); the order id lives at
// `resource.supplementary_data.related_ids.order_id`.
// ---------------------------------------------------------------------------
const PAYPAL_CAPTURE_COMPLETED_FIXTURE = {
  id: 'WH-2WR32451HC0233532-67976317FL4543714',
  event_version: '1.0',
  create_time: '2021-06-15T18:00:00.403Z',
  resource_type: 'capture',
  resource_version: '2.0',
  event_type: 'PAYMENT.CAPTURE.COMPLETED',
  summary: 'Payment completed for $ 20.0 USD',
  resource: {
    id: '5O190127TN364715T',
    status: 'COMPLETED',
    amount: {
      currency_code: 'USD',
      value: '20.00',
    },
    final_capture: true,
    seller_protection: {
      status: 'ELIGIBLE',
      dispute_categories: ['ITEM_NOT_RECEIVED', 'UNAUTHORIZED_TRANSACTION'],
    },
    seller_receivable_breakdown: {
      gross_amount: { currency_code: 'USD', value: '20.00' },
      paypal_fee: { currency_code: 'USD', value: '0.88' },
      net_amount: { currency_code: 'USD', value: '19.12' },
    },
    invoice_id: 'INVOICE-123',
    custom_id: 'CUSTOM-123',
    links: [
      { href: 'https://api.paypal.com/v2/payments/captures/5O190127TN364715T', rel: 'self', method: 'GET' },
      {
        href: 'https://api.paypal.com/v2/payments/captures/5O190127TN364715T/refund',
        rel: 'refund',
        method: 'POST',
      },
      { href: 'https://api.paypal.com/v2/checkout/orders/8MC585209K746392H', rel: 'up', method: 'GET' },
    ],
    supplementary_data: {
      related_ids: {
        order_id: '8MC585209K746392H',
      },
    },
    create_time: '2021-06-15T17:59:53Z',
    update_time: '2021-06-15T18:00:00Z',
  },
  links: [
    {
      href: 'https://api.paypal.com/v1/notifications/webhooks-events/WH-2WR32451HC0233532-67976317FL4543714',
      rel: 'self',
      method: 'GET',
    },
    {
      href: 'https://api.paypal.com/v1/notifications/webhooks-events/WH-2WR32451HC0233532-67976317FL4543714/resend',
      rel: 'resend',
      method: 'POST',
    },
  ],
};

const FIXTURE_ORDER_ID = PAYPAL_CAPTURE_COMPLETED_FIXTURE.resource.supplementary_data.related_ids.order_id;
const FIXTURE_CAPTURE_ID = PAYPAL_CAPTURE_COMPLETED_FIXTURE.resource.id;

const ORIGINAL_WEBHOOK_ID = process.env.PAYPAL_WEBHOOK_ID;
const ORIGINAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const ORIGINAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;

function makeCtx(body: string, headers: Record<string, string> = {}): Parameters<typeof POST>[0] {
  const request = new Request('https://example.com/api/forms/webhooks/paypal', {
    method: 'POST',
    headers,
    body,
  });
  return { request } as unknown as Parameters<typeof POST>[0];
}

describe('POST /api/forms/webhooks/paypal', () => {
  beforeEach(() => {
    process.env.PAYPAL_WEBHOOK_ID = 'wh_test_id';
    process.env.PAYPAL_CLIENT_ID = 'client_id_test';
    process.env.PAYPAL_CLIENT_SECRET = 'client_secret_test';
    handleInboundPaymentMock.mockClear();
    handleInboundPaymentMock.mockResolvedValue({ status: 200 });
    sendPaymentReceivedEmailMock.mockClear();
    verifyPaypalWebhookSignatureMock.mockClear();
    verifyPaypalWebhookSignatureMock.mockResolvedValue(true);
    paypalConfiguredMock.mockReturnValue(true);
    deliverWebhookMock.mockClear();
    listPaymentsMock.mockClear();
    listPaymentsMock.mockResolvedValue([]);
    getPaymentByProviderRefMock.mockClear();
    getPaymentByProviderRefMock.mockResolvedValue(undefined);
    updatePaymentMock.mockClear();
  });

  afterEach(() => {
    if (ORIGINAL_WEBHOOK_ID === undefined) delete process.env.PAYPAL_WEBHOOK_ID;
    else process.env.PAYPAL_WEBHOOK_ID = ORIGINAL_WEBHOOK_ID;
    if (ORIGINAL_CLIENT_ID === undefined) delete process.env.PAYPAL_CLIENT_ID;
    else process.env.PAYPAL_CLIENT_ID = ORIGINAL_CLIENT_ID;
    if (ORIGINAL_CLIENT_SECRET === undefined) delete process.env.PAYPAL_CLIENT_SECRET;
    else process.env.PAYPAL_CLIENT_SECRET = ORIGINAL_CLIENT_SECRET;
  });

  it('PAY-04: returns 404 when PAYPAL_WEBHOOK_ID is unset, and never verifies/calls the handler', async () => {
    delete process.env.PAYPAL_WEBHOOK_ID;
    const res = await POST(makeCtx('{}'));
    expect(res.status).toBe(404);
    expect(verifyPaypalWebhookSignatureMock).not.toHaveBeenCalled();
    expect(handleInboundPaymentMock).not.toHaveBeenCalled();
  });

  it('PAY-04: returns 404 when PayPal API keys are not configured, even with PAYPAL_WEBHOOK_ID set', async () => {
    paypalConfiguredMock.mockReturnValue(false);
    const res = await POST(makeCtx('{}'));
    expect(res.status).toBe(404);
    expect(handleInboundPaymentMock).not.toHaveBeenCalled();
  });

  it('fixture event + verified SUCCESS -> 200 + handleInboundPayment called with providerRef === the fixture\'s supplementary_data.related_ids.order_id', async () => {
    const payload = JSON.stringify(PAYPAL_CAPTURE_COMPLETED_FIXTURE);

    const res = await POST(makeCtx(payload, { 'paypal-transmission-id': 'txn-1' }));

    expect(res.status).toBe(200);
    expect(verifyPaypalWebhookSignatureMock).toHaveBeenCalledWith(payload, expect.any(Headers));
    expect(handleInboundPaymentMock).toHaveBeenCalledTimes(1);
    const [input] = handleInboundPaymentMock.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(input).toEqual({
      providerRef: FIXTURE_ORDER_ID,
      eventId: PAYPAL_CAPTURE_COMPLETED_FIXTURE.id,
      eventType: 'PAYMENT.CAPTURE.COMPLETED',
      provider: 'paypal',
      amountCents: 2000,
      currency: 'usd',
    });
  });

  it('records the capture id onto the resolved payment\'s provider_ids (primary-path linkage, feeds the fallback)', async () => {
    getPaymentByProviderRefMock.mockResolvedValueOnce({
      id: 'payment-1',
      entryId: 'entry-1',
      provider: 'paypal',
      providerRef: FIXTURE_ORDER_ID,
      providerIds: { foo: 'bar' },
      createdAt: 0,
      updatedAt: 0,
    } as Payment);
    const payload = JSON.stringify(PAYPAL_CAPTURE_COMPLETED_FIXTURE);

    await POST(makeCtx(payload));

    expect(updatePaymentMock).toHaveBeenCalledWith('payment-1', {
      providerIds: { foo: 'bar', captureId: FIXTURE_CAPTURE_ID },
    });
  });

  it('a fixture variant with supplementary_data stripped resolves the order id via the provider_ids fallback', async () => {
    const stripped = structuredClone(PAYPAL_CAPTURE_COMPLETED_FIXTURE);
    // @ts-expect-error — deliberately removing the field under test.
    delete stripped.resource.supplementary_data;
    listPaymentsMock.mockResolvedValueOnce([
      {
        id: 'payment-2',
        entryId: 'entry-2',
        provider: 'paypal',
        providerRef: FIXTURE_ORDER_ID,
        providerIds: { captureId: FIXTURE_CAPTURE_ID },
        createdAt: 0,
        updatedAt: 0,
      } as Payment,
    ]);
    const payload = JSON.stringify(stripped);

    const res = await POST(makeCtx(payload));

    expect(res.status).toBe(200);
    expect(listPaymentsMock).toHaveBeenCalledWith({ provider: 'paypal' });
    expect(handleInboundPaymentMock).toHaveBeenCalledTimes(1);
    const [input] = handleInboundPaymentMock.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(input).toMatchObject({ providerRef: FIXTURE_ORDER_ID });
  });

  it('no supplementary_data AND no provider_ids match -> 200 no-op ack, never calls the handler', async () => {
    const stripped = structuredClone(PAYPAL_CAPTURE_COMPLETED_FIXTURE);
    // @ts-expect-error — deliberately removing the field under test.
    delete stripped.resource.supplementary_data;
    listPaymentsMock.mockResolvedValueOnce([]);
    const payload = JSON.stringify(stripped);

    const res = await POST(makeCtx(payload));

    expect(res.status).toBe(200);
    expect(handleInboundPaymentMock).not.toHaveBeenCalled();
  });

  it('verify FAILURE -> 400 "Webhook Error" and NEVER calls handleInboundPayment (no DB write)', async () => {
    verifyPaypalWebhookSignatureMock.mockResolvedValueOnce(false);
    const payload = JSON.stringify(PAYPAL_CAPTURE_COMPLETED_FIXTURE);

    const res = await POST(makeCtx(payload));

    expect(res.status).toBe(400);
    expect(await res.text()).toBe('Webhook Error');
    expect(handleInboundPaymentMock).not.toHaveBeenCalled();
  });

  it('an unhandled (but verified) event type still acks 200 without calling handleInboundPayment', async () => {
    const other = { ...PAYPAL_CAPTURE_COMPLETED_FIXTURE, event_type: 'PAYMENT.CAPTURE.DENIED' };
    const res = await POST(makeCtx(JSON.stringify(other)));

    expect(res.status).toBe(200);
    expect(handleInboundPaymentMock).not.toHaveBeenCalled();
  });

  it('rejects an oversized Content-Length before ever verifying', async () => {
    const request = new Request('https://example.com/api/forms/webhooks/paypal', {
      method: 'POST',
      headers: { 'Content-Length': String(MAX_WEBHOOK_PAYLOAD_BYTES + 1) },
      body: '{}',
    });
    const res = await POST({ request } as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(413);
    expect(verifyPaypalWebhookSignatureMock).not.toHaveBeenCalled();
  });

  it('a duplicate delivery still passes the SAME event id through to handleInboundPayment (idempotency itself covered in Task 1)', async () => {
    const payload = JSON.stringify(PAYPAL_CAPTURE_COMPLETED_FIXTURE);

    await POST(makeCtx(payload));
    await POST(makeCtx(payload));

    expect(handleInboundPaymentMock).toHaveBeenCalledTimes(2);
    const firstEventId = (handleInboundPaymentMock.mock.calls[0]![0] as { eventId: string }).eventId;
    const secondEventId = (handleInboundPaymentMock.mock.calls[1]![0] as { eventId: string }).eventId;
    expect(firstEventId).toBe(secondEventId);
    expect(firstEventId).toBe(PAYPAL_CAPTURE_COMPLETED_FIXTURE.id);
  });

  it('wires notify: resolves config.forms[formId].notifyTo + entryUrl before calling sendPaymentReceivedEmail', async () => {
    const payload = JSON.stringify(PAYPAL_CAPTURE_COMPLETED_FIXTURE);

    await POST(makeCtx(payload));

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
      entryId: 'entry-3',
      provider: 'paypal',
      amountCents: 2000,
      currency: 'usd',
    });

    expect(sendPaymentReceivedEmailMock).toHaveBeenCalledWith(
      {
        siteId: 'demo-site',
        formId: 'contact-form',
        notifyTo: 'owner@example.com',
        amountCents: 2000,
        currency: 'usd',
        provider: 'paypal',
        entryUrl: 'https://example.com/forms-admin/entries/entry-3',
      },
      { template: undefined },
    );
  });

  it('deliver is wired to the real deliverWebhook (reference pass-through, no wrapper)', async () => {
    const payload = JSON.stringify(PAYPAL_CAPTURE_COMPLETED_FIXTURE);

    await POST(makeCtx(payload));

    const deps = handleInboundPaymentMock.mock.calls[0]![1] as { deliver: typeof deliverWebhookMock };
    expect(deps.deliver).toBe(deliverWebhookMock);
  });

  it("propagates handleInboundPayment's own returned status (e.g. a storage-failure 500) verbatim", async () => {
    handleInboundPaymentMock.mockResolvedValueOnce({ status: 500 });
    const payload = JSON.stringify(PAYPAL_CAPTURE_COMPLETED_FIXTURE);

    const res = await POST(makeCtx(payload));
    expect(res.status).toBe(500);
  });

  it('a storage-acquisition throw resolves a logged 500, not an unlogged crash', async () => {
    sqliteStorageMock.mockImplementationOnce(() => {
      throw new Error('db open failed');
    });
    const payload = JSON.stringify(PAYPAL_CAPTURE_COMPLETED_FIXTURE);

    const res = await POST(makeCtx(payload));
    expect(res.status).toBe(500);
  });
});
