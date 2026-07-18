/**
 * deliver.ts tests — buildWebhookEvent / deliverWebhook retry+backoff /
 * registerWebhookTargets (HOOK-01). Fetch and the backoff scheduler are
 * both injected so this suite is entirely network-free and never depends
 * on real elapsed time. Clean-room, not derived from any commercial form-plugin source.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebhookTarget } from '../../types.js';

const { logMock, logErrorMock } = vi.hoisted(() => ({ logMock: vi.fn(), logErrorMock: vi.fn() }));
vi.mock('../log.js', () => ({ log: logMock, logError: logErrorMock }));

import {
  buildWebhookEvent,
  deliverWebhook,
  getRegisteredTargets,
  registerWebhookTargets,
  resetWebhookTargets,
} from './deliver.js';
import { verifyWebhookSignature } from './sign.js';

afterEach(() => {
  resetWebhookTargets();
  vi.clearAllMocks();
});

const TARGET: WebhookTarget = { url: 'https://example.com/hook', secret: 'whsec_test' };

/** Runs the scheduled backoff callback immediately — no real elapsed time in tests. */
function fastSchedule(fn: () => void): void {
  fn();
}

type FakeResponse = { ok: boolean };

describe('buildWebhookEvent', () => {
  it('returns {id, type, at, data} with a non-empty ulid id', () => {
    const event = buildWebhookEvent('entry.submitted', { entryId: 'e1' }, 1_700_000_000_000);
    expect(event.type).toBe('entry.submitted');
    expect(event.at).toBe(1_700_000_000_000);
    expect(event.data).toEqual({ entryId: 'e1' });
    expect(typeof event.id).toBe('string');
    expect(event.id.length).toBeGreaterThan(0);
  });

  it('defaults `at` to Date.now() when now is omitted', () => {
    const before = Date.now();
    const event = buildWebhookEvent('entry.abandoned', {});
    const after = Date.now();
    expect(event.at).toBeGreaterThanOrEqual(before);
    expect(event.at).toBeLessThanOrEqual(after);
  });
});

describe('registerWebhookTargets / getRegisteredTargets', () => {
  it('replaces the whole registered list on each call', () => {
    registerWebhookTargets([TARGET]);
    expect(getRegisteredTargets()).toEqual([TARGET]);
    registerWebhookTargets([]);
    expect(getRegisteredTargets()).toEqual([]);
  });
});

describe('deliverWebhook — delivery', () => {
  it('signs and POSTs to a subscribed target; logs webhook.delivered on 2xx', async () => {
    const fetchFn = vi.fn(async (_url: string, _init: RequestInit): Promise<FakeResponse> => ({ ok: true }));
    registerWebhookTargets([TARGET]);

    deliverWebhook(
      'entry.submitted',
      { entryId: 'e1' },
      { fetch: fetchFn, schedule: fastSchedule, now: () => 1_700_000_000_000 },
    );

    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));

    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(TARGET.url);
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(typeof headers['X-Caf-Signature']).toBe('string');
    expect(
      verifyWebhookSignature(init.body as string, headers['X-Caf-Signature'], TARGET.secret, 1_700_000_000_000),
    ).toBe(true);

    await vi.waitFor(() =>
      expect(logMock).toHaveBeenCalledWith(
        'webhook.delivered',
        expect.objectContaining({ url: TARGET.url, type: 'entry.submitted' }),
      ),
    );
    expect(logMock).not.toHaveBeenCalledWith('webhook.exhausted', expect.anything());
  });

  it('retries on a non-2xx response then succeeds; exactly 2 fetch attempts, no exhausted log', async () => {
    const fetchFn = vi
      .fn<(url: string, init: RequestInit) => Promise<FakeResponse>>()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true });
    registerWebhookTargets([TARGET]);

    deliverWebhook('entry.submitted', { entryId: 'e1' }, { fetch: fetchFn, schedule: fastSchedule });

    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(logMock).toHaveBeenCalledWith('webhook.delivered', expect.anything()));
    expect(logMock).not.toHaveBeenCalledWith('webhook.exhausted', expect.anything());
  });

  it('retries 3 attempts total then logs webhook.exhausted on persistent failure', async () => {
    const fetchFn = vi.fn(async (): Promise<FakeResponse> => ({ ok: false }));
    registerWebhookTargets([TARGET]);

    deliverWebhook('entry.submitted', { entryId: 'e1' }, { fetch: fetchFn, schedule: fastSchedule });

    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(3));
    await vi.waitFor(() =>
      expect(logMock).toHaveBeenCalledWith(
        'webhook.exhausted',
        expect.objectContaining({ url: TARGET.url, type: 'entry.submitted' }),
      ),
    );
    expect(logMock).not.toHaveBeenCalledWith('webhook.delivered', expect.anything());
  });

  it('never throws when fetch rejects — retries then exhausts', async () => {
    const fetchFn = vi.fn(async (): Promise<FakeResponse> => {
      throw new Error('network down');
    });
    registerWebhookTargets([TARGET]);

    expect(() =>
      deliverWebhook('entry.submitted', { entryId: 'e1' }, { fetch: fetchFn, schedule: fastSchedule }),
    ).not.toThrow();

    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(logMock).toHaveBeenCalledWith('webhook.exhausted', expect.anything()));
  });

  it('is a silent no-op with zero registered targets', async () => {
    const fetchFn = vi.fn();
    registerWebhookTargets([]);

    deliverWebhook('entry.submitted', { entryId: 'e1' }, { fetch: fetchFn as never, schedule: fastSchedule });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchFn).not.toHaveBeenCalled();
    expect(logMock).not.toHaveBeenCalled();
  });

  it('delivers only to targets subscribed to the event type', async () => {
    const fetchFn = vi.fn(async (_url: string, _init: RequestInit): Promise<FakeResponse> => ({ ok: true }));
    const subscribed: WebhookTarget = { url: 'https://a.example.com/hook', secret: 's1', events: ['entry.submitted'] };
    const notSubscribed: WebhookTarget = {
      url: 'https://b.example.com/hook',
      secret: 's2',
      events: ['entry.abandoned'],
    };
    const allEvents: WebhookTarget = { url: 'https://c.example.com/hook', secret: 's3' };

    deliverWebhook('entry.submitted', { entryId: 'e1' }, {
      targets: [subscribed, notSubscribed, allEvents],
      fetch: fetchFn,
      schedule: fastSchedule,
    });

    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
    const calledUrls = fetchFn.mock.calls.map((call) => call[0]);
    expect(calledUrls).toContain(subscribed.url);
    expect(calledUrls).toContain(allEvents.url);
    expect(calledUrls).not.toContain(notSubscribed.url);
  });

  it('deps.targets overrides the registered targets', async () => {
    const fetchFn = vi.fn(async (_url: string, _init: RequestInit): Promise<FakeResponse> => ({ ok: true }));
    registerWebhookTargets([TARGET]);
    const override: WebhookTarget = { url: 'https://override.example.com/hook', secret: 'override-secret' };

    deliverWebhook('entry.submitted', { entryId: 'e1' }, { targets: [override], fetch: fetchFn, schedule: fastSchedule });

    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    expect(fetchFn.mock.calls[0]![0]).toBe(override.url);
  });
});
