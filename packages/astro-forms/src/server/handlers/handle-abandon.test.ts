import { describe, expect, it, vi } from 'vitest';
import type { CoolFormsConfig } from '../../config.js';
import { MAX_PAYLOAD_BYTES } from '../../limits.js';
import { HONEYPOT_FIELD_NAME, type Entry } from '../../types.js';
import type { AbandonedLeadEmailData } from '../notify.js';
import type { RateLimiter } from '../security/rate-limit.js';
import type { StorageAdapter, UpsertAbandonedResult } from '../storage/adapter.js';
import { handleAbandon, resetAbandonPurgeGate, type HandleAbandonDeps } from './handle-abandon.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeConfig(abandonmentOverrides: Partial<CoolFormsConfig['forms'][string]['abandonment']> = {}): CoolFormsConfig {
  return {
    siteId: 'demo-site',
    siteUrl: 'https://example.com',
    forms: {
      'contact-form': {
        abandonment: {
          require: 'email-or-phone',
          dedupeWindowMins: 60,
          notifyOnUpdate: false,
          ...abandonmentOverrides,
        },
        notifyTo: 'owner@example.com',
      },
    },
    requireConsent: false,
    journeyParams: false,
    retentionDays: 90,
    dbPath: 'data/forms.db',
    geo: { enabled: true, providerUrl: 'https://ipwho.is/{ip}', timeoutMs: 3000 },
    admin: { sessionTtlDays: 7 },
    payments: { payLinkFees: [], requestPage: { minAmountCents: 100, maxAmountCents: 1_000_000, allowedCurrencies: ['usd'] } },
    webhooks: [],
    drive: { linkAccess: 'private', attachmentFallbackMaxBytes: 10_485_760, rootFolderName: 'cool-astro-forms' },
    recovery: { enabled: false, delayMins: 60, consentMode: 'auto' },
    rateLimit: { store: 'memory' },
    storage: { kind: 'sqlite' },
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
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function notImplemented(name: string) {
  return vi.fn(async () => {
    throw new Error(`${name} not stubbed for this test`);
  });
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

function makeFakeRateLimiter(allow = true): RateLimiter {
  return {
    allow: vi.fn(() => allow),
    size: vi.fn(() => 0),
    clear: vi.fn(),
  };
}

interface MakeInputOptions {
  origin?: string;
  cookie?: string;
  body?: Record<string, unknown>;
  ip?: string;
}

function makeInput(opts: MakeInputOptions = {}) {
  const headers = new Headers();
  headers.set('Origin', opts.origin ?? 'https://example.com');
  if (opts.cookie) headers.set('Cookie', opts.cookie);
  const payload = {
    siteId: 'demo-site',
    formId: 'contact-form',
    visitorUuid: 'visitor-1',
    fields: { email: 'jane@example.com' },
    ...opts.body,
  };
  return {
    body: JSON.stringify(payload),
    headers,
    ip: opts.ip ?? '203.0.113.5',
  };
}

function makeDeps(overrides: Partial<HandleAbandonDeps> = {}): HandleAbandonDeps {
  return {
    config: makeConfig(),
    storage: makeFakeStorage(),
    notify: vi.fn(async () => ({})),
    rateLimiter: makeFakeRateLimiter(),
    log: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Rejects (steps 1-5) — every branch must log exactly once via deps.log
// ---------------------------------------------------------------------------

describe('handleAbandon — origin check', () => {
  it('cross-origin Origin header -> 403 {saved:false, reason:"origin"}; no storage call; deps.log called once', async () => {
    const upsertAbandoned = vi.fn();
    const log = vi.fn();
    const result = await handleAbandon(
      makeInput({ origin: 'https://evil.example' }),
      makeDeps({ storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never }), log }),
    );
    expect(result.status).toBe(403);
    expect(JSON.parse(result.body)).toEqual({ saved: false, reason: 'origin' });
    expect(upsertAbandoned).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![1]).toMatchObject({ reason: 'origin' });
  });
});

describe('handleAbandon — size cap', () => {
  it('oversized body -> 413 {saved:false, reason:"payload"}; deps.log called once', async () => {
    const log = vi.fn();
    const oversized = 'x'.repeat(MAX_PAYLOAD_BYTES + 1);
    const result = await handleAbandon(
      { body: oversized, headers: new Headers({ Origin: 'https://example.com' }), ip: '203.0.113.5' },
      makeDeps({ log }),
    );
    expect(result.status).toBe(413);
    expect(JSON.parse(result.body)).toEqual({ saved: false, reason: 'payload' });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![1]).toMatchObject({ reason: 'payload' });
  });
});

describe('handleAbandon — rate limit', () => {
  it('rate limiter denies -> 429 {saved:false, reason:"rate-limit"}; deps.log called once', async () => {
    const log = vi.fn();
    const result = await handleAbandon(
      makeInput({}),
      makeDeps({ rateLimiter: makeFakeRateLimiter(false), log }),
    );
    expect(result.status).toBe(429);
    expect(JSON.parse(result.body)).toEqual({ saved: false, reason: 'rate-limit' });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![1]).toMatchObject({ reason: 'rate-limit' });
  });
});

