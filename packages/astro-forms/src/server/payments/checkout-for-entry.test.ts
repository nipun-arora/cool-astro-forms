/**
 * createCheckoutForEntry (0.1.15) — the typed, public way for a host page
 * (a desk quote page, for example) to take a card payment against an entry.
 *
 * The invariant every case here protects: a guest can never be charged for
 * a session the package has no record of. The webhook only marks rows it
 * can find, so a session created without its payments row (wrong key, a
 * storage failure, an entry that does not exist) is money taken and never
 * matched. Hence: validate and look the entry up BEFORE Stripe is called,
 * write the row with typed keys, and expire the session if the write fails.
 *
 * 0.1.17 adds customer attribution: a payer whose earlier payment the
 * webhook adopted is attributed to that Customer, and a new payer's session
 * makes Stripe create one at confirmation, so a repeat payer's payments share
 * one Customer and the dashboard no longer reads "Customers created: 0"
 * beside real revenue. The package itself never creates or writes one.
 */
import Stripe from 'stripe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '../../types.js';
import type { StorageAdapter } from '../storage/adapter.js';
import { getDb, resetDbCache } from '../storage/db.js';
import { SqliteStorage } from '../storage/sqlite.js';
import { createCheckoutForEntry, type CreateCheckoutForEntryInput } from './checkout-for-entry.js';

vi.mock('../log.js', () => ({ log: vi.fn(), logError: vi.fn(), warn: vi.fn() }));

const NOW = Date.UTC(2026, 9, 3, 8, 0, 0);
const HOUR = 3_600_000;

interface FakeCustomer {
  id: string;
  email: string;
  created?: number;
  metadata?: Record<string, string>;
  paymentMethods?: string[];
}

/** The tag the webhook writes on a paying Customer (customers.ts), and the only kind checkout reuses. */
const PKG = { source: 'cool-astro-forms' };

/** A Customer an earlier verified payment by guest@example.com created and the webhook adopted. */
const adopted = (): FakeCustomer => ({ id: 'cus_adopted', email: 'guest@example.com', created: 1, metadata: PKG });

/**
 * In-memory Stripe Customers API: `list` matches the email exactly and
 * ignores metadata (as Stripe does), `search` finds nothing, and
 * `listPaymentMethods` returns the stored customer's cards. `seed` holds the
 * Customers that already exist (`store` can gain one between calls, as the
 * webhook's adoption would). `failList` models a Stripe outage on the lookup
 * alone: `true` fails every list call, a predicate fails only the calls
 * (0-based) it returns true for. `create` and `update` are spies: checkout
 * must never call them.
 */
function fakeCustomers(opts: { failList?: boolean | ((call: number) => boolean); seed?: FakeCustomer[] } = {}) {
  const store: FakeCustomer[] = [...(opts.seed ?? [])];
  let listCalls = 0;
  const list = vi.fn(async (params: { email: string }) => {
    const call = listCalls++;
    if (opts.failList === true || (typeof opts.failList === 'function' && opts.failList(call))) {
      throw new Error('stripe unreachable');
    }
    return { data: store.filter((c) => c.email === params.email) };
  });
  const search = vi.fn(async () => ({ data: [] }));
  const create = vi.fn();
  const update = vi.fn();
  const listPaymentMethods = vi.fn(async (id: string) => ({
    data: (store.find((c) => c.id === id)?.paymentMethods ?? []).map((pm) => ({ id: pm })),
  }));
  return { resource: { list, search, create, update, listPaymentMethods }, list, create, update, store };
}

function fakeClient(
  opts: {
    create?: ReturnType<typeof vi.fn>;
    expire?: ReturnType<typeof vi.fn>;
    customers?: ReturnType<typeof fakeCustomers>;
  } = {},
) {
  const create =
    opts.create ??
    vi.fn(async (params: { expires_at: number }) => ({
      id: 'cs_test_desk_1',
      url: 'https://checkout.stripe.com/c/pay/cs_test_desk_1',
      expires_at: params.expires_at,
    }));
  const expire = opts.expire ?? vi.fn(async (id: string) => ({ id, status: 'expired' }));
  const customers = opts.customers ?? fakeCustomers();
  const client = { checkout: { sessions: { create, expire } }, customers: customers.resource } as unknown as Stripe;
  return { client, create, expire, customers };
}

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: 'entry-1',
    siteId: 'site',
    formId: 'booking',
    status: 'submitted',
    fields: {},
    visitorUuid: 'v-1',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function fakeStorage(overrides: Partial<StorageAdapter> = {}): StorageAdapter {
  return {
    getEntryById: vi.fn(async (id: string) => (id === 'entry-1' ? entry() : undefined)),
    getPaymentByProviderRef: vi.fn(async () => undefined),
    attachPayment: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as StorageAdapter;
}

function input(overrides: Partial<CreateCheckoutForEntryInput> = {}): CreateCheckoutForEntryInput {
  return {
    entryId: 'entry-1',
    amountCents: 250000,
    currency: 'AED',
    customerEmail: 'guest@example.com',
    expiresAt: new Date(NOW + 23 * HOUR),
    successUrl: 'https://tours.example/payment/received/',
    cancelUrl: 'https://tours.example/payment/cancelled/',
    idempotencyKey: 'quote-7f3c',
    metadata: { booking_ref: 'REF-1234' },
    ...overrides,
  };
}

const ORIGINAL_KEY = process.env.STRIPE_SECRET_KEY;
afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = ORIGINAL_KEY;
});

