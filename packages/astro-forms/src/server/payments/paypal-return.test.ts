/**
 * The PayPal return page's capture step (0.1.18).
 *
 * The bug: orders were created with `intent: CAPTURE` and never captured
 * after the buyer approved them, so no money moved and
 * PAYMENT.CAPTURE.COMPLETED never fired. The buyer's return to
 * /forms-pay/paypal-return (`?token=<order id>`) now captures the order on the
 * server. What these cases protect:
 *  - only an order this install created and has not seen paid is captured
 *    (a stored PayPal row in `link_created`), never an id taken on trust from
 *    the query string;
 *  - every capture attempt is a NEW request (fresh PayPal-Request-Id), so a
 *    retry after a decline or a not-yet-approved hit is not a replay of that
 *    failure, and a reload or double hit still cannot capture twice (PayPal
 *    allows one capture per order: ORDER_ALREADY_CAPTURED reads as received);
 *  - the return page never writes: the verified PAYMENT.CAPTURE.COMPLETED
 *    webhook stays the single writer of `paid`;
 *  - the payer reads what actually happened (received, pending, declined
 *    with a way back to PayPal, or a plain error).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Payment } from '../../types.js';
import type { StorageAdapter } from '../storage/adapter.js';
import { getDb, resetDbCache } from '../storage/db.js';
import { SqliteStorage } from '../storage/sqlite.js';
import { handleInboundPayment } from '../webhooks/handle-inbound.js';
import { captureOrder, type CaptureOrderResult } from './paypal.js';
import { handlePaypalReturn } from './paypal-return.js';

vi.mock('../log.js', () => ({ log: vi.fn(), logError: vi.fn(), warn: vi.fn() }));

const ORDER_ID = '5O190127TN364715T';
const APPROVAL_URL = `https://www.sandbox.paypal.com/checkoutnow?token=${ORDER_ID}`;

function paypalRow(overrides: Partial<Payment> = {}): Payment {
  return {
    id: 'payment-1',
    entryId: 'entry-1',
    provider: 'paypal',
    amountCents: 2000,
    currency: 'usd',
    status: 'link_created',
    payLinkUrl: APPROVAL_URL,
    providerRef: ORDER_ID,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/**
 * Storage with ONE read method. Every other adapter method is a spy that
 * throws, so any write (or any read the handler has no business making)
 * fails the case and shows up in `writes`.
 */
function readOnlyStorage(row: Payment | undefined) {
  const getPaymentByProviderRef = vi.fn(async (ref: string) => (row && row.providerRef === ref ? row : undefined));
  const writes: string[] = [];
  const storage = new Proxy({ getPaymentByProviderRef } as Record<string, unknown>, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return () => {
        writes.push(prop);
        throw new Error(`unexpected storage call: ${prop}`);
      };
    },
  }) as unknown as Pick<StorageAdapter, 'getPaymentByProviderRef'>;
  return { storage, getPaymentByProviderRef, writes };
}

function run(
  token: string | null,
  opts: { row?: Payment; capture?: CaptureOrderResult | (() => Promise<CaptureOrderResult>) } = {},
) {
  const { storage, getPaymentByProviderRef, writes } = readOnlyStorage(opts.row);
  const capture = vi.fn(async (_orderId: string): Promise<CaptureOrderResult> => {
    if (typeof opts.capture === 'function') return opts.capture();
    return opts.capture ?? { ok: true, orderStatus: 'COMPLETED', captureStatus: 'COMPLETED' };
  });
  const log = vi.fn();
  const result = handlePaypalReturn({ token }, { storage, capture, log });
  return { result, capture, log, getPaymentByProviderRef, writes };
}