describe('handleAbandon — parse + unknown site/form id', () => {
  it('malformed JSON body -> 400 {saved:false, reason:"invalid"}; deps.log called once', async () => {
    const log = vi.fn();
    const result = await handleAbandon(
      { body: '{not valid json', headers: new Headers({ Origin: 'https://example.com' }), ip: '203.0.113.5' },
      makeDeps({ log }),
    );
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body)).toEqual({ saved: false, reason: 'invalid' });
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('unknown siteId -> 400 {saved:false, reason:"invalid"}', async () => {
    const result = await handleAbandon(makeInput({ body: { siteId: 'someone-elses-site' } }), makeDeps());
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body)).toEqual({ saved: false, reason: 'invalid' });
  });

  it('unknown formId -> 400 {saved:false, reason:"invalid"}; no storage call; deps.log called once', async () => {
    const upsertAbandoned = vi.fn();
    const log = vi.fn();
    const result = await handleAbandon(
      makeInput({ body: { formId: 'does-not-exist' } }),
      makeDeps({ storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never }), log }),
    );
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body)).toEqual({ saved: false, reason: 'invalid' });
    expect(upsertAbandoned).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe('handleAbandon — honeypot', () => {
  it('honeypot filled (payload.honeypot) -> 204 body-less, no save, no notify; deps.log called once', async () => {
    const upsertAbandoned = vi.fn();
    const notify = vi.fn();
    const log = vi.fn();
    const result = await handleAbandon(
      makeInput({ body: { honeypot: 'i-am-a-bot' } }),
      makeDeps({ storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never }), notify, log }),
    );
    expect(result.status).toBe(204);
    expect(result.body).toBe('');
    expect(upsertAbandoned).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('honeypot value carried inside fields[HONEYPOT_FIELD_NAME] (direct bot POST) also trips the guard', async () => {
    const upsertAbandoned = vi.fn();
    const result = await handleAbandon(
      makeInput({ body: { fields: { email: 'a@b.com', [HONEYPOT_FIELD_NAME]: 'bot-filled' } } }),
      makeDeps({ storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never }) }),
    );
    expect(result.status).toBe(204);
    expect(upsertAbandoned).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Visitor identity (S3-F1)
// ---------------------------------------------------------------------------

describe('handleAbandon — visitor identity', () => {
  it('cookie-present + forged payload uuid: the row is keyed by the COOKIE uuid, not the payload uuid', async () => {
    const upsertAbandoned = vi.fn(
      async (input: { visitorUuid: string }): Promise<UpsertAbandonedResult> => ({
        outcome: 'created',
        entry: makeEntry({ visitorUuid: input.visitorUuid }),
      }),
    );
    await handleAbandon(
      makeInput({ cookie: '_caf_uid=cookie-uuid-real', body: { visitorUuid: 'forged-uuid-attacker' } }),
      makeDeps({ storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never }) }),
    );
    const call = upsertAbandoned.mock.calls[0]![0] as { visitorUuid: string };
    expect(call.visitorUuid).toBe('cookie-uuid-real');
  });

  it('falls back to payload.visitorUuid when no cookie is present', async () => {
    const upsertAbandoned = vi.fn(
      async (input: { visitorUuid: string }): Promise<UpsertAbandonedResult> => ({
        outcome: 'created',
        entry: makeEntry({ visitorUuid: input.visitorUuid }),
      }),
    );
    await handleAbandon(
      makeInput({ body: { visitorUuid: 'payload-uuid-only' } }),
      makeDeps({ storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never }) }),
    );
    const call = upsertAbandoned.mock.calls[0]![0] as { visitorUuid: string };
    expect(call.visitorUuid).toBe('payload-uuid-only');
  });
});

// ---------------------------------------------------------------------------
// Gate (ABND-02)
// ---------------------------------------------------------------------------

describe('handleAbandon — gate', () => {
  it('gate-unmet (email-or-phone, neither present) -> 200 {saved:false, reason:"gate"}; no storage/notify call', async () => {
    const upsertAbandoned = vi.fn();
    const notify = vi.fn();
    const log = vi.fn();
    const result = await handleAbandon(
      makeInput({ body: { fields: { name: 'Jane Doe' } } }),
      makeDeps({ storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never }), notify, log }),
    );
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ saved: false, reason: 'gate' });
    expect(upsertAbandoned).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('gate-unmet when the email field value is not well-formed (invalid, not just present)', async () => {
    const result = await handleAbandon(
      makeInput({ body: { fields: { email: 'not-an-email' } } }),
      makeDeps(),
    );
    expect(JSON.parse(result.body)).toEqual({ saved: false, reason: 'gate' });
  });

  it('gate-met via a valid phone field (non-empty, no email present)', async () => {
    const upsertAbandoned = vi.fn(async (): Promise<UpsertAbandonedResult> => ({ outcome: 'created', entry: makeEntry() }));
    const result = await handleAbandon(
      makeInput({ body: { fields: { phone: '+15551234567' } } }),
      makeDeps({ storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never }) }),
    );
    expect(JSON.parse(result.body)).toEqual({ saved: true, deduped: false });
  });

  it('"always" mode saves without email/phone present', async () => {
    const upsertAbandoned = vi.fn(async (): Promise<UpsertAbandonedResult> => ({ outcome: 'created', entry: makeEntry() }));
    const result = await handleAbandon(
      makeInput({ body: { fields: { note: 'no contact info' } } }),
      makeDeps({
        config: makeConfig({ require: 'always' }),
        storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never }),
      }),
    );
    expect(JSON.parse(result.body)).toEqual({ saved: true, deduped: false });
    expect(upsertAbandoned).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Dedupe + notify (ABND-03)
// ---------------------------------------------------------------------------

