/**
 * Webhook contract, end to end through REAL code: the Stripe route, its real
 * signature verification (generateTestHeaderString, no network), the real
 * handleInboundPayment, and the real SQLite adapter. Only notify, outbound
 * delivery and logging are spies, and the webhook's Stripe client keeps its
 * real signature verification but talks to an in-memory Customers API (no
 * test reaches Stripe's network).
 *
 * Why: the unit suites on each side mock the other side, and that is exactly
 * how fleet bug F1 shipped (the admin flow stored plink_ ids, the webhook
 * looked up cs_ ids, and both sides' tests were green). These cases create
 * the payment row the way production does, post the event Stripe would
 * send, and read the row back.
 */
import Stripe from 'stripe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sendPaymentReceivedEmailMock, deliverWebhookMock, webhookClient } = vi.hoisted(() => ({
  sendPaymentReceivedEmailMock: vi.fn(async (_data: unknown, _opts?: unknown) => ({})),
  deliverWebhookMock: vi.fn(),
  /** What `getStripeClient` returns to the route; set per test in beforeEach. */
  webhookClient: { current: undefined as unknown },
}));

vi.mock('virtual:cool-astro-forms/config', () => ({
  default: {
    siteId: 'site',
    siteUrl: 'https://tours.example',
    forms: {
      booking: {
        abandonment: { require: 'email-or-phone', dedupeWindowMins: 60, notifyOnUpdate: false },
        notifyTo: 'desk@tours.example',
      },
    },
    dbPath: ':memory:',
    storage: { kind: 'sqlite' },
    trailingSlash: 'always',
  },
}));
vi.mock('../../notify.js', () => ({ sendPaymentReceivedEmail: sendPaymentReceivedEmailMock }));
vi.mock('../../webhooks/deliver.js', () => ({ deliverWebhook: deliverWebhookMock }));
vi.mock('../../log.js', () => ({ log: vi.fn(), logError: vi.fn(), warn: vi.fn() }));
vi.mock('../../payments/stripe.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../payments/stripe.js')>()),
  getStripeClient: vi.fn(() => webhookClient.current),
}));

import { logError } from '../../log.js';
import { createCheckoutForEntry } from '../../payments/checkout-for-entry.js';
import { getDb, resetDbCache } from '../../storage/db.js';
import { SqliteStorage } from '../../storage/sqlite.js';
import { POST } from './stripe.js';

const WEBHOOK_SECRET = 'whsec_contract';
const ORIGINAL = { secret: process.env.STRIPE_WEBHOOK_SECRET, key: process.env.STRIPE_SECRET_KEY };

interface StoredCustomer {
  id: string;
  email: string;
  created: number;
  deleted?: boolean;
  metadata: Record<string, string>;
  paymentMethods?: string[];
}

/**
 * The owner's Stripe Customers, in memory, shared by the checkout side and
 * the webhook side. `list` matches the email exactly (case-sensitive, as
 * Stripe does), `search` the package's narrowed query case-insensitively,
 * `update` merges metadata and answers 404 for an unknown id, and `create`
 * is a spy the package must never call: only `stripeCreatesAtConfirmation`
 * (standing in for Stripe at session confirmation) adds a Customer.
 */
function customersApi() {
  const store: StoredCustomer[] = [];
  const resource = {
    list: vi.fn(async (params: { email: string }) => ({ data: store.filter((c) => c.email === params.email) })),
    search: vi.fn(async (params: { query: string }) => {
      const wanted = /^email:'((?:[^'\\]|\\.)*)'/.exec(params.query)![1]!.toLowerCase();
      return { data: store.filter((c) => c.email.toLowerCase() === wanted && c.metadata.source === 'cool-astro-forms') };
    }),
    listPaymentMethods: vi.fn(async (id: string) => ({
      data: (store.find((c) => c.id === id)?.paymentMethods ?? []).map((pm) => ({ id: pm })),
    })),
    update: vi.fn(async (id: string, params: { metadata?: Record<string, string> }) => {
      const customer = store.find((c) => c.id === id);
      if (!customer) throw Object.assign(new Error('No such customer'), { type: 'StripeInvalidRequestError', statusCode: 404 });
      customer.metadata = { ...customer.metadata, ...params.metadata };
      return customer;
    }),
    create: vi.fn(),
  };
  const stripeCreatesAtConfirmation = (id: string, email: string): void => {
    store.push({ id, email, created: store.length + 1, metadata: {} });
  };
  return { store, resource, stripeCreatesAtConfirmation };
}

