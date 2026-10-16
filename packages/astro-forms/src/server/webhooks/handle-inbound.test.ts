import { describe, expect, it, vi } from 'vitest';
import type { Entry, Payment } from '../../types.js';
import type { StorageAdapter } from '../storage/adapter.js';
import {
  handleInboundPayment,
  type HandleInboundPaymentDeps,
  type PaymentReceivedNotifyData,
} from './handle-inbound.js';

// ---------------------------------------------------------------------------
// Fixtures (mirrors handle-abandon.test.ts's makeFakeStorage/notImplemented
// conventions — same StorageAdapter shape).
// ---------------------------------------------------------------------------

function notImplemented(name: string) {
  return vi.fn(async () => {
    throw new Error(`${name} not stubbed for this test`);
  });
}

function makePayment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: 'payment-1',
    entryId: 'entry-1',
    provider: 'stripe',
    amountCents: 2000,
    currency: 'usd',
    status: 'link_created',
    providerRef: 'cs_test_1',
    events: [],
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function makeEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: 'entry-1',
    siteId: 'demo-site',
    formId: 'contact-form',
    status: 'abandoned',
    fields: {},
    visitorUuid: 'visitor-1',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function makeFakeStorage(overrides: Partial<StorageAdapter> = {}): StorageAdapter {
  return {
    createEntry: notImplemented('createEntry'),
    updateEntry: vi.fn(async (id: string, patch) => ({ ...makeEntry(), id, ...patch }) as Entry),
    findAbandoned: vi.fn(async () => undefined),
    listEntries: vi.fn(async () => []),
    countEntries: vi.fn(async () => 0),
    attachPayment: vi.fn(async () => undefined),
    attachFiles: vi.fn(async () => undefined),
    exportCsv: vi.fn(async () => ''),
    upsertAbandoned: notImplemented('upsertAbandoned') as unknown as StorageAdapter['upsertAbandoned'],
    convertAndCreateSubmitted: notImplemented(
      'convertAndCreateSubmitted',
    ) as unknown as StorageAdapter['convertAndCreateSubmitted'],
    purgeVisitor: vi.fn(async () => 0),
    purgeExpired: vi.fn(async () => 0),
    recordFormStart: vi.fn(async () => undefined),
    getFunnel: vi.fn(async () => ({ started: 0, abandoned: 0, submitted: 0, converted: 0 })),
    getTopDropOff: vi.fn(async () => []),
    getEntryById: vi.fn(async () => makeEntry()),
    deleteEntry: vi.fn(async () => false),
    getPaymentByProviderRef: vi.fn(async () => makePayment()),
    getPaymentsByEntry: vi.fn(async () => []),
    updatePayment: notImplemented('updatePayment') as unknown as StorageAdapter['updatePayment'],
    appendPaymentEventIfAbsent: vi.fn(async () => true),
    listPayments: vi.fn(async () => []),
    countPayments: vi.fn(async () => 0),
    getFilesByEntry: vi.fn(async () => []),
    findRecoverableEntries: vi.fn(async () => []),
    markConsent: vi.fn(async () => undefined),
    markRecoverySent: vi.fn(async () => true),
    suppressRecovery: vi.fn(async () => undefined),
    isRecoverySuppressed: vi.fn(async () => false),
    consumeRateLimitToken: vi.fn(async () => true),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<HandleInboundPaymentDeps> = {}): HandleInboundPaymentDeps {
  return {
    storage: makeFakeStorage(),
    notify: vi.fn(async () => undefined),
    deliver: vi.fn(),
    log: vi.fn(),
    now: () => 5000,
    ...overrides,
  };
}

const BASE_INPUT = {
  providerRef: 'cs_test_1',
  eventId: 'evt_1',
  eventType: 'checkout.session.completed',
  provider: 'stripe' as const,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleInboundPayment — unknown providerRef', () => {
  it('logs webhook.unknown-ref and returns 200 with zero side effects (nothing to flip)', async () => {
    const storage = makeFakeStorage({ getPaymentByProviderRef: vi.fn(async () => undefined) });
    const deps = makeDeps({ storage });

    const result = await handleInboundPayment(BASE_INPUT, deps);

    expect(result).toEqual({ status: 200, markedPaid: false });
    expect(deps.log).toHaveBeenCalledWith('webhook.unknown-ref', {
      providerRef: 'cs_test_1',
      provider: 'stripe',
    });
    expect(storage.appendPaymentEventIfAbsent).not.toHaveBeenCalled();
    expect(deps.notify).not.toHaveBeenCalled();
    expect(deps.deliver).not.toHaveBeenCalled();
  });
});