describe('handleAbandon — dedupe + notify', () => {
  it('gate-met: upserts a created entry, fires notify exactly once, returns 200 {saved:true, deduped:false}', async () => {
    const notify = vi.fn(async (_data: AbandonedLeadEmailData) => ({}));
    const upsertAbandoned = vi.fn(async (): Promise<UpsertAbandonedResult> => ({ outcome: 'created', entry: makeEntry() }));
    const log = vi.fn();
    const result = await handleAbandon(
      makeInput({}),
      makeDeps({ storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never }), notify, log }),
    );
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ saved: true, deduped: false });
    expect(upsertAbandoned).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    const notifyArg = notify.mock.calls[0]![0] as { notifyTo: string; siteId: string; formId: string };
    expect(notifyArg.notifyTo).toBe('owner@example.com');
    expect(notifyArg.siteId).toBe('demo-site');
    expect(notifyArg.formId).toBe('contact-form');
    expect(log).not.toHaveBeenCalled();
  });

  it('dedupe-hit (outcome updated) returns {saved:true, deduped:true}; notify SKIPPED by default (notifyOnUpdate false)', async () => {
    const notify = vi.fn(async () => ({}));
    const upsertAbandoned = vi.fn(async (): Promise<UpsertAbandonedResult> => ({ outcome: 'updated', entry: makeEntry() }));
    const result = await handleAbandon(
      makeInput({}),
      makeDeps({
        config: makeConfig({ notifyOnUpdate: false }),
        storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never }),
        notify,
      }),
    );
    expect(JSON.parse(result.body)).toEqual({ saved: true, deduped: true });
    expect(notify).not.toHaveBeenCalled();
  });

  it('dedupe-hit (outcome updated): notify CALLED when notifyOnUpdate is true', async () => {
    const notify = vi.fn(async () => ({}));
    const upsertAbandoned = vi.fn(async (): Promise<UpsertAbandonedResult> => ({ outcome: 'updated', entry: makeEntry() }));
    const result = await handleAbandon(
      makeInput({}),
      makeDeps({
        config: makeConfig({ notifyOnUpdate: true }),
        storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never }),
        notify,
      }),
    );
    expect(JSON.parse(result.body)).toEqual({ saved: true, deduped: true });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('already-converted: no-ops with 200 {saved:false, reason:"duplicate"}; no notify; deps.log called once', async () => {
    const notify = vi.fn(async () => ({}));
    const upsertAbandoned = vi.fn(async (): Promise<UpsertAbandonedResult> => ({ outcome: 'already-converted' }));
    const log = vi.fn();
    const result = await handleAbandon(
      makeInput({}),
      makeDeps({ storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never }), notify, log }),
    );
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ saved: false, reason: 'duplicate' });
    expect(notify).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![1]).toMatchObject({ reason: 'duplicate' });
  });

  it('does not await notify before returning the response (fire-and-forget)', async () => {
    let resolveNotify: (() => void) | undefined;
    const notify = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          resolveNotify = () => resolve({});
        }),
    );
    const upsertAbandoned = vi.fn(async (): Promise<UpsertAbandonedResult> => ({ outcome: 'created', entry: makeEntry() }));
    const result = await handleAbandon(
      makeInput({}),
      makeDeps({ storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never }), notify }),
    );
    expect(result.status).toBe(200);
    expect(notify).toHaveBeenCalledTimes(1);
    // The notify promise is still pending at this point — resolving it now
    // proves handleAbandon() did not block the response on it.
    resolveNotify?.();
  });

  it('a notify rejection is caught (fire-and-forget .catch) — response stays 200 with the save intact', async () => {
    const notify = vi.fn(async () => {
      throw new Error('smtp down');
    });
    const upsertAbandoned = vi.fn(async (): Promise<UpsertAbandonedResult> => ({ outcome: 'created', entry: makeEntry() }));
    const result = await handleAbandon(
      makeInput({}),
      makeDeps({ storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never }), notify }),
    );
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ saved: true, deduped: false });
    // Allow the fire-and-forget rejection's .catch handler to settle before
    // the test exits — proves no unhandled rejection escapes handleAbandon.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Storage failure
// ---------------------------------------------------------------------------

