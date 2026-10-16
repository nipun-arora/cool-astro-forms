import Stripe from 'stripe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logError } from '../log.js';
import { CHECKOUT_SESSION_TTL_MIN } from '../payment-constants.js';
import {
  createCheckoutSession,
  createPaymentLink,
  getStripeClient,
  verifyStripeWebhook,
} from './stripe.js';

vi.mock('../log.js', () => ({ log: vi.fn(), logError: vi.fn(), warn: vi.fn() }));

// Every create-fn case injects a FAKE client (paymentLinks.create /
// checkout.sessions.create are vi.fn()s) — zero network, zero real Stripe
// SDK invocation. verifyStripeWebhook cases use a REAL `new Stripe(...)`
// instance: constructEvent/generateTestHeaderString are pure crypto, no
// network involved either way (mirrors RESEARCH.md's testing pattern).

interface FakeCustomer {
  id: string;
  email: string;
  created?: number;
  metadata?: Record<string, string>;
  paymentMethods?: string[];
}

/** The tag the webhook writes on a paying Customer (customers.ts), and the only kind checkout reuses. */
const PKG = { source: 'cool-astro-forms' };

/**
 * In-memory Stripe Customers API: `list` matches the email exactly and
 * ignores metadata (as Stripe does), `search` finds nothing, and
 * `listPaymentMethods` returns the stored customer's cards. `seed` holds the
 * Customers that already exist; `failList` models a Stripe outage on the
 * lookup. `create` and `update` are spies: checkout must never call them.
 */