describe('handlePaypalReturn — which orders are captured', () => {
  it('captures a known PayPal order in link_created exactly once, and reports it received', async () => {
    const { result, capture, writes } = run(ORDER_ID, { row: paypalRow() });

    expect(await result).toEqual({ outcome: 'captured', reference: ORDER_ID });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(ORDER_ID);
    expect(writes).toEqual([]);
  });

  it('an order id with no stored row is never captured (the query string is not trusted)', async () => {
    const { result, capture } = run('9XY12345AB678901C', { row: paypalRow() });

    expect((await result).outcome).toBe('unknown-order');
    expect(capture).not.toHaveBeenCalled();
  });

  it('a stored row that is not a PayPal order (a Stripe session id) is never captured', async () => {
    const { result, capture } = run(ORDER_ID, { row: paypalRow({ provider: 'stripe' }) });

    expect((await result).outcome).toBe('unknown-order');
    expect(capture).not.toHaveBeenCalled();
  });

  it.each([null, '', 'not-an-order-id', '../../v1/oauth2/token', 'a'.repeat(20), 'A'.repeat(37)])(
    'a missing or malformed token %j is ignored before any lookup or capture',
    async (token) => {
      const { result, capture, getPaymentByProviderRef } = run(token, { row: paypalRow() });

      expect(await result).toEqual({ outcome: 'unknown-order' });
      expect(getPaymentByProviderRef).not.toHaveBeenCalled();
      expect(capture).not.toHaveBeenCalled();
    },
  );

  it('a row the webhook already marked paid is reported received without capturing again', async () => {
    const { result, capture } = run(ORDER_ID, { row: paypalRow({ status: 'paid' }) });

    expect(await result).toEqual({ outcome: 'captured', reference: ORDER_ID });
    expect(capture).not.toHaveBeenCalled();
  });

  it.each(['failed', 'refunded', 'link_sent'] as const)('a row in %s is never captured', async (status) => {
    const { result, capture } = run(ORDER_ID, { row: paypalRow({ status }) });

    expect(await result).toEqual({ outcome: 'error', reference: ORDER_ID });
    expect(capture).not.toHaveBeenCalled();
  });

  it('a storage failure on the lookup is a plain error and never reaches PayPal', async () => {
    const capture = vi.fn();
    const log = vi.fn();
    const storage = {
      getPaymentByProviderRef: vi.fn(async () => {
        throw new Error('db locked');
      }),
    };

    const result = await handlePaypalReturn({ token: ORDER_ID }, { storage, capture, log });

    expect(result).toEqual({ outcome: 'error', reference: ORDER_ID });
    expect(capture).not.toHaveBeenCalled();
  });
});

describe('handlePaypalReturn — what the payer is told', () => {
  it('a pending capture is "pending", not "received"', async () => {
    const { result } = run(ORDER_ID, {
      row: paypalRow(),
      capture: { ok: true, orderStatus: 'COMPLETED', captureStatus: 'PENDING' },
    });

    expect(await result).toEqual({ outcome: 'pending', reference: ORDER_ID });
  });

  it('ORDER_ALREADY_CAPTURED (a replayed return after the first capture) is reported received', async () => {
    const { result } = run(ORDER_ID, {
      row: paypalRow(),
      capture: { ok: false, httpStatus: 422, issue: 'ORDER_ALREADY_CAPTURED' },
    });

    expect(await result).toEqual({ outcome: 'captured', reference: ORDER_ID });
  });

  it('PREVIOUS_REQUEST_IN_PROGRESS (two hits at once) is "pending": the other request is capturing', async () => {
    const { result } = run(ORDER_ID, {
      row: paypalRow(),
      capture: { ok: false, httpStatus: 409, issue: 'PREVIOUS_REQUEST_IN_PROGRESS' },
    });

    expect((await result).outcome).toBe('pending');
  });

  it.each(['INSTRUMENT_DECLINED', 'REDIRECT_PAYER_FOR_ALTERNATE_FUNDING'])(
    '%s is "declined" with the stored approval URL, so the payer can pick another funding source in PayPal',
    async (issue) => {
      const { result } = run(ORDER_ID, { row: paypalRow(), capture: { ok: false, httpStatus: 422, issue } });

      expect(await result).toEqual({ outcome: 'declined', retryUrl: APPROVAL_URL, reference: ORDER_ID });
    },
  );

  it.each(['ORDER_NOT_APPROVED', 'PAYER_ACTION_REQUIRED'])(
    '%s is "needs-approval" with the stored approval URL (PayPal: send the payer back to approve)',
    async (issue) => {
      const { result } = run(ORDER_ID, { row: paypalRow(), capture: { ok: false, httpStatus: 422, issue } });

      expect(await result).toEqual({ outcome: 'needs-approval', retryUrl: APPROVAL_URL, reference: ORDER_ID });
    },
  );

  it('a capture that came back DECLINED inside a 2xx is "declined" without a retry link (the order itself is spent)', async () => {
    const { result } = run(ORDER_ID, {
      row: paypalRow(),
      capture: { ok: true, orderStatus: 'COMPLETED', captureStatus: 'DECLINED' },
    });

    expect(await result).toEqual({ outcome: 'declined', reference: ORDER_ID });
  });

  it('never offers a retry link that is not an https URL', async () => {
    const { result } = run(ORDER_ID, {
      row: paypalRow({ payLinkUrl: 'javascript:alert(1)' }),
      capture: { ok: false, httpStatus: 422, issue: 'INSTRUMENT_DECLINED' },
    });

    expect(await result).toEqual({ outcome: 'declined', reference: ORDER_ID });
  });

  it.each([
    [{ ok: false } as CaptureOrderResult],
    [{ ok: false, httpStatus: 500, issue: 'INTERNAL_SERVER_ERROR' } as CaptureOrderResult],
    [{ ok: false, httpStatus: 422, issue: 'ORDER_EXPIRED' } as CaptureOrderResult],
    [{ ok: true, orderStatus: 'VOIDED', captureStatus: undefined } as CaptureOrderResult],
  ])('any other result is a plain error: %j', async (capture) => {
    const { result } = run(ORDER_ID, { row: paypalRow(), capture });

    expect(await result).toEqual({ outcome: 'error', reference: ORDER_ID });
  });

  it('logs the outcome with the payment id, issue and PayPal debug id only', async () => {
    const { result, log } = run(ORDER_ID, {
      row: paypalRow(),
      capture: { ok: false, httpStatus: 422, issue: 'INSTRUMENT_DECLINED', debugId: 'dbg-1' },
    });
    await result;

    expect(log).toHaveBeenCalledWith('paypal-return.capture', {
      paymentId: 'payment-1',
      outcome: 'declined',
      httpStatus: 422,
      issue: 'INSTRUMENT_DECLINED',
      debugId: 'dbg-1',
    });
  });
});

