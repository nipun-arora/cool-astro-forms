/**
 * findReusableStripeCustomer (0.1.17) — finds the ONE Stripe Customer a
 * payment may be attributed to, and nothing else. The email it is given can
 * be typed by an anonymous visitor on the public /forms-pay page, so the
 * properties these cases pin are:
 *
 *  - Anonymous input never writes to Stripe. The lookup never creates a
 *    Customer (an abandoned or scripted submit used to leave one behind per
 *    address), never updates one (a visitor-typed name used to stick to the
 *    email's Customer for good) and sends no idempotency key (a replayed key
 *    used to hand back a Customer without the eligibility checks). Stripe
 *    creates the Customer itself when a payer confirms (`customer_creation:
 *    'always'`), and the webhook tags it after a verified payment.
 *  - Only a Customer that is safe to put in front of whoever typed the email
 *    is returned: tagged by this package, exactly that email, not deleted,
 *    and holding no payment method (Checkout in payment mode prefills a
 *    Customer's saved card for whoever opens the session).
 *  - The calls made do not depend on whether the address is known: list and
 *    Search run together every time, so neither the response time nor a
 *    side effect tells a prober which emails have paid before.
 *  - A lookup failure never blocks the payment: it answers "no Customer".
 */
import type Stripe from 'stripe';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { logError } from '../log.js';
import { adoptStripeCustomer, findReusableStripeCustomer, isIdempotentReplay } from './customers.js';

vi.mock('../log.js', () => ({ log: vi.fn(), logError: vi.fn(), warn: vi.fn() }));

/** The tag the webhook writes on a Customer after a verified payment, and the only kind the lookup returns. */
const PKG = { source: 'cool-astro-forms' };

/** The Search query the package sends for a normalized email. */
const searchQuery = (escapedEmail: string) => `email:'${escapedEmail}' AND metadata['source']:'cool-astro-forms'`;

interface FakeCustomer {
  id: string;
  email: string | null;
  created?: number;
  deleted?: boolean;
  metadata?: Record<string, string>;
  /** Ids of payment methods attached to the customer (none unless a test adds one). */
  paymentMethods?: string[];
}

type FakeMethod = 'list' | 'search' | 'listPaymentMethods';

/**
 * A small in-memory Stripe Customers API. `list` filters by EXACT email only
 * (Stripe's list `email` filter is case-sensitive and knows nothing of
 * metadata) and returns newest first; `search` answers only the package's
 * narrowed query, matching the email case-insensitively and the metadata tag
 * exactly, like the Search API; `listPaymentMethods` returns the stored
 * customer's `paymentMethods`. Every write method is a spy that should never
 * run, and `touched` records each Customers method the code reached for.
 */
function fakeStripe(seed: FakeCustomer[] = [], overrides: Partial<Record<FakeMethod, ReturnType<typeof vi.fn>>> = {}) {
  const store: FakeCustomer[] = [...seed];
  const list =
    overrides.list ??
    vi.fn(async (params: { email: string; limit?: number }) => ({
      data: store
        .filter((c) => c.email === params.email)
        .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
        .slice(0, params.limit ?? 10),
    }));
  const search =
    overrides.search ??
    vi.fn(async (params: { query: string; limit?: number }) => {
      const match = /^email:'((?:[^'\\]|\\.)*)' AND metadata\['source'\]:'cool-astro-forms'$/.exec(params.query);
      if (!match) throw new Error(`unexpected search query: ${params.query}`);
      const wanted = match[1]!.replace(/\\(['\\])/g, '$1').toLowerCase();
      return {
        data: store
          .filter((c) => c.email?.trim().toLowerCase() === wanted && c.metadata?.source === PKG.source)
          .slice(0, params.limit ?? 10),
      };
    });
  const listPaymentMethods =
    overrides.listPaymentMethods ??
    vi.fn(async (id: string, params?: { limit?: number }) => ({
      data: (store.find((c) => c.id === id)?.paymentMethods ?? []).slice(0, params?.limit ?? 10).map((pm) => ({ id: pm })),
    }));
  const create = vi.fn();
  // Merges metadata like Stripe's update, so the webhook's adopt step can be
  // followed by a lookup. Still a spy: the lookup itself must never call it.
  const update = vi.fn(async (id: string, params: { metadata?: Record<string, string> }) => {
    const customer = store.find((c) => c.id === id);
    if (!customer) throw Object.assign(new Error(`No such customer: '${id}'`), { type: 'StripeInvalidRequestError', statusCode: 404 });
    customer.metadata = { ...customer.metadata, ...params.metadata };
    return customer;
  });
  const del = vi.fn();
  const retrieve = vi.fn();
  const touched: string[] = [];
  const resource = { list, search, listPaymentMethods, create, update, del, retrieve };
  const customers = new Proxy(resource, {
    get(target, prop, receiver) {
      if (typeof prop === 'string') touched.push(prop);
      return Reflect.get(target, prop, receiver);
    },
  });
  const client = { customers } as unknown as Stripe;
  return { client, list, search, listPaymentMethods, create, update, del, retrieve, touched, store };
}