function fakeCustomers(opts: { failList?: boolean; seed?: FakeCustomer[] } = {}) {
  const store: FakeCustomer[] = [...(opts.seed ?? [])];
  const list = vi.fn(async (params: { email: string }) => {
    if (opts.failList) throw new Error('stripe unreachable');
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

function fakeClient(opts: {
  paymentLinksCreate?: ReturnType<typeof vi.fn>;
  sessionsCreate?: ReturnType<typeof vi.fn>;
  customers?: ReturnType<typeof fakeCustomers>['resource'];
}): Stripe {
  return {
    paymentLinks: { create: opts.paymentLinksCreate ?? vi.fn() },
    checkout: { sessions: { create: opts.sessionsCreate ?? vi.fn() } },
    customers: opts.customers ?? fakeCustomers().resource,
  } as unknown as Stripe;
}

function withEnv(key: string, value: string | undefined, fn: () => void): void {
  const original = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    fn();
  } finally {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createPaymentLink', () => {
  // 0.1.15 (fleet bug F1): the expected params gained `restrictions`. Up to
  // 0.1.14 this test pinned a reusable link, so one quote row could be paid
  // any number of times while the admin showed a single amount; the link is
  // now deactivated by Stripe after its first completed checkout.
  it('builds an ad-hoc price_data line item with entry_id metadata, limited to ONE completed checkout', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'plink_123', url: 'https://buy.stripe.com/test_abc' });
    const client = fakeClient({ paymentLinksCreate: create });

    const result = await createPaymentLink(
      { amountCents: 2500, currency: 'usd', memo: 'Invoice #4', entryId: 'entry_1' },
      { client },
    );

    expect(create).toHaveBeenCalledWith({
      line_items: [
        {
          price_data: {
            currency: 'usd',
            unit_amount: 2500,
            product_data: { name: 'Invoice #4' },
          },
          quantity: 1,
        },
      ],
      metadata: { entry_id: 'entry_1' },
      restrictions: { completed_sessions: { limit: 1 } },
      customer_creation: 'always',
      payment_intent_data: { metadata: { entry_id: 'entry_1' }, description: 'Invoice #4' },
    });
    expect(result).toEqual({ url: 'https://buy.stripe.com/test_abc', providerRef: 'plink_123' });
  });

  // 0.1.17: a Payment Link without `customer_creation` makes a guest
  // checkout, so the Stripe dashboard counted no customers while revenue
  // came in. Payment Links cannot take an existing `customer`, so 'always'
  // is the most this path can do.
  it('asks Stripe to create a Customer for the payer (customer_creation: always), never a guest checkout', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'plink_c', url: 'https://buy.stripe.com/test_c' });
    const client = fakeClient({ paymentLinksCreate: create });

    await createPaymentLink({ amountCents: 500, currency: 'usd', entryId: 'entry_c' }, { client });

    const [args] = create.mock.calls[0] as [Record<string, unknown>];
    expect(args.customer_creation).toBe('always');
    expect(args).not.toHaveProperty('customer');
  });

  it('puts entry_id and a readable description on the PaymentIntent (what the Stripe Payments list shows), defaulting to "Payment request"', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'plink_d', url: 'https://buy.stripe.com/test_d' });
    const client = fakeClient({ paymentLinksCreate: create });

    await createPaymentLink({ amountCents: 500, currency: 'usd', entryId: 'entry_d' }, { client });

    const [args] = create.mock.calls[0] as [{ payment_intent_data: unknown }];
    expect(args.payment_intent_data).toEqual({ metadata: { entry_id: 'entry_d' }, description: 'Payment request' });
  });

  it("appends Stripe's prefilled_email param (URL-encoded) so the payer's email is prefilled at checkout", async () => {
    const create = vi.fn().mockResolvedValue({ id: 'plink_e', url: 'https://buy.stripe.com/test_e' });
    const client = fakeClient({ paymentLinksCreate: create });

    const result = await createPaymentLink(
      { amountCents: 500, currency: 'usd', entryId: 'entry_e', customerEmail: 'jenny+test@example.com' },
      { client },
    );

    expect(result.url).toBe('https://buy.stripe.com/test_e?prefilled_email=jenny%2Btest%40example.com');
    expect(result.providerRef).toBe('plink_e');
  });

  it('keeps an existing query string on the link URL when adding prefilled_email', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'plink_f', url: 'https://buy.stripe.com/test_f?locale=en' });
    const client = fakeClient({ paymentLinksCreate: create });

    const result = await createPaymentLink(
      { amountCents: 500, currency: 'usd', entryId: 'entry_f', customerEmail: 'a@example.com' },
      { client },
    );

    const url = new URL(result.url);
    expect(url.searchParams.get('locale')).toBe('en');
    expect(url.searchParams.get('prefilled_email')).toBe('a@example.com');
  });

  it('leaves the link URL untouched when no customerEmail is given', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'plink_g', url: 'https://buy.stripe.com/test_g' });
    const client = fakeClient({ paymentLinksCreate: create });

    const result = await createPaymentLink({ amountCents: 500, currency: 'usd', entryId: 'entry_g' }, { client });

    expect(result.url).toBe('https://buy.stripe.com/test_g');
  });

  it('defaults the line item product name to "Payment request" when memo is absent', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'plink_2', url: 'https://buy.stripe.com/test_def' });
    const client = fakeClient({ paymentLinksCreate: create });

    await createPaymentLink({ amountCents: 500, currency: 'usd', entryId: 'entry_2' }, { client });

    const [args] = create.mock.calls[0] as [{ line_items: [{ price_data: { product_data: { name: string } } }] }];
    expect(args.line_items[0]!.price_data.product_data.name).toBe('Payment request');
  });

  it('throws when no client is injected and STRIPE_SECRET_KEY is unset (PAY-04 inert)', async () => {
    const original = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    try {
      await expect(createPaymentLink({ amountCents: 100, currency: 'usd', entryId: 'entry_3' })).rejects.toThrow(
        /not configured/,
      );
    } finally {
      if (original !== undefined) process.env.STRIPE_SECRET_KEY = original;
    }
  });
});

