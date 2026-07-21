import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyTurnstile } from './turnstile.js';

// Every case here mocks global fetch — NEVER a live call to Cloudflare's
// siteverify endpoint (mirrors geo.test.ts's fetch-mocking convention).

function mockFetch(impl: (...args: unknown[]) => unknown) {
  const fetchMock = vi.fn(impl);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('verifyTurnstile — mocked siteverify responses', () => {
  it('a {success:true} response resolves {ok:true}', async () => {
    mockFetch(async () => ({ json: async () => ({ success: true }) }));
    const result = await verifyTurnstile('good-token', { secret: 'sekret' });
    expect(result).toEqual({ ok: true });
  });

  it('a {success:false, "error-codes":[...]} response resolves {ok:false, errorCodes}', async () => {
    mockFetch(async () => ({
      json: async () => ({ success: false, 'error-codes': ['timeout-or-duplicate'] }),
    }));
    const result = await verifyTurnstile('replayed-token', { secret: 'sekret' });
    expect(result).toEqual({ ok: false, errorCodes: ['timeout-or-duplicate'] });
  });
});

describe('verifyTurnstile — empty token/secret short-circuit (no fetch)', () => {
  it('an absent token resolves {ok:false, errorCodes:[missing-input-response]} WITHOUT calling fetch — the no-token case must carry a diagnosable code like every siteverify rejection does', async () => {
    const fetchMock = mockFetch(async () => ({ json: async () => ({ success: true }) }));
    const result = await verifyTurnstile(undefined, { secret: 'sekret' });
    expect(result).toEqual({ ok: false, errorCodes: ['missing-input-response'] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an empty-string token resolves {ok:false, errorCodes:[missing-input-response]} WITHOUT calling fetch', async () => {
    const fetchMock = mockFetch(async () => ({ json: async () => ({ success: true }) }));
    const result = await verifyTurnstile('', { secret: 'sekret' });
    expect(result).toEqual({ ok: false, errorCodes: ['missing-input-response'] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an empty secret resolves {ok:false} WITHOUT calling fetch (module inert without a configured secret)', async () => {
    const fetchMock = mockFetch(async () => ({ json: async () => ({ success: true }) }));
    const result = await verifyTurnstile('good-token', { secret: '' });
    expect(result).toEqual({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('verifyTurnstile — never throws', () => {
  it('a network error / rejection resolves {ok:false}', async () => {
    mockFetch(async () => {
      throw new Error('network down');
    });
    const result = await verifyTurnstile('good-token', { secret: 'sekret' });
    expect(result).toEqual({ ok: false });
  });

  it('a timeout/abort rejection resolves {ok:false}', async () => {
    mockFetch(async () => {
      throw new Error('The operation was aborted');
    });
    const result = await verifyTurnstile('good-token', { secret: 'sekret' });
    expect(result).toEqual({ ok: false });
  });

  it('a malformed JSON response body resolves {ok:false}', async () => {
    mockFetch(async () => ({
      json: async () => {
        throw new Error('Unexpected token');
      },
    }));
    const result = await verifyTurnstile('good-token', { secret: 'sekret' });
    expect(result).toEqual({ ok: false });
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
