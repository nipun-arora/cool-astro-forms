import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTurnstileInertWarning, verifyTurnstile, warnTurnstileInert } from './turnstile.js';

// Every case here mocks global fetch — NEVER a live call to Cloudflare's
// siteverify endpoint (mirrors geo.test.ts's fetch-mocking convention).

function mockFetch(impl: (...args: unknown[]) => unknown) {
  const fetchMock = vi.fn(impl);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  // The inert warning is once-per-process by design; re-arm it so cases stay
  // independent of the order they run in.
  resetTurnstileInertWarning();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('verifyTurnstile — mocked siteverify responses', () => {
  it('a {success:true} response resolves ok:true with outcome "verified"', async () => {
    mockFetch(async () => ({ json: async () => ({ success: true }) }));
    const result = await verifyTurnstile('good-token', { secret: 'sekret' });
    expect(result).toEqual({ ok: true, outcome: 'verified' });
  });

  it('a {success:false, "error-codes":[...]} response resolves outcome "rejected" and forwards the codes — a host needs the code to tell a spent token from a bot', async () => {
    mockFetch(async () => ({
      json: async () => ({ success: false, 'error-codes': ['timeout-or-duplicate'] }),
    }));
    const result = await verifyTurnstile('replayed-token', { secret: 'sekret' });
    expect(result).toEqual({ ok: false, outcome: 'rejected', errorCodes: ['timeout-or-duplicate'] });
  });

  it('a {success:false} response with NO error codes resolves outcome "unreachable", not "rejected" — Cloudflare gave no reason, so the visitor must not be blamed for it', async () => {
    mockFetch(async () => ({ json: async () => ({ success: false }) }));
    const result = await verifyTurnstile('some-token', { secret: 'sekret' });
    expect(result).toEqual({ ok: false, outcome: 'unreachable' });
  });
});

describe('verifyTurnstile — empty token/secret short-circuit (no fetch)', () => {
  it('an absent token resolves outcome "rejected" with errorCodes:[missing-input-response] WITHOUT calling fetch — the no-token case must carry a diagnosable code like every siteverify rejection does', async () => {
    const fetchMock = mockFetch(async () => ({ json: async () => ({ success: true }) }));
    const result = await verifyTurnstile(undefined, { secret: 'sekret' });
    expect(result).toEqual({ ok: false, outcome: 'rejected', errorCodes: ['missing-input-response'] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an empty-string token resolves outcome "rejected" with errorCodes:[missing-input-response] WITHOUT calling fetch', async () => {
    const fetchMock = mockFetch(async () => ({ json: async () => ({ success: true }) }));
    const result = await verifyTurnstile('', { secret: 'sekret' });
    expect(result).toEqual({ ok: false, outcome: 'rejected', errorCodes: ['missing-input-response'] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an empty secret resolves outcome "skipped", NOT "rejected" — nothing was checked, so a host that refuses on "rejected" must not refuse here', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = mockFetch(async () => ({ json: async () => ({ success: true }) }));
    const result = await verifyTurnstile('good-token', { secret: '' });
    expect(result).toEqual({ ok: false, outcome: 'skipped' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('verifyTurnstile — never throws', () => {
  it('a network error / rejection resolves outcome "unreachable" so an outage never drops a real submission', async () => {
    mockFetch(async () => {
      throw new Error('network down');
    });
    const result = await verifyTurnstile('good-token', { secret: 'sekret' });
    expect(result).toEqual({ ok: false, outcome: 'unreachable' });
  });

  it('a timeout/abort rejection resolves outcome "unreachable"', async () => {
    mockFetch(async () => {
      throw new Error('The operation was aborted');
    });
    const result = await verifyTurnstile('good-token', { secret: 'sekret' });
    expect(result).toEqual({ ok: false, outcome: 'unreachable' });
  });

  it('a malformed JSON response body resolves outcome "unreachable"', async () => {
    mockFetch(async () => ({
      json: async () => {
        throw new Error('Unexpected token');
      },
    }));
    const result = await verifyTurnstile('good-token', { secret: 'sekret' });
    expect(result).toEqual({ ok: false, outcome: 'unreachable' });
  });
});

// ---------------------------------------------------------------------------
// The inert-gate warning. The failure this guards against is a bot gate that
// is switched OFF by a missing env var and looks identical to a working one:
// hosts have learned about it from Cloudflare's dashboard saying siteverify
// was never called, not from their own logs.
// ---------------------------------------------------------------------------

describe('verifyTurnstile — inert-gate warning (loud once, never per request)', () => {
  it('warns on the first call made without a secret, naming TURNSTILE_SECRET_KEY as the missing config', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await verifyTurnstile('good-token', { secret: '' });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const record = JSON.parse(warnSpy.mock.calls[0]![0] as string) as Record<string, unknown>;
    expect(record.event).toBe('turnstile.inert');
    expect(record.level).toBe('warn');
    expect(record.missingConfig).toBe('TURNSTILE_SECRET_KEY');
    expect(record.where).toBe('verifyTurnstile');
  });

  it('warns ONCE per process however many unverified requests arrive — a per-request line would drown the log it is meant to be found in', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await verifyTurnstile('a', { secret: '' });
    await verifyTurnstile('b', { secret: '' });
    await verifyTurnstile('c', { secret: '' });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('never warns while a secret is configured, whatever siteverify answers', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockFetch(async () => ({ json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }) }));
    await verifyTurnstile('bad-token', { secret: 'sekret' });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warnTurnstileInert() shares the one-per-process budget with verifyTurnstile, so a route that warns first silences the helper (and vice versa)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warnTurnstileInert('routes/abandon', { effect: 'nothing is verified' });
    await verifyTurnstile('good-token', { secret: '' });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const record = JSON.parse(warnSpy.mock.calls[0]![0] as string) as Record<string, unknown>;
    expect(record.where).toBe('routes/abandon');
    expect(record.effect).toBe('nothing is verified');
  });
});

describe('verifyTurnstile — request shape', () => {
  it('POSTs JSON {secret, response, remoteip?} to the siteverify endpoint with a 3s AbortSignal.timeout', async () => {
    const fetchMock = mockFetch(async () => ({ json: async () => ({ success: true }) }));
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');

    await verifyTurnstile('tok123', { secret: 'sekret', remoteip: '203.0.113.5' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      secret: 'sekret',
      response: 'tok123',
      remoteip: '203.0.113.5',
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(timeoutSpy).toHaveBeenCalledWith(3000);

    timeoutSpy.mockRestore();
  });

  it('omits remoteip from the body when not provided', async () => {
    const fetchMock = mockFetch(async () => ({ json: async () => ({ success: true }) }));
    await verifyTurnstile('tok123', { secret: 'sekret' });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ secret: 'sekret', response: 'tok123' });
  });

  it('passes idempotency_key through when provided (safe-retry reuse, Research Don\'t-Hand-Roll)', async () => {
    const fetchMock = mockFetch(async () => ({ json: async () => ({ success: true }) }));
    await verifyTurnstile('tok123', { secret: 'sekret', idempotencyKey: 'idem-1' });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      secret: 'sekret',
      response: 'tok123',
      idempotency_key: 'idem-1',
    });
  });
});