describe('createCheckoutSession', () => {
  it('builds base + fee lines as SEPARATE line_items, expires_at from CHECKOUT_SESSION_TTL_MIN, metadata.entry_id', async () => {
    const create = vi
      .fn()
      .mockResolvedValue({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
    const client = fakeClient({ sessionsCreate: create });

    const before = Math.floor(Date.now() / 1000);
    const result = await createCheckoutSession(
      {
        baseAmountCents: 20000,
        feeLines: [{ label: 'Processing fee', amountCents: 600 }],
        currency: 'usd',
        memo: 'Consulting',
        entryId: 'entry_4',
        successUrl: 'https://site.example/forms-pay/success/?session_id={CHECKOUT_SESSION_ID}',
        cancelUrl: 'https://site.example/forms-pay/?amount=200',
      },
      { client },
    );
    const after = Math.floor(Date.now() / 1000);

    expect(create).toHaveBeenCalledTimes(1);
    const [args] = create.mock.calls[0] as [
      {
        mode: string;
        line_items: unknown[];
        metadata: Record<string, string>;
        expires_at: number;
      },
    ];
    expect(args.mode).toBe('payment');
    expect(args.line_items).toEqual([
      {
        price_data: { currency: 'usd', unit_amount: 20000, product_data: { name: 'Consulting' } },
        quantity: 1,
      },
      {
        price_data: { currency: 'usd', unit_amount: 600, product_data: { name: 'Processing fee' } },
        quantity: 1,
      },
    ]);
    expect(args.metadata).toEqual({ entry_id: 'entry_4' });
    expect(args.expires_at).toBeGreaterThanOrEqual(before + CHECKOUT_SESSION_TTL_MIN * 60);
    expect(args.expires_at).toBeLessThanOrEqual(after + CHECKOUT_SESSION_TTL_MIN * 60);
    expect(result).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_test_1', providerRef: 'cs_test_1' });
  });

  describe('customer attribution (0.1.17)', () => {
    const base = {
      baseAmountCents: 20000,
      feeLines: [],
      currency: 'usd',
      memo: 'Consulting',
      entryId: 'entry_cus',
      successUrl: 'https://site.example/forms-pay/success/',
      cancelUrl: 'https://site.example/forms-pay/',
    };

    function sessionsCreateMock() {
      return vi.fn().mockResolvedValue({ id: 'cs_cus', url: 'https://checkout.stripe.com/c/pay/cs_cus' });
    }

    function sessionParams(create: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> {
      return create.mock.calls[call]![0] as Record<string, unknown>;
    }

    /** A Customer a verified payment already tagged (the webhook adopts it), holding no card. */
    const adopted = (email = 'payer@example.com'): FakeCustomer => ({ id: 'cus_adopted', email, created: 1, metadata: PKG });

    // Through the first 0.1.17 draft the lookup created a Customer for every
    // new email: an abandoned or scripted submit left a Customer behind, with
    // whatever name the visitor typed. Stripe now creates the Customer only
    // when a payer confirms, and the package writes nothing.
    it('a first payment by a new email lets Stripe create the Customer at confirmation (customer_creation: always + normalized customer_email); the package creates and updates nothing', async () => {
      const customers = fakeCustomers();
      const create = sessionsCreateMock();
      const client = fakeClient({ sessionsCreate: create, customers: customers.resource });

      await createCheckoutSession({ ...base, customerEmail: '  Payer@Example.COM ', customerName: 'Pat Payer' }, { client });

      const params = sessionParams(create);
      expect(params.customer_creation).toBe('always');
      expect(params.customer_email).toBe('payer@example.com');
      expect(params).not.toHaveProperty('customer');
      expect(customers.create).not.toHaveBeenCalled();
      expect(customers.update).not.toHaveBeenCalled();
    });

    it("a payer whose earlier payment was adopted is attributed to that Customer, found by the email in any case", async () => {
      const customers = fakeCustomers({ seed: [adopted()] });
      const create = sessionsCreateMock();
      const client = fakeClient({ sessionsCreate: create, customers: customers.resource });

      await createCheckoutSession({ ...base, customerEmail: 'PAYER@example.com ' }, { client });

      const params = sessionParams(create);
      expect(params.customer).toBe('cus_adopted');
      expect(params).not.toHaveProperty('customer_email');
      expect(params).not.toHaveProperty('customer_creation');
      expect(customers.create).not.toHaveBeenCalled();
      expect(customers.update).not.toHaveBeenCalled();
    });

    // Checkout given `customer` prefills that Customer's most recent saved
    // card, so the package's Customers must never be given one.
    it('a session for a Customer turns saving the card off (payment_method_save: disabled) and never sets setup_future_usage', async () => {
      const customers = fakeCustomers({ seed: [adopted()] });
      const create = sessionsCreateMock();
      const client = fakeClient({ sessionsCreate: create, customers: customers.resource });

      await createCheckoutSession({ ...base, customerEmail: 'payer@example.com' }, { client });

      const params = sessionParams(create);
      expect(params.customer).toBe('cus_adopted');
      expect(params.saved_payment_method_options).toEqual({ payment_method_save: 'disabled' });
      expect(params.payment_intent_data).not.toHaveProperty('setup_future_usage');
    });

    // Audit (0.1.17): this page's payment methods come from the dashboard, and
    // attaching an email-matched Customer enables bank transfers paid from
    // that Customer's cash balance. Anyone who knows a payer's email could
    // then spend the payer's balance on their own payment.
    it("a session for a Customer excludes customer_balance, so a visitor who knows a payer's email cannot spend that payer's cash balance", async () => {
      const customers = fakeCustomers({ seed: [adopted()] });
      const create = sessionsCreateMock();
      const client = fakeClient({ sessionsCreate: create, customers: customers.resource });

      await createCheckoutSession({ ...base, customerEmail: 'payer@example.com' }, { client });

      const params = sessionParams(create);
      expect(params.customer).toBe('cus_adopted');
      expect(params.excluded_payment_method_types).toEqual(['customer_balance']);
      expect(params).not.toHaveProperty('payment_method_types');
    });

    it('a session without a Customer leaves the dashboard payment methods alone (the new Customer has no balance to spend)', async () => {
      const create = sessionsCreateMock();
      const client = fakeClient({ sessionsCreate: create, customers: fakeCustomers().resource });

      await createCheckoutSession({ ...base, customerEmail: 'payer@example.com' }, { client });

      expect(sessionParams(create)).not.toHaveProperty('excluded_payment_method_types');
    });

    it('a visitor typing the email of a Customer the package never adopted (legacy, another integration) never gets that Customer on the session', async () => {
      const customers = fakeCustomers({ seed: [{ id: 'cus_victim', email: 'payer@example.com', created: 1 }] });
      const create = sessionsCreateMock();
      const client = fakeClient({ sessionsCreate: create, customers: customers.resource });

      await createCheckoutSession({ ...base, customerEmail: 'Payer@Example.com', customerName: 'Visitor' }, { client });

      const params = sessionParams(create);
      expect(params).not.toHaveProperty('customer');
      expect(params.customer_creation).toBe('always');
      expect(customers.update).not.toHaveBeenCalled();
    });

    it('a tagged Customer that holds a card is never put on the session', async () => {
      const customers = fakeCustomers({ seed: [{ ...adopted(), paymentMethods: ['pm_card'] }] });
      const create = sessionsCreateMock();
      const client = fakeClient({ sessionsCreate: create, customers: customers.resource });

      await createCheckoutSession({ ...base, customerEmail: 'payer@example.com' }, { client });

      expect(sessionParams(create)).not.toHaveProperty('customer');
      expect(sessionParams(create).customer_creation).toBe('always');
    });

    // The name is visitor input. Checkout collects the payer's own name.
    it('customerName is still accepted but never sent to Stripe, on either path', async () => {
      for (const seed of [[], [adopted()]]) {
        const customers = fakeCustomers({ seed });
        const create = sessionsCreateMock();
        const client = fakeClient({ sessionsCreate: create, customers: customers.resource });

        await createCheckoutSession({ ...base, customerEmail: 'payer@example.com', customerName: 'Visitor Name' }, { client });

        expect(JSON.stringify(sessionParams(create))).not.toContain('Visitor Name');
        expect(customers.create).not.toHaveBeenCalled();
        expect(customers.update).not.toHaveBeenCalled();
      }
    });

    it('a customer lookup failure still produces a checkout: falls back to customer_creation: always with customer_email, never both customer fields', async () => {
      const customers = fakeCustomers({ failList: true, seed: [adopted()] });
      const create = sessionsCreateMock();
      const client = fakeClient({ sessionsCreate: create, customers: customers.resource });

      const result = await createCheckoutSession({ ...base, customerEmail: 'payer@example.com' }, { client });

      expect(result.providerRef).toBe('cs_cus');
      const params = sessionParams(create);
      expect(params.customer_creation).toBe('always');
      expect(params.customer_email).toBe('payer@example.com');
      expect(params).not.toHaveProperty('customer');
      expect(logError).toHaveBeenCalledWith('stripe.customer-lookup-failed', expect.anything(), expect.anything());
    });

    it('with no payer email there is nothing to look up: customer_creation: always makes Stripe create the Customer, no customer_email', async () => {
      const customers = fakeCustomers();
      const create = sessionsCreateMock();
      const client = fakeClient({ sessionsCreate: create, customers: customers.resource });

      await createCheckoutSession(base, { client });

      const params = sessionParams(create);
      expect(params.customer_creation).toBe('always');
      expect(params).not.toHaveProperty('customer');
      expect(params).not.toHaveProperty('customer_email');
      expect(customers.list).not.toHaveBeenCalled();
    });

    it('never sends customer together with customer_creation or customer_email (Stripe rejects both pairs), whichever path is taken', async () => {
      for (const failList of [false, true]) {
        for (const customerEmail of ['payer@example.com', 'new@example.com', undefined]) {
          const customers = fakeCustomers({ failList, seed: [adopted()] });
          const create = sessionsCreateMock();
          const client = fakeClient({ sessionsCreate: create, customers: customers.resource });

          await createCheckoutSession({ ...base, customerEmail }, { client });

          const params = sessionParams(create);
          expect('customer' in params && 'customer_creation' in params).toBe(false);
          expect('customer' in params && 'customer_email' in params).toBe(false);
          expect('customer' in params || 'customer_creation' in params).toBe(true);
          expect(params.payment_intent_data).not.toHaveProperty('setup_future_usage');
        }
      }
    });

    it('puts entry_id and the memo on the PaymentIntent (what the Stripe Payments list shows) and keeps the session metadata', async () => {
      const create = sessionsCreateMock();
      const client = fakeClient({ sessionsCreate: create });

      await createCheckoutSession(base, { client });

      const params = sessionParams(create);
      expect(params.payment_intent_data).toEqual({ metadata: { entry_id: 'entry_cus' }, description: 'Consulting' });
      expect(params.metadata).toEqual({ entry_id: 'entry_cus' });
    });

    it('tags the session with client_reference_id = the entry id so the Stripe dashboard and exports show which entry paid', async () => {
      const create = sessionsCreateMock();
      const client = fakeClient({ sessionsCreate: create });

      await createCheckoutSession(base, { client });

      expect(sessionParams(create).client_reference_id).toBe('entry_cus');
    });

    it('the PaymentIntent description defaults to "Payment" when there is no memo', async () => {
      const create = sessionsCreateMock();
      const client = fakeClient({ sessionsCreate: create });

      await createCheckoutSession({ ...base, memo: undefined }, { client });

      expect((sessionParams(create).payment_intent_data as { description: string }).description).toBe('Payment');
    });
  });

  it('B1: passes successUrl/cancelUrl through byte-verbatim (trailing-slash-shaped URLs)', async () => {
    const create = vi
      .fn()
      .mockResolvedValue({ id: 'cs_test_2', url: 'https://checkout.stripe.com/c/pay/cs_test_2' });
    const client = fakeClient({ sessionsCreate: create });
    const successUrl = 'https://site.example/forms-pay/success/?session_id={CHECKOUT_SESSION_ID}';
    const cancelUrl = 'https://site.example/forms-pay/?amount=200';

    await createCheckoutSession(
      {
        baseAmountCents: 100,
        feeLines: [],
        currency: 'usd',
        entryId: 'entry_5',
        successUrl,
        cancelUrl,
      },
      { client },
    );

    const [args] = create.mock.calls[0] as [{ success_url: string; cancel_url: string }];
    expect(args.success_url).toBe(successUrl);
    expect(args.cancel_url).toBe(cancelUrl);
  });

  it('omits fee line items entirely when feeLines is empty', async () => {
    const create = vi
      .fn()
      .mockResolvedValue({ id: 'cs_test_3', url: 'https://checkout.stripe.com/c/pay/cs_test_3' });
    const client = fakeClient({ sessionsCreate: create });

    await createCheckoutSession(
      {
        baseAmountCents: 100,
        feeLines: [],
        currency: 'usd',
        entryId: 'entry_6',
        successUrl: 'https://site.example/s/',
        cancelUrl: 'https://site.example/c/',
      },
      { client },
    );

    const [args] = create.mock.calls[0] as [{ line_items: unknown[] }];
    expect(args.line_items).toHaveLength(1);
  });

  it('falls back to an empty string url when Stripe returns url:null', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'cs_test_4', url: null });
    const client = fakeClient({ sessionsCreate: create });

    const result = await createCheckoutSession(
      {
        baseAmountCents: 100,
        feeLines: [],
        currency: 'usd',
        entryId: 'entry_7',
        successUrl: 'https://site.example/s/',
        cancelUrl: 'https://site.example/c/',
      },
      { client },
    );

    expect(result.url).toBe('');
  });

  it('throws when no client is injected and STRIPE_SECRET_KEY is unset (PAY-04 inert)', async () => {
    const original = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    try {
      await expect(
        createCheckoutSession({
          baseAmountCents: 100,
          feeLines: [],
          currency: 'usd',
          entryId: 'entry_8',
          successUrl: 'https://site.example/s/',
          cancelUrl: 'https://site.example/c/',
        }),
      ).rejects.toThrow(/not configured/);
    } finally {
      if (original !== undefined) process.env.STRIPE_SECRET_KEY = original;
    }
  });
});

