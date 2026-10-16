/**
 * abandon-alerts.ts tests — the deferred abandoned-lead alert (0.1.18).
 *
 * Why this exists: the capture sends its abandon beacon on a tab or app
 * switch, an exit-intent move, a tel:/mailto:/WhatsApp click and unload, as
 * soon as an email or phone is typed. The server used to email the owner's
 * "Abandoned" alert (and fire `entry.abandoned`) on that first save, so a
 * visitor who glanced at another tab and then submitted produced a false
 * "Abandoned" alert followed by the real submission, on every live site.
 * The alert now waits `abandonment.alertDelayMins` (default 15) and a real
 * submission inside the wait cancels it.
 *
 * Unit cases inject storage/notify/webhook fakes; the lifecycle cases at the
 * bottom run the real handleAbandon + recordSubmission + sweep against real
 * SQLite and Turso databases, with no clock waits and no SMTP or network.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { parseConfig, type CoolFormsConfig } from '../../config.js';
import type { Entry, WebhookEventType } from '../../types.js';
import { BATCH_LIMIT } from '../drive-recovery-constants.js';
import { handleAbandon, resetAbandonPurgeGate } from '../handlers/handle-abandon.js';
import type { AbandonedLeadEmailData } from '../notify.js';
import { sendAbandonedLeadEmail } from '../notify.js';
import { recordSubmission, resetRecordSubmissionPurgeGate } from '../record-submission.js';
import type { RateLimiter } from '../security/rate-limit.js';
import type { DueAbandonAlert, StorageAdapter } from '../storage/adapter.js';
import { getDb, resetDbCache } from '../storage/db.js';
import { SqliteStorage } from '../storage/sqlite.js';
import { TursoStorage } from '../storage/turso.js';
import {
  ABANDON_ALERT_MAX_BATCHES_PER_PASS,
  ABANDON_ALERT_PASS_BUDGET_MS,
  ABANDON_ALERT_SWEEP_INTERVAL_MS,
  DEFAULT_ABANDON_ALERT_DELAY_MINS,
  abandonAlertDelayMins,
  maybeRunAbandonAlertSweep,
  resetAbandonAlertSweepGate,
  runAbandonAlertSweep,
  type AbandonAlertSweepDeps,
} from './abandon-alerts.js';

vi.mock('../notify.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notify.js')>()),
  sendAbandonedLeadEmail: vi.fn(async () => null),
}));

const MINUTE = 60_000;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeConfig(abandonment: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): CoolFormsConfig {
  return parseConfig({
    siteId: 'demo-site',
    siteUrl: 'https://example.com',
    forms: {
      'contact-form': { notifyTo: 'owner@example.com', abandonment },
    },
    // The three live sites run with recovery OFF; the alert must not depend on it.
    recovery: { enabled: false },
    ...extra,
  });
}

function makeEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: 'entry-1',
    siteId: 'demo-site',
    formId: 'contact-form',
    status: 'abandoned',
    fields: { email: 'jane@example.com', phone: '+1 555 0100' },
    visitorUuid: 'visitor-1',
    journey: [{ url: '/contact', title: 'Contact', ts: 1, durationMs: 4000 }],
    pageUrl: 'https://example.com/contact',
    referrer: 'https://google.com/',
    geo: { country: 'IN', city: 'Delhi' },
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function due(entry: Entry, alertedBefore = false): DueAbandonAlert {
  return { entry, alertedBefore };
}

/** Only the two alert methods the sweep touches; anything else throws if reached. */
function makeAlertStorage(overrides: Partial<StorageAdapter> = {}): StorageAdapter {
  return {
    findDueAbandonAlerts: vi.fn(async () => []),
    claimAbandonAlert: vi.fn(async () => true),
    ...overrides,
  } as unknown as StorageAdapter;
}

function makeDeps(overrides: Partial<AbandonAlertSweepDeps> = {}): AbandonAlertSweepDeps {
  return {
    storage: makeAlertStorage(),
    config: makeConfig(),
    now: () => 10_000_000,
    notify: vi.fn(async (_data: AbandonedLeadEmailData) => ({ ok: true }) as unknown),
    deliverWebhook: vi.fn((_type: WebhookEventType, _data: unknown) => {}),
    ...overrides,
  };
}