// ---------------------------------------------------------------------------
// End to end over the real capture call (fetch mocked) and the real SQLite
// adapter: retries are new requests, one capture per order, and the
// single-writer invariant.
// ---------------------------------------------------------------------------

describe('handlePaypalReturn — replay and the webhook as the single writer of paid', () => {
  const ORIGINAL_ID = process.env.PAYPAL_CLIENT_ID;
  const ORIGINAL_SECRET = process.env.PAYPAL_CLIENT_SECRET;

  beforeEach(() => {
    process.env.PAYPAL_CLIENT_ID = 'client-id';
    process.env.PAYPAL_CLIENT_SECRET = 'client-secret';
    resetDbCache();
  });

  afterEach(() => {
    if (ORIGINAL_ID === undefined) delete process.env.PAYPAL_CLIENT_ID;
    else process.env.PAYPAL_CLIENT_ID = ORIGINAL_ID;
    if (ORIGINAL_SECRET === undefined) delete process.env.PAYPAL_CLIENT_SECRET;
    else process.env.PAYPAL_CLIENT_SECRET = ORIGINAL_SECRET;
    resetDbCache();
  });

  type CaptureAnswer = { ok: boolean; status: number; body: unknown };

  /**
   * PayPal over a mocked fetch, modelling the two rules the retry design rests
   * on (developer.paypal.com idempotency reference, Orders v2 capture errors):
   *  - a REUSED PayPal-Request-Id replays the stored answer of the first
   *    request with that id, whatever happened to the order since;
   *  - a CAPTURE-intent order is captured once; a new request after that is
   *    422 ORDER_ALREADY_CAPTURED.
   * `refusals` are the issues PayPal answers new requests with before the
   * capture goes through (e.g. INSTRUMENT_DECLINED until the payer picks
   * another funding source).
   */
  function paypalApi(refusals: string[] = []) {
    const seenRequestIds: string[] = [];
    const stored = new Map<string, CaptureAnswer>();
    const pending = [...refusals];
    let captures = 0;
    const error = (issue: string): CaptureAnswer => ({
      ok: false,
      status: 422,
      body: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue }], debug_id: 'dbg' },
    });
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes('/v1/oauth2/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok' }) };
      if (url.includes('/capture')) {
        const requestId = (init.headers as Record<string, string>)['PayPal-Request-Id']!;
        seenRequestIds.push(requestId);
        let answer = stored.get(requestId);
        if (!answer) {
          const refusal = pending.shift();
          if (captures > 0) answer = error('ORDER_ALREADY_CAPTURED');
          else if (refusal) answer = error(refusal);
          else {
            captures += 1;
            answer = {
              ok: true,
              status: 201,
              body: {
                id: ORDER_ID,
                status: 'COMPLETED',
                purchase_units: [{ payments: { captures: [{ id: 'CAPTURE-1', status: 'COMPLETED' }] } }],
              },
            };
          }
          stored.set(requestId, answer);
        }
        const { ok, status, body } = answer;
        return { ok, status, json: async () => body };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    return { fetchMock, seenRequestIds, captureCount: () => captures };
  }

  async function seed(storage: SqliteStorage) {
    const entry = await storage.createEntry({
      siteId: 'site',
      formId: '_payment_request',
      status: 'submitted',
      fields: {},
      visitorUuid: 'v-pp',
    });
    await storage.attachPayment(entry.id, {
      provider: 'paypal',
      providerRef: ORDER_ID,
      amountCents: 2000,
      currency: 'usd',
      status: 'link_created',
      payLinkUrl: APPROVAL_URL,
    });
  }

  function depsFor(storage: SqliteStorage, fetchMock: ReturnType<typeof paypalApi>['fetchMock']) {
    return {
      storage,
      capture: (orderId: string) => captureOrder(orderId, { fetch: fetchMock as unknown as typeof fetch }),
      log: vi.fn(),
    };
  }

  it('a reloaded return page is a new capture request that PayPal answers ORDER_ALREADY_CAPTURED: received, and captured once', async () => {
    const storage = new SqliteStorage(getDb(':memory:'));
    await seed(storage);
    const { fetchMock, seenRequestIds, captureCount } = paypalApi();
    const deps = depsFor(storage, fetchMock);

    const first = await handlePaypalReturn({ token: ORDER_ID }, deps);
    const reload = await handlePaypalReturn({ token: ORDER_ID }, deps);

    expect(first.outcome).toBe('captured');
    expect(reload.outcome).toBe('captured');
    expect(captureCount()).toBe(1);
    expect(seenRequestIds).toHaveLength(2);
    expect(seenRequestIds[0]).not.toBe(seenRequestIds[1]);
  });

  // The case a per-order PayPal-Request-Id broke: PayPal would replay the
  // stored refusal for the same id, so the payer who fixed the problem in
  // PayPal came back to the same failure page and the order never captured.
  it.each([
    ['INSTRUMENT_DECLINED', 'declined'],
    ['ORDER_NOT_APPROVED', 'needs-approval'],
  ] as const)(
    'after %s and the payer going back to PayPal, the next return captures the order (not a replay of the refusal)',
    async (issue, firstOutcome) => {
      const storage = new SqliteStorage(getDb(':memory:'));
      await seed(storage);
      const { fetchMock, seenRequestIds, captureCount } = paypalApi([issue]);
      const deps = depsFor(storage, fetchMock);

      const first = await handlePaypalReturn({ token: ORDER_ID }, deps);
      expect(first).toEqual({ outcome: firstOutcome, retryUrl: APPROVAL_URL, reference: ORDER_ID });

      const afterReapproval = await handlePaypalReturn({ token: ORDER_ID }, deps);
      expect(afterReapproval).toEqual({ outcome: 'captured', reference: ORDER_ID });
      expect(captureCount()).toBe(1);
      expect(seenRequestIds[0]).not.toBe(seenRequestIds[1]);
    },
  );

  it('the return page never marks the row paid; the verified PAYMENT.CAPTURE.COMPLETED webhook does', async () => {
    const storage = new SqliteStorage(getDb(':memory:'));
    await seed(storage);
    const { fetchMock } = paypalApi();

    const returned = await handlePaypalReturn({ token: ORDER_ID }, depsFor(storage, fetchMock));

    expect(returned.outcome).toBe('captured');
    const afterReturn = await storage.getPaymentByProviderRef(ORDER_ID);
    expect(afterReturn?.status).toBe('link_created');
    expect(afterReturn?.events ?? []).toEqual([]);

    // The webhook for that capture, matched through
    // resource.supplementary_data.related_ids.order_id (routes/webhooks/paypal.ts).
    const webhook = await handleInboundPayment(
      {
        providerRef: ORDER_ID,
        eventId: 'WH-1',
        eventType: 'PAYMENT.CAPTURE.COMPLETED',
        provider: 'paypal',
        amountCents: 2000,
        currency: 'usd',
      },
      { storage, notify: async () => undefined, log: vi.fn() },
    );

    expect(webhook).toEqual({ status: 200, markedPaid: true });
    expect((await storage.getPaymentByProviderRef(ORDER_ID))?.status).toBe('paid');
  });
});