describe('verifyStripeWebhook', () => {
  const secret = 'whsec_test_secret';
  // A real (network-free) Stripe instance — constructEvent/generateTestHeaderString
  // are pure crypto over the provided payload+secret, never a fetch call.
  const client = new Stripe('sk_test_123');

  it('a validly-signed payload resolves {ok:true, event}', () => {
    const payload = JSON.stringify({
      id: 'evt_test_1',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_1' } },
    });
    const signature = client.webhooks.generateTestHeaderString({ payload, secret });

    const result = verifyStripeWebhook(payload, signature, { client, secret });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.id).toBe('evt_test_1');
      expect(result.event.type).toBe('checkout.session.completed');
    }
  });

  it('a tampered payload (signature no longer matches) resolves {ok:false}', () => {
    const payload = JSON.stringify({
      id: 'evt_test_2',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_2' } },
    });
    const signature = client.webhooks.generateTestHeaderString({ payload, secret });
    const tampered = payload.replace('cs_test_2', 'cs_test_HACKED');

    const result = verifyStripeWebhook(tampered, signature, { client, secret });

    expect(result).toEqual({ ok: false });
  });

  it('a bogus signature header resolves {ok:false}', () => {
    const payload = JSON.stringify({ id: 'evt_test_3', type: 'checkout.session.completed', data: {} });

    const result = verifyStripeWebhook(payload, 't=1,v1=deadbeef', { client, secret });

    expect(result).toEqual({ ok: false });
  });

  it('resolves {ok:false} when no secret is configured (deps.secret absent, env unset)', () => {
    withEnv('STRIPE_WEBHOOK_SECRET', undefined, () => {
      const result = verifyStripeWebhook('{}', 't=1,v1=abc', { client });
      expect(result).toEqual({ ok: false });
    });
  });

  it('resolves {ok:false} when no client is injected and STRIPE_SECRET_KEY is unset (PAY-04 inert)', () => {
    withEnv('STRIPE_SECRET_KEY', undefined, () => {
      const result = verifyStripeWebhook('{}', 't=1,v1=abc', { secret });
      expect(result).toEqual({ ok: false });
    });
  });
});