afterEach(() => {
  resetAbandonAlertSweepGate();
  vi.mocked(sendAbandonedLeadEmail).mockClear();
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

describe('abandonment.alertDelayMins config', () => {
  it('defaults to 15 minutes per form when unset, and 0 restores the immediate alert', () => {
    expect(DEFAULT_ABANDON_ALERT_DELAY_MINS).toBe(15);
    expect(abandonAlertDelayMins(makeConfig(), 'contact-form')).toBe(15);
    expect(abandonAlertDelayMins(makeConfig({ alertDelayMins: 0 }), 'contact-form')).toBe(0);
    expect(abandonAlertDelayMins(makeConfig({ alertDelayMins: 45 }), 'contact-form')).toBe(45);
  });

  it('rejects a negative or fractional delay at config time (fail loud, never a silently odd schedule)', () => {
    expect(() => makeConfig({ alertDelayMins: -1 })).toThrow();
    expect(() => makeConfig({ alertDelayMins: 1.5 })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// runAbandonAlertSweep — claim, then send
// ---------------------------------------------------------------------------

describe('runAbandonAlertSweep — claim, then send', () => {
  it('claims a due alert, then emails the owner the stored draft and fires one entry.abandoned webhook with the pre-0.1.18 payload', async () => {
    const entry = makeEntry();
    const storage = makeAlertStorage({ findDueAbandonAlerts: vi.fn(async () => [due(entry)]) });
    const deps = makeDeps({ storage });

    await runAbandonAlertSweep(deps);

    expect(storage.findDueAbandonAlerts).toHaveBeenCalledWith(10_000_000, 25);
    expect(storage.claimAbandonAlert).toHaveBeenCalledWith('entry-1', 10_000_000);
    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(deps.notify).toHaveBeenCalledWith({
      siteId: 'demo-site',
      formId: 'contact-form',
      notifyTo: 'owner@example.com',
      fields: entry.fields,
      journey: entry.journey,
      pageUrl: entry.pageUrl,
      referrer: entry.referrer,
      geo: entry.geo,
    } satisfies AbandonedLeadEmailData);
    expect(deps.deliverWebhook).toHaveBeenCalledTimes(1);
    expect(deps.deliverWebhook).toHaveBeenCalledWith('entry.abandoned', {
      id: 'entry-1',
      siteId: 'demo-site',
      formId: 'contact-form',
      fields: entry.fields,
      geo: entry.geo,
      createdAt: 1000,
    });
  });

  it('a lost claim (another sweep or instance already took it) sends nothing', async () => {
    const storage = makeAlertStorage({
      findDueAbandonAlerts: vi.fn(async () => [due(makeEntry())]),
      claimAbandonAlert: vi.fn(async () => false),
    });
    const deps = makeDeps({ storage });

    await runAbandonAlertSweep(deps);

    expect(deps.notify).not.toHaveBeenCalled();
    expect(deps.deliverWebhook).not.toHaveBeenCalled();
  });

  it('a notifyOnUpdate re-alert emails again but never re-fires entry.abandoned (the webhook is creation-only, as before)', async () => {
    const storage = makeAlertStorage({ findDueAbandonAlerts: vi.fn(async () => [due(makeEntry(), true)]) });
    const deps = makeDeps({ storage });

    await runAbandonAlertSweep(deps);

    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(deps.deliverWebhook).not.toHaveBeenCalled();
  });

  it('a bot-flagged draft still alerts (Turnstile stays soft-fail), and the internal _turnstile flag is not added to the email or webhook fields', async () => {
    const entry = makeEntry({ fields: { email: 'jane@example.com', _turnstile: 'failed' } });
    const storage = makeAlertStorage({ findDueAbandonAlerts: vi.fn(async () => [due(entry)]) });
    const deps = makeDeps({ storage });

    await runAbandonAlertSweep(deps);

    const email = vi.mocked(deps.notify!).mock.calls[0]![0];
    expect(email.fields).toEqual({ email: 'jane@example.com' });
    const [, webhookData] = vi.mocked(deps.deliverWebhook!).mock.calls[0]!;
    expect((webhookData as { fields: unknown }).fields).toEqual({ email: 'jane@example.com' });
  });

  it('a draft whose form is no longer configured is claimed (so it stops being listed) but nothing is sent', async () => {
    const storage = makeAlertStorage({
      findDueAbandonAlerts: vi.fn(async () => [due(makeEntry({ formId: 'removed-form' }))]),
    });
    const deps = makeDeps({ storage });

    await runAbandonAlertSweep(deps);

    expect(storage.claimAbandonAlert).toHaveBeenCalledWith('entry-1', 10_000_000);
    expect(deps.notify).not.toHaveBeenCalled();
    expect(deps.deliverWebhook).not.toHaveBeenCalled();
  });

  it('defaults the email to sendAbandonedLeadEmail with the host templatesModule abandonedLead override', async () => {
    const template = vi.fn(() => ({ subject: 's', text: 't' }));
    const config = Object.assign(makeConfig(), { templates: { abandonedLead: template } });
    const storage = makeAlertStorage({ findDueAbandonAlerts: vi.fn(async () => [due(makeEntry())]) });

    await runAbandonAlertSweep({ storage, config, now: () => 10_000_000, deliverWebhook: vi.fn() });

    expect(sendAbandonedLeadEmail).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendAbandonedLeadEmail).mock.calls[0]![1]).toEqual({ template });
  });
});

describe('runAbandonAlertSweep — never throws', () => {
  it('is a no-op for a custom StorageAdapter without the alert methods (the handler alerts immediately for those)', async () => {
    const deps = makeDeps({ storage: {} as StorageAdapter });
    await expect(runAbandonAlertSweep(deps)).resolves.toBeUndefined();
    expect(deps.notify).not.toHaveBeenCalled();
  });

  it('a failing due-alert query resolves without throwing', async () => {
    const storage = makeAlertStorage({ findDueAbandonAlerts: vi.fn(async () => Promise.reject(new Error('db down'))) });
    await expect(runAbandonAlertSweep(makeDeps({ storage }))).resolves.toBeUndefined();
  });

  it('a failing claim on one row is logged and the next row still goes out', async () => {
    const storage = makeAlertStorage({
      findDueAbandonAlerts: vi.fn(async () => [due(makeEntry({ id: 'bad' })), due(makeEntry({ id: 'good' }))]),
      claimAbandonAlert: vi.fn(async (id: string) => {
        if (id === 'bad') throw new Error('locked');
        return true;
      }),
    });
    const deps = makeDeps({ storage });

    await runAbandonAlertSweep(deps);

    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.deliverWebhook!).mock.calls[0]![1]).toMatchObject({ id: 'good' });
  });

  it('a rejected email send is logged and does not stop later rows', async () => {
    const storage = makeAlertStorage({
      findDueAbandonAlerts: vi.fn(async () => [due(makeEntry({ id: 'a' })), due(makeEntry({ id: 'b' }))]),
    });
    const notify = vi.fn(async () => Promise.reject(new Error('smtp down')));
    const deps = makeDeps({ storage, notify });

    await expect(runAbandonAlertSweep(deps)).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// runAbandonAlertSweep — a backlog bigger than one batch
//
// One batch of 25 per minute per process let a bot that queued thousands of
// cheap drafts hold genuine alerts back for hours. A pass now keeps claiming
// batches until the backlog is drained, up to ABANDON_ALERT_MAX_BATCHES_PER_PASS
// batches or ABANDON_ALERT_PASS_BUDGET_MS, whichever comes first.
// ---------------------------------------------------------------------------

/** A due backlog the sweep drains for real: a claimed id is never listed again, like the adapters' conditional UPDATE. */
function makeBacklogStorage(count: number): StorageAdapter {
  const pending = Array.from({ length: count }, (_, i) => makeEntry({ id: 'e' + String(i).padStart(4, '0') }));
  const claimed = new Set<string>();
  return makeAlertStorage({
    findDueAbandonAlerts: vi.fn(async (_now: number, limit: number) =>
      pending.filter((entry) => !claimed.has(entry.id)).slice(0, limit).map((entry) => due(entry)),
    ),
    claimAbandonAlert: vi.fn(async (id: string) => {
      if (claimed.has(id)) return false;
      claimed.add(id);
      return true;
    }),
  });
}

describe('runAbandonAlertSweep — draining a backlog', () => {
  it('keeps claiming batches in one pass until the due backlog is drained', async () => {
    const storage = makeBacklogStorage(60);
    const deps = makeDeps({ storage });

    await runAbandonAlertSweep(deps);

    expect(deps.notify).toHaveBeenCalledTimes(60);
    // 25 + 25 + 10: the short third batch shows nothing more is due.
    expect(storage.findDueAbandonAlerts).toHaveBeenCalledTimes(3);
  });

  it('stops after ABANDON_ALERT_MAX_BATCHES_PER_PASS batches; the next pass picks up the rest', async () => {
    expect(ABANDON_ALERT_MAX_BATCHES_PER_PASS).toBe(8);
    const storage = makeBacklogStorage(1000);
    const deps = makeDeps({ storage });

    await runAbandonAlertSweep(deps);
    expect(storage.findDueAbandonAlerts).toHaveBeenCalledTimes(8);
    expect(deps.notify).toHaveBeenCalledTimes(8 * 25);

    await runAbandonAlertSweep(deps);
    expect(deps.notify).toHaveBeenCalledTimes(16 * 25);
  });

  it('starts no further batch once ABANDON_ALERT_PASS_BUDGET_MS has elapsed (a slow SMTP send cannot stretch a pass into minutes)', async () => {
    expect(ABANDON_ALERT_PASS_BUDGET_MS).toBe(5000);
    const storage = makeBacklogStorage(1000);
    let clock = 10_000_000;
    // Each email takes 100 ms: batch one ends at 2.5 s, batch two at 5 s.
    const notify = vi.fn(async () => {
      clock += 100;
      return { ok: true } as unknown;
    });

    await runAbandonAlertSweep(makeDeps({ storage, notify, now: () => clock }));

    expect(storage.findDueAbandonAlerts).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledTimes(50);
    // Every batch in the pass is listed and claimed against the time the pass started.
    expect(vi.mocked(storage.findDueAbandonAlerts!).mock.calls.map(([now]) => now)).toEqual([10_000_000, 10_000_000]);
  });

  it('a batch that claims nothing ends the pass (rows another sweep holds, or a failing claim, are never spun on)', async () => {
    const storage = makeAlertStorage({
      findDueAbandonAlerts: vi.fn(async () => Array.from({ length: 25 }, (_, i) => due(makeEntry({ id: 'held-' + i })))),
      claimAbandonAlert: vi.fn(async () => false),
    });
    const deps = makeDeps({ storage });

    await runAbandonAlertSweep(deps);

    expect(storage.findDueAbandonAlerts).toHaveBeenCalledTimes(1);
    expect(deps.notify).not.toHaveBeenCalled();
  });

  it('a failing query on a later batch ends the pass without throwing; the alerts already claimed still went out', async () => {
    const first = Array.from({ length: 25 }, (_, i) => due(makeEntry({ id: 'first-' + i })));
    const storage = makeAlertStorage({
      findDueAbandonAlerts: vi.fn().mockResolvedValueOnce(first).mockRejectedValueOnce(new Error('db down')),
    });
    const deps = makeDeps({ storage });

    await expect(runAbandonAlertSweep(deps)).resolves.toBeUndefined();
    expect(deps.notify).toHaveBeenCalledTimes(25);
  });
});

// ---------------------------------------------------------------------------
// maybeRunAbandonAlertSweep — request-driven, per-process gate
// ---------------------------------------------------------------------------

describe('maybeRunAbandonAlertSweep — module gate', () => {
  it('runs with recovery disabled (the live sites all run with recovery off)', async () => {
    const deps = makeDeps();
    expect(deps.config.recovery.enabled).toBe(false);
    maybeRunAbandonAlertSweep(deps);
    await vi.waitFor(() => expect(deps.storage.findDueAbandonAlerts).toHaveBeenCalledTimes(1));
  });

  it('queries at most once per ABANDON_ALERT_SWEEP_INTERVAL_MS per process, and again once it has passed', async () => {
    let now = 10_000_000;
    const deps = makeDeps({ now: () => now });

    maybeRunAbandonAlertSweep(deps);
    now += ABANDON_ALERT_SWEEP_INTERVAL_MS - 1;
    maybeRunAbandonAlertSweep(deps);
    await vi.waitFor(() => expect(deps.storage.findDueAbandonAlerts).toHaveBeenCalledTimes(1));

    now += 1;
    maybeRunAbandonAlertSweep(deps);
    await vi.waitFor(() => expect(deps.storage.findDueAbandonAlerts).toHaveBeenCalledTimes(2));
  });

  it('checks often enough that the gate adds at most a minute to the delay', () => {
    expect(ABANDON_ALERT_SWEEP_INTERVAL_MS).toBeLessThanOrEqual(MINUTE);
  });

  it('resetAbandonAlertSweepGate() lets the next call query immediately', async () => {
    const deps = makeDeps();
    maybeRunAbandonAlertSweep(deps);
    resetAbandonAlertSweepGate();
    maybeRunAbandonAlertSweep(deps);
    await vi.waitFor(() => expect(deps.storage.findDueAbandonAlerts).toHaveBeenCalledTimes(2));
  });

  it('never throws synchronously, even when the sweep rejects', () => {
    const storage = makeAlertStorage({ findDueAbandonAlerts: vi.fn(() => Promise.reject(new Error('boom'))) });
    expect(() => maybeRunAbandonAlertSweep(makeDeps({ storage }))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Full lifecycle against real databases: abandon beacon -> (submit?) -> sweep.
// ---------------------------------------------------------------------------

const allowAll: RateLimiter = { allow: () => true, size: () => 0, clear: () => {} };

const backends: Array<[string, () => StorageAdapter]> = [
  [
    'SQLite',
    () => {
      resetDbCache();
      return new SqliteStorage(getDb(':memory:'));
    },
  ],
  ['Turso', () => new TursoStorage(':memory:')],
];

describe.each(backends)('deferred alert lifecycle on %s', (_name, makeStorage) => {
  interface Harness {
    storage: StorageAdapter;
    notify: ReturnType<typeof vi.fn<(data: AbandonedLeadEmailData) => Promise<unknown>>>;
    webhooks: Array<{ type: WebhookEventType; data: unknown }>;
    abandon: (fields?: Record<string, unknown>) => Promise<{ status: number; body: string }>;
    submit: () => Promise<void>;
    sweep: (now: number) => Promise<void>;
    abandonedWebhooks: () => unknown[];
  }

  function harness(config: CoolFormsConfig): Harness {
    resetAbandonPurgeGate();
    resetRecordSubmissionPurgeGate();
    const storage = makeStorage();
    const notify = vi.fn<(data: AbandonedLeadEmailData) => Promise<unknown>>(async () => ({ ok: true }));
    const webhooks: Array<{ type: WebhookEventType; data: unknown }> = [];
    const deliverWebhook = (type: WebhookEventType, data: unknown) => {
      webhooks.push({ type, data });
    };

    return {
      storage,
      notify,
      webhooks,
      abandon: (fields = { email: 'jane@example.com' }) =>
        handleAbandon(
          {
            body: JSON.stringify({ siteId: 'demo-site', formId: 'contact-form', visitorUuid: 'visitor-1', fields }),
            headers: new Headers({ Origin: 'https://example.com' }),
            ip: '203.0.113.5',
          },
          { config, storage, notify, rateLimiter: allowAll, log: () => {}, deliverWebhook },
        ),
      submit: async () => {
        const result = await recordSubmission(
          {
            siteId: 'demo-site',
            formId: 'contact-form',
            fields: { email: 'jane@example.com', message: 'Please call me' },
            request: new Request('https://example.com/api/contact', { headers: { cookie: '_caf_uid=visitor-1' } }),
          },
          { storage, deliverWebhook, log: () => {} },
        );
        expect(result.ok).toBe(true);
      },
      sweep: (now: number) => runAbandonAlertSweep({ storage, config, now: () => now, notify, deliverWebhook }),
      abandonedWebhooks: () => webhooks.filter((w) => w.type === 'entry.abandoned'),
    };
  }

  it('a tab switch then a submission inside the window sends no abandoned alert and no entry.abandoned webhook', async () => {
    const h = harness(makeConfig());

    const saved = await h.abandon();
    expect(JSON.parse(saved.body)).toEqual({ saved: true, deduped: false });
    // The draft is in /forms-admin/abandoned straight away either way.
    expect(await h.storage.countEntries({ status: 'abandoned' })).toBe(1);

    await h.submit();
    await h.sweep(Date.now() + 60 * MINUTE);

    expect(h.notify).not.toHaveBeenCalled();
    expect(h.abandonedWebhooks()).toEqual([]);
    expect(h.webhooks.map((w) => w.type)).toEqual(['entry.submitted']);
  });

  it('a real abandonment sends exactly one alert and one entry.abandoned webhook, after the delay and not before (recovery off)', async () => {
    const h = harness(makeConfig());

    await h.abandon();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.abandonedWebhooks()).toEqual([]);

    await h.sweep(Date.now() + 14 * MINUTE);
    expect(h.notify).not.toHaveBeenCalled();

    await h.sweep(Date.now() + 15 * MINUTE + 1000);
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0]![0]).toMatchObject({ notifyTo: 'owner@example.com', fields: { email: 'jane@example.com' } });
    expect(h.abandonedWebhooks()).toHaveLength(1);

    await h.sweep(Date.now() + 120 * MINUTE);
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.abandonedWebhooks()).toHaveLength(1);
  });

  it('a second tab switch inside the window updates the draft but neither delays the alert nor adds a second one', async () => {
    const h = harness(makeConfig());

    await h.abandon({ email: 'jane@example.com' });
    const second = await h.abandon({ email: 'jane@example.com', phone: '+1 555 0100' });
    expect(JSON.parse(second.body)).toEqual({ saved: true, deduped: true });

    await h.sweep(Date.now() + 15 * MINUTE + 1000);
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0]![0].fields).toEqual({ email: 'jane@example.com', phone: '+1 555 0100' });
    expect(h.abandonedWebhooks()).toHaveLength(1);
  });

  it('alertDelayMins: 0 alerts and fires the webhook on the save itself (pre-0.1.18 behaviour) and the sweep adds nothing', async () => {
    const h = harness(makeConfig({ alertDelayMins: 0 }));

    await h.abandon();
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.abandonedWebhooks()).toHaveLength(1);

    await h.sweep(Date.now() + 120 * MINUTE);
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.abandonedWebhooks()).toHaveLength(1);
  });

  it('a backlog of more than one batch of Turnstile-flagged drafts does not hold back a genuine one: its alert is the first to go out', async () => {
    const config = makeConfig();
    const h = harness(config);
    const botDeps = {
      config,
      storage: h.storage,
      notify: h.notify,
      rateLimiter: allowAll,
      log: () => {},
      deliverWebhook: () => {},
      // Turnstile soft-fail: the draft is saved and flagged, never refused.
      verifyToken: async () => ({ ok: false }),
    };
    for (let i = 0; i < 30; i++) {
      await handleAbandon(
        {
          body: JSON.stringify({ siteId: 'demo-site', formId: 'contact-form', visitorUuid: 'bot-' + i, fields: { email: 'bot' + i + '@example.com' } }),
          headers: new Headers({ Origin: 'https://example.com' }),
          ip: '198.51.100.7',
        },
        botDeps,
      );
    }
    // The genuine visitor abandons last, so their alert is the newest due.
    await h.abandon({ email: 'jane@example.com' });

    await h.sweep(Date.now() + 16 * MINUTE);

    expect(h.notify.mock.calls[0]![0].fields).toEqual({ email: 'jane@example.com' });
    expect(h.notify).toHaveBeenCalledTimes(31);
  });

  it('two sweeps racing over the same due alert send it once', async () => {
    const h = harness(makeConfig());
    await h.abandon();

    const later = Date.now() + 16 * MINUTE;
    await Promise.all([h.sweep(later), h.sweep(later), h.sweep(later)]);

    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.abandonedWebhooks()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Corrupted due drafts. The listing skips a row whose stored JSON cannot be
// read; left pending, BATCH_LIMIT of them with the oldest due times filled
// every batch, so no alert behind them ever went out, and fewer in a batch
// made it come back short, which ends a sweep's drain early. Real databases
// again, written to directly, since no adapter method stores bad JSON.
// ---------------------------------------------------------------------------

interface CorruptibleBackend {
  storage: StorageAdapter;
  /** Overwrites a row's `fields` column with JSON that cannot be parsed. */
  corrupt: (id: string) => Promise<void>;
  /** Rows with an alert still pending (`abandon_notify_due_at` set). */
  pendingIds: () => Promise<string[]>;
  close: () => void;
}

const BAD_JSON = '{not valid json';

const corruptibleBackends: Array<[string, () => Promise<CorruptibleBackend>]> = [
  [
    'SQLite',
    async () => {
      resetDbCache();
      const db = getDb(':memory:');
      return {
        storage: new SqliteStorage(db),
        corrupt: async (id) => {
          db.prepare('UPDATE entries SET fields = ? WHERE id = ?').run(BAD_JSON, id);
        },
        pendingIds: async () =>
          (db.prepare('SELECT id FROM entries WHERE abandon_notify_due_at IS NOT NULL').all() as { id: string }[]).map(
            (row) => row.id,
          ),
        close: () => resetDbCache(),
      };
    },
  ],
  [
    'Turso',
    async () => {
      // A file database, so a second client can reach the rows the adapter wrote.
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caf-alert-corrupt-'));
      const url = 'file:' + path.join(tmpDir, 'forms.db');
      const storage = new TursoStorage(url);
      await storage.ready;
      const { createClient } = await import('@libsql/client');
      const client = createClient({ url });
      return {
        storage,
        corrupt: async (id) => {
          await client.execute({ sql: 'UPDATE entries SET fields = ? WHERE id = ?', args: [BAD_JSON, id] });
        },
        pendingIds: async () =>
          (await client.execute('SELECT id FROM entries WHERE abandon_notify_due_at IS NOT NULL')).rows.map((row) =>
            String(row.id),
          ),
        close: () => {
          client.close();
          fs.rmSync(tmpDir, { recursive: true, force: true });
        },
      };
    },
  ],
];

describe.each(corruptibleBackends)('corrupted due drafts on %s', (_name, open) => {
  let backend: CorruptibleBackend;
  let warnSpy: MockInstance<typeof console.warn>;
  let errorSpy: MockInstance<typeof console.error>;

  beforeEach(async () => {
    backend = await open();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    backend.close();
  });

  async function draft(visitorUuid: string, dueAt: number, email = visitorUuid + '@example.com'): Promise<string> {
    const saved = await backend.storage.upsertAbandoned(
      { siteId: 'demo-site', formId: 'contact-form', fields: { email }, visitorUuid },
      60,
      { dueAt },
    );
    return saved.entry!.id;
  }

  function sweep(notify: AbandonAlertSweepDeps['notify']): Promise<void> {
    return runAbandonAlertSweep({
      storage: backend.storage,
      config: makeConfig(),
      now: () => 1_000_000,
      notify,
      deliverWebhook: () => {},
    });
  }

  function retiredLogs(): Record<string, unknown>[] {
    return warnSpy.mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .filter((record) => record.event === 'abandon-alert.corrupt-row-retired');
  }

  it('a full batch of corrupted drafts due first cannot hold the queue: one sweep sends the good draft behind them and retires them, each logged once without field data', async () => {
    const corrupted: string[] = [];
    for (let i = 0; i < BATCH_LIMIT; i++) {
      const id = await draft('v-corrupt-' + i, 1000 + i);
      await backend.corrupt(id);
      corrupted.push(id);
    }
    await draft('v-good', 5000, 'jane@example.com');

    const notify = vi.fn(async (_data: AbandonedLeadEmailData) => ({ ok: true }) as unknown);
    await sweep(notify);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0].fields).toEqual({ email: 'jane@example.com' });
    expect(await backend.pendingIds()).toEqual([]);
    const logs = retiredLogs();
    expect(logs.map((record) => record.id).sort()).toEqual([...corrupted].sort());
    for (const record of logs) expect(Object.keys(record).sort()).toEqual(['event', 'id', 'level', 'ts']);

    // Retired, so a later sweep neither lists nor logs them again.
    await sweep(notify);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(retiredLogs()).toHaveLength(BATCH_LIMIT);
  });

  it('a few corrupted drafts in a batch do not cut the drain short: one sweep still sends every good draft across batches', async () => {
    for (let i = 0; i < 5; i++) await backend.corrupt(await draft('v-corrupt-' + i, 1000 + i));
    for (let i = 0; i < BATCH_LIMIT + 5; i++) await draft('v-good-' + i, 2000 + i);

    const notify = vi.fn(async (_data: AbandonedLeadEmailData) => ({ ok: true }) as unknown);
    await sweep(notify);

    expect(notify).toHaveBeenCalledTimes(BATCH_LIMIT + 5);
    expect(await backend.pendingIds()).toEqual([]);
  });
});
