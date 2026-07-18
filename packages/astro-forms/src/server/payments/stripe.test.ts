import Stripe from 'stripe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHECKOUT_SESSION_TTL_MIN } from '../payment-constants.js';
import {
  createCheckoutSession,
  createPaymentLink,
  getStripeClient,
  verifyStripeWebhook,
} from './stripe.js';

// Every create-fn case injects a FAKE client (paymentLinks.create /
// checkout.sessions.create are vi.fn()s) — zero network, zero real Stripe
// SDK invocation. verifyStripeWebhook cases use a REAL `new Stripe(...)`
// instance: constructEvent/generateTestHeaderString are pure crypto, no
// network involved either way (mirrors RESEARCH.md's testing pattern).

function fakeClient(opts: {
  paymentLinksCreate?: ReturnType<typeof vi.fn>;
  sessionsCreate?: ReturnType<typeof vi.fn>;
}): Stripe {
  return {
    paymentLinks: { create: opts.paymentLinksCreate ?? vi.fn() },
    checkout: { sessions: { create: opts.sessionsCreate ?? vi.fn() } },
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
  it('builds an ad-hoc price_data line item with entry_id metadata', async () => {
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
    });
    expect(result).toEqual({ url: 'https://buy.stripe.com/test_abc', providerRef: 'plink_123' });
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