describe('handleAbandon — storage failure', () => {
  it('storage throws (SQLITE_BUSY simulated) -> 500 {saved:false, reason:"error"}; logError called; no unhandled rejection', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const upsertAbandoned = vi.fn(async () => {
      throw new Error('SQLITE_BUSY: database is locked');
    });
    const result = await handleAbandon(
      makeInput({}),
      makeDeps({ storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never }) }),
    );
    expect(result.status).toBe(500);
    expect(JSON.parse(result.body)).toEqual({ saved: false, reason: 'error' });
    expect(errorSpy).toHaveBeenCalled();
    const record = JSON.parse(errorSpy.mock.calls[0]![0] as string);
    expect(record.event).toBe('abandon.storage-failed');
    errorSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Journey wiring (JRNY-02 pinned shape)
// ---------------------------------------------------------------------------

describe('handleAbandon — journey wiring', () => {
  it('stores recomputeJourney(...).steps — a JourneyStep[] — not the raw client array or the {steps,totalSteps,totalElapsedMs} wrapper', async () => {
    const upsertAbandoned = vi.fn(
      async (input: { journey?: unknown }): Promise<UpsertAbandonedResult> => ({
        outcome: 'created',
        entry: makeEntry({ journey: input.journey as never }),
      }),
    );
    const journeyPayload = [
      { url: '/a', title: 'A', ts: 1000, duration: 999999 },
      { url: '/b', title: 'B', ts: 4000 },
    ];
    const result = await handleAbandon(
      makeInput({ body: { journey: journeyPayload } }),
      makeDeps({
        storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never }),
        now: () => 5000,
      }),
    );
    expect(result.status).toBe(200);
    const call = upsertAbandoned.mock.calls[0]![0] as { journey: Array<Record<string, unknown>> };
    expect(Array.isArray(call.journey)).toBe(true);
    expect(call.journey).not.toHaveProperty('totalSteps');
    expect(call.journey).not.toHaveProperty('totalElapsedMs');
    expect(call.journey[0]!.durationMs).toBe(3000);
    expect(call.journey[0]!.duration).toBeUndefined();
  });

  it('accepts the external referrer-seed flag through the payload schema and persists it (traffic source)', async () => {
    const upsertAbandoned = vi.fn(
      async (input: { journey?: unknown }): Promise<UpsertAbandonedResult> => ({
        outcome: 'created',
        entry: makeEntry({ journey: input.journey as never }),
      }),
    );
    const journeyPayload = [
      { url: 'https://www.google.com/', title: 'www.google.com', ts: 1000, external: true },
      { url: '/b', title: 'B', ts: 4000 },
    ];
    const result = await handleAbandon(
      makeInput({ body: { journey: journeyPayload } }),
      makeDeps({
        storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never }),
        now: () => 5000,
      }),
    );
    expect(result.status).toBe(200);
    const call = upsertAbandoned.mock.calls[0]![0] as { journey: Array<Record<string, unknown>> };
    expect(call.journey[0]).toEqual(
      expect.objectContaining({ url: 'https://www.google.com/', external: true }),
    );
    expect(call.journey[1]).not.toHaveProperty('external');
  });

  it('threads config.journeyParams through recomputeJourney — params stripped from the stored entry by default', async () => {
    const upsertAbandoned = vi.fn(
      async (input: { journey?: unknown }): Promise<UpsertAbandonedResult> => ({
        outcome: 'created',
        entry: makeEntry({ journey: input.journey as never }),
      }),
    );
    await handleAbandon(
      makeInput({ body: { journey: [{ url: '/a?x=1', title: 'A', ts: 1000, params: { x: '1' } }] } }),
      makeDeps({
        config: makeConfig(),
        storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never }),
        now: () => 2000,
      }),
    );
    const call = upsertAbandoned.mock.calls[0]![0] as { journey: Array<Record<string, unknown>> };
    expect(call.journey[0]!.params).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Geo enrichment (GEO-01) + last_field passthrough (ANLY-01 D1)
// ---------------------------------------------------------------------------

describe('handleAbandon — geo enrichment', () => {
  it('an injected geo stub resolving a Geo is forwarded to upsertAbandoned and the notify payload; response stays {saved:true}', async () => {
    const geoValue = { city: 'Metropolis', region: 'NY', country: 'US' };
    const geo = vi.fn(async () => geoValue);
    const notify = vi.fn(async (_data: AbandonedLeadEmailData) => ({}));
    const upsertAbandoned = vi.fn(
      async (input: { geo?: unknown }): Promise<UpsertAbandonedResult> => ({
        outcome: 'created',
        entry: makeEntry({ geo: input.geo as never }),
      }),
    );
    const result = await handleAbandon(
      makeInput({}),
      makeDeps({ storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never }), notify, geo }),
    );
    expect(JSON.parse(result.body)).toEqual({ saved: true, deduped: false });
    expect(geo).toHaveBeenCalledWith('203.0.113.5');
    const upsertCall = upsertAbandoned.mock.calls[0]![0] as { geo?: unknown };
    expect(upsertCall.geo).toEqual(geoValue);
    const notifyCall = notify.mock.calls[0]![0] as { geo?: unknown };
    expect(notifyCall.geo).toEqual(geoValue);
  });

  it('a geo stub resolving undefined (or no geo dep at all) leaves the save unaffected — geo undefined on upsertAbandoned', async () => {
    const upsertAbandoned = vi.fn(
      async (_input: { geo?: unknown }): Promise<UpsertAbandonedResult> => ({
        outcome: 'created',
        entry: makeEntry(),
      }),
    );
    const result = await handleAbandon(
      makeInput({}),
      makeDeps({ storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never }) }), // no geo dep
    );
    expect(JSON.parse(result.body)).toEqual({ saved: true, deduped: false });
    const upsertCall = upsertAbandoned.mock.calls[0]![0] as { geo?: unknown };
    expect(upsertCall.geo).toBeUndefined();
  });

  it('an injected geo stub that rejects never blocks the save — geo resolves undefined', async () => {
    const geo = vi.fn(async () => {
      throw new Error('geo lookup exploded');
    });
    const upsertAbandoned = vi.fn(
      async (_input: { geo?: unknown }): Promise<UpsertAbandonedResult> => ({ outcome: 'created', entry: makeEntry() }),
    );
    const result = await handleAbandon(
      makeInput({}),
      makeDeps({ storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never }), geo }),
    );
    expect(JSON.parse(result.body)).toEqual({ saved: true, deduped: false });
    const upsertCall = upsertAbandoned.mock.calls[0]![0] as { geo?: unknown };
    expect(upsertCall.geo).toBeUndefined();
  });
});