describe('handleInboundPayment — first completed event (atomic boolean-gated flip)', () => {
  it('calls appendPaymentEventIfAbsent with the paid patch — true → one email + one deliver', async () => {
    const appendPaymentEventIfAbsent = vi.fn(async () => true);
    const storage = makeFakeStorage({ appendPaymentEventIfAbsent });
    const deps = makeDeps({ storage });

    const result = await handleInboundPayment(BASE_INPUT, deps);

    expect(result).toEqual({ status: 200, markedPaid: true });
    expect(appendPaymentEventIfAbsent).toHaveBeenCalledTimes(1);
    expect(appendPaymentEventIfAbsent).toHaveBeenCalledWith(
      'payment-1',
      'evt_1',
      { id: 'evt_1', type: 'checkout.session.completed', at: 5000 },
      { status: 'paid' },
    );

    // Fire-and-forget notify/deliver are called synchronously inside the
    // handler (only the notify PROMISE is unawaited) — no extra tick needed.
    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(deps.notify).toHaveBeenCalledWith({
      siteId: 'demo-site',
      formId: 'contact-form',
      entryId: 'entry-1',
      provider: 'stripe',
      amountCents: 2000,
      currency: 'usd',
    } satisfies PaymentReceivedNotifyData);

    expect(deps.deliver).toHaveBeenCalledTimes(1);
    expect(deps.deliver).toHaveBeenCalledWith('payment.paid', {
      id: 'payment-1',
      entryId: 'entry-1',
      siteId: 'demo-site',
      formId: 'contact-form',
      provider: 'stripe',
      amountCents: 2000,
      currency: 'usd',
      status: 'paid',
    });
  });

  it('prefers the webhook event-supplied amountCents/currency over the stored payment row when both are present', async () => {
    const storage = makeFakeStorage();
    const deps = makeDeps({ storage });

    await handleInboundPayment({ ...BASE_INPUT, amountCents: 2600, currency: 'eur' }, deps);

    expect(deps.notify).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 2600, currency: 'eur' }),
    );
  });

  it('flips the anchor entry abandoned -> submitted when it is not already terminal', async () => {
    const updateEntry = vi.fn(async (id: string, patch) => ({ ...makeEntry(), id, ...patch }) as Entry);
    const storage = makeFakeStorage({
      getEntryById: vi.fn(async () => makeEntry({ status: 'abandoned' })),
      updateEntry,
    });
    const deps = makeDeps({ storage });

    await handleInboundPayment(BASE_INPUT, deps);

    expect(updateEntry).toHaveBeenCalledWith('entry-1', { status: 'submitted' });
  });

  it.each(['submitted', 'converted', 'spam'] as const)(
    'does NOT flip (or downgrade) an already-terminal entry status: %s',
    async (status) => {
      const updateEntry = vi.fn(async (id: string, patch) => ({ ...makeEntry(), id, ...patch }) as Entry);
      const storage = makeFakeStorage({
        getEntryById: vi.fn(async () => makeEntry({ status })),
        updateEntry,
      });
      const deps = makeDeps({ storage });

      await handleInboundPayment(BASE_INPUT, deps);

      expect(updateEntry).not.toHaveBeenCalled();
      // The paid transition itself still notifies/delivers regardless of
      // whether the entry needed a status flip.
      expect(deps.notify).toHaveBeenCalledTimes(1);
      expect(deps.deliver).toHaveBeenCalledTimes(1);
    },
  );

  it('an entry-lookup/flip throw is caught + logged — notify/deliver still fire (paid status already committed)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const storage = makeFakeStorage({
      getEntryById: vi.fn(async () => {
        throw new Error('db unavailable');
      }),
    });
    const deps = makeDeps({ storage });

    const result = await handleInboundPayment(BASE_INPUT, deps);

    expect(result).toEqual({ status: 200, markedPaid: true });
    expect(errorSpy).toHaveBeenCalled();
    const record = JSON.parse(errorSpy.mock.calls[0]![0] as string);
    expect(record.event).toBe('webhook.entry-flip-failed');
    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(deps.deliver).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('a rejecting notify is caught + logged — never an unhandled rejection, never affects the returned status', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const notify = vi.fn(async () => {
      throw new Error('smtp down');
    });
    const deps = makeDeps({ notify });

    const result = await handleInboundPayment(BASE_INPUT, deps);
    expect(result).toEqual({ status: 200, markedPaid: true });

    // Allow the fire-and-forget rejection's .catch handler to settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errorSpy).toHaveBeenCalled();
    const record = JSON.parse(errorSpy.mock.calls[0]![0] as string);
    expect(record.event).toBe('webhook.notify-failed');
    errorSpy.mockRestore();
  });

  it('deliver is optional — a caller omitting it never throws', async () => {
    const deps = makeDeps({ deliver: undefined });
    const result = await handleInboundPayment(BASE_INPUT, deps);
    expect(result).toEqual({ status: 200, markedPaid: true });
  });
});