let storage: SqliteStorage;
let customers: ReturnType<typeof customersApi>;

beforeEach(() => {
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.STRIPE_SECRET_KEY = 'sk_test_contract';
  resetDbCache();
  storage = new SqliteStorage(getDb(':memory:'));
  sendPaymentReceivedEmailMock.mockClear();
  deliverWebhookMock.mockClear();
  vi.mocked(logError).mockClear();
  // The webhook's client: real signature verification, in-memory Customers.
  customers = customersApi();
  const client = new Stripe('sk_test_contract');
  (client as unknown as { customers: unknown }).customers = customers.resource;
  webhookClient.current = client;
});

afterEach(() => {
  resetDbCache();
  if (ORIGINAL.secret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
  else process.env.STRIPE_WEBHOOK_SECRET = ORIGINAL.secret;
  if (ORIGINAL.key === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = ORIGINAL.key;
});

async function postEvent(event: Record<string, unknown>): Promise<Response> {
  const payload = JSON.stringify(event);
  const signature = new Stripe('sk_test_contract').webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  const request = new Request('https://tours.example/api/forms/webhooks/stripe/', {
    method: 'POST',
    headers: { 'stripe-signature': signature },
    body: payload,
  });
  return POST({ request } as unknown as Parameters<typeof POST>[0]);
}

async function abandonedEntry(): Promise<string> {
  const entry = await storage.createEntry({
    siteId: 'site',
    formId: 'booking',
    status: 'abandoned',
    fields: { email: 'guest@example.com' },
    visitorUuid: `v-${Math.random()}`,
  });
  return entry.id;
}

function fakeStripe(sessionId: string): Stripe {
  return {
    checkout: {
      sessions: {
        create: vi.fn(async (params: { expires_at: number }) => ({
          id: sessionId,
          url: `https://checkout.stripe.com/c/pay/${sessionId}`,
          expires_at: params.expires_at,
        })),
        expire: vi.fn(),
      },
    },
  } as unknown as Stripe;
}

describe('createCheckoutForEntry -> signed checkout.session.completed -> paid (real storage)', () => {
  it('marks the row paid, promotes the entry, and emails the form notifyTo with the AED amount', async () => {
    const entryId = await abandonedEntry();
    const created = await createCheckoutForEntry(
      {
        entryId,
        amountCents: 250000,
        currency: 'aed',
        expiresAt: new Date(Date.now() + 23 * 3_600_000),
        successUrl: 'https://tours.example/payment/received/',
        cancelUrl: 'https://tours.example/payment/cancelled/',
        idempotencyKey: 'contract-1',
      },
      { client: fakeStripe('cs_test_contract_1'), storage },
    );
    expect(created.ok).toBe(true);

    const res = await postEvent({
      id: 'evt_contract_1',
      type: 'checkout.session.completed',
      data: {
        object: { id: 'cs_test_contract_1', payment_status: 'paid', amount_total: 250000, currency: 'aed' },
      },
    });

    expect(res.status).toBe(200);
    expect((await storage.getPaymentByProviderRef('cs_test_contract_1'))?.status).toBe('paid');
    expect((await storage.getEntryById(entryId))?.status).toBe('submitted');
    expect(sendPaymentReceivedEmailMock).toHaveBeenCalledTimes(1);
    expect(sendPaymentReceivedEmailMock.mock.calls[0]![0]).toMatchObject({
      notifyTo: 'desk@tours.example',
      amountCents: 250000,
      currency: 'aed',
      entryUrl: `https://tours.example/forms-admin/entries/${entryId}/`,
    });
    expect(deliverWebhookMock).toHaveBeenCalledWith('payment.paid', expect.objectContaining({ amountCents: 250000 }));
  });

  it('a completion for a DIFFERENT amount leaves the row unpaid and sends nothing', async () => {
    const entryId = await abandonedEntry();
    await createCheckoutForEntry(
      {
        entryId,
        amountCents: 250000,
        currency: 'aed',
        expiresAt: new Date(Date.now() + 23 * 3_600_000),
        successUrl: 'https://tours.example/payment/received/',
        cancelUrl: 'https://tours.example/payment/cancelled/',
        idempotencyKey: 'contract-2',
      },
      { client: fakeStripe('cs_test_contract_2'), storage },
    );

    const res = await postEvent({
      id: 'evt_contract_2',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_contract_2', payment_status: 'paid', amount_total: 100, currency: 'aed' } },
    });

    expect(res.status).toBe(200);
    expect((await storage.getPaymentByProviderRef('cs_test_contract_2'))?.status).toBe('link_created');
    expect((await storage.getEntryById(entryId))?.status).toBe('abandoned');
    expect(sendPaymentReceivedEmailMock).not.toHaveBeenCalled();
    expect(deliverWebhookMock).not.toHaveBeenCalled();
  });
});

/** Emulates Stripe's idempotency: the same key with the same params replays the first session. */
function replayingStripe(): Stripe {
  const byKey = new Map<string, unknown>();
  let created = 0;
  return {
    checkout: {
      sessions: {
        create: vi.fn(async (params: { expires_at: number }, opts: { idempotencyKey: string }) => {
          const prior = byKey.get(opts.idempotencyKey);
          if (prior) return prior;
          created += 1;
          const session = {
            id: `cs_test_replay_${created}`,
            url: `https://checkout.stripe.com/c/pay/cs_test_replay_${created}`,
            expires_at: params.expires_at,
          };
          byKey.set(opts.idempotencyKey, session);
          return session;
        }),
        expire: vi.fn(),
      },
    },
  } as unknown as Stripe;
}

describe('a quote form submitted twice (same idempotency key) -> one row, and it is the row that gets paid', () => {
  it('leaves no unpaid link_created twin beside the paid payment', async () => {
    const entryId = await abandonedEntry();
    const client = replayingStripe();
    const quote = {
      entryId,
      amountCents: 250000,
      currency: 'aed',
      expiresAt: new Date(Date.now() + 23 * 3_600_000),
      successUrl: 'https://tours.example/payment/received/',
      cancelUrl: 'https://tours.example/payment/cancelled/',
      idempotencyKey: 'quote-form-uuid-1',
    };
    const first = await createCheckoutForEntry(quote, { client, storage });
    const second = await createCheckoutForEntry(quote, { client, storage });
    expect(first.ok && second.ok).toBe(true);

    await postEvent({
      id: 'evt_contract_replay',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_replay_1', payment_status: 'paid', amount_total: 250000, currency: 'aed' } },
    });

    const rows = await storage.getPaymentsByEntry(entryId);
    expect(rows.map((row) => [row.providerRef, row.status])).toEqual([['cs_test_replay_1', 'paid']]);
    expect(sendPaymentReceivedEmailMock).toHaveBeenCalledTimes(1);
  });
});

describe('fleet bug F1: an admin Payment Link row (keyed plink_) is matched by the session it produced', () => {
  it("before 0.1.15 this event was logged as unknown-ref and the payment stayed unpaid; now the row flips through session.payment_link", async () => {
    const entryId = await abandonedEntry();
    // Exactly what routes/admin/payment-action.ts stores for a Stripe link.
    await storage.attachPayment(entryId, {
      provider: 'stripe',
      amountCents: 20050,
      currency: 'usd',
      status: 'link_created',
      payLinkUrl: 'https://buy.stripe.com/test_link',
      providerRef: 'plink_contract_1',
    });

    const res = await postEvent({
      id: 'evt_contract_plink',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_from_link',
          payment_link: 'plink_contract_1',
          payment_status: 'paid',
          amount_total: 20050,
          currency: 'usd',
        },
      },
    });

    expect(res.status).toBe(200);
    expect((await storage.getPaymentByProviderRef('plink_contract_1'))?.status).toBe('paid');
    expect(sendPaymentReceivedEmailMock).toHaveBeenCalledTimes(1);
  });

  it('the same event delivered twice notifies once (idempotency holds on the fallback path too)', async () => {
    const entryId = await abandonedEntry();
    await storage.attachPayment(entryId, {
      provider: 'stripe',
      amountCents: 20050,
      currency: 'usd',
      status: 'link_created',
      payLinkUrl: 'https://buy.stripe.com/test_link',
      providerRef: 'plink_contract_2',
    });
    const event = {
      id: 'evt_contract_dup',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_dup',
          payment_link: 'plink_contract_2',
          payment_status: 'paid',
          amount_total: 20050,
          currency: 'usd',
        },
      },
    };

    await postEvent(event);
    await postEvent(event);

    expect(sendPaymentReceivedEmailMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 0.1.17 — Stripe customer visibility, end to end through real code. A paid
// session records its customer and payer email on the payment row so repeat
// payers are traceable; the write is atomic with the paid flip, so a replay
// cannot overwrite it and an unpaid or mismatched session cannot record it.
// ---------------------------------------------------------------------------

describe('a paid Stripe session records its customer and payer email on the payment row (0.1.17)', () => {
  async function linkRow(providerRef: string, amountCents = 20050): Promise<string> {
    const entryId = await abandonedEntry();
    await storage.attachPayment(entryId, {
      provider: 'stripe',
      amountCents,
      currency: 'usd',
      status: 'link_created',
      payLinkUrl: 'https://buy.stripe.com/test_link',
      providerRef,
    });
    return entryId;
  }

  function sessionEvent(eventId: string, sessionOverrides: Record<string, unknown>, eventOverrides: Record<string, unknown> = {}) {
    return {
      id: eventId,
      type: 'checkout.session.completed',
      livemode: false,
      data: {
        object: { id: 'cs_test_cust', payment_status: 'paid', amount_total: 20050, currency: 'usd', ...sessionOverrides },
      },
      ...eventOverrides,
    };
  }

  it('marks the row paid AND records customerRef + lowercased payerEmail from the verified session', async () => {
    await linkRow('cs_test_cust');

    const res = await postEvent(
      sessionEvent('evt_cust_1', { customer: 'cus_ABC123', customer_details: { email: 'Payer@Example.com' } }),
    );

    expect(res.status).toBe(200);
    const row = await storage.getPaymentByProviderRef('cs_test_cust');
    expect(row?.status).toBe('paid');
    expect(row?.customerRef).toBe('cus_ABC123');
    expect(row?.payerEmail).toBe('payer@example.com');
    // The event carries the livemode flag the admin uses to pick the dashboard.
    expect(row?.events?.[0]).toMatchObject({ id: 'evt_cust_1', livemode: false });
  });

  it('records the customer on a row keyed by its Payment Link id (the admin quote flow), found through session.payment_link', async () => {
    await linkRow('plink_cust_1');

    await postEvent(
      sessionEvent('evt_cust_plink', {
        id: 'cs_test_from_plink',
        payment_link: 'plink_cust_1',
        customer: 'cus_FROMLINK',
        customer_details: { email: 'link@example.com' },
      }),
    );

    const row = await storage.getPaymentByProviderRef('plink_cust_1');
    expect(row?.status).toBe('paid');
    expect(row?.customerRef).toBe('cus_FROMLINK');
    expect(row?.payerEmail).toBe('link@example.com');
  });

  it('a guest checkout (no customer, no email) still marks the row paid and leaves the customer columns empty', async () => {
    await linkRow('cs_test_cust');

    await postEvent(sessionEvent('evt_guest', { customer: null, customer_details: null }));

    const row = await storage.getPaymentByProviderRef('cs_test_cust');
    expect(row?.status).toBe('paid');
    expect(row?.customerRef).toBeUndefined();
    expect(row?.payerEmail).toBeUndefined();
  });

  it('a replayed webhook does not overwrite or double-write: the same event id with different customer data changes nothing and notifies once', async () => {
    await linkRow('cs_test_cust');

    await postEvent(
      sessionEvent('evt_replay_cust', { customer: 'cus_FIRST', customer_details: { email: 'first@example.com' } }),
    );
    const res = await postEvent(
      sessionEvent('evt_replay_cust', { customer: 'cus_SECOND', customer_details: { email: 'second@example.com' } }),
    );

    expect(res.status).toBe(200);
    const row = await storage.getPaymentByProviderRef('cs_test_cust');
    expect(row?.customerRef).toBe('cus_FIRST');
    expect(row?.payerEmail).toBe('first@example.com');
    expect(row?.events).toHaveLength(1);
    expect(sendPaymentReceivedEmailMock).toHaveBeenCalledTimes(1);
  });

  it('an unpaid session (delayed payment method) records no customer data, and the later async success records it', async () => {
    await linkRow('cs_test_cust');

    await postEvent(
      sessionEvent('evt_unpaid', {
        payment_status: 'unpaid',
        customer: 'cus_ASYNC',
        customer_details: { email: 'async@example.com' },
      }),
    );
    const unpaid = await storage.getPaymentByProviderRef('cs_test_cust');
    expect(unpaid?.status).toBe('link_created');
    expect(unpaid?.customerRef).toBeUndefined();
    expect(unpaid?.payerEmail).toBeUndefined();

    await postEvent(
      sessionEvent(
        'evt_async_ok',
        { customer: 'cus_ASYNC', customer_details: { email: 'async@example.com' } },
        { type: 'checkout.session.async_payment_succeeded' },
      ),
    );
    const paid = await storage.getPaymentByProviderRef('cs_test_cust');
    expect(paid?.status).toBe('paid');
    expect(paid?.customerRef).toBe('cus_ASYNC');
    expect(paid?.payerEmail).toBe('async@example.com');
  });

  it('a session for a different amount records no customer data: it is not this payment', async () => {
    await linkRow('cs_test_cust');

    await postEvent(
      sessionEvent('evt_mismatch', {
        amount_total: 100,
        customer: 'cus_WRONG',
        customer_details: { email: 'wrong@example.com' },
      }),
    );

    const row = await storage.getPaymentByProviderRef('cs_test_cust');
    expect(row?.status).toBe('link_created');
    expect(row?.customerRef).toBeUndefined();
    expect(row?.payerEmail).toBeUndefined();
  });

  it('a repeat payer: two paid payments by the same email carry the same customer and the same lowercased email', async () => {
    await linkRow('cs_test_one');
    await linkRow('cs_test_two');

    await postEvent(
      sessionEvent('evt_rp_1', { id: 'cs_test_one', customer: 'cus_REPEAT', customer_details: { email: 'Repeat@Example.com' } }),
    );
    await postEvent(
      sessionEvent('evt_rp_2', { id: 'cs_test_two', customer: 'cus_REPEAT', customer_details: { email: 'repeat@example.com' } }),
    );

    const rows = (await storage.listPayments({})).filter((row) => row.status === 'paid');
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.customerRef))).toEqual(new Set(['cus_REPEAT']));
    expect(new Set(rows.map((row) => row.payerEmail))).toEqual(new Set(['repeat@example.com']));
  });
});

