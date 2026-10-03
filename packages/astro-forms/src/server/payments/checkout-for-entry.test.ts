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
 */
import type Stripe from 'stripe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '../../types.js';
import type { StorageAdapter } from '../storage/adapter.js';
import { getDb, resetDbCache } from '../storage/db.js';
import { SqliteStorage } from '../storage/sqlite.js';
import { createCheckoutForEntry, type CreateCheckoutForEntryInput } from './checkout-for-entry.js';

vi.mock('../log.js', () => ({ log: vi.fn(), logError: vi.fn(), warn: vi.fn() }));

const NOW = Date.UTC(2026, 9, 3, 8, 0, 0);
const HOUR = 3_600_000;

function fakeClient(opts: { create?: ReturnType<typeof vi.fn>; expire?: ReturnType<typeof vi.fn> } = {}) {
  const create =
    opts.create ??
    vi.fn(async (params: { expires_at: number }) => ({
      id: 'cs_test_desk_1',
      url: 'https://checkout.stripe.com/c/pay/cs_test_desk_1',
      expires_at: params.expires_at,
    }));
  const expire = opts.expire ?? vi.fn(async (id: string) => ({ id, status: 'expired' }));
  const client = { checkout: { sessions: { create, expire } } } as unknown as Stripe;
  return { client, create, expire };
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
        customer_email: 'guest@example.com',
        expires_at: Math.floor((NOW + 23 * HOUR) / 1000),
        success_url: 'https://tours.example/payment/received/',
        cancel_url: 'https://tours.example/payment/cancelled/',
        metadata: { booking_ref: 'REF-1234', entry_id: 'entry-1' },
        payment_intent_data: { metadata: { booking_ref: 'REF-1234', entry_id: 'entry-1' } },
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

  it('defaults the product name to "Payment" and omits customer_email and extra metadata when not given', async () => {
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
  });
});

describe('createCheckoutForEntry — refuses BEFORE calling Stripe', () => {
  it('an unknown entry: entry-not-found, Stripe never called, nothing recorded', async () => {
    const { client, create } = fakeClient();
    const storage = fakeStorage();

    const result = await createCheckoutForEntry(input({ entryId: 'nope' }), { client, storage, now: () => NOW });

    expect(result).toMatchObject({ ok: false, code: 'entry-not-found' });
    expect(create).not.toHaveBeenCalled();
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
    ['metadata that tries to set entry_id', { metadata: { entry_id: 'other-entry' } }],
    ['an empty entry id', { entryId: '' }],
  ])('rejects %s as invalid-input without touching storage or Stripe', async (_label, overrides) => {
    const { client, create } = fakeClient();
    const storage = fakeStorage();

    const result = await createCheckoutForEntry(input(overrides), { client, storage, now: () => NOW });

    expect(result).toMatchObject({ ok: false, code: 'invalid-input' });
    expect(create).not.toHaveBeenCalled();
    expect(storage.getEntryById).not.toHaveBeenCalled();
    expect(storage.attachPayment).not.toHaveBeenCalled();
  });
});

describe('createCheckoutForEntry — failures after Stripe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a Stripe error: provider-error, nothing recorded, no URL returned', async () => {
    const { client } = fakeClient({
      create: vi.fn(async () => {
        throw new Error('api_key_expired');
      }),
    });
    const storage = fakeStorage();

    const result = await createCheckoutForEntry(input(), { client, storage, now: () => NOW });

    expect(result).toMatchObject({ ok: false, code: 'provider-error' });
    expect(result).not.toHaveProperty('url');
    expect(storage.attachPayment).not.toHaveBeenCalled();
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
 * does. `replayHeader: false` models an injected client that exposes no
 * response headers, so the package cannot tell a replay from a fresh create.
 */
function replayingClient(opts: { replayHeader?: boolean } = {}) {
  const replayHeader = opts.replayHeader ?? true;
  const byKey = new Map<string, { params: string; session: Record<string, unknown> }>();
  let created = 0;
  const create = vi.fn(async (params: { expires_at: number }, callOpts: { idempotencyKey: string }) => {
    const prior = byKey.get(callOpts.idempotencyKey);
    if (prior) {
      if (prior.params !== JSON.stringify(params)) throw new Error('idempotency_error: keys are for one request');
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
  return { client: { checkout: { sessions: { create, expire } } } as unknown as Stripe, create, expire };
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