describe('handleInboundPayment — duplicate delivery (checker W1 atomic gate)', () => {
  it('appendPaymentEventIfAbsent resolving false -> 200, ZERO email/deliver/entry-flip side effects', async () => {
    const appendPaymentEventIfAbsent = vi.fn(async () => false);
    const updateEntry = vi.fn(async (id: string, patch: Partial<Entry>) => ({ ...makeEntry(), id, ...patch }) as Entry);
    const storage = makeFakeStorage({ appendPaymentEventIfAbsent, updateEntry });
    const deps = makeDeps({ storage });

    const result = await handleInboundPayment(BASE_INPUT, deps);

    expect(result).toEqual({ status: 200, markedPaid: false });
    expect(deps.log).toHaveBeenCalledWith('webhook.duplicate-event', {
      paymentId: 'payment-1',
      eventId: 'evt_1',
    });
    expect(updateEntry).not.toHaveBeenCalled();
    expect(deps.notify).not.toHaveBeenCalled();
    expect(deps.deliver).not.toHaveBeenCalled();
  });
});

describe('handleInboundPayment — storage failures never crash the route', () => {
  it('getPaymentByProviderRef throwing is logged and resolves a safe (500) status, not an unhandled crash', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const storage = makeFakeStorage({
      getPaymentByProviderRef: vi.fn(async () => {
        throw new Error('SQLITE_BUSY: database is locked');
      }),
    });
    const deps = makeDeps({ storage });

    const result = await handleInboundPayment(BASE_INPUT, deps);

    expect(result).toEqual({ status: 500, markedPaid: false });
    expect(errorSpy).toHaveBeenCalled();
    const record = JSON.parse(errorSpy.mock.calls[0]![0] as string);
    expect(record.event).toBe('webhook.lookup-failed');
    errorSpy.mockRestore();
  });

  it('appendPaymentEventIfAbsent throwing is logged and resolves a safe (500) status, not an unhandled crash', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const storage = makeFakeStorage({
      appendPaymentEventIfAbsent: vi.fn(async () => {
        throw new Error('SQLITE_BUSY: database is locked');
      }),
    });
    const deps = makeDeps({ storage });

    const result = await handleInboundPayment(BASE_INPUT, deps);

    expect(result).toEqual({ status: 500, markedPaid: false });
    expect(errorSpy).toHaveBeenCalled();
    const record = JSON.parse(errorSpy.mock.calls[0]![0] as string);
    expect(record.event).toBe('webhook.append-event-failed');
    errorSpy.mockRestore();
  });
});