describe('createCheckoutForEntry — happy path', () => {
  it('creates a card-only session for the exact amount and currency, with entry_id metadata on the session and the payment intent, under the idempotency key', async () => {
    const { client, create } = fakeClient();
    const storage = fakeStorage();

    const result = await createCheckoutForEntry(input({ productName: 'Example Tours booking REF-1234' }), {
      client,
      storage,
      now: () => NOW,
    });

    expect(result).toEqual({
      ok: true,
      url: 'https://checkout.stripe.com/c/pay/cs_test_desk_1',
      sessionId: 'cs_test_desk_1',
      expiresAt: new Date(Math.floor((NOW + 23 * HOUR) / 1000) * 1000),
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      {
        mode: 'payment',
        payment_method_types: ['card'],
        line_items: [
          {
            price_data: {
              currency: 'aed',
              unit_amount: 250000,
              product_data: { name: 'Example Tours booking REF-1234' },
            },
            quantity: 1,
          },
        ],
        // A first payment: Stripe creates the payer's Customer at confirmation.
        customer_creation: 'always',
        customer_email: 'guest@example.com',
        client_reference_id: 'entry-1',
        expires_at: Math.floor((NOW + 23 * HOUR) / 1000),
        success_url: 'https://tours.example/payment/received/',
        cancel_url: 'https://tours.example/payment/cancelled/',
        metadata: { booking_ref: 'REF-1234', entry_id: 'entry-1' },
        payment_intent_data: {
          metadata: { booking_ref: 'REF-1234', entry_id: 'entry-1' },
          description: 'Example Tours booking REF-1234',
          // 0.1.18: a live-mode receipt goes to the payer whatever the dashboard email setting.
          receipt_email: 'guest@example.com',
        },
      },
      { idempotencyKey: 'quote-7f3c' },
    );
  });

  it('records the payments row with typed keys: provider stripe, providerRef = the cs_ session id (what the webhook looks up), amount, lowercase currency, link_created, the pay URL', async () => {
    const { client } = fakeClient();
    const storage = fakeStorage();

    await createCheckoutForEntry(input(), { client, storage, now: () => NOW });

    expect(storage.attachPayment).toHaveBeenCalledWith('entry-1', {
      provider: 'stripe',
      providerRef: 'cs_test_desk_1',
      amountCents: 250000,
      currency: 'aed',
      status: 'link_created',
      payLinkUrl: 'https://checkout.stripe.com/c/pay/cs_test_desk_1',
    });
  });

  it('against the real SQLite adapter, the stored row is findable by the session id with every column set (no NULL from a mistyped key)', async () => {
    resetDbCache();
    const storage = new SqliteStorage(getDb(':memory:'));
    const created = await storage.createEntry({
      siteId: 'site',
      formId: 'booking',
      status: 'submitted',
      fields: {},
      visitorUuid: 'v-real',
    });
    const { client } = fakeClient();

    const result = await createCheckoutForEntry(input({ entryId: created.id }), { client, storage, now: () => NOW });

    expect(result.ok).toBe(true);
    const row = await storage.getPaymentByProviderRef('cs_test_desk_1');
    expect(row).toMatchObject({
      entryId: created.id,
      provider: 'stripe',
      providerRef: 'cs_test_desk_1',
      amountCents: 250000,
      currency: 'aed',
      status: 'link_created',
      payLinkUrl: 'https://checkout.stripe.com/c/pay/cs_test_desk_1',
    });
    resetDbCache();
  });

  it('defaults the product name and PaymentIntent description to "Payment" and omits extra metadata when not given', async () => {
    const { client, create } = fakeClient();

    await createCheckoutForEntry(input({ customerEmail: undefined, metadata: undefined }), {
      client,
      storage: fakeStorage(),
      now: () => NOW,
    });

    const [params] = create.mock.calls[0] as [Record<string, unknown>];
    expect(params).not.toHaveProperty('customer_email');
    expect((params.line_items as [{ price_data: { product_data: { name: string } } }])[0].price_data.product_data.name).toBe(
      'Payment',
    );
    expect(params.metadata).toEqual({ entry_id: 'entry-1' });
    expect(params.payment_intent_data).toEqual({ metadata: { entry_id: 'entry-1' }, description: 'Payment' });
  });
});

// ---------------------------------------------------------------------------
// 0.1.17 customer attribution. Through 0.1.16 this function sent only
// `customer_email`, which Stripe treats as a guest checkout: the dashboard
// showed "Customers created: 0" beside real revenue, and a repeat payer was
// never tied to their existing Customer. The first 0.1.17 draft created the
// Customer itself from the (possibly anonymous) input; now Stripe creates it
// when the payer confirms, the webhook adopts it after a verified payment,
// and later payments by that email reuse it.
// ---------------------------------------------------------------------------

describe('createCheckoutForEntry — customer attribution', () => {
  const run = (overrides: Partial<CreateCheckoutForEntryInput>, client: Stripe) =>
    createCheckoutForEntry(input(overrides), { client, storage: fakeStorage(), now: () => NOW });

  it('a first payment by a new email: customer_creation always + the normalized customer_email, and the package creates and updates no Customer', async () => {
    const { client, create, customers } = fakeClient();

    await run({ customerEmail: 'Guest@Example.COM', customerName: 'Jane Guest' }, client);

    const [params] = create.mock.calls[0] as [Record<string, unknown>];
    expect(params.customer_creation).toBe('always');
    expect(params.customer_email).toBe('guest@example.com');
    expect(params).not.toHaveProperty('customer');
    expect(customers.create).not.toHaveBeenCalled();
    expect(customers.update).not.toHaveBeenCalled();
  });

  it("a payer whose earlier payment was adopted is attributed to that Customer: customer id, card saving off, no customer_email, no customer_creation", async () => {
    const { client, create, customers } = fakeClient({ customers: fakeCustomers({ seed: [adopted()] }) });

    await run({ customerEmail: 'GUEST@example.com' }, client);

    const [params] = create.mock.calls[0] as [Record<string, unknown>];
    expect(params.customer).toBe('cus_adopted');
    expect(params).not.toHaveProperty('customer_email');
    expect(params).not.toHaveProperty('customer_creation');
    // Checkout prefills a Customer's saved card for whoever opens the link;
    // the package's Customers must never be given one.
    expect(params.saved_payment_method_options).toEqual({ payment_method_save: 'disabled' });
    expect(params.payment_intent_data).not.toHaveProperty('setup_future_usage');
    expect(customers.create).not.toHaveBeenCalled();
    expect(customers.update).not.toHaveBeenCalled();
  });

  // The cash-balance exclusion stripe.ts sends is for dashboard-managed
  // payment methods. This session is card-only, so customer_balance (a bank
  // transfer funded from the Customer's balance) can never be offered here.
  it("a session for a Customer stays card-only, so the Customer's cash balance can never pay it", async () => {
    const { client, create } = fakeClient({ customers: fakeCustomers({ seed: [adopted()] }) });

    await run({}, client);

    const [params] = create.mock.calls[0] as [Record<string, unknown>];
    expect(params.customer).toBe('cus_adopted');
    expect(params.payment_method_types).toEqual(['card']);
  });

  it('a Customer that is untagged, or tagged but holding a card, is never put on the session', async () => {
    for (const seed of [
      { id: 'cus_legacy', email: 'guest@example.com', created: 1 },
      { ...adopted(), paymentMethods: ['pm_card'] },
    ]) {
      const { client, create } = fakeClient({ customers: fakeCustomers({ seed: [seed] }) });

      await run({}, client);

      const [params] = create.mock.calls[0] as [Record<string, unknown>];
      expect(params).not.toHaveProperty('customer');
      expect(params.customer_creation).toBe('always');
    }
  });

  it("a repeat payer's checkouts (different keys, different quotes) all land on the adopted Customer", async () => {
    const { client, create } = fakeClient({ customers: fakeCustomers({ seed: [adopted()] }) });

    await run({ idempotencyKey: 'quote-a' }, client);
    await run({ idempotencyKey: 'quote-b', customerEmail: 'GUEST@example.com' }, client);

    const customerIds = create.mock.calls.map((call) => (call[0] as { customer?: string }).customer);
    expect(customerIds).toEqual(['cus_adopted', 'cus_adopted']);
  });

  it('a customer lookup failure still produces a checkout: customer_creation: always plus customer_email, never both customer fields', async () => {
    const { client, create } = fakeClient({ customers: fakeCustomers({ failList: true, seed: [adopted()] }) });

    const result = await run({}, client);

    expect(result).toMatchObject({ ok: true, sessionId: 'cs_test_desk_1' });
    const [params] = create.mock.calls[0] as [Record<string, unknown>];
    expect(params.customer_creation).toBe('always');
    expect(params.customer_email).toBe('guest@example.com');
    expect(params).not.toHaveProperty('customer');
  });

  it('with no customerEmail there is nothing to look up: customer_creation: always makes Stripe create the Customer', async () => {
    const { client, create, customers } = fakeClient();

    await run({ customerEmail: undefined }, client);

    const [params] = create.mock.calls[0] as [Record<string, unknown>];
    expect(params.customer_creation).toBe('always');
    expect(params).not.toHaveProperty('customer');
    expect(params).not.toHaveProperty('customer_email');
    expect(customers.list).not.toHaveBeenCalled();
  });

  // Stripe answers a reused idempotency key with an error unless the params
  // match exactly. The lookup is deterministic for an email, so the replayed
  // create is identical on both paths.
  it('a replayed request sends IDENTICAL session params, because the same email resolves the same way', async () => {
    for (const seed of [[], [adopted()]]) {
      const { client, create } = fakeClient({ customers: fakeCustomers({ seed }) });

      await run({ idempotencyKey: 'quote-replay' }, client);
      await run({ idempotencyKey: 'quote-replay', customerEmail: 'GUEST@example.com' }, client);

      expect(create.mock.calls[1]![0]).toEqual(create.mock.calls[0]![0]);
    }
  });

  it('tags the session with client_reference_id = the entry id, on every path (customer, fallback and no email), so the Stripe dashboard and exports show which entry paid', async () => {
    const withCustomer = fakeClient({ customers: fakeCustomers({ seed: [adopted()] }) });
    const fallback = fakeClient({ customers: fakeCustomers({ failList: true }) });
    const noEmail = fakeClient();

    await run({}, withCustomer.client);
    await run({}, fallback.client);
    await run({ customerEmail: undefined }, noEmail.client);

    for (const { create } of [withCustomer, fallback, noEmail]) {
      expect((create.mock.calls[0]![0] as Record<string, unknown>).client_reference_id).toBe('entry-1');
    }
  });

  // The name is caller input that may come from a visitor; Checkout collects
  // the payer's own name. It is still validated, for API compatibility.
  it('customerName is accepted but never sent to Stripe, on either path', async () => {
    for (const seed of [[], [adopted()]]) {
      const { client, create, customers } = fakeClient({ customers: fakeCustomers({ seed }) });

      const result = await run({ customerName: 'Jane Guest' }, client);

      expect(result.ok).toBe(true);
      expect(JSON.stringify(create.mock.calls[0]![0])).not.toContain('Jane Guest');
      expect(customers.create).not.toHaveBeenCalled();
      expect(customers.update).not.toHaveBeenCalled();
    }
  });
});

// ---------------------------------------------------------------------------
// 0.1.18 payer receipt. Up to 0.1.17 the session named no receipt address, so
// Stripe emailed the payer a receipt only when the dashboard's "Successful
// payments" email setting was on. `payment_intent_data.receipt_email` makes
// Stripe send it for a live-mode payment regardless (never in test mode).
// It is derived from the INPUT email, never from the customer lookup, so the
// two customer shapes a reused idempotency key can produce stay identical in
// everything but the customer fields, and Stripe can replay the first one.
// ---------------------------------------------------------------------------

describe('createCheckoutForEntry — payer receipt (0.1.18)', () => {
  const run = (overrides: Partial<CreateCheckoutForEntryInput>, client: Stripe) =>
    createCheckoutForEntry(input(overrides), { client, storage: fakeStorage(), now: () => NOW });
  const receiptEmail = (create: ReturnType<typeof vi.fn>, call = 0): unknown =>
    (create.mock.calls[call]![0] as { payment_intent_data: Record<string, unknown> }).payment_intent_data.receipt_email;

  it("sends receipt_email = the payer's normalized email, with or without an adopted Customer and when the lookup fails", async () => {
    for (const customers of [
      fakeCustomers(),
      fakeCustomers({ seed: [adopted()] }),
      fakeCustomers({ failList: true, seed: [adopted()] }),
    ]) {
      const { client, create } = fakeClient({ customers });

      const result = await run({ customerEmail: 'Guest@Example.COM' }, client);

      expect(result.ok).toBe(true);
      expect(receiptEmail(create)).toBe('guest@example.com');
    }
  });

  it('sends no receipt_email without a customerEmail (Checkout collects the address; the dashboard setting then decides)', async () => {
    const { client, create } = fakeClient();

    await run({ customerEmail: undefined }, client);

    expect((create.mock.calls[0]![0] as { payment_intent_data: object }).payment_intent_data).not.toHaveProperty(
      'receipt_email',
    );
  });

  it('the customer-shape resend under a reused key carries the SAME receipt_email as both earlier requests (only the customer fields differ)', async () => {
    const customers = fakeCustomers({ failList: (call) => call === 0, seed: [adopted()] });
    const { client, create } = fakeClient({
      customers,
      create: vi.fn(async (params: { customer?: string; expires_at: number }) => {
        // The first request (no Customer) took the key; a second shape is refused.
        if (create.mock.calls.length === 2 && params.customer) {
          throw Object.assign(new Error('Keys for idempotent requests can only be used with the same parameters'), {
            type: 'StripeIdempotencyError',
            rawType: 'idempotency_error',
          });
        }
        return { id: 'cs_test_desk_1', url: 'https://checkout.stripe.com/c/pay/cs_test_desk_1', expires_at: params.expires_at };
      }),
    });

    await run({}, client);
    await run({ customerEmail: 'GUEST@example.com' }, client);

    expect(create).toHaveBeenCalledTimes(3);
    expect(create.mock.calls.map((_call, index) => receiptEmail(create, index))).toEqual([
      'guest@example.com',
      'guest@example.com',
      'guest@example.com',
    ]);
    const withoutCustomerFields = (params: Record<string, unknown>) => {
      const { customer, customer_creation, customer_email, saved_payment_method_options, ...rest } = params;
      void customer;
      void customer_creation;
      void customer_email;
      void saved_payment_method_options;
      return rest;
    };
    expect(withoutCustomerFields(create.mock.calls[1]![0] as Record<string, unknown>)).toEqual(
      withoutCustomerFields(create.mock.calls[0]![0] as Record<string, unknown>),
    );
    expect(create.mock.calls[2]![0]).toEqual(create.mock.calls[0]![0]);
  });

  // receipt_email overrides a merchant who turned Stripe receipts off on
  // purpose. payerReceipts: 'dashboard' leaves the decision to that setting.
  it("payerReceipts 'dashboard' sends no receipt_email, with or without an adopted Customer and when the lookup fails", async () => {
    for (const customers of [
      fakeCustomers(),
      fakeCustomers({ seed: [adopted()] }),
      fakeCustomers({ failList: true, seed: [adopted()] }),
    ]) {
      const { client, create } = fakeClient({ customers });

      const result = await run({ customerEmail: 'guest@example.com', payerReceipts: 'dashboard' }, client);

      expect(result.ok).toBe(true);
      expect(JSON.stringify(create.mock.calls[0]![0])).not.toContain('receipt_email');
    }
  });

  it("payerReceipts 'always' is the same as leaving it out", async () => {
    const { client, create } = fakeClient();

    await run({ payerReceipts: 'always' }, client);

    expect(receiptEmail(create)).toBe('guest@example.com');
  });

  it("under payerReceipts 'dashboard' the customer-shape resend still matches the first request exactly, so Stripe replays it", async () => {
    const customers = fakeCustomers({ failList: (call) => call === 0, seed: [adopted()] });
    const { client, create } = fakeClient({
      customers,
      create: vi.fn(async (params: { customer?: string; expires_at: number }) => {
        if (create.mock.calls.length === 2 && params.customer) {
          throw Object.assign(new Error('Keys for idempotent requests can only be used with the same parameters'), {
            type: 'StripeIdempotencyError',
            rawType: 'idempotency_error',
          });
        }
        return { id: 'cs_test_desk_1', url: 'https://checkout.stripe.com/c/pay/cs_test_desk_1', expires_at: params.expires_at };
      }),
    });

    await run({ payerReceipts: 'dashboard' }, client);
    await run({ payerReceipts: 'dashboard' }, client);

    expect(create).toHaveBeenCalledTimes(3);
    expect(create.mock.calls[2]![0]).toEqual(create.mock.calls[0]![0]);
    expect(JSON.stringify(create.mock.calls)).not.toContain('receipt_email');
  });
});

// ---------------------------------------------------------------------------
// 0.1.18 product name. A host page may pass text a visitor typed (a tour
// name, a booking note) as productName. It becomes the Checkout line item and
// the PaymentIntent description the payer and the Stripe dashboard show, so
// it is cleaned like the pay page's label: control characters and lone
// surrogate halves removed, whitespace collapsed, at most 100 characters, and
// "Payment" when nothing is left.
// ---------------------------------------------------------------------------

describe('createCheckoutForEntry — product name cleaning (0.1.18)', () => {
  const run = (productName: string, client: Stripe) =>
    createCheckoutForEntry(input({ productName }), { client, storage: fakeStorage(), now: () => NOW });
  const sent = (create: ReturnType<typeof vi.fn>, call = 0) => {
    const params = create.mock.calls[call]![0] as {
      line_items: [{ price_data: { product_data: { name: string } } }];
      payment_intent_data: { description: string };
    };
    return { name: params.line_items[0].price_data.product_data.name, description: params.payment_intent_data.description };
  };

  it('caps a long product name at 100 characters on the line item and the PaymentIntent description', async () => {
    const { client, create } = fakeClient();

    const result = await run('Safari '.repeat(40), client);

    expect(result.ok).toBe(true);
    const { name, description } = sent(create);
    expect(Array.from(name)).toHaveLength(100);
    expect(name.startsWith('Safari Safari')).toBe(true);
    expect(name).toBe(name.trim());
    expect(description).toBe(name);
  });

  it('removes control characters and collapses whitespace', async () => {
    const { client, create } = fakeClient();

    await run('  Serengeti\u0000 tour\r\n\r\n2\u001b[31m adults\t\t', client);

    expect(sent(create)).toEqual({ name: 'Serengeti tour 2[31m adults', description: 'Serengeti tour 2[31m adults' });
  });

  it('sends a well-formed name for a product name with a lone surrogate (the Stripe SDK would throw URIError on it)', async () => {
    const { client, create } = fakeClient();

    const result = await run('Tour \uD83E booking \u{1F981}', client);

    expect(result.ok).toBe(true);
    const { name, description } = sent(create);
    // The Stripe SDK form-encodes with encodeURIComponent, which throws on a lone surrogate.
    expect(() => encodeURIComponent(name)).not.toThrow();
    expect(() => encodeURIComponent(description)).not.toThrow();
    expect(name).toBe('Tour booking \u{1F981}');
  });

  it('falls back to "Payment" when nothing is left after cleaning', async () => {
    const { client, create } = fakeClient();

    await run(' \u0000\u0007\n\t ', client);

    expect(sent(create)).toEqual({ name: 'Payment', description: 'Payment' });
  });
});

describe('createCheckoutForEntry — refuses BEFORE calling Stripe', () => {
  it('an unknown entry: entry-not-found, Stripe never called, nothing recorded', async () => {
    const { client, create, customers } = fakeClient();
    const storage = fakeStorage();

    const result = await createCheckoutForEntry(input({ entryId: 'nope' }), { client, storage, now: () => NOW });

    expect(result).toMatchObject({ ok: false, code: 'entry-not-found' });
    expect(create).not.toHaveBeenCalled();
    // A bogus entry never even looks the email up at Stripe.
    expect(customers.list).not.toHaveBeenCalled();
    expect(storage.attachPayment).not.toHaveBeenCalled();
  });

  it('a storage failure on the entry lookup: storage-error, Stripe never called', async () => {
    const { client, create } = fakeClient();
    const storage = fakeStorage({
      getEntryById: vi.fn(async () => {
        throw new Error('db locked');
      }),
    });

    const result = await createCheckoutForEntry(input(), { client, storage, now: () => NOW });

    expect(result).toMatchObject({ ok: false, code: 'storage-error' });
    expect(create).not.toHaveBeenCalled();
  });

  it('no client and no STRIPE_SECRET_KEY: stripe-not-configured', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const storage = fakeStorage();

    const result = await createCheckoutForEntry(input(), { storage, now: () => NOW });

    expect(result).toMatchObject({ ok: false, code: 'stripe-not-configured' });
    expect(storage.getEntryById).not.toHaveBeenCalled();
  });

  it.each<[string, Partial<CreateCheckoutForEntryInput>]>([
    ['a zero amount', { amountCents: 0 }],
    ['a negative amount', { amountCents: -100 }],
    ['a fractional amount (minor units are integers)', { amountCents: 2500.5 }],
    ['a NaN amount', { amountCents: Number.NaN }],
    ['a two-letter currency', { currency: 'ae' }],
    ['a currency with digits', { currency: 'a3d' }],
    ['an expiry under 30 minutes away (Stripe minimum)', { expiresAt: new Date(NOW + 29 * 60_000) }],
    ['an expiry more than 24 hours away (Stripe maximum)', { expiresAt: new Date(NOW + 24 * HOUR + 60_000) }],
    ['an invalid Date', { expiresAt: new Date('not a date') }],
    ['a relative success URL', { successUrl: '/payment/received/' }],
    ['a javascript: cancel URL', { cancelUrl: 'javascript:alert(1)' }],
    ['an empty idempotency key', { idempotencyKey: '' }],
    ['an idempotency key over 255 characters', { idempotencyKey: 'k'.repeat(256) }],
    ['a malformed customer email', { customerEmail: 'not-an-email' }],
    ['a customer name over 200 characters', { customerName: 'n'.repeat(201) }],
    ['a customer name that is not a string', { customerName: 42 as unknown as string }],
    ['metadata that tries to set entry_id', { metadata: { entry_id: 'other-entry' } }],
    ['an unknown payerReceipts value', { payerReceipts: 'never' as unknown as 'always' }],
    ['an empty entry id', { entryId: '' }],
  ])('rejects %s as invalid-input without touching storage or Stripe', async (_label, overrides) => {
    const { client, create, customers } = fakeClient();
    const storage = fakeStorage();

    const result = await createCheckoutForEntry(input(overrides), { client, storage, now: () => NOW });

    expect(result).toMatchObject({ ok: false, code: 'invalid-input' });
    expect(create).not.toHaveBeenCalled();
    expect(customers.list).not.toHaveBeenCalled();
    expect(storage.getEntryById).not.toHaveBeenCalled();
    expect(storage.attachPayment).not.toHaveBeenCalled();
  });
});