// ---------------------------------------------------------------------------
// 0.1.17 Customer lifecycle, end to end through real code. Checkout only LOOKS
// a payer up; a new payer's session makes Stripe create the Customer when the
// payer confirms; the verified paid webhook tags (adopts) it; the payer's
// next payment, in any case, reuses it. Anonymous input never creates or
// writes a Customer, and nothing short of a verified payment adopts one.
// ---------------------------------------------------------------------------

describe('Customer lifecycle: Stripe creates at payment, the paid webhook adopts, the next payment reuses (0.1.17)', () => {
  /** The checkout side's client: records each session's params and shares the owner's Customers. */
  function checkoutClient() {
    let created = 0;
    const create = vi.fn(async (params: { expires_at: number }) => {
      created += 1;
      return {
        id: `cs_test_life_${created}`,
        url: `https://checkout.stripe.com/c/pay/cs_test_life_${created}`,
        expires_at: params.expires_at,
      };
    });
    const client = { checkout: { sessions: { create, expire: vi.fn() } }, customers: customers.resource } as unknown as Stripe;
    return { client, create };
  }

  async function quote(client: Stripe, entryId: string, key: string, customerEmail: string) {
    return createCheckoutForEntry(
      {
        entryId,
        amountCents: 250000,
        currency: 'aed',
        customerEmail,
        customerName: 'Typed By Whoever',
        expiresAt: new Date(Date.now() + 23 * 3_600_000),
        successUrl: 'https://tours.example/payment/received/',
        cancelUrl: 'https://tours.example/payment/cancelled/',
        idempotencyKey: key,
      },
      { client, storage },
    );
  }

  function paidEvent(eventId: string, sessionId: string, session: Record<string, unknown> = {}) {
    return {
      id: eventId,
      type: 'checkout.session.completed',
      data: { object: { id: sessionId, payment_status: 'paid', amount_total: 250000, currency: 'aed', ...session } },
    };
  }

  it('first payment: customer_creation; paid webhook tags the new Customer; the next payment by that email (different case) reuses it', async () => {
    const { client, create } = checkoutClient();

    const first = await quote(client, await abandonedEntry(), 'life-1', 'guest@example.com');
    expect(first.ok).toBe(true);
    expect(create.mock.calls[0]![0]).toMatchObject({ customer_creation: 'always', customer_email: 'guest@example.com' });
    expect(create.mock.calls[0]![0]).not.toHaveProperty('customer');

    // The payer confirms: Stripe creates their Customer, untagged.
    customers.stripeCreatesAtConfirmation('cus_LIFE', 'guest@example.com');
    const res = await postEvent(paidEvent('evt_life_1', 'cs_test_life_1', { customer: 'cus_LIFE' }));

    expect(res.status).toBe(200);
    expect((await storage.getPaymentByProviderRef('cs_test_life_1'))?.status).toBe('paid');
    expect(customers.store.find((c) => c.id === 'cus_LIFE')?.metadata).toEqual({ source: 'cool-astro-forms' });

    const second = await quote(client, await abandonedEntry(), 'life-2', 'GUEST@Example.com');
    expect(second.ok).toBe(true);
    expect(create.mock.calls[1]![0]).toMatchObject({
      customer: 'cus_LIFE',
      saved_payment_method_options: { payment_method_save: 'disabled' },
      payment_method_types: ['card'],
    });
    expect(create.mock.calls[1]![0]).not.toHaveProperty('customer_creation');
    // The package itself never created a Customer, and never wrote the typed name anywhere.
    expect(customers.resource.create).not.toHaveBeenCalled();
    expect(JSON.stringify([create.mock.calls, customers.resource.update.mock.calls])).not.toContain('Typed By Whoever');
  });

  it('an abandoned checkout (never paid) leaves no Customer, and nothing is ever adopted for it', async () => {
    const { client } = checkoutClient();

    await quote(client, await abandonedEntry(), 'life-abandoned', 'someone@example.com');

    expect(customers.store).toHaveLength(0);
    expect(customers.resource.create).not.toHaveBeenCalled();
    expect(customers.resource.update).not.toHaveBeenCalled();
  });

  it('an unpaid session and a session for a different amount do not adopt their Customer', async () => {
    const { client } = checkoutClient();
    await quote(client, await abandonedEntry(), 'life-unpaid', 'guest@example.com');
    customers.stripeCreatesAtConfirmation('cus_UNPAID', 'guest@example.com');

    await postEvent(paidEvent('evt_unpaid_life', 'cs_test_life_1', { customer: 'cus_UNPAID', payment_status: 'unpaid' }));
    await postEvent(paidEvent('evt_wrong_amount', 'cs_test_life_1', { customer: 'cus_UNPAID', amount_total: 1 }));

    expect(customers.resource.update).not.toHaveBeenCalled();
    expect(customers.store[0]!.metadata).toEqual({});
  });

  it('the same paid event delivered twice adopts once and answers 200 both times', async () => {
    const { client } = checkoutClient();
    await quote(client, await abandonedEntry(), 'life-dup', 'guest@example.com');
    customers.stripeCreatesAtConfirmation('cus_DUP', 'guest@example.com');
    const event = paidEvent('evt_life_dup', 'cs_test_life_1', { customer: 'cus_DUP' });

    const first = await postEvent(event);
    const second = await postEvent(event);

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(customers.resource.update).toHaveBeenCalledTimes(1);
    expect(sendPaymentReceivedEmailMock).toHaveBeenCalledTimes(1);
  });

  it('an adoption that fails at Stripe still answers 200 and leaves the row paid (the next payment just gets a new Customer)', async () => {
    const { client } = checkoutClient();
    await quote(client, await abandonedEntry(), 'life-fail', 'guest@example.com');
    customers.resource.update.mockRejectedValueOnce(Object.assign(new Error('rate limited'), { type: 'StripeRateLimitError', statusCode: 429 }));
    customers.stripeCreatesAtConfirmation('cus_FAIL', 'guest@example.com');

    const res = await postEvent(paidEvent('evt_life_fail', 'cs_test_life_1', { customer: 'cus_FAIL' }));

    expect(res.status).toBe(200);
    expect((await storage.getPaymentByProviderRef('cs_test_life_1'))?.status).toBe('paid');
    expect(logError).toHaveBeenCalledWith('stripe.customer-adopt-failed', expect.any(Error), {
      eventId: 'evt_life_fail',
      statusCode: 429,
    });
  });

  it('an adopted Customer that later holds a card, or was deleted, is not reused: the next payment goes back to customer_creation', async () => {
    const { client, create } = checkoutClient();
    customers.stripeCreatesAtConfirmation('cus_CARDED', 'carded@example.com');
    customers.stripeCreatesAtConfirmation('cus_DELETED', 'deleted@example.com');
    Object.assign(customers.store[0]!, { metadata: { source: 'cool-astro-forms' }, paymentMethods: ['pm_card'] });
    Object.assign(customers.store[1]!, { metadata: { source: 'cool-astro-forms' }, deleted: true });

    await quote(client, await abandonedEntry(), 'life-carded', 'carded@example.com');
    await quote(client, await abandonedEntry(), 'life-deleted', 'deleted@example.com');

    for (const call of create.mock.calls) {
      expect(call[0]).not.toHaveProperty('customer');
      expect(call[0]).toMatchObject({ customer_creation: 'always' });
    }
  });
});