describe('handleInboundPayment — refund-type (non-completed) events', () => {
  it('appends via the same atomic primitive WITHOUT a status patch, and never notifies/delivers', async () => {
    const appendPaymentEventIfAbsent = vi.fn(async () => true);
    const updateEntry = vi.fn(async (id: string, patch: Partial<Entry>) => ({ ...makeEntry(), id, ...patch }) as Entry);
    const storage = makeFakeStorage({ appendPaymentEventIfAbsent, updateEntry });
    const deps = makeDeps({ storage });

    const result = await handleInboundPayment(
      { ...BASE_INPUT, eventType: 'charge.refunded', eventId: 'evt_refund_1' },
      deps,
    );

    expect(result).toEqual({ status: 200, markedPaid: false });
    expect(appendPaymentEventIfAbsent).toHaveBeenCalledWith(
      'payment-1',
      'evt_refund_1',
      { id: 'evt_refund_1', type: 'charge.refunded', at: 5000 },
      undefined,
    );
    expect(updateEntry).not.toHaveBeenCalled();
    expect(deps.notify).not.toHaveBeenCalled();
    expect(deps.deliver).not.toHaveBeenCalled();
  });

  it('a duplicate refund event id still resolves 200 with zero writes (same idempotency gate)', async () => {
    const appendPaymentEventIfAbsent = vi.fn(async () => false);
    const storage = makeFakeStorage({ appendPaymentEventIfAbsent });
    const deps = makeDeps({ storage });

    const result = await handleInboundPayment({ ...BASE_INPUT, eventType: 'charge.refunded' }, deps);

    expect(result).toEqual({ status: 200, markedPaid: false });
    expect(deps.notify).not.toHaveBeenCalled();
  });
});