describe('handleAbandon — last_field passthrough (ANLY-01 D1)', () => {
  it('payload.lastField flows through to upsertAbandoned as lastField', async () => {
    const upsertAbandoned = vi.fn(
      async (_input: { lastField?: string }): Promise<UpsertAbandonedResult> => ({ outcome: 'created', entry: makeEntry() }),
    );
    await handleAbandon(
      makeInput({ body: { lastField: 'email' } }),
      makeDeps({ storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never }) }),
    );
    const call = upsertAbandoned.mock.calls[0]![0] as { lastField?: string };
    expect(call.lastField).toBe('email');
  });

  it('omitted lastField flows through as undefined', async () => {
    const upsertAbandoned = vi.fn(
      async (_input: { lastField?: string }): Promise<UpsertAbandonedResult> => ({ outcome: 'created', entry: makeEntry() }),
    );
    await handleAbandon(
      makeInput({}),
      makeDeps({ storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never }) }),
    );
    const call = upsertAbandoned.mock.calls[0]![0] as { lastField?: string };
    expect(call.lastField).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Turnstile-flag seam (D3)
// ---------------------------------------------------------------------------

describe('handleAbandon — turnstile-flag seam (D3)', () => {
  it('on outcome "created", verifyToken is awaited exactly once with (token, ip) read from the _caf envelope', async () => {
    const verifyToken = vi.fn(async () => ({ ok: true }));
    const upsertAbandoned = vi.fn(async (): Promise<UpsertAbandonedResult> => ({ outcome: 'created', entry: makeEntry() }));
    await handleAbandon(
      makeInput({
        body: { fields: { email: 'jane@example.com', _caf: JSON.stringify({ turnstileToken: 'tok-abc' }) } },
      }),
      makeDeps({ storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never }), verifyToken }),
    );
    expect(verifyToken).toHaveBeenCalledTimes(1);
    expect(verifyToken).toHaveBeenCalledWith('tok-abc', '203.0.113.5');
  });

  it('a missing _caf envelope resolves an undefined token, still passed to verifyToken', async () => {
    const verifyToken = vi.fn(async () => ({ ok: true }));
    const upsertAbandoned = vi.fn(async (): Promise<UpsertAbandonedResult> => ({ outcome: 'created', entry: makeEntry() }));
    await handleAbandon(
      makeInput({}),
      makeDeps({ storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never }), verifyToken }),
    );
    expect(verifyToken).toHaveBeenCalledWith(undefined, '203.0.113.5');
  });

  it('a malformed _caf envelope resolves an undefined token instead of throwing', async () => {
    const verifyToken = vi.fn(async () => ({ ok: true }));
    const upsertAbandoned = vi.fn(async (): Promise<UpsertAbandonedResult> => ({ outcome: 'created', entry: makeEntry() }));
    const result = await handleAbandon(
      makeInput({ body: { fields: { email: 'jane@example.com', _caf: '{not valid json' } } }),
      makeDeps({ storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never }), verifyToken }),
    );
    expect(JSON.parse(result.body)).toEqual({ saved: true, deduped: false });
    expect(verifyToken).toHaveBeenCalledWith(undefined, '203.0.113.5');
  });

  it('{ok:false} persists fields._turnstile="failed" on the created row via storage.updateEntry and soft-logs; save stands as {saved:true}', async () => {
    const verifyToken = vi.fn(async () => ({ ok: false }));
    const entry = makeEntry({ id: 'entry-created', fields: { email: 'jane@example.com' } });
    const upsertAbandoned = vi.fn(async (): Promise<UpsertAbandonedResult> => ({ outcome: 'created', entry }));
    const updateEntry = vi.fn(async () => entry);
    const log = vi.fn();
    const result = await handleAbandon(
      makeInput({}),
      makeDeps({
        storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never, updateEntry: updateEntry as never }),
        verifyToken,
        log,
      }),
    );
    expect(JSON.parse(result.body)).toEqual({ saved: true, deduped: false });
    expect(updateEntry).toHaveBeenCalledWith('entry-created', {
      fields: { email: 'jane@example.com', _turnstile: 'failed' },
    });
    expect(log).toHaveBeenCalledWith(
      'abandon.turnstile-failed',
      expect.objectContaining({ siteId: 'demo-site', formId: 'contact-form' }),
    );
  });

  it('{ok:true} writes no flag and logs no turnstile-failed event', async () => {
    const verifyToken = vi.fn(async () => ({ ok: true }));
    const upsertAbandoned = vi.fn(async (): Promise<UpsertAbandonedResult> => ({ outcome: 'created', entry: makeEntry() }));
    const updateEntry = vi.fn(async () => makeEntry());
    const log = vi.fn();
    const result = await handleAbandon(
      makeInput({}),
      makeDeps({
        storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never, updateEntry: updateEntry as never }),
        verifyToken,
        log,
      }),
    );
    expect(JSON.parse(result.body)).toEqual({ saved: true, deduped: false });
    expect(updateEntry).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalledWith('abandon.turnstile-failed', expect.anything());
  });

  it('a verifyToken rejection is caught — logError only, save stands unaffected (never a 500)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const verifyToken = vi.fn(async () => {
      throw new Error('siteverify unreachable');
    });
    const upsertAbandoned = vi.fn(async (): Promise<UpsertAbandonedResult> => ({ outcome: 'created', entry: makeEntry() }));
    const result = await handleAbandon(
      makeInput({}),
      makeDeps({ storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never }), verifyToken }),
    );
    expect(JSON.parse(result.body)).toEqual({ saved: true, deduped: false });
    expect(errorSpy).toHaveBeenCalled();
    const record = JSON.parse(errorSpy.mock.calls[0]![0] as string);
    expect(record.event).toBe('abandon.turnstile-check-failed');
    errorSpy.mockRestore();
  });

  it('an updateEntry throw while persisting the flag is caught — logError only, save still stands', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const verifyToken = vi.fn(async () => ({ ok: false }));
    const upsertAbandoned = vi.fn(async (): Promise<UpsertAbandonedResult> => ({ outcome: 'created', entry: makeEntry() }));
    const updateEntry = vi.fn(async () => {
      throw new Error('SQLITE_BUSY');
    });
    const result = await handleAbandon(
      makeInput({}),
      makeDeps({
        storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never, updateEntry: updateEntry as never }),
        verifyToken,
      }),
    );
    expect(JSON.parse(result.body)).toEqual({ saved: true, deduped: false });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('verifyToken is NOT invoked on outcome "updated" (dedupe hit)', async () => {
    const verifyToken = vi.fn(async () => ({ ok: true }));
    const upsertAbandoned = vi.fn(async (): Promise<UpsertAbandonedResult> => ({ outcome: 'updated', entry: makeEntry() }));
    await handleAbandon(
      makeInput({}),
      makeDeps({ storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never }), verifyToken }),
    );
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it('verifyToken is NOT invoked on outcome "already-converted"', async () => {
    const verifyToken = vi.fn(async () => ({ ok: true }));
    const upsertAbandoned = vi.fn(async (): Promise<UpsertAbandonedResult> => ({ outcome: 'already-converted' }));
    await handleAbandon(
      makeInput({}),
      makeDeps({ storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never }), verifyToken }),
    );
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it('no verifyToken dep injected — no-op, save proceeds normally', async () => {
    const upsertAbandoned = vi.fn(async (): Promise<UpsertAbandonedResult> => ({ outcome: 'created', entry: makeEntry() }));
    const result = await handleAbandon(
      makeInput({}),
      makeDeps({ storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never }) }),
    );
    expect(JSON.parse(result.body)).toEqual({ saved: true, deduped: false });
  });
});