describe('getStripeClient', () => {
  it('returns undefined when STRIPE_SECRET_KEY is unset (PAY-04 inert)', () => {
    withEnv('STRIPE_SECRET_KEY', undefined, () => {
      expect(getStripeClient()).toBeUndefined();
    });
  });

  it('returns a Stripe instance when STRIPE_SECRET_KEY is set', () => {
    withEnv('STRIPE_SECRET_KEY', 'sk_test_abc', () => {
      expect(getStripeClient()).toBeInstanceOf(Stripe);
    });
  });

  it('e2e route-seam mock: STRIPE_API_BASE_URL redirects the client host/protocol/port off the real Stripe API', () => {
    withEnv('STRIPE_SECRET_KEY', 'sk_test_e2e_dummy', () => {
      withEnv('STRIPE_API_BASE_URL', 'http://127.0.0.1:4390', () => {
        const client = getStripeClient();
        expect(client).toBeInstanceOf(Stripe);
        expect(client?.getApiField('host')).toBe('127.0.0.1');
        expect(client?.getApiField('protocol')).toBe('http');
        expect(client?.getApiField('port')).toBe('4390');
      });
    });
  });

  it('ignores STRIPE_API_BASE_URL when unset — the real Stripe host applies (production posture)', () => {
    withEnv('STRIPE_SECRET_KEY', 'sk_test_abc', () => {
      withEnv('STRIPE_API_BASE_URL', undefined, () => {
        const client = getStripeClient();
        expect(client?.getApiField('host')).toBe('api.stripe.com');
      });
    });
  });
});