describe('createCheckoutForEntry — failures after Stripe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a Stripe error: provider-error, nothing recorded, no URL returned, and no second create (only an idempotency mismatch is retried)', async () => {
    const { client, create } = fakeClient({
      create: vi.fn(async () => {
        throw new Error('api_key_expired');
      }),
    });
    const storage = fakeStorage();

    const result = await createCheckoutForEntry(input(), { client, storage, now: () => NOW });

    expect(result).toMatchObject({ ok: false, code: 'provider-error' });
    expect(result).not.toHaveProperty('url');
    expect(storage.attachPayment).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('the payments row cannot be written: the session is EXPIRED, record-failed is returned with sessionExpired:true, and the URL is never handed out', async () => {
    const { client, expire } = fakeClient();
    const storage = fakeStorage({
      attachPayment: vi.fn(async () => {
        throw new Error('SQLITE_FULL');
      }),
    });

    const result = await createCheckoutForEntry(input(), { client, storage, now: () => NOW });

    expect(expire).toHaveBeenCalledWith('cs_test_desk_1');
    expect(result).toMatchObject({ ok: false, code: 'record-failed', sessionExpired: true });
    expect(JSON.stringify(result)).not.toContain('checkout.stripe.com');
  });

  it('the row write fails AND the expire call fails: record-failed with sessionExpired:false (the host must not reuse the URL; it never received it)', async () => {
    const { client } = fakeClient({
      expire: vi.fn(async () => {
        throw new Error('stripe unreachable');
      }),
    });
    const storage = fakeStorage({
      attachPayment: vi.fn(async () => {
        throw new Error('SQLITE_FULL');
      }),
    });

    const result = await createCheckoutForEntry(input(), { client, storage, now: () => NOW });

    expect(result).toMatchObject({ ok: false, code: 'record-failed', sessionExpired: false });
    expect(JSON.stringify(result)).not.toContain('checkout.stripe.com');
  });

  it('a session without a hosted URL is treated as a provider error and expired, never recorded', async () => {
    const { client, expire } = fakeClient({
      create: vi.fn(async () => ({ id: 'cs_nourl', url: null, expires_at: 1 })),
    });
    const storage = fakeStorage();

    const result = await createCheckoutForEntry(input(), { client, storage, now: () => NOW });

    expect(result).toMatchObject({ ok: false, code: 'provider-error' });
    expect(expire).toHaveBeenCalledWith('cs_nourl');
    expect(storage.attachPayment).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// A reused idempotency key. The documented pattern is one key per rendered
// quote form, so a double-click (stripe-node retries Stripe's 409
// idempotency_key_in_use and then receives the replay) or a back-and-resubmit
// sends the SAME key twice. Stripe answers the second create with the first
// session. If the package recorded a row for each answer, the webhook would
// flip one row to paid and leave its twin `link_created` beside a paid
// booking: an unpaid duplicate quote in the admin for money already taken.
// ---------------------------------------------------------------------------

/**
 * stripe-node's response metadata: every returned object carries a
 * non-enumerable `lastResponse` whose `headers` are the raw response
 * headers (a plain lowercase object from the Node HTTP client, a fetch
 * `Headers` from the fetch client). Stripe marks a replayed idempotent
 * response with `Idempotent-Replayed: true`.
 */
function withResponseHeaders<T extends object>(session: T, headers: Record<string, string> | Headers): T {
  Object.defineProperty(session, 'lastResponse', {
    enumerable: false,
    value: { headers, requestId: 'req_test', statusCode: 200 },
  });
  return session;
}

/**
 * Emulates Stripe's idempotency: the same key with the same params replays
 * the first session, flagged `Idempotent-Replayed: true` the way the API
 * does; the same key with different params is refused with the error
 * stripe-node raises for it (`StripeIdempotencyError`, raw type
 * `idempotency_error`, HTTP 400). `replayHeader: false` models an injected
 * client that exposes no response headers, so the package cannot tell a
 * replay from a fresh create.
 */
function replayingClient(opts: { replayHeader?: boolean; customers?: ReturnType<typeof fakeCustomers> } = {}) {
  const replayHeader = opts.replayHeader ?? true;
  const byKey = new Map<string, { params: string; session: Record<string, unknown> }>();
  let created = 0;
  const create = vi.fn(async (params: { expires_at: number }, callOpts: { idempotencyKey: string }) => {
    const prior = byKey.get(callOpts.idempotencyKey);
    if (prior) {
      if (prior.params !== JSON.stringify(params)) {
        throw new Stripe.errors.StripeIdempotencyError({
          type: 'idempotency_error',
          statusCode: 400,
          message: `Keys for idempotent requests can only be used with the same parameters they were first used with. Try using a key other than '${callOpts.idempotencyKey}' if you meant to execute a different request.`,
        });
      }
      const replay = { ...prior.session };
      return replayHeader ? withResponseHeaders(replay, { 'idempotent-replayed': 'true' }) : replay;
    }
    created += 1;
    const session = {
      id: `cs_test_replay_${created}`,
      url: `https://checkout.stripe.com/c/pay/cs_test_replay_${created}`,
      expires_at: params.expires_at,
    };
    byKey.set(callOpts.idempotencyKey, { params: JSON.stringify(params), session });
    const fresh = { ...session };
    return replayHeader ? withResponseHeaders(fresh, { 'request-id': 'req_test' }) : fresh;
  });
  const expire = vi.fn(async (id: string) => ({ id, status: 'expired' }));
  const customers = opts.customers ?? fakeCustomers();
  return {
    client: { checkout: { sessions: { create, expire } }, customers: customers.resource } as unknown as Stripe,
    create,
    expire,
  };
}

/** A client whose create always answers with a replay of `cs_test_replayed` (the key was used by an earlier call). */
function replayOnlyClient(headers: Record<string, string> | Headers = { 'idempotent-replayed': 'true' }) {
  return fakeClient({
    create: vi.fn(async (params: { expires_at: number }) =>
      withResponseHeaders(
        {
          id: 'cs_test_replayed',
          url: 'https://checkout.stripe.com/c/pay/cs_test_replayed',
          expires_at: params.expires_at,
        },
        headers,
      ),
    ),
  });
}

describe('createCheckoutForEntry — a replayed idempotency key (double-click, back-and-resubmit)', () => {
  let storage: SqliteStorage;
  let entryId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetDbCache();
    storage = new SqliteStorage(getDb(':memory:'));
    entryId = (
      await storage.createEntry({ siteId: 'site', formId: 'booking', status: 'submitted', fields: {}, visitorUuid: 'v-replay' })
    ).id;
  });
  afterEach(() => resetDbCache());

  it('the same quote form submitted twice returns the same session both times and records ONE payments row', async () => {
    const { client, create, expire } = replayingClient();

    const first = await createCheckoutForEntry(input({ entryId }), { client, storage, now: () => NOW });
    const second = await createCheckoutForEntry(input({ entryId }), { client, storage, now: () => NOW });

    expect(create).toHaveBeenCalledTimes(2);
    expect(first).toMatchObject({ ok: true, sessionId: 'cs_test_replay_1' });
    expect(second).toEqual(first);
    const rows = await storage.getPaymentsByEntry(entryId);
    expect(rows.map((row) => row.providerRef)).toEqual(['cs_test_replay_1']);
    // The replay is the live session the payer may already hold: never expire it.
    expect(expire).not.toHaveBeenCalled();
  });

  it('a NEW key for the same entry is a new quote: a second session and a second row (only replays are folded)', async () => {
    const { client } = replayingClient();

    await createCheckoutForEntry(input({ entryId, idempotencyKey: 'quote-a' }), { client, storage, now: () => NOW });
    await createCheckoutForEntry(input({ entryId, idempotencyKey: 'quote-b' }), { client, storage, now: () => NOW });

    const rows = await storage.getPaymentsByEntry(entryId);
    expect(rows.map((row) => row.providerRef).sort()).toEqual(['cs_test_replay_1', 'cs_test_replay_2']);
  });

  // Two posts of the same form that overlap (a double-click on a host whose
  // storage is a network round trip away, like Turso): the replay can land
  // before the first call has written its row. A replay must never write,
  // or the session ends up with a paid row and an unpaid twin.
  it('two OVERLAPPING calls with the same key leave exactly one row for the session, and nothing is expired', async () => {
    const { client, expire } = replayingClient();

    const results = await Promise.all([
      createCheckoutForEntry(input({ entryId }), { client, storage, now: () => NOW }),
      createCheckoutForEntry(input({ entryId }), { client, storage, now: () => NOW }),
    ]);

    expect(results.some((result) => result.ok)).toBe(true);
    const rows = await storage.getPaymentsByEntry(entryId);
    expect(rows.map((row) => row.providerRef)).toEqual(['cs_test_replay_1']);
    expect(expire).not.toHaveBeenCalled();
  });

  // The customer lookup is part of the request: when it failed on the first
  // call, that session was created with `customer_creation` + `customer_email`;
  // a retry whose lookup succeeds would send `customer` instead, and Stripe
  // refuses a reused key with different params. The retry must still fold
  // into the first session, not fail.
  it('the first call\'s customer lookup failed and the retry\'s succeeds: the call resends the first call\'s shape under the same key and gets the replay (same URL, one row)', async () => {
    const customers = fakeCustomers({ failList: (call) => call === 0, seed: [adopted()] });
    const { client, create, expire } = replayingClient({ customers });

    const first = await createCheckoutForEntry(input({ entryId }), { client, storage, now: () => NOW });
    const second = await createCheckoutForEntry(input({ entryId }), { client, storage, now: () => NOW });

    expect(first).toMatchObject({ ok: true, sessionId: 'cs_test_replay_1' });
    expect(second).toEqual(first);
    expect(create).toHaveBeenCalledTimes(3);
    expect(create.mock.calls[0]![0]).toMatchObject({ customer_creation: 'always', customer_email: 'guest@example.com' });
    expect(create.mock.calls[1]![0]).toMatchObject({ customer: 'cus_adopted' });
    expect(create.mock.calls[2]![0]).toEqual(create.mock.calls[0]![0]);
    expect(create.mock.calls.map((call) => call[1])).toEqual([
      { idempotencyKey: 'quote-7f3c' },
      { idempotencyKey: 'quote-7f3c' },
      { idempotencyKey: 'quote-7f3c' },
    ]);
    const rows = await storage.getPaymentsByEntry(entryId);
    expect(rows.map((row) => row.providerRef)).toEqual(['cs_test_replay_1']);
    expect(expire).not.toHaveBeenCalled();
  });

  // The common way the shape changes: the first call found no Customer (a new
  // payer), the payer paid, and the webhook adopted the Customer Stripe made.
  // A resubmit of the same quote form now finds that Customer, so it would
  // send `customer`; it must still fold into the first (paid) session.
  it('the payer paid and was adopted between two posts of the same quote form: the retry folds into the first session (same URL, one row)', async () => {
    const customers = fakeCustomers();
    const { client, create, expire } = replayingClient({ customers });

    const first = await createCheckoutForEntry(input({ entryId }), { client, storage, now: () => NOW });
    customers.store.push(adopted());
    const second = await createCheckoutForEntry(input({ entryId, customerEmail: 'Guest@Example.com' }), {
      client,
      storage,
      now: () => NOW,
    });

    expect(first).toMatchObject({ ok: true, sessionId: 'cs_test_replay_1' });
    expect(second).toEqual(first);
    expect(create.mock.calls[0]![0]).toMatchObject({ customer_creation: 'always', customer_email: 'guest@example.com' });
    expect(create.mock.calls[1]![0]).toMatchObject({ customer: 'cus_adopted' });
    expect(create.mock.calls[2]![0]).toEqual(create.mock.calls[0]![0]);
    const rows = await storage.getPaymentsByEntry(entryId);
    expect(rows.map((row) => row.providerRef)).toEqual(['cs_test_replay_1']);
    expect(expire).not.toHaveBeenCalled();
  });

  // The reverse: the first session carries `customer: <id>`, and the retry's
  // lookup fails, so it has no id to resend. It cannot reproduce the first
  // request, so it answers provider-error and changes nothing; a later retry
  // whose lookup succeeds gets the replay.
  it('the first call\'s lookup succeeded and the retry\'s fails: provider-error, nothing written or expired; a later retry with a working lookup gets the replay', async () => {
    const customers = fakeCustomers({ failList: (call) => call === 1, seed: [adopted()] });
    const { client, create, expire } = replayingClient({ customers });

    const first = await createCheckoutForEntry(input({ entryId }), { client, storage, now: () => NOW });
    const second = await createCheckoutForEntry(input({ entryId }), { client, storage, now: () => NOW });

    expect(first).toMatchObject({ ok: true, sessionId: 'cs_test_replay_1' });
    expect(second).toMatchObject({ ok: false, code: 'provider-error' });
    expect(create).toHaveBeenCalledTimes(2);

    const third = await createCheckoutForEntry(input({ entryId }), { client, storage, now: () => NOW });
    expect(third).toEqual(first);
    const rows = await storage.getPaymentsByEntry(entryId);
    expect(rows.map((row) => row.providerRef)).toEqual(['cs_test_replay_1']);
    expect(expire).not.toHaveBeenCalled();
  });

  // A key genuinely reused for a different quote (another amount) mismatches
  // in either customer shape. One retry, then provider-error: never a loop,
  // never a new session.
  it('a key reused with a different amount is retried ONCE in the other customer shape, then answers provider-error', async () => {
    const customers = fakeCustomers({ failList: (call) => call === 0, seed: [adopted()] });
    const { client, create } = replayingClient({ customers });

    await createCheckoutForEntry(input({ entryId }), { client, storage, now: () => NOW });
    const changed = await createCheckoutForEntry(input({ entryId, amountCents: 300000 }), { client, storage, now: () => NOW });

    expect(changed).toMatchObject({ ok: false, code: 'provider-error' });
    expect(create).toHaveBeenCalledTimes(3);
    const rows = await storage.getPaymentsByEntry(entryId);
    expect(rows).toHaveLength(1);
  });

  it('overlapping calls through a client that exposes no replay header still leave one row: the storage write itself refuses a second row for the same session', async () => {
    const { client } = replayingClient({ replayHeader: false });

    const results = await Promise.all([
      createCheckoutForEntry(input({ entryId }), { client, storage, now: () => NOW }),
      createCheckoutForEntry(input({ entryId }), { client, storage, now: () => NOW }),
    ]);

    expect(results.every((result) => result.ok)).toBe(true);
    const rows = await storage.getPaymentsByEntry(entryId);
    expect(rows.map((row) => row.providerRef)).toEqual(['cs_test_replay_1']);
  });
});

describe('createCheckoutForEntry — a replay never writes and never expires', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each<[string, Record<string, string> | Headers]>([
    ['Node client headers (plain object)', { 'idempotent-replayed': 'true' }],
    ['fetch client headers (Headers)', new Headers({ 'Idempotent-Replayed': 'true' })],
  ])(
    'a replayed session with NO row (the first call is still writing it, or it failed and expired the session): replay-unrecorded, nothing written, nothing expired, no URL [%s]',
    async (_label, headers) => {
      const { client, expire } = replayOnlyClient(headers);
      const storage = fakeStorage();

      const result = await createCheckoutForEntry(input(), { client, storage, now: () => NOW });

      expect(result).toMatchObject({ ok: false, code: 'replay-unrecorded' });
      expect(storage.attachPayment).not.toHaveBeenCalled();
      expect(expire).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain('checkout.stripe.com');
    },
  );

  it('a replayed session whose row exists returns the same URL and writes nothing', async () => {
    const { client, expire } = replayOnlyClient();
    const existingRow = { id: 'p1', entryId: 'entry-1', providerRef: 'cs_test_replayed', status: 'link_created' };
    const storage = fakeStorage({
      getPaymentByProviderRef: vi.fn(async () => existingRow),
    } as unknown as Partial<StorageAdapter>);

    const result = await createCheckoutForEntry(input(), { client, storage, now: () => NOW });

    expect(result).toMatchObject({
      ok: true,
      url: 'https://checkout.stripe.com/c/pay/cs_test_replayed',
      sessionId: 'cs_test_replayed',
    });
    expect(storage.attachPayment).not.toHaveBeenCalled();
    expect(expire).not.toHaveBeenCalled();
  });

  // The replayed session belongs to an EARLIER call; its URL may already be
  // in the payer's inbox. A storage hiccup while looking up its row must not
  // kill that live link.
  it('the row lookup for a replayed session fails: storage-error, the session is NOT expired, no URL, nothing written', async () => {
    const { client, expire } = replayOnlyClient();
    const storage = fakeStorage({
      getPaymentByProviderRef: vi.fn(async () => {
        throw new Error('SQLITE_BUSY');
      }),
    });

    const result = await createCheckoutForEntry(input(), { client, storage, now: () => NOW });

    expect(result).toMatchObject({ ok: false, code: 'storage-error' });
    expect(expire).not.toHaveBeenCalled();
    expect(storage.attachPayment).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('checkout.stripe.com');
  });

  it('a replayed session without a hosted URL is a provider-error and is NOT expired (this call did not create it)', async () => {
    const { client, expire } = fakeClient({
      create: vi.fn(async () => withResponseHeaders({ id: 'cs_nourl', url: null, expires_at: 1 }, { 'idempotent-replayed': 'true' })),
    });
    const storage = fakeStorage();

    const result = await createCheckoutForEntry(input(), { client, storage, now: () => NOW });

    expect(result).toMatchObject({ ok: false, code: 'provider-error' });
    expect(expire).not.toHaveBeenCalled();
  });

  it('a FRESH create whose row write fails is still expired (this call created it)', async () => {
    const { client, expire } = fakeClient({
      create: vi.fn(async (params: { expires_at: number }) =>
        withResponseHeaders(
          { id: 'cs_fresh', url: 'https://checkout.stripe.com/c/pay/cs_fresh', expires_at: params.expires_at },
          { 'request-id': 'req_1' },
        ),
      ),
    });
    const storage = fakeStorage({
      attachPayment: vi.fn(async () => {
        throw new Error('SQLITE_BUSY');
      }),
    });

    const result = await createCheckoutForEntry(input(), { client, storage, now: () => NOW });

    expect(result).toMatchObject({ ok: false, code: 'record-failed', sessionExpired: true });
    expect(expire).toHaveBeenCalledWith('cs_fresh');
  });
});