/** Every Customers write the code could make, so a test can assert none happened. */
function writes(fakes: ReturnType<typeof fakeStripe>) {
  return [fakes.create, fakes.update, fakes.del].flatMap((spy) => spy.mock.calls);
}

/**
 * The logError calls, serialized the way log.ts serializes an Error (name,
 * message, stack, plus any enumerable fields). Plain JSON.stringify writes an
 * Error as `{}`, so a leak in its message would go unseen.
 */
function serializedLogErrorCalls(): string {
  return JSON.stringify(vi.mocked(logError).mock.calls, (_key, value: unknown) =>
    value instanceof Error ? { ...value, name: value.name, message: value.message, stack: value.stack } : value,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('findReusableStripeCustomer — finds the payer a verified payment already tagged', () => {
  it('returns the tagged, card-free Customer for a known email (a repeat payer lands on the Customer of their first payment)', async () => {
    const fakes = fakeStripe([{ id: 'cus_known', email: 'guest@example.com', metadata: PKG }]);

    expect(await findReusableStripeCustomer({ email: 'guest@example.com' }, fakes.client)).toBe('cus_known');
    expect(fakes.list).toHaveBeenCalledWith({ email: 'guest@example.com', limit: 100 });
    expect(fakes.listPaymentMethods).toHaveBeenCalledWith('cus_known', { limit: 1 });
  });

  // Stripe's list `email` filter is case-sensitive. If the lookup sent the
  // address as typed, "Guest@Example.com" would never find the Customer
  // stored as "guest@example.com".
  it('looks the payer up by the trimmed, lower-cased email, so a different case on the next payment still finds them', async () => {
    const fakes = fakeStripe([{ id: 'cus_known', email: 'guest@example.com', metadata: PKG }]);

    expect(await findReusableStripeCustomer({ email: '  Guest@Example.COM ' }, fakes.client)).toBe('cus_known');
    expect(fakes.list).toHaveBeenCalledWith({ email: 'guest@example.com', limit: 100 });
    expect(fakes.search).toHaveBeenCalledWith({ query: searchQuery('guest@example.com'), limit: 10 });
  });

  // A Customer Stripe created at checkout keeps the email the payer typed
  // there, and an operator can re-case it in the dashboard: list (exact,
  // case-sensitive) misses it, Search does not.
  it('finds a tagged Customer whose stored email differs only in case through Search', async () => {
    const fakes = fakeStripe([{ id: 'cus_recased', email: 'Guest@Example.com', metadata: PKG }]);

    expect(await findReusableStripeCustomer({ email: 'guest@example.com' }, fakes.client)).toBe('cus_recased');
  });

  it("escapes a quote and a backslash in the email before it goes into the Search query (so it cannot break out of the 'value')", async () => {
    const fakes = fakeStripe();

    await findReusableStripeCustomer({ email: "o'brien\\x@example.com" }, fakes.client);

    expect(fakes.search).toHaveBeenCalledWith({ query: searchQuery("o\\'brien\\\\x@example.com"), limit: 10 });
  });

  // Tagged Customers can still share an email (two first payments at the
  // same moment each made one). Stripe lists newest first; picking the first
  // row would spread one payer's history across records.
  it('converges on the OLDEST eligible Customer across list and Search results', async () => {
    const fakes = fakeStripe([
      { id: 'cus_newest', email: 'guest@example.com', created: 300, metadata: PKG },
      { id: 'cus_oldest_recased', email: 'GUEST@example.com', created: 100, metadata: PKG },
      { id: 'cus_middle', email: 'guest@example.com', created: 200, metadata: PKG },
    ]);

    expect(await findReusableStripeCustomer({ email: 'guest@example.com' }, fakes.client)).toBe('cus_oldest_recased');
  });

  it('checks a Customer returned by both list and Search only once', async () => {
    const fakes = fakeStripe([{ id: 'cus_both', email: 'guest@example.com', created: 1, metadata: PKG, paymentMethods: ['pm_1'] }]);

    expect(await findReusableStripeCustomer({ email: 'guest@example.com' }, fakes.client)).toBeUndefined();
    expect(fakes.listPaymentMethods).toHaveBeenCalledTimes(1);
  });

  it('an unknown email answers undefined (the caller lets Stripe create the Customer at payment)', async () => {
    const fakes = fakeStripe();

    expect(await findReusableStripeCustomer({ email: 'new@example.com' }, fakes.client)).toBeUndefined();
  });

  it('an empty or whitespace-only email answers undefined without calling Stripe', async () => {
    const fakes = fakeStripe();

    expect(await findReusableStripeCustomer({ email: '   ' }, fakes.client)).toBeUndefined();
    expect(fakes.touched).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The email comes from whoever filled in the form. Checkout given `customer`
// prefills that Customer's most recently saved card, name and billing address
// and offers its redisplayable cards, so a Customer is returned only when it
// is safe to hand to a stranger who knows the address.
// ---------------------------------------------------------------------------

describe('findReusableStripeCustomer — only an eligible Customer is ever returned', () => {
  it('an untagged Customer with the same email (legacy, or another integration) is never returned', async () => {
    const fakes = fakeStripe([{ id: 'cus_legacy', email: 'guest@example.com', created: 1 }]);

    expect(await findReusableStripeCustomer({ email: 'guest@example.com' }, fakes.client)).toBeUndefined();
  });

  it('a Customer tagged by a different source is never returned', async () => {
    const fakes = fakeStripe([{ id: 'cus_other', email: 'guest@example.com', created: 1, metadata: { source: 'wp-simple-pay' } }]);

    expect(await findReusableStripeCustomer({ email: 'guest@example.com' }, fakes.client)).toBeUndefined();
  });

  it('the tagged Customer is returned even when an OLDER untagged one shares the email', async () => {
    const fakes = fakeStripe([
      { id: 'cus_legacy', email: 'guest@example.com', created: 1 },
      { id: 'cus_pkg', email: 'guest@example.com', created: 50, metadata: PKG },
    ]);

    expect(await findReusableStripeCustomer({ email: 'guest@example.com' }, fakes.client)).toBe('cus_pkg');
  });

  // The narrowed Search query is only the first filter: Search is eventually
  // consistent and matches word sequences, so the code checks every hit.
  it('a Search hit with no tag, or an email that is not exactly the normalized address, is ignored by the code itself', async () => {
    const fakes = fakeStripe([], {
      search: vi.fn(async () => ({
        data: [
          { id: 'cus_untagged', email: 'guest@example.com', created: 1 },
          { id: 'cus_near1', email: 'guest@example.com.au', created: 2, metadata: PKG },
          { id: 'cus_near2', email: 'old.guest@example.com', created: 3, metadata: PKG },
          { id: 'cus_noemail', email: null, created: 4, metadata: PKG },
        ],
      })),
    });

    expect(await findReusableStripeCustomer({ email: 'guest@example.com' }, fakes.client)).toBeUndefined();
    expect(fakes.listPaymentMethods).not.toHaveBeenCalled();
  });

  it('also filters list results by exact email and tag, so a loose list response is never trusted', async () => {
    const fakes = fakeStripe([], {
      list: vi.fn(async () => ({ data: [{ id: 'cus_other', email: 'other@example.com', created: 1, metadata: PKG }] })),
    });

    expect(await findReusableStripeCustomer({ email: 'guest@example.com' }, fakes.client)).toBeUndefined();
  });

  it('a deleted Customer is never returned', async () => {
    const fakes = fakeStripe([], {
      list: vi.fn(async () => ({ data: [{ id: 'cus_gone', email: 'guest@example.com', deleted: true, metadata: PKG }] })),
    });

    expect(await findReusableStripeCustomer({ email: 'guest@example.com' }, fakes.client)).toBeUndefined();
  });

  // The package never saves a card, but an operator or another integration
  // can add one to a tagged Customer (a setup-mode Checkout saves it with
  // allow_redisplay 'always'); Checkout would then prefill it for whoever
  // types the address.
  it('a tagged Customer holding a payment method is never returned', async () => {
    const fakes = fakeStripe([{ id: 'cus_carded', email: 'guest@example.com', created: 1, metadata: PKG, paymentMethods: ['pm_card'] }]);

    expect(await findReusableStripeCustomer({ email: 'guest@example.com' }, fakes.client)).toBeUndefined();
  });

  it('skips a carded oldest match and returns the next-oldest card-free one', async () => {
    const fakes = fakeStripe([
      { id: 'cus_carded', email: 'guest@example.com', created: 100, metadata: PKG, paymentMethods: ['pm_card'] },
      { id: 'cus_clean', email: 'guest@example.com', created: 200, metadata: PKG },
    ]);

    expect(await findReusableStripeCustomer({ email: 'guest@example.com' }, fakes.client)).toBe('cus_clean');
  });

  it('a payment-method check that fails makes that Customer ineligible (never trusted), logged without the email', async () => {
    const fakes = fakeStripe([{ id: 'cus_unknown', email: 'guest@example.com', created: 1, metadata: PKG }], {
      listPaymentMethods: vi.fn(async () => {
        throw Object.assign(new Error('Restricted key cannot read guest@example.com'), {
          type: 'StripePermissionError',
          statusCode: 403,
        });
      }),
    });

    expect(await findReusableStripeCustomer({ email: 'guest@example.com' }, fakes.client)).toBeUndefined();
    expect(logError).toHaveBeenCalledWith('stripe.customer-payment-methods-check-failed', expect.any(Error), {
      customerId: 'cus_unknown',
      statusCode: 403,
    });
    const serialized = serializedLogErrorCalls();
    expect(serialized).toContain('"message":"StripePermissionError"');
    expect(serialized).not.toContain('guest@example.com');
  });
});

// ---------------------------------------------------------------------------
// Audit (0.1.17): the lookup used to create a Customer for every new email,
// under an idempotency key, with the visitor's name. An abandoned or scripted
// submit therefore filled the owner's Stripe account with Customers, a
// visitor-chosen name stuck to the email's Customer for good, and a replayed
// idempotency key handed back a Customer the eligibility checks had skipped.
// ---------------------------------------------------------------------------

describe('findReusableStripeCustomer — anonymous input never writes to Stripe', () => {
  it.each<[string, FakeCustomer[], Partial<Record<FakeMethod, ReturnType<typeof vi.fn>>>]>([
    ['an unknown email', [], {}],
    ['an eligible tagged Customer', [{ id: 'cus_ok', email: 'guest@example.com', metadata: PKG }], {}],
    ['only an untagged Customer', [{ id: 'cus_legacy', email: 'guest@example.com' }], {}],
    ['only a carded Customer', [{ id: 'cus_c', email: 'guest@example.com', metadata: PKG, paymentMethods: ['pm_1'] }], {}],
    [
      'a list failure',
      [],
      {
        list: vi.fn(async () => {
          throw new Error('stripe unreachable');
        }),
      },
    ],
    [
      'a Search failure',
      [],
      {
        search: vi.fn(async () => {
          throw new Error('search not available in this region');
        }),
      },
    ],
  ])('%s: only list, Search and the payment-method check are called; nothing is created or updated', async (_label, seed, overrides) => {
    const fakes = fakeStripe(seed, overrides);

    await findReusableStripeCustomer({ email: 'Guest@Example.com' }, fakes.client);

    expect(writes(fakes)).toEqual([]);
    expect(fakes.retrieve).not.toHaveBeenCalled();
    expect(new Set(fakes.touched)).toEqual(
      new Set(seed.some((c) => c.metadata?.source === PKG.source) ? ['list', 'search', 'listPaymentMethods'] : ['list', 'search']),
    );
  });

  it('no call carries request options (no idempotency key that Stripe could replay)', async () => {
    const fakes = fakeStripe([{ id: 'cus_ok', email: 'guest@example.com', metadata: PKG }]);

    await findReusableStripeCustomer({ email: 'guest@example.com' }, fakes.client);

    for (const spy of [fakes.list, fakes.search]) {
      for (const call of spy.mock.calls) expect(call).toHaveLength(1);
    }
    for (const call of fakes.listPaymentMethods.mock.calls) expect(call).toHaveLength(2);
  });

  it('a hundred anonymous submits with fresh addresses leave zero Customers behind', async () => {
    const fakes = fakeStripe();

    for (let i = 0; i < 100; i += 1) {
      expect(await findReusableStripeCustomer({ email: `bot${i}@example.com` }, fakes.client)).toBeUndefined();
    }

    expect(writes(fakes)).toEqual([]);
    expect(fakes.store).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Timing: the old lookup asked Search only after list missed, so a known
// address answered faster than an unknown one (and an unknown one also made
// a Customer). Both lookups now start together on every call.
// ---------------------------------------------------------------------------

describe('findReusableStripeCustomer — the same calls whether or not the address is known', () => {
  it('starts list and Search together: Search is already in flight before list answers', async () => {
    let releaseList!: (value: { data: FakeCustomer[] }) => void;
    const list = vi.fn(() => new Promise<{ data: FakeCustomer[] }>((resolve) => (releaseList = resolve)));
    const fakes = fakeStripe([], { list });

    const pending = findReusableStripeCustomer({ email: 'guest@example.com' }, fakes.client);
    await Promise.resolve();

    expect(fakes.list).toHaveBeenCalledTimes(1);
    expect(fakes.search).toHaveBeenCalledTimes(1);
    releaseList({ data: [] });
    expect(await pending).toBeUndefined();
  });

  it('runs Search even when list already found an eligible Customer', async () => {
    const fakes = fakeStripe([{ id: 'cus_known', email: 'guest@example.com', metadata: PKG }]);

    await findReusableStripeCustomer({ email: 'guest@example.com' }, fakes.client);

    expect(fakes.search).toHaveBeenCalledTimes(1);
  });

  it('a known and an unknown address make the same list and Search calls', async () => {
    const known = fakeStripe([{ id: 'cus_known', email: 'known@example.com', metadata: PKG }]);
    const unknown = fakeStripe();

    await findReusableStripeCustomer({ email: 'known@example.com' }, known.client);
    await findReusableStripeCustomer({ email: 'unknown@example.com' }, unknown.client);

    expect(known.list).toHaveBeenCalledTimes(1);
    expect(unknown.list).toHaveBeenCalledTimes(1);
    expect(known.search).toHaveBeenCalledTimes(1);
    expect(unknown.search).toHaveBeenCalledTimes(1);
  });
});

describe('findReusableStripeCustomer — never blocks a payment', () => {
  it('a Search failure (the API is unavailable in some regions) still returns a list match, and is not logged as a lookup failure', async () => {
    const fakes = fakeStripe([{ id: 'cus_known', email: 'guest@example.com', metadata: PKG }], {
      search: vi.fn(async () => {
        throw new Error('search not available in this region');
      }),
    });

    expect(await findReusableStripeCustomer({ email: 'guest@example.com' }, fakes.client)).toBe('cus_known');
    expect(logError).not.toHaveBeenCalled();
  });

  it('a Search that throws synchronously is tolerated the same way', async () => {
    const fakes = fakeStripe([{ id: 'cus_known', email: 'guest@example.com', metadata: PKG }], {
      search: vi.fn(() => {
        throw new TypeError('search is not available');
      }),
    });

    expect(await findReusableStripeCustomer({ email: 'guest@example.com' }, fakes.client)).toBe('cus_known');
  });

  it('a list failure resolves undefined (the caller falls back to customer_creation) and logs without the email', async () => {
    const fakes = fakeStripe([], {
      list: vi.fn(async () => {
        throw Object.assign(new Error('No such thing for guest@example.com'), { type: 'StripeConnectionError', statusCode: 500 });
      }),
    });

    expect(await findReusableStripeCustomer({ email: 'guest@example.com' }, fakes.client)).toBeUndefined();
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith('stripe.customer-lookup-failed', expect.any(Error), { statusCode: 500 });
    const serialized = serializedLogErrorCalls();
    // Something useful was logged: the Stripe error type survives redaction.
    expect(serialized).toContain('"message":"StripeConnectionError"');
    expect(serialized).not.toContain('guest@example.com');
  });

  it('a client with no customers resource at all still resolves undefined instead of throwing', async () => {
    expect(await findReusableStripeCustomer({ email: 'guest@example.com' }, {} as unknown as Stripe)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Adoption: Stripe creates the payer's Customer at checkout (customer_creation
// 'always'). Once the webhook has verified that payment and marked the row
// paid, it tags that Customer, which is what makes it reusable for the same
// payer's next payment. Only a real, verified payment gets a Customer tagged.
// ---------------------------------------------------------------------------

describe('adoptStripeCustomer — tags the paying Customer after a verified payment', () => {
  it('writes only the source tag (no name, no email, nothing a visitor typed) and reports success', async () => {
    const fakes = fakeStripe([{ id: 'cus_paid', email: 'payer@example.com' }]);

    expect(await adoptStripeCustomer('cus_paid', fakes.client, { eventId: 'evt_1' })).toBe(true);
    expect(fakes.update).toHaveBeenCalledTimes(1);
    expect(fakes.update).toHaveBeenCalledWith('cus_paid', { metadata: { source: 'cool-astro-forms' } });
    expect(fakes.create).not.toHaveBeenCalled();
  });

  it("the payer's next payment, typed in a different case, finds the Customer their first payment created", async () => {
    // Stripe stored the email as the payer typed it at checkout.
    const fakes = fakeStripe([{ id: 'cus_from_checkout', email: 'payer@example.com', created: 10 }]);
    expect(await findReusableStripeCustomer({ email: 'payer@example.com' }, fakes.client)).toBeUndefined();

    await adoptStripeCustomer('cus_from_checkout', fakes.client, { eventId: 'evt_paid' });

    expect(await findReusableStripeCustomer({ email: '  PAYER@Example.com' }, fakes.client)).toBe('cus_from_checkout');
  });

  it('adopting the same Customer twice is harmless (a metadata update is idempotent)', async () => {
    const fakes = fakeStripe([{ id: 'cus_paid', email: 'payer@example.com' }]);

    expect(await adoptStripeCustomer('cus_paid', fakes.client, { eventId: 'evt_1' })).toBe(true);
    expect(await adoptStripeCustomer('cus_paid', fakes.client, { eventId: 'evt_2' })).toBe(true);
    expect(fakes.store[0]!.metadata).toEqual(PKG);
  });

  it.each(['', 'acct_123', 'guest', 'cs_test_1'])('ignores %j: only a cus_ id is ever written to', async (id) => {
    const fakes = fakeStripe();

    expect(await adoptStripeCustomer(id, fakes.client, { eventId: 'evt_1' })).toBe(false);
    expect(fakes.touched).toEqual([]);
  });

  it('a failed update never throws: false, logged as stripe.customer-adopt-failed with the event id, never the customer id or email', async () => {
    const fakes = fakeStripe();
    fakes.update.mockRejectedValueOnce(
      Object.assign(new Error("No such customer: 'cus_gone' (payer@example.com)"), {
        type: 'StripeInvalidRequestError',
        code: 'resource_missing',
        statusCode: 404,
      }),
    );

    expect(await adoptStripeCustomer('cus_gone', fakes.client, { eventId: 'evt_9' })).toBe(false);
    expect(logError).toHaveBeenCalledWith('stripe.customer-adopt-failed', expect.any(Error), {
      eventId: 'evt_9',
      statusCode: 404,
    });
    const serialized = serializedLogErrorCalls();
    expect(serialized).toContain('"message":"StripeInvalidRequestError:resource_missing"');
    expect(serialized).not.toContain('cus_gone');
    expect(serialized).not.toContain('payer@example.com');
  });

  it('a client with no customers resource resolves false instead of throwing', async () => {
    expect(await adoptStripeCustomer('cus_x', {} as unknown as Stripe, { eventId: 'evt_1' })).toBe(false);
  });
});

describe('isIdempotentReplay', () => {
  it.each<[string, unknown, boolean]>([
    ['Node client headers (plain object)', { lastResponse: { headers: { 'idempotent-replayed': 'true' } } }, true],
    ['fetch client headers (Headers)', { lastResponse: { headers: new Headers({ 'Idempotent-Replayed': 'true' }) } }, true],
    ['a fresh response', { lastResponse: { headers: { 'request-id': 'req_1' } } }, false],
    ['an object with no response metadata (an injected fake)', { id: 'x' }, false],
    ['null', null, false],
  ])('%s', (_label, value, expected) => {
    expect(isIdempotentReplay(value)).toBe(expected);
  });
});
