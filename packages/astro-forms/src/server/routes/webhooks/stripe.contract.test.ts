/**
 * Webhook contract, end to end through REAL code: the Stripe route, its real
 * signature verification (generateTestHeaderString, no network), the real
 * handleInboundPayment, and the real SQLite adapter. Only notify, outbound
 * delivery and logging are spies.
 *
 * Why: the unit suites on each side mock the other side, and that is exactly
 * how fleet bug F1 shipped (the admin flow stored plink_ ids, the webhook
 * looked up cs_ ids, and both sides' tests were green). These cases create
 * the payment row the way production does, post the event Stripe would
 * send, and read the row back.
 */
import Stripe from 'stripe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sendPaymentReceivedEmailMock, deliverWebhookMock } = vi.hoisted(() => ({
  sendPaymentReceivedEmailMock: vi.fn(async (_data: unknown, _opts?: unknown) => ({})),
  deliverWebhookMock: vi.fn(),
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

import { createCheckoutForEntry } from '../../payments/checkout-for-entry.js';
import { getDb, resetDbCache } from '../../storage/db.js';
import { SqliteStorage } from '../../storage/sqlite.js';
import { POST } from './stripe.js';

const WEBHOOK_SECRET = 'whsec_contract';
const ORIGINAL = { secret: process.env.STRIPE_WEBHOOK_SECRET, key: process.env.STRIPE_SECRET_KEY };

let storage: SqliteStorage;

beforeEach(() => {
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.STRIPE_SECRET_KEY = 'sk_test_contract';
  resetDbCache();
  storage = new SqliteStorage(getDb(':memory:'));
  sendPaymentReceivedEmailMock.mockClear();
  deliverWebhookMock.mockClear();
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