// ---------------------------------------------------------------------------
// Outbound entry.abandoned webhook (HOOK-01)
// ---------------------------------------------------------------------------

describe('handleAbandon — deliverWebhook wiring (HOOK-01)', () => {
  it('fires entry.abandoned via deps.deliverWebhook exactly once on create, with the expected payload', async () => {
    const deliverWebhook = vi.fn();
    const upsertAbandoned = vi.fn(
      async (): Promise<UpsertAbandonedResult> => ({
        outcome: 'created',
        entry: makeEntry({ id: 'entry-9', createdAt: 4242 }),
      }),
    );
    const result = await handleAbandon(
      makeInput({}),
      makeDeps({ storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never }), deliverWebhook }),
    );
    expect(result.status).toBe(200);
    expect(deliverWebhook).toHaveBeenCalledTimes(1);
    expect(deliverWebhook).toHaveBeenCalledWith(
      'entry.abandoned',
      expect.objectContaining({
        id: 'entry-9',
        siteId: 'demo-site',
        formId: 'contact-form',
        createdAt: 4242,
      }),
    );
  });

  it('does NOT fire deliverWebhook on a dedupe-update (outcome updated)', async () => {
    const deliverWebhook = vi.fn();
    const upsertAbandoned = vi.fn(async (): Promise<UpsertAbandonedResult> => ({ outcome: 'updated', entry: makeEntry() }));
    await handleAbandon(
      makeInput({}),
      makeDeps({ storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never }), deliverWebhook }),
    );
    expect(deliverWebhook).not.toHaveBeenCalled();
  });

  it('does NOT fire deliverWebhook on already-converted', async () => {
    const deliverWebhook = vi.fn();
    const upsertAbandoned = vi.fn(async (): Promise<UpsertAbandonedResult> => ({ outcome: 'already-converted' }));
    await handleAbandon(
      makeInput({}),
      makeDeps({ storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never }), deliverWebhook }),
    );
    expect(deliverWebhook).not.toHaveBeenCalled();
  });

  it('does NOT fire deliverWebhook on a rejected request (gate-unmet, storage never called)', async () => {
    const deliverWebhook = vi.fn();
    const upsertAbandoned = vi.fn();
    const result = await handleAbandon(
      makeInput({ body: { fields: {} } }),
      makeDeps({ storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never }), deliverWebhook }),
    );
    expect(JSON.parse(result.body)).toEqual({ saved: false, reason: 'gate' });
    expect(upsertAbandoned).not.toHaveBeenCalled();
    expect(deliverWebhook).not.toHaveBeenCalled();
  });

  it('no deliverWebhook dep injected — no-op, save proceeds normally', async () => {
    const upsertAbandoned = vi.fn(async (): Promise<UpsertAbandonedResult> => ({ outcome: 'created', entry: makeEntry() }));
    const result = await handleAbandon(
      makeInput({}),
      makeDeps({ storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never }) }),
    );
    expect(JSON.parse(result.body)).toEqual({ saved: true, deduped: false });
  });
});

// ---------------------------------------------------------------------------
// Consent-basis recording (D3/RCV-01)
// ---------------------------------------------------------------------------