describe('handleInboundPayment — no manual events[] read-check-write (checker W1)', () => {
  it('never reads payment.events directly — the atomic primitive is the ONLY dedupe gate', async () => {
    // A payment row whose events[] the handler must never inspect itself —
    // proven by using a Proxy that throws if `.events` is ever accessed.
    const payment = makePayment();
    const guarded = new Proxy(payment, {
      get(target, prop, receiver) {
        if (prop === 'events') {
          throw new Error('handleInboundPayment must never read payment.events directly (checker W1)');
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const storage = makeFakeStorage({ getPaymentByProviderRef: vi.fn(async () => guarded) });
    const deps = makeDeps({ storage });

    const result = await handleInboundPayment(BASE_INPUT, deps);
    expect(result).toEqual({ status: 200, markedPaid: true });
  });
});

// ---------------------------------------------------------------------------
// 0.1.15 — provider-confirmed settlement (Stripe: payment_status,
// amount_total, currency). Before this, a validly signed completion flipped
// the row to paid on its event type alone: an unpaid session (a delayed
// payment method) or a session for a different amount was recorded as paid
// money. Now the stored row is the contract and the event must match it.
// ---------------------------------------------------------------------------

describe('handleInboundPayment — settlement check (0.1.15)', () => {
  const PAID = { paid: true, amountCents: 2000, currency: 'usd' };

  it('flips to paid when the provider says paid AND the amount and currency equal the stored row', async () => {
    const appendPaymentEventIfAbsent = vi.fn(async () => true);
    const deps = makeDeps({ storage: makeFakeStorage({ appendPaymentEventIfAbsent }) });

    const result = await handleInboundPayment({ ...BASE_INPUT, settlement: PAID }, deps);

    expect(result).toEqual({ status: 200, markedPaid: true });
    expect(appendPaymentEventIfAbsent).toHaveBeenCalledWith('payment-1', 'evt_1', expect.anything(), { status: 'paid' });
    expect(deps.notify).toHaveBeenCalledTimes(1);
  });

  it('compares the currency case-insensitively (Stripe sends lowercase; a host may have stored "AED")', async () => {
    const appendPaymentEventIfAbsent = vi.fn(async () => true);
    const storage = makeFakeStorage({
      appendPaymentEventIfAbsent,
      getPaymentByProviderRef: vi.fn(async () => makePayment({ currency: 'AED', amountCents: 250000 })),
    });
    const deps = makeDeps({ storage });

    await handleInboundPayment({ ...BASE_INPUT, settlement: { paid: true, amountCents: 250000, currency: 'aed' } }, deps);

    expect(appendPaymentEventIfAbsent).toHaveBeenCalledWith('payment-1', 'evt_1', expect.anything(), { status: 'paid' });
  });

  it.each([
    ['not-paid', { paid: false, amountCents: 2000, currency: 'usd' }],
    ['amount', { paid: true, amountCents: 1999, currency: 'usd' }],
    ['currency', { paid: true, amountCents: 2000, currency: 'eur' }],
    ['amount', { paid: true, amountCents: null, currency: 'usd' }],
  ] as const)(
    'reason %s: records the event WITHOUT the paid patch, logs webhook.settlement-mismatch, and sends no email, no outbound webhook, no entry flip',
    async (reason, settlement) => {
      const appendPaymentEventIfAbsent = vi.fn(async () => true);
      const storage = makeFakeStorage({ appendPaymentEventIfAbsent });
      const deps = makeDeps({ storage });

      const result = await handleInboundPayment({ ...BASE_INPUT, settlement }, deps);

      expect(result).toEqual({ status: 200, markedPaid: false });
      expect(appendPaymentEventIfAbsent).toHaveBeenCalledWith('payment-1', 'evt_1', expect.anything(), undefined);
      expect(deps.log).toHaveBeenCalledWith(
        'webhook.settlement-mismatch',
        expect.objectContaining({
          reason,
          paymentId: 'payment-1',
          eventId: 'evt_1',
          expected: { amountCents: 2000, currency: 'usd' },
        }),
      );
      expect(deps.notify).not.toHaveBeenCalled();
      expect(deps.deliver).not.toHaveBeenCalled();
      expect(storage.updateEntry).not.toHaveBeenCalled();
    },
  );

  it('a stored row with no amount never verifies (nothing to compare against is not a match)', async () => {
    const storage = makeFakeStorage({
      getPaymentByProviderRef: vi.fn(async () => makePayment({ amountCents: undefined })),
    });
    const deps = makeDeps({ storage });

    await handleInboundPayment({ ...BASE_INPUT, settlement: PAID }, deps);

    expect(deps.notify).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith('webhook.settlement-mismatch', expect.objectContaining({ reason: 'amount' }));
  });

  it('a duplicate delivery of a mismatched event is still a no-op (the same atomic gate)', async () => {
    const storage = makeFakeStorage({ appendPaymentEventIfAbsent: vi.fn(async () => false) });
    const deps = makeDeps({ storage });

    await handleInboundPayment({ ...BASE_INPUT, settlement: { paid: false, amountCents: 2000, currency: 'usd' } }, deps);

    expect(deps.log).toHaveBeenCalledWith('webhook.duplicate-event', expect.anything());
    expect(deps.log).not.toHaveBeenCalledWith('webhook.settlement-mismatch', expect.anything());
  });

  it('checkout.session.async_payment_succeeded is a completed event: a delayed method that settles later flips the row once it is paid', async () => {
    const appendPaymentEventIfAbsent = vi.fn(async () => true);
    const deps = makeDeps({ storage: makeFakeStorage({ appendPaymentEventIfAbsent }) });

    await handleInboundPayment(
      { ...BASE_INPUT, eventId: 'evt_async', eventType: 'checkout.session.async_payment_succeeded', settlement: PAID },
      deps,
    );

    expect(appendPaymentEventIfAbsent).toHaveBeenCalledWith('payment-1', 'evt_async', expect.anything(), {
      status: 'paid',
    });
    expect(deps.notify).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 0.1.15 — fleet bug F1. The admin "Create payment link" flow stores the
// Payment Link id (plink_…) because the Checkout Session id does not exist
// until someone pays; the webhook carries the session id (cs_…). Without the
// alternate lookup those payments were acked as unknown and never marked
// paid, and nobody was emailed.
// ---------------------------------------------------------------------------

describe('handleInboundPayment — alternate provider ref (payment link, F1)', () => {
  it('when the session id matches no row, finds the row by the payment link id and flips it', async () => {
    const getPaymentByProviderRef = vi.fn(async (ref: string) =>
      ref === 'plink_1' ? makePayment({ providerRef: 'plink_1' }) : undefined,
    );
    const appendPaymentEventIfAbsent = vi.fn(async () => true);
    const deps = makeDeps({ storage: makeFakeStorage({ getPaymentByProviderRef, appendPaymentEventIfAbsent }) });

    const result = await handleInboundPayment({ ...BASE_INPUT, alternateProviderRef: 'plink_1' }, deps);

    expect(result).toEqual({ status: 200, markedPaid: true });
    expect(getPaymentByProviderRef).toHaveBeenNthCalledWith(1, 'cs_test_1');
    expect(getPaymentByProviderRef).toHaveBeenNthCalledWith(2, 'plink_1');
    expect(appendPaymentEventIfAbsent).toHaveBeenCalledWith('payment-1', 'evt_1', expect.anything(), { status: 'paid' });
    expect(deps.notify).toHaveBeenCalledTimes(1);
  });

  it('never consults the alternate ref when the session id already matches a row', async () => {
    const getPaymentByProviderRef = vi.fn(async () => makePayment());
    const deps = makeDeps({ storage: makeFakeStorage({ getPaymentByProviderRef }) });

    await handleInboundPayment({ ...BASE_INPUT, alternateProviderRef: 'plink_1' }, deps);

    expect(getPaymentByProviderRef).toHaveBeenCalledTimes(1);
  });

  it('when neither ref matches, acks 200 and logs both refs as unknown', async () => {
    const storage = makeFakeStorage({ getPaymentByProviderRef: vi.fn(async () => undefined) });
    const deps = makeDeps({ storage });

    const result = await handleInboundPayment({ ...BASE_INPUT, alternateProviderRef: 'plink_9' }, deps);

    expect(result).toEqual({ status: 200, markedPaid: false });
    expect(deps.log).toHaveBeenCalledWith('webhook.unknown-ref', {
      providerRef: 'cs_test_1',
      alternateProviderRef: 'plink_9',
      provider: 'stripe',
    });
    expect(storage.appendPaymentEventIfAbsent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 0.1.17 — Stripe customer visibility. A paid session records its Stripe
// Customer and the payer's email on the payment row so a repeat payer is
// recognisable in the admin. The values ride the SAME atomic patch as the
// paid flip (never a second write), only on a real paid transition.
// ---------------------------------------------------------------------------

describe('handleInboundPayment — payer data on the paid flip (0.1.17)', () => {
  const PAID = { paid: true, amountCents: 2000, currency: 'usd' };
  const PAYER = { customerRef: 'cus_ABC123', payerEmail: 'payer@example.com' };

  it('a paid session records its customer and payer email in the SAME atomic patch as the paid flip (one write, no second update)', async () => {
    const appendPaymentEventIfAbsent = vi.fn(async () => true);
    const updatePayment = vi.fn();
    const deps = makeDeps({
      storage: makeFakeStorage({
        appendPaymentEventIfAbsent,
        updatePayment: updatePayment as unknown as StorageAdapter['updatePayment'],
      }),
    });

    await handleInboundPayment({ ...BASE_INPUT, settlement: PAID, ...PAYER }, deps);

    expect(appendPaymentEventIfAbsent).toHaveBeenCalledTimes(1);
    expect(appendPaymentEventIfAbsent).toHaveBeenCalledWith('payment-1', 'evt_1', expect.anything(), {
      status: 'paid',
      customerRef: 'cus_ABC123',
      payerEmail: 'payer@example.com',
    });
    expect(updatePayment).not.toHaveBeenCalled();
  });

  it('works without a settlement block too (the 0.1.14 path): a completed event still carries the payer data', async () => {
    const appendPaymentEventIfAbsent = vi.fn(async () => true);
    const deps = makeDeps({ storage: makeFakeStorage({ appendPaymentEventIfAbsent }) });

    await handleInboundPayment({ ...BASE_INPUT, ...PAYER }, deps);

    expect(appendPaymentEventIfAbsent).toHaveBeenCalledWith('payment-1', 'evt_1', expect.anything(), {
      status: 'paid',
      customerRef: 'cus_ABC123',
      payerEmail: 'payer@example.com',
    });
  });

  it('an unpaid session records NO customer data: the event is appended without any patch', async () => {
    const appendPaymentEventIfAbsent = vi.fn(async () => true);
    const deps = makeDeps({ storage: makeFakeStorage({ appendPaymentEventIfAbsent }) });

    await handleInboundPayment(
      { ...BASE_INPUT, settlement: { paid: false, amountCents: 2000, currency: 'usd' }, ...PAYER },
      deps,
    );

    expect(appendPaymentEventIfAbsent).toHaveBeenCalledWith('payment-1', 'evt_1', expect.anything(), undefined);
  });

  it.each([
    ['a different amount', { paid: true, amountCents: 100, currency: 'usd' }],
    ['a different currency', { paid: true, amountCents: 2000, currency: 'eur' }],
  ])('a settlement with %s records NO customer data (the session is not this payment)', async (_label, settlement) => {
    const appendPaymentEventIfAbsent = vi.fn(async () => true);
    const deps = makeDeps({ storage: makeFakeStorage({ appendPaymentEventIfAbsent }) });

    await handleInboundPayment({ ...BASE_INPUT, settlement, ...PAYER }, deps);

    expect(appendPaymentEventIfAbsent).toHaveBeenCalledWith('payment-1', 'evt_1', expect.anything(), undefined);
  });

  it('a non-completed event (refund) never writes customer data', async () => {
    const appendPaymentEventIfAbsent = vi.fn(async () => true);
    const deps = makeDeps({ storage: makeFakeStorage({ appendPaymentEventIfAbsent }) });

    await handleInboundPayment({ ...BASE_INPUT, eventType: 'charge.refunded', ...PAYER }, deps);

    expect(appendPaymentEventIfAbsent).toHaveBeenCalledWith('payment-1', 'evt_1', expect.anything(), undefined);
  });

  it('a replayed webhook (the atomic primitive reports a duplicate) makes no further write and no side effect', async () => {
    const updatePayment = vi.fn();
    const storage = makeFakeStorage({
      appendPaymentEventIfAbsent: vi.fn(async () => false),
      updatePayment: updatePayment as unknown as StorageAdapter['updatePayment'],
    });
    const deps = makeDeps({ storage });

    const result = await handleInboundPayment({ ...BASE_INPUT, settlement: PAID, ...PAYER }, deps);

    expect(result).toEqual({ status: 200, markedPaid: false });
    expect(updatePayment).not.toHaveBeenCalled();
    expect(deps.notify).not.toHaveBeenCalled();
    expect(deps.deliver).not.toHaveBeenCalled();
  });

  it('a guest checkout (no customer, no email) keeps the patch exactly { status: "paid" }', async () => {
    const appendPaymentEventIfAbsent = vi.fn(async () => true);
    const deps = makeDeps({ storage: makeFakeStorage({ appendPaymentEventIfAbsent }) });

    await handleInboundPayment({ ...BASE_INPUT, settlement: PAID, customerRef: null, payerEmail: null }, deps);

    expect(appendPaymentEventIfAbsent).toHaveBeenCalledWith('payment-1', 'evt_1', expect.anything(), { status: 'paid' });
  });

  it('records only the half it has: an email with no customer, or a customer with no email', async () => {
    const appendPaymentEventIfAbsent = vi.fn(async () => true);
    const deps = makeDeps({ storage: makeFakeStorage({ appendPaymentEventIfAbsent }) });

    await handleInboundPayment({ ...BASE_INPUT, eventId: 'evt_a', settlement: PAID, payerEmail: 'only@example.com' }, deps);
    await handleInboundPayment({ ...BASE_INPUT, eventId: 'evt_b', settlement: PAID, customerRef: 'cus_ONLY' }, deps);

    expect(appendPaymentEventIfAbsent).toHaveBeenNthCalledWith(1, 'payment-1', 'evt_a', expect.anything(), {
      status: 'paid',
      payerEmail: 'only@example.com',
    });
    expect(appendPaymentEventIfAbsent).toHaveBeenNthCalledWith(2, 'payment-1', 'evt_b', expect.anything(), {
      status: 'paid',
      customerRef: 'cus_ONLY',
    });
  });

  it('stamps the event with the provider livemode flag so the admin can pick the test or live Stripe dashboard; omitted when the route sent none', async () => {
    const appendPaymentEventIfAbsent = vi.fn(async () => true);
    const deps = makeDeps({ storage: makeFakeStorage({ appendPaymentEventIfAbsent }) });

    await handleInboundPayment({ ...BASE_INPUT, eventId: 'evt_t', livemode: false }, deps);
    await handleInboundPayment({ ...BASE_INPUT, eventId: 'evt_l', livemode: true }, deps);
    await handleInboundPayment({ ...BASE_INPUT, eventId: 'evt_n' }, deps);

    expect(appendPaymentEventIfAbsent).toHaveBeenNthCalledWith(
      1,
      'payment-1',
      'evt_t',
      { id: 'evt_t', type: 'checkout.session.completed', at: 5000, livemode: false },
      { status: 'paid' },
    );
    expect(appendPaymentEventIfAbsent).toHaveBeenNthCalledWith(
      2,
      'payment-1',
      'evt_l',
      { id: 'evt_l', type: 'checkout.session.completed', at: 5000, livemode: true },
      { status: 'paid' },
    );
    expect(appendPaymentEventIfAbsent).toHaveBeenNthCalledWith(
      3,
      'payment-1',
      'evt_n',
      { id: 'evt_n', type: 'checkout.session.completed', at: 5000 },
      { status: 'paid' },
    );
  });

  it('never logs the payer email or customer id (PII stays out of logs), on the paid path or the mismatch path', async () => {
    const deps = makeDeps();
    await handleInboundPayment({ ...BASE_INPUT, eventId: 'evt_ok', settlement: PAID, ...PAYER }, deps);
    await handleInboundPayment(
      { ...BASE_INPUT, eventId: 'evt_bad', settlement: { paid: false, amountCents: 2000, currency: 'usd' }, ...PAYER },
      deps,
    );

    const logged = JSON.stringify((deps.log as ReturnType<typeof vi.fn>).mock.calls);
    expect(logged).not.toContain('payer@example.com');
    expect(logged).not.toContain('cus_ABC123');
  });
});

// ---------------------------------------------------------------------------
// 0.1.17 — `markedPaid` tells the calling route that THIS delivery made the
// paid flip. The Stripe route adopts the paying Customer (tags it so the
// payer's next payment can reuse it) only then: never for an unpaid or
// mismatched session, a refund, or a replay of an event already applied.
// ---------------------------------------------------------------------------

describe('handleInboundPayment — markedPaid (0.1.17)', () => {
  const PAID = { paid: true, amountCents: 2000, currency: 'usd' };

  it('is true for the delivery that flips the row, and false for the same event delivered again', async () => {
    const appendPaymentEventIfAbsent = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const deps = makeDeps({ storage: makeFakeStorage({ appendPaymentEventIfAbsent }) });

    const first = await handleInboundPayment({ ...BASE_INPUT, settlement: PAID }, deps);
    const replay = await handleInboundPayment({ ...BASE_INPUT, settlement: PAID }, deps);

    expect(first.markedPaid).toBe(true);
    expect(replay.markedPaid).toBe(false);
    expect(replay.status).toBe(first.status);
  });

  it.each([
    ['an unpaid session', { settlement: { ...PAID, paid: false } }],
    ['a different amount', { settlement: { ...PAID, amountCents: 1 } }],
    ['a refund event', { eventType: 'charge.refunded' }],
  ])('is false for %s, which is recorded but never marks the row paid', async (_label, overrides) => {
    const deps = makeDeps();

    const result = await handleInboundPayment({ ...BASE_INPUT, settlement: PAID, ...overrides }, deps);

    expect(result).toEqual({ status: 200, markedPaid: false });
  });
});
