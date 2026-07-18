// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JOURNEY_MAX_AGE_MS, JOURNEY_MAX_BYTES, JOURNEY_MAX_STEPS } from '../limits.js';
import type { JourneyStep } from '../types.js';
import {
  clearTrail,
  pruneTrail,
  pushStep,
  readTrail,
  recordPageView,
  seedReferrer,
  stripQuery,
  writeTrail,
} from './journey.js';

const NOW = Date.UTC(2026, 6, 12, 12, 0, 0);

function makeStep(overrides: Partial<JourneyStep> = {}): JourneyStep {
  return { url: '/page', title: 'Page', ts: NOW, ...overrides };
}

beforeEach(() => {
  localStorage.clear();
  clearTrail();
});

describe('stripQuery', () => {
  it('returns the pathname, dropping query and hash from an absolute URL', () => {
    expect(stripQuery('https://example.com/pricing?utm=x#section')).toBe('/pricing');
  });

  it('falls back to manual stripping for a relative URL', () => {
    expect(stripQuery('/pricing?utm=x#section')).toBe('/pricing');
  });
});

describe('pushStep', () => {
  it('appends a distinct step', () => {
    const trail = pushStep([], makeStep());
    expect(trail).toHaveLength(1);
  });

  it('updates ts instead of appending when the last step has the same url (consecutive dedupe)', () => {
    const first = pushStep([], makeStep({ url: '/page', ts: NOW }));
    const second = pushStep(first, makeStep({ url: '/page', ts: NOW + 5000 }));
    expect(second).toHaveLength(1);
    expect(second[0]!.ts).toBe(NOW + 5000);
  });

  it('appends when the url differs from the last step', () => {
    const first = pushStep([], makeStep({ url: '/a', ts: NOW }));
    const second = pushStep(first, makeStep({ url: '/b', ts: NOW + 1000 }));
    expect(second).toHaveLength(2);
  });
});

describe('pruneTrail', () => {
  it('drops the oldest step once the trail exceeds JOURNEY_MAX_STEPS', () => {
    const trail: JourneyStep[] = Array.from({ length: JOURNEY_MAX_STEPS + 1 }, (_, i) =>
      makeStep({ url: `/page-${i}`, ts: NOW + i }),
    );
    const pruned = pruneTrail(trail, NOW + JOURNEY_MAX_STEPS);
    expect(pruned).toHaveLength(JOURNEY_MAX_STEPS);
    expect(pruned[0]!.url).toBe('/page-1');
  });

  it('prunes a trail whose serialization exceeds JOURNEY_MAX_BYTES down to at most that many bytes', () => {
    const longTitle = 'x'.repeat(500);
    const trail: JourneyStep[] = Array.from({ length: 40 }, (_, i) =>
      makeStep({ url: `/page-${i}`, title: longTitle, ts: NOW + i }),
    );
    const beforeBytes = new TextEncoder().encode(JSON.stringify(trail)).length;
    expect(beforeBytes).toBeGreaterThan(JOURNEY_MAX_BYTES);

    const pruned = pruneTrail(trail, NOW + 40);
    const afterBytes = new TextEncoder().encode(JSON.stringify(pruned)).length;
    expect(afterBytes).toBeLessThanOrEqual(JOURNEY_MAX_BYTES);
  });

  it('drops a step older than JOURNEY_MAX_AGE_MS', () => {
    const old = makeStep({ url: '/old', ts: NOW - JOURNEY_MAX_AGE_MS - 1 });
    const recent = makeStep({ url: '/recent', ts: NOW });
    const pruned = pruneTrail([old, recent], NOW);
    expect(pruned).toHaveLength(1);
    expect(pruned[0]!.url).toBe('/recent');
  });
});

describe('seedReferrer', () => {
  const currentOrigin = 'https://example.com';

  it('prepends exactly one synthetic step for a non-empty EXTERNAL referrer on an empty trail', () => {
    const trail = seedReferrer([], 'https://google.com/search?q=x', currentOrigin, NOW);
    expect(trail).toHaveLength(1);
    expect(trail[0]!.url).toBe('https://google.com/search');
  });

  it('does not seed when the referrer is same-origin', () => {
    const trail = seedReferrer([], 'https://example.com/other-page', currentOrigin, NOW);
    expect(trail).toHaveLength(0);
  });

  it('does not seed when the trail already has a step', () => {
    const trail = seedReferrer([makeStep()], 'https://google.com/search', currentOrigin, NOW);
    expect(trail).toHaveLength(1);
  });

  it('does not seed when the referrer is empty', () => {
    const trail = seedReferrer([], '', currentOrigin, NOW);
    expect(trail).toHaveLength(0);
  });
});

describe('recordPageView + readTrail/writeTrail/clearTrail', () => {
  it('persists a step to localStorage under the _caf_journey key', () => {
    recordPageView({
      url: 'https://example.com/pricing',
      title: 'Pricing',
      referrer: '',
      now: NOW,
    });
    const raw = localStorage.getItem('_caf_journey');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].url).toBe('/pricing');
  });

  it('omits params by default (journeyParams false)', () => {
    const trail = recordPageView({
      url: 'https://example.com/pricing?utm_source=ads',
      title: 'Pricing',
      referrer: '',
      now: NOW,
    });
    expect(trail[trail.length - 1]!.params).toBeUndefined();
  });

  it('attaches params when journeyParams is true', () => {
    const trail = recordPageView({
      url: 'https://example.com/pricing?utm_source=ads',
      title: 'Pricing',
      referrer: '',
      now: NOW,
      journeyParams: true,
    });
    expect(trail[trail.length - 1]!.params).toEqual({ utm_source: 'ads' });
  });

  it('clearTrail empties a populated trail', () => {
    writeTrail([makeStep()]);
    expect(readTrail()).toHaveLength(1);
    clearTrail();
    expect(readTrail()).toHaveLength(0);
  });
});

describe('localStorage failure fallback (Safari private mode)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('degrades to an in-memory trail without throwing when localStorage throws', async () => {
    vi.resetModules();
    const throwingStorage: Storage = {
      getItem() {
        throw new DOMException('Access is denied', 'SecurityError');
      },
      setItem() {
        throw new DOMException('Access is denied', 'SecurityError');
      },
      removeItem() {
        throw new DOMException('Access is denied', 'SecurityError');
      },
      clear() {},
      key() {
        return null;
      },
      length: 0,
    };
    vi.stubGlobal('localStorage', throwingStorage);

    const fresh = await import('./journey.js');

    expect(() =>
      fresh.recordPageView({
        url: 'https://example.com/checkout',
        title: 'Checkout',
        referrer: '',
        now: NOW,
      }),
    ).not.toThrow();

    // The module-load auto page-view AND the explicit call above both landed
    // in the in-memory fallback trail — never threw despite localStorage
    // throwing on every access.
    expect(fresh.readTrail().length).toBeGreaterThanOrEqual(1);
  });
});
