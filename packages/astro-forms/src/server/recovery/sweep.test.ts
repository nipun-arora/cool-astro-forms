/**
 * sweep.ts tests — the lazy, module-gated, atomic-claim recovery sweep
 * (RCV-01/D3). Injected storage/config/now/send/resolveSecret keep every
 * case network-free; no real clock waits, no real SMTP.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoolFormsConfig } from '../../config.js';
import type { Entry } from '../../types.js';
import type { RecoveryEmailData } from '../notify.js';
import type { StorageAdapter } from '../storage/adapter.js';
import { maybeRunRecoverySweep, resetRecoverySweepGate, runRecoverySweep, type RecoverySweepDeps } from './sweep.js';
import { verifyUnsubscribeToken } from './unsubscribe-token.js';

const TEST_SECRET = 'sweep-test-secret-do-not-use-in-prod';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function notImplemented(name: string) {
  return vi.fn(async () => {
    throw new Error(`${name} not stubbed for this test`);
  });
}

type ConfigWithTrailingSlash = CoolFormsConfig & { trailingSlash?: 'always' | 'never' | 'ignore' };

function makeConfig(
  overrides: Partial<CoolFormsConfig> = {},
  trailingSlash?: 'always' | 'never' | 'ignore',
): ConfigWithTrailingSlash {
  return {
    siteId: 'demo-site',
    siteUrl: 'https://example.com',
    forms: {},
    requireConsent: false,
    journeyParams: false,
    retentionDays: 90,
    dbPath: 'data/forms.db',
    geo: { enabled: true, providerUrl: 'https://ipwho.is/{ip}', timeoutMs: 3000 },
    admin: { sessionTtlDays: 7 },
    payments: {
      payLinkFees: [],
      requestPage: { minAmountCents: 100, maxAmountCents: 1_000_000, allowedCurrencies: ['usd'] },
    },
    webhooks: [],
    drive: { linkAccess: 'private', attachmentFallbackMaxBytes: 10_485_760, rootFolderName: 'cool-astro-forms' },
    recovery: { enabled: true, delayMins: 60, consentMode: 'auto' },
    rateLimit: { store: 'memory' },
    storage: { kind: 'sqlite' },
    ...overrides,
    ...(trailingSlash ? { trailingSlash } : {}),
  };
}

function makeEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: 'entry-1',
    siteId: 'demo-site',
    formId: 'contact-form',
    status: 'abandoned',
    fields: { email: 'jane@example.com' },
    visitorUuid: 'visitor-1',
    pageUrl: '/contact',
    createdAt: 1000,
    updatedAt: 1000,
    consentAt: 1000,
    ...overrides,
  };
}

function makeFakeStorage(overrides: Partial<StorageAdapter> = {}): StorageAdapter {
  return {
    createEntry: notImplemented('createEntry'),
    updateEntry: notImplemented('updateEntry'),
    findAbandoned: vi.fn(async () => undefined),
    listEntries: vi.fn(async () => []),
    countEntries: vi.fn(async () => 0),
    attachPayment: vi.fn(async () => undefined),
    attachFiles: vi.fn(async () => undefined),
    exportCsv: vi.fn(async () => ''),
    upsertAbandoned: notImplemented('upsertAbandoned') as unknown as StorageAdapter['upsertAbandoned'],
    convertAndCreateSubmitted: notImplemented('convertAndCreateSubmitted') as unknown as StorageAdapter['convertAndCreateSubmitted'],
    purgeVisitor: vi.fn(async () => 0),
    purgeExpired: vi.fn(async () => 0),
    recordFormStart: vi.fn(async () => undefined),
    getFunnel: vi.fn(async () => ({ started: 0, abandoned: 0, submitted: 0, converted: 0 })),
    getTopDropOff: vi.fn(async () => []),
    getEntryById: vi.fn(async () => undefined),
    deleteEntry: vi.fn(async () => false),
    getPaymentByProviderRef: vi.fn(async () => undefined),
    getPaymentsByEntry: vi.fn(async () => []),
    updatePayment: notImplemented('updatePayment') as unknown as StorageAdapter['updatePayment'],
    appendPaymentEventIfAbsent: notImplemented(
      'appendPaymentEventIfAbsent',
    ) as unknown as StorageAdapter['appendPaymentEventIfAbsent'],
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

function makeDeps(overrides: Partial<RecoverySweepDeps> = {}): RecoverySweepDeps {
  return {
    storage: makeFakeStorage(),
    config: makeConfig(),
    now: () => 10_000_000,
    send: vi.fn(async () => ({ ok: true }) as unknown),
    resolveSecret: () => TEST_SECRET,
    ...overrides,
  };
}

afterEach(() => {
  resetRecoverySweepGate();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// runRecoverySweep — claim-then-send, skips, never-throws
// ---------------------------------------------------------------------------

describe('runRecoverySweep — claim-then-send', () => {
  it('claims via markRecoverySent then sends exactly one recovery email to the resolved visitor email', async () => {
    const entry = makeEntry();
    const storage = makeFakeStorage({ findRecoverableEntries: vi.fn(async () => [entry]) });
    const send = vi.fn(async (_data: RecoveryEmailData) => ({ ok: true }) as unknown);
    const deps = makeDeps({ storage, send });

    await runRecoverySweep(deps);

    expect(storage.markRecoverySent).toHaveBeenCalledWith(entry.id, deps.now!());
    expect(send).toHaveBeenCalledTimes(1);
    const sentData = send.mock.calls[0]![0] as RecoveryEmailData;
    expect(sentData.to).toBe('jane@example.com');
    expect(sentData.siteId).toBe('demo-site');
    expect(sentData.formId).toBe('contact-form');
  });

  it('resolves the email via the /email/i + valid-email heuristic — a non-email-shaped field is ignored', async () => {
    const entry = makeEntry({ fields: { name: 'Jane Doe', contactEmail: 'jane@example.com', phone: '555-1234' } });
    const storage = makeFakeStorage({ findRecoverableEntries: vi.fn(async () => [entry]) });
    const send = vi.fn(async (_data: RecoveryEmailData) => undefined);
    const deps = makeDeps({ storage, send });

    await runRecoverySweep(deps);

    const sentData = send.mock.calls[0]![0] as RecoveryEmailData;
    expect(sentData.to).toBe('jane@example.com');
  });

  it('claim-false (a concurrent sweep already won) is NOT emailed', async () => {
    const entry = makeEntry();
    const storage = makeFakeStorage({
      findRecoverableEntries: vi.fn(async () => [entry]),
      markRecoverySent: vi.fn(async () => false),
    });
    const send = vi.fn(async (_data: RecoveryEmailData) => undefined);
    const deps = makeDeps({ storage, send });

    await runRecoverySweep(deps);

    expect(storage.markRecoverySent).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it('a row with no resolvable email is skipped — no claim attempt, no send, no crash', async () => {
    const entry = makeEntry({ fields: { name: 'No Email Here' } });
    const storage = makeFakeStorage({ findRecoverableEntries: vi.fn(async () => [entry]) });
    const send = vi.fn(async (_data: RecoveryEmailData) => undefined);
    const deps = makeDeps({ storage, send });

    await expect(runRecoverySweep(deps)).resolves.toBeUndefined();

    expect(storage.markRecoverySent).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('an invalid (malformed) email-shaped field is treated as no resolvable email', async () => {
    const entry = makeEntry({ fields: { email: 'not-an-email' } });
    const storage = makeFakeStorage({ findRecoverableEntries: vi.fn(async () => [entry]) });
    const send = vi.fn(async (_data: RecoveryEmailData) => undefined);
    const deps = makeDeps({ storage, send });

    await runRecoverySweep(deps);

    expect(storage.markRecoverySent).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('processes multiple rows independently — a claim-false row does not block a claim-true row', async () => {
    const won = makeEntry({ id: 'entry-won', visitorUuid: 'visitor-won', fields: { email: 'won@example.com' } });
    const lost = makeEntry({ id: 'entry-lost', visitorUuid: 'visitor-lost', fields: { email: 'lost@example.com' } });
    const storage = makeFakeStorage({
      findRecoverableEntries: vi.fn(async () => [lost, won]),
      markRecoverySent: vi.fn(async (id: string) => id === 'entry-won'),
    });
    const send = vi.fn(async (_data: RecoveryEmailData) => undefined);
    const deps = makeDeps({ storage, send });

    await runRecoverySweep(deps);

    expect(send).toHaveBeenCalledTimes(1);
    const sentData = send.mock.calls[0]![0] as RecoveryEmailData;
    expect(sentData.to).toBe('won@example.com');
  });
});

/**
 * Per-form recovery override (04-10 gap closure, RCV-01/ROADMAP Phase 4
 * SC4 "per-form flag"). RED-first: written before the eligibility filter
 * exists in runRecoverySweep. The filter must run BEFORE resolveVisitorEmail
 * AND BEFORE the markRecoverySent claim — a filtered row must never burn
 * the atomic claim (T-04-40).
 */
