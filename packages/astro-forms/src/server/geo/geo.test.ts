import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPrivateOrLocal, lookupGeo } from './geo.js';

// Every case here mocks global fetch — NEVER a live call to ipwho.is
// (Research Environment Availability: fixture-mocked fetch is mandatory,
// mirrors notify.test.ts's jsonTransport pattern).

const opts = { providerUrl: 'https://ipwho.is/{ip}', timeoutMs: 3000 };

const successFixture = {
  success: true,
  city: 'Mountain View',
  region: 'California',
  country: 'United States',
  latitude: 37.4056,
  longitude: -122.0775,
  postal: '94043',
  connection: { isp: 'Google LLC' },
};

function mockFetch(impl: (...args: unknown[]) => unknown) {
  const fetchMock = vi.fn(impl);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GEO_PROVIDER;
});

// ---------------------------------------------------------------------------
// isPrivateOrLocal
// ---------------------------------------------------------------------------

describe('isPrivateOrLocal', () => {
  const privateCases: Array<[string, string]> = [
    ['10.0.0.0/8', '10.1.2.3'],
    ['172.16.0.0/12 lower bound', '172.16.0.1'],
    ['172.16.0.0/12 upper bound', '172.31.255.255'],
    ['192.168.0.0/16', '192.168.1.1'],
    ['127.0.0.0/8', '127.0.0.1'],
    ['::1 loopback', '::1'],
    ['fc00::/7 (fc)', 'fc00::1'],
    ['fc00::/7 (fd)', 'fd12:3456::1'],
    ['fe80::/10 link-local', 'fe80::1'],
    ['0.0.0.0', '0.0.0.0'],
    [':: unspecified', '::'],
    ['empty string', ''],
  ];

  it.each(privateCases)('%s (%s) -> true', (_label, ip) => {
    expect(isPrivateOrLocal(ip)).toBe(true);
  });

  it('a public IP -> false', () => {
    expect(isPrivateOrLocal('203.0.113.5')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// lookupGeo — success mapping
// ---------------------------------------------------------------------------

describe('lookupGeo — success mapping', () => {
  it('maps the ipwho.is success fixture: latitude->lat, longitude->lon, connection.isp->isp', async () => {
    const fetchMock = mockFetch(async () => ({ ok: true, json: async () => successFixture }));

    const geo = await lookupGeo('203.0.113.5', opts);

    expect(geo).toEqual({
      city: 'Mountain View',
      region: 'California',
      country: 'United States',
      lat: 37.4056,
      lon: -122.0775,
      postal: '94043',
      isp: 'Google LLC',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://ipwho.is/203.0.113.5');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

// ---------------------------------------------------------------------------
// lookupGeo — never throws, resolves undefined on every failure mode
// ---------------------------------------------------------------------------

describe('lookupGeo — never throws, resolves undefined on failure', () => {
  it('private IP -> undefined, no fetch call', async () => {
    const fetchMock = mockFetch(async () => ({ ok: true, json: async () => successFixture }));
    const geo = await lookupGeo('10.0.0.5', opts);
    expect(geo).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('empty IP -> undefined, no fetch call', async () => {
    const fetchMock = mockFetch(async () => ({ ok: true, json: async () => successFixture }));
    const geo = await lookupGeo('', opts);
    expect(geo).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a fetch rejection (network error / abort timeout) -> undefined', async () => {
    mockFetch(async () => {
      throw new Error('The operation was aborted');
    });
    const geo = await lookupGeo('203.0.113.5', opts);
    expect(geo).toBeUndefined();
  });

  it('res.ok === false -> undefined', async () => {
    mockFetch(async () => ({ ok: false, json: async () => ({}) }));
    const geo = await lookupGeo('203.0.113.5', opts);
    expect(geo).toBeUndefined();
  });

  it('body success:false -> undefined', async () => {
    mockFetch(async () => ({ ok: true, json: async () => ({ success: false, message: 'invalid ip' }) }));
    const geo = await lookupGeo('203.0.113.5', opts);
    expect(geo).toBeUndefined();
  });

  it('a JSON-parse failure on the response body -> undefined', async () => {
    mockFetch(async () => ({
      ok: true,
      json: async () => {
        throw new Error('Unexpected token');
      },
    }));
    const geo = await lookupGeo('203.0.113.5', opts);
    expect(geo).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// lookupGeo — provider URL + timeout wiring
// ---------------------------------------------------------------------------

describe('lookupGeo — provider URL + timeout', () => {
  it('substitutes {ip} with encodeURIComponent(ip) into providerUrl', async () => {
    const fetchMock = mockFetch(async () => ({ ok: true, json: async () => successFixture }));
    await lookupGeo('2001:db8::1', { providerUrl: 'https://example.test/lookup?ip={ip}', timeoutMs: 3000 });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(`https://example.test/lookup?ip=${encodeURIComponent('2001:db8::1')}`);
  });

  it('process.env.GEO_PROVIDER overrides opts.providerUrl when set', async () => {
    process.env.GEO_PROVIDER = 'https://override.test/{ip}';
    const fetchMock = mockFetch(async () => ({ ok: true, json: async () => successFixture }));
    await lookupGeo('203.0.113.5', opts);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://override.test/203.0.113.5');
  });

  it('uses opts.timeoutMs on AbortSignal.timeout', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    mockFetch(async () => ({ ok: true, json: async () => successFixture }));
    await lookupGeo('203.0.113.5', { providerUrl: 'https://ipwho.is/{ip}', timeoutMs: 1234 });
    expect(timeoutSpy).toHaveBeenCalledWith(1234);
    timeoutSpy.mockRestore();
  });
});