describe('handleAbandon — consent-basis recording (D3)', () => {
  it('auto mode: a valid captured email records consent_at via markConsent on the created entry', async () => {
    const entry = makeEntry({ id: 'entry-auto' });
    const upsertAbandoned = vi.fn(async (): Promise<UpsertAbandonedResult> => ({ outcome: 'created', entry }));
    const markConsent = vi.fn(async () => undefined);
    const result = await handleAbandon(
      makeInput({ body: { fields: { email: 'jane@example.com' } } }),
      makeDeps({
        config: { ...makeConfig(), recovery: { enabled: true, delayMins: 60, consentMode: 'auto' } },
        storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never, markConsent: markConsent as never }),
      }),
    );
    expect(JSON.parse(result.body)).toEqual({ saved: true, deduped: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(markConsent).toHaveBeenCalledTimes(1);
    expect(markConsent).toHaveBeenCalledWith('entry-auto', expect.any(Number));
  });

  it('auto mode: a phone-only field (no email) records NO consent — auto basis is email-specific', async () => {
    const upsertAbandoned = vi.fn(async (): Promise<UpsertAbandonedResult> => ({ outcome: 'created', entry: makeEntry() }));
    const markConsent = vi.fn(async () => undefined);
    await handleAbandon(
      makeInput({ body: { fields: { phone: '+15551234567' } } }),
      makeDeps({
        config: { ...makeConfig(), recovery: { enabled: true, delayMins: 60, consentMode: 'auto' } },
        storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never, markConsent: markConsent as never }),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(markConsent).not.toHaveBeenCalled();
  });

  it('checkbox mode: recoveryOptIn:true records consent_at', async () => {
    const entry = makeEntry({ id: 'entry-checkbox' });
    const upsertAbandoned = vi.fn(async (): Promise<UpsertAbandonedResult> => ({ outcome: 'created', entry }));
    const markConsent = vi.fn(async () => undefined);
    await handleAbandon(
      makeInput({ body: { fields: { email: 'jane@example.com' }, recoveryOptIn: true } }),
      makeDeps({
        config: { ...makeConfig(), recovery: { enabled: true, delayMins: 60, consentMode: 'checkbox' } },
        storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never, markConsent: markConsent as never }),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(markConsent).toHaveBeenCalledTimes(1);
    expect(markConsent).toHaveBeenCalledWith('entry-checkbox', expect.any(Number));
  });

  it('checkbox mode: the SAME save without recoveryOptIn records NO consent even with a valid email', async () => {
    const upsertAbandoned = vi.fn(async (): Promise<UpsertAbandonedResult> => ({ outcome: 'created', entry: makeEntry() }));
    const markConsent = vi.fn(async () => undefined);
    await handleAbandon(
      makeInput({ body: { fields: { email: 'jane@example.com' } } }),
      makeDeps({
        config: { ...makeConfig(), recovery: { enabled: true, delayMins: 60, consentMode: 'checkbox' } },
        storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never, markConsent: markConsent as never }),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(markConsent).not.toHaveBeenCalled();
  });

  it('checkbox mode: recoveryOptIn:false records NO consent', async () => {
    const upsertAbandoned = vi.fn(async (): Promise<UpsertAbandonedResult> => ({ outcome: 'created', entry: makeEntry() }));
    const markConsent = vi.fn(async () => undefined);
    await handleAbandon(
      makeInput({ body: { fields: { email: 'jane@example.com' }, recoveryOptIn: false } }),
      makeDeps({
        config: { ...makeConfig(), recovery: { enabled: true, delayMins: 60, consentMode: 'checkbox' } },
        storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never, markConsent: markConsent as never }),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(markConsent).not.toHaveBeenCalled();
  });

  it('recovery.enabled:false: consent_at is never recorded regardless of email/recoveryOptIn', async () => {
    const upsertAbandoned = vi.fn(async (): Promise<UpsertAbandonedResult> => ({ outcome: 'created', entry: makeEntry() }));
    const markConsent = vi.fn(async () => undefined);
    await handleAbandon(
      makeInput({ body: { fields: { email: 'jane@example.com' }, recoveryOptIn: true } }),
      makeDeps({
        config: { ...makeConfig(), recovery: { enabled: false, delayMins: 60, consentMode: 'auto' } },
        storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never, markConsent: markConsent as never }),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(markConsent).not.toHaveBeenCalled();
  });

  it('already-converted (no entry): records no consent — nothing to mark', async () => {
    const upsertAbandoned = vi.fn(async (): Promise<UpsertAbandonedResult> => ({ outcome: 'already-converted' }));
    const markConsent = vi.fn(async () => undefined);
    const result = await handleAbandon(
      makeInput({ body: { fields: { email: 'jane@example.com' } } }),
      makeDeps({
        config: { ...makeConfig(), recovery: { enabled: true, delayMins: 60, consentMode: 'auto' } },
        storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never, markConsent: markConsent as never }),
      }),
    );
    expect(JSON.parse(result.body)).toEqual({ saved: false, reason: 'duplicate' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(markConsent).not.toHaveBeenCalled();
  });

  it('does not await markConsent before returning the response (fire-and-forget)', async () => {
    let resolveMarkConsent: (() => void) | undefined;
    const markConsent = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveMarkConsent = resolve;
        }),
    );
    const upsertAbandoned = vi.fn(async (): Promise<UpsertAbandonedResult> => ({ outcome: 'created', entry: makeEntry() }));
    const result = await handleAbandon(
      makeInput({ body: { fields: { email: 'jane@example.com' } } }),
      makeDeps({
        config: { ...makeConfig(), recovery: { enabled: true, delayMins: 60, consentMode: 'auto' } },
        storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never, markConsent: markConsent as never }),
      }),
    );
    expect(result.status).toBe(200);
    expect(markConsent).toHaveBeenCalledTimes(1);
    // markConsent's promise is still pending here — resolving it now proves
    // handleAbandon() did not block the response on it.
    resolveMarkConsent?.();
  });

  it('a markConsent rejection is caught (fire-and-forget .catch) — response stays 200 with the save intact', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const markConsent = vi.fn(async () => {
      throw new Error('SQLITE_BUSY');
    });
    const upsertAbandoned = vi.fn(async (): Promise<UpsertAbandonedResult> => ({ outcome: 'created', entry: makeEntry() }));
    const result = await handleAbandon(
      makeInput({ body: { fields: { email: 'jane@example.com' } } }),
      makeDeps({
        config: { ...makeConfig(), recovery: { enabled: true, delayMins: 60, consentMode: 'auto' } },
        storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never, markConsent: markConsent as never }),
      }),
    );
    expect(JSON.parse(result.body)).toEqual({ saved: true, deduped: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errorSpy).toHaveBeenCalled();
    const record = JSON.parse(errorSpy.mock.calls[0]![0] as string);
    expect(record.event).toBe('recovery.consent-failed');
    errorSpy.mockRestore();
  });

  it('idempotent: markConsent is called again on a dedupe-update outcome (storage layer itself is the fill-if-null idempotency gate)', async () => {
    const upsertAbandoned = vi.fn(async (): Promise<UpsertAbandonedResult> => ({ outcome: 'updated', entry: makeEntry() }));
    const markConsent = vi.fn(async () => undefined);
    const result = await handleAbandon(
      makeInput({ body: { fields: { email: 'jane@example.com' } } }),
      makeDeps({
        config: { ...makeConfig(), recovery: { enabled: true, delayMins: 60, consentMode: 'auto' } },
        storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never, markConsent: markConsent as never }),
      }),
    );
    expect(JSON.parse(result.body)).toEqual({ saved: true, deduped: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(markConsent).toHaveBeenCalledTimes(1);
  });
});

