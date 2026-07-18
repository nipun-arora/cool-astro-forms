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

    expect(result).toEqual({ status: 200 });
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

    expect(result).toEqual({ status: 200 });
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

    expect(result).toEqual({ status: 200 });
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
    expect(result).toEqual({ status: 200 });

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
    expect(result).toEqual({ status: 200 });
  });
});

describe('handleInboundPayment — duplicate delivery (checker W1 atomic gate)', () => {
  it('appendPaymentEventIfAbsent resolving false -> 200, ZERO email/deliver/entry-flip side effects', async () => {
    const appendPaymentEventIfAbsent = vi.fn(async () => false);
    const updateEntry = vi.fn(async (id: string, patch: Partial<Entry>) => ({ ...makeEntry(), id, ...patch }) as Entry);
    const storage = makeFakeStorage({ appendPaymentEventIfAbsent, updateEntry });
    const deps = makeDeps({ storage });

    const result = await handleInboundPayment(BASE_INPUT, deps);

    expect(result).toEqual({ status: 200 });
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

    expect(result).toEqual({ status: 500 });
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

    expect(result).toEqual({ status: 500 });
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

    expect(result).toEqual({ status: 200 });
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

    expect(result).toEqual({ status: 200 });
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
    expect(result).toEqual({ status: 200 });
  });
});