describe('runRecoverySweep — per-form recovery override (04-10)', () => {
  function formConfig(overrides: Record<string, unknown> = {}) {
    return {
      abandonment: { require: 'email-or-phone' as const, dedupeWindowMins: 60, notifyOnUpdate: false },
      notifyTo: 'owner@example.com',
      ...overrides,
    };
  }

  it('emails ONLY the form-A lead under site-wide ON; form-B (recovery.enabled:false) is skipped WITHOUT a markRecoverySent call for its entry id', async () => {
    const entryA = makeEntry({ id: 'entry-a', formId: 'form-a', visitorUuid: 'visitor-a', fields: { email: 'a@example.com' } });
    const entryB = makeEntry({ id: 'entry-b', formId: 'form-b', visitorUuid: 'visitor-b', fields: { email: 'b@example.com' } });
    const markRecoverySent = vi.fn(async () => true);
    const storage = makeFakeStorage({
      findRecoverableEntries: vi.fn(async () => [entryA, entryB]),
      markRecoverySent,
    });
    const send = vi.fn(async (_data: RecoveryEmailData) => undefined);
    const config = makeConfig({
      forms: {
        'form-a': formConfig(),
        'form-b': formConfig({ recovery: { enabled: false } }),
      },
    });
    const deps = makeDeps({ storage, send, config });

    await runRecoverySweep(deps);

    expect(send).toHaveBeenCalledTimes(1);
    const sentData = send.mock.calls[0]![0] as RecoveryEmailData;
    expect(sentData.to).toBe('a@example.com');

    // The claim was attempted for A but NEVER for B's entry id — a filtered
    // row must not burn the atomic claim (it would falsely set
    // recovery_sent_at and permanently silence a lead the host may
    // re-enable).
    expect(markRecoverySent).toHaveBeenCalledWith('entry-a', expect.any(Number));
    expect(markRecoverySent).not.toHaveBeenCalledWith('entry-b', expect.any(Number));
  });

  it('an unknown formId (no forms entry at all) inherits the site-wide ON value — still emailed', async () => {
    const entry = makeEntry({ id: 'entry-ghost', formId: 'ghost-form', fields: { email: 'ghost@example.com' } });
    const storage = makeFakeStorage({ findRecoverableEntries: vi.fn(async () => [entry]) });
    const send = vi.fn(async (_data: RecoveryEmailData) => undefined);
    const deps = makeDeps({ storage, send, config: makeConfig({ forms: {} }) });

    await runRecoverySweep(deps);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a later sweep after the host removes the per-form override CAN then claim+send the legacy row', async () => {
    const entryB = makeEntry({ id: 'entry-b', formId: 'form-b', visitorUuid: 'visitor-b', fields: { email: 'b@example.com' } });
    const markRecoverySent = vi.fn(async () => true);
    const storage = makeFakeStorage({
      findRecoverableEntries: vi.fn(async () => [entryB]),
      markRecoverySent,
    });
    const send = vi.fn(async (_data: RecoveryEmailData) => undefined);

    // Pass 1: form-b is recovery-off — skipped, no claim.
    const offConfig = makeConfig({ forms: { 'form-b': formConfig({ recovery: { enabled: false } }) } });
    await runRecoverySweep(makeDeps({ storage, send, config: offConfig }));
    expect(send).not.toHaveBeenCalled();
    expect(markRecoverySent).not.toHaveBeenCalled();

    // Pass 2: host removes the override — the SAME still-unclaimed row is
    // now eligible and gets claimed + sent.
    const onConfig = makeConfig({ forms: { 'form-b': formConfig() } });
    await runRecoverySweep(makeDeps({ storage, send, config: onConfig }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(markRecoverySent).toHaveBeenCalledWith('entry-b', expect.any(Number));
  });
});

describe('runRecoverySweep — the unsubscribe link is signed + trailingSlash-aware', () => {
  it('the token embedded in unsubscribeUrl verifies back to the entry visitorUuid via the SAME secret', async () => {
    const entry = makeEntry({ visitorUuid: 'visitor-xyz' });
    const storage = makeFakeStorage({ findRecoverableEntries: vi.fn(async () => [entry]) });
    const send = vi.fn(async (_data: RecoveryEmailData) => undefined);
    const deps = makeDeps({ storage, send });

    await runRecoverySweep(deps);

    const sentData = send.mock.calls[0]![0] as RecoveryEmailData;
    const url = new URL(sentData.unsubscribeUrl);
    const token = url.searchParams.get('token');
    expect(token).toBeTruthy();
    expect(verifyUnsubscribeToken(token, TEST_SECRET)).toBe('visitor-xyz');
  });

  it('carries a trailing slash before the query string under config.trailingSlash "always"', async () => {
    const entry = makeEntry();
    const storage = makeFakeStorage({ findRecoverableEntries: vi.fn(async () => [entry]) });
    const send = vi.fn(async (_data: RecoveryEmailData) => undefined);
    const deps = makeDeps({ storage, send, config: makeConfig({}, 'always') });

    await runRecoverySweep(deps);

    const sentData = send.mock.calls[0]![0] as RecoveryEmailData;
    expect(sentData.unsubscribeUrl).toMatch(/\/api\/forms\/recovery-unsubscribe\/\?token=/);
  });

  it('is slashless when trailingSlash is unset/never/ignore', async () => {
    const entry = makeEntry();
    const storage = makeFakeStorage({ findRecoverableEntries: vi.fn(async () => [entry]) });
    const send = vi.fn(async (_data: RecoveryEmailData) => undefined);
    const deps = makeDeps({ storage, send });

    await runRecoverySweep(deps);

    const sentData = send.mock.calls[0]![0] as RecoveryEmailData;
    expect(sentData.unsubscribeUrl).toMatch(/\/api\/forms\/recovery-unsubscribe\?token=/);
  });

  it('the resume URL falls back to config.siteUrl when entry.pageUrl is absent', async () => {
    const entry = makeEntry({ pageUrl: undefined });
    const storage = makeFakeStorage({ findRecoverableEntries: vi.fn(async () => [entry]) });
    const send = vi.fn(async (_data: RecoveryEmailData) => undefined);
    const deps = makeDeps({ storage, send });

    await runRecoverySweep(deps);

    const sentData = send.mock.calls[0]![0] as RecoveryEmailData;
    expect(sentData.resumeUrl).toBe('https://example.com');
  });

  it('uses entry.pageUrl as the resume URL when present', async () => {
    const entry = makeEntry({ pageUrl: '/pricing' });
    const storage = makeFakeStorage({ findRecoverableEntries: vi.fn(async () => [entry]) });
    const send = vi.fn(async (_data: RecoveryEmailData) => undefined);
    const deps = makeDeps({ storage, send });

    await runRecoverySweep(deps);

    const sentData = send.mock.calls[0]![0] as RecoveryEmailData;
    expect(sentData.resumeUrl).toBe('/pricing');
  });
});

describe('runRecoverySweep — never throws', () => {
  it('a storage.findRecoverableEntries failure resolves without throwing', async () => {
    const storage = makeFakeStorage({
      findRecoverableEntries: vi.fn(async () => {
        throw new Error('db exploded');
      }),
    });
    const deps = makeDeps({ storage });

    await expect(runRecoverySweep(deps)).resolves.toBeUndefined();
  });

  it('a markRecoverySent failure on one row logs + continues to the next row', async () => {
    const bad = makeEntry({ id: 'entry-bad', visitorUuid: 'visitor-bad', fields: { email: 'bad@example.com' } });
    const good = makeEntry({ id: 'entry-good', visitorUuid: 'visitor-good', fields: { email: 'good@example.com' } });
    const storage = makeFakeStorage({
      findRecoverableEntries: vi.fn(async () => [bad, good]),
      markRecoverySent: vi.fn(async (id: string) => {
        if (id === 'entry-bad') throw new Error('claim exploded');
        return true;
      }),
    });
    const send = vi.fn(async (_data: RecoveryEmailData) => undefined);
    const deps = makeDeps({ storage, send });

    await expect(runRecoverySweep(deps)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
    const sentData = send.mock.calls[0]![0] as RecoveryEmailData;
    expect(sentData.to).toBe('good@example.com');
  });

  it('a send() rejection is caught — logged, does not throw, does not block later rows', async () => {
    const first = makeEntry({ id: 'entry-1', visitorUuid: 'visitor-1', fields: { email: 'first@example.com' } });
    const second = makeEntry({ id: 'entry-2', visitorUuid: 'visitor-2', fields: { email: 'second@example.com' } });
    const storage = makeFakeStorage({ findRecoverableEntries: vi.fn(async () => [first, second]) });
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('smtp exploded'))
      .mockResolvedValueOnce(undefined);
    const deps = makeDeps({ storage, send });

    await expect(runRecoverySweep(deps)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('runRecoverySweep — respects recovery.enabled and passes delayMins/BATCH_LIMIT through', () => {
  it('is a total no-op (never queries) when config.recovery.enabled is false', async () => {
    const storage = makeFakeStorage();
    const deps = makeDeps({ storage, config: makeConfig({ recovery: { enabled: false, delayMins: 60, consentMode: 'auto' } }) });

    await runRecoverySweep(deps);

    expect(storage.findRecoverableEntries).not.toHaveBeenCalled();
  });

  it('passes config.recovery.delayMins + now through to findRecoverableEntries', async () => {
    const storage = makeFakeStorage();
    const deps = makeDeps({
      storage,
      config: makeConfig({ recovery: { enabled: true, delayMins: 90, consentMode: 'auto' } }),
      now: () => 5_000_000,
    });

    await runRecoverySweep(deps);

    expect(storage.findRecoverableEntries).toHaveBeenCalledWith(90, 5_000_000, expect.any(Number));
  });
});

// ---------------------------------------------------------------------------
// maybeRunRecoverySweep — module-gated (lazy, no setTimeout), enabled-gated
// ---------------------------------------------------------------------------

describe('maybeRunRecoverySweep — module gate', () => {
  it('never queries when config.recovery.enabled is false', () => {
    const storage = makeFakeStorage();
    const deps = makeDeps({ storage, config: makeConfig({ recovery: { enabled: false, delayMins: 60, consentMode: 'auto' } }) });

    maybeRunRecoverySweep(deps);

    expect(storage.findRecoverableEntries).not.toHaveBeenCalled();
  });

  it('runs on first call and sets the gate', async () => {
    const storage = makeFakeStorage();
    const deps = makeDeps({ storage, now: () => 1_000_000 });

    maybeRunRecoverySweep(deps);
    await vi.waitFor(() => expect(storage.findRecoverableEntries).toHaveBeenCalledTimes(1));
  });

  it('a second call inside RECOVERY_SWEEP_INTERVAL_MS does not query again', async () => {
    const storage = makeFakeStorage();
    const deps1 = makeDeps({ storage, now: () => 1_000_000 });
    maybeRunRecoverySweep(deps1);
    await vi.waitFor(() => expect(storage.findRecoverableEntries).toHaveBeenCalledTimes(1));

    const deps2 = makeDeps({ storage, now: () => 1_000_000 + 60_000 }); // 1 minute later — well inside the 15min gate
    maybeRunRecoverySweep(deps2);

    expect(storage.findRecoverableEntries).toHaveBeenCalledTimes(1);
  });

  it('a call after RECOVERY_SWEEP_INTERVAL_MS queries again', async () => {
    const storage = makeFakeStorage();
    const deps1 = makeDeps({ storage, now: () => 1_000_000 });
    maybeRunRecoverySweep(deps1);
    await vi.waitFor(() => expect(storage.findRecoverableEntries).toHaveBeenCalledTimes(1));

    const deps2 = makeDeps({ storage, now: () => 1_000_000 + 15 * 60 * 1000 + 1 });
    maybeRunRecoverySweep(deps2);
    await vi.waitFor(() => expect(storage.findRecoverableEntries).toHaveBeenCalledTimes(2));
  });

  it('resetRecoverySweepGate() clears the gate so the next call queries immediately', async () => {
    const storage = makeFakeStorage();
    const deps1 = makeDeps({ storage, now: () => 1_000_000 });
    maybeRunRecoverySweep(deps1);
    await vi.waitFor(() => expect(storage.findRecoverableEntries).toHaveBeenCalledTimes(1));

    resetRecoverySweepGate();

    const deps2 = makeDeps({ storage, now: () => 1_000_001 }); // 1ms later — would be gated without the reset
    maybeRunRecoverySweep(deps2);
    await vi.waitFor(() => expect(storage.findRecoverableEntries).toHaveBeenCalledTimes(2));
  });

  it('never throws synchronously even when the underlying sweep rejects', () => {
    const storage = makeFakeStorage({
      findRecoverableEntries: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const deps = makeDeps({ storage });

    expect(() => maybeRunRecoverySweep(deps)).not.toThrow();
  });
});