/**
 * Per-form recovery override (04-10 gap closure, RCV-01/ROADMAP Phase 4
 * SC4 "per-form flag"). RED-first: written before the consent gate at
 * handle-abandon.ts:322 is re-routed through recoveryEnabledForForm().
 */
describe('handleAbandon — per-form recovery override (04-10)', () => {
  function makeConfigWithFormRecovery(
    siteEnabled: boolean,
    formRecoveryEnabled: boolean | undefined,
    consentMode: 'auto' | 'checkbox' = 'auto',
  ): CoolFormsConfig {
    const base = makeConfig();
    return {
      ...base,
      recovery: { enabled: siteEnabled, delayMins: 60, consentMode },
      forms: {
        ...base.forms,
        'contact-form': {
          ...base.forms['contact-form']!,
          ...(formRecoveryEnabled !== undefined ? { recovery: { enabled: formRecoveryEnabled } } : {}),
        },
      },
    };
  }

  it('site ON + form {recovery:{enabled:false}}: auto mode with a valid email records NO consent', async () => {
    const upsertAbandoned = vi.fn(async (): Promise<UpsertAbandonedResult> => ({ outcome: 'created', entry: makeEntry() }));
    const markConsent = vi.fn(async () => undefined);
    await handleAbandon(
      makeInput({ body: { fields: { email: 'jane@example.com' } } }),
      makeDeps({
        config: makeConfigWithFormRecovery(true, false, 'auto'),
        storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never, markConsent: markConsent as never }),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(markConsent).not.toHaveBeenCalled();
  });

  it('site ON + form {recovery:{enabled:false}}: checkbox mode with recoveryOptIn:true records NO consent', async () => {
    const upsertAbandoned = vi.fn(async (): Promise<UpsertAbandonedResult> => ({ outcome: 'created', entry: makeEntry() }));
    const markConsent = vi.fn(async () => undefined);
    await handleAbandon(
      makeInput({ body: { fields: { email: 'jane@example.com' }, recoveryOptIn: true } }),
      makeDeps({
        config: makeConfigWithFormRecovery(true, false, 'checkbox'),
        storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never, markConsent: markConsent as never }),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(markConsent).not.toHaveBeenCalled();
  });

  it('the SAME payload on a form WITHOUT the override still records consent (site ON, no per-form key)', async () => {
    const upsertAbandoned = vi.fn(async (): Promise<UpsertAbandonedResult> => ({ outcome: 'created', entry: makeEntry() }));
    const markConsent = vi.fn(async () => undefined);
    await handleAbandon(
      makeInput({ body: { fields: { email: 'jane@example.com' } } }),
      makeDeps({
        config: makeConfigWithFormRecovery(true, undefined, 'auto'),
        storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never, markConsent: markConsent as never }),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(markConsent).toHaveBeenCalledTimes(1);
  });

  it('site OFF + form {recovery:{enabled:true}}: NO consent is recorded — the site switch is the hard gate', async () => {
    const upsertAbandoned = vi.fn(async (): Promise<UpsertAbandonedResult> => ({ outcome: 'created', entry: makeEntry() }));
    const markConsent = vi.fn(async () => undefined);
    await handleAbandon(
      makeInput({ body: { fields: { email: 'jane@example.com' } } }),
      makeDeps({
        config: makeConfigWithFormRecovery(false, true, 'auto'),
        storage: makeFakeStorage({ upsertAbandoned: upsertAbandoned as never, markConsent: markConsent as never }),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(markConsent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Hourly purge gate reset hook — sanity check the test-only export exists
// ---------------------------------------------------------------------------

describe('resetAbandonPurgeGate', () => {
  it('is callable without throwing', () => {
    expect(() => resetAbandonPurgeGate()).not.toThrow();
  });
});
