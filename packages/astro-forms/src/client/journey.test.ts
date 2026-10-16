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

// 0.1.18: requireConsent gate. initJourneyTracking() runs at module load, so
// each case resets modules and sets window.__cafConfig BEFORE the dynamic
// import (the integration injects the config head-inline ahead of the module
// scripts — LESSONS #10). The gate reuses visitor.ts's hasConsent mechanism
// (grantConsent / window.__cafConsent / persisted flag), same as capture.ts.
describe('requireConsent gate (0.1.18)', () => {
  const JOURNEY_KEY = '_caf_journey';

  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    delete window.__cafConsent;
    delete window.__cafConfig;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete window.__cafConsent;
    delete window.__cafConfig;
    vi.resetModules();
  });

  it('writes no journey trail to localStorage at module load before consent when requireConsent is true', async () => {
    window.__cafConfig = { requireConsent: true };
    const setItem = vi.spyOn(Storage.prototype, 'setItem');

    await import('./journey.js');

    expect(setItem.mock.calls.filter(([key]) => key === JOURNEY_KEY)).toHaveLength(0);
    expect(localStorage.getItem(JOURNEY_KEY)).toBeNull();
  });

  it('does not record on astro:page-load before consent when requireConsent is true', async () => {
    window.__cafConfig = { requireConsent: true };
    await import('./journey.js');

    document.dispatchEvent(new Event('astro:page-load'));

    expect(localStorage.getItem(JOURNEY_KEY)).toBeNull();
  });

  // Kept ahead of the consent-granting cases: astro:page-load listeners from
  // earlier module instances outlive vi.resetModules().
  it('clears a stored trail on astro:page-load while consent is still missing', async () => {
    window.__cafConfig = { requireConsent: true };
    await import('./journey.js');
    localStorage.setItem(JOURNEY_KEY, JSON.stringify([{ url: '/old', title: 'Old', ts: Date.now() }]));

    document.dispatchEvent(new Event('astro:page-load'));

    expect(localStorage.getItem(JOURNEY_KEY)).toBeNull();
  });

  it('starts recording from the page where consent is granted, without backfilling earlier pages', async () => {
    window.__cafConfig = { requireConsent: true };
    const journey = await import('./journey.js');
    const visitor = await import('./visitor.js');
    expect(localStorage.getItem(JOURNEY_KEY)).toBeNull();

    visitor.grantConsent();
    journey.recordCurrentPageView();

    const trail = journey.readTrail();
    expect(trail).toHaveLength(1);
    expect(trail[0]!.url).toBe(location.pathname);
    expect(localStorage.getItem(JOURNEY_KEY)).not.toBeNull();
  });

  it('records on the next astro:page-load once consent is granted', async () => {
    window.__cafConfig = { requireConsent: true };
    const journey = await import('./journey.js');
    const visitor = await import('./visitor.js');

    visitor.grantConsent();
    document.dispatchEvent(new Event('astro:page-load'));

    expect(journey.readTrail()).toHaveLength(1);
  });

  it('records at module load when consent was already persisted (window.__cafConsent set by the host)', async () => {
    window.__cafConfig = { requireConsent: true };
    window.__cafConsent = true;

    const journey = await import('./journey.js');

    expect(journey.readTrail()).toHaveLength(1);
  });

  // Sites on <=0.1.17 stored a trail (up to 365 days) before any consent
  // check existed. Left in place it would ship with the abandon payload the
  // moment the visitor consents, so the gate clears it. Removing stored data
  // needs no consent.
  it('clears a pre-0.1.18 trail at module load when requireConsent is true and consent is missing, then restarts from one step after consent', async () => {
    const old: JourneyStep[] = [
      { url: '/old-a', title: 'Old A', ts: Date.now() - 86_400_000 },
      { url: '/old-b', title: 'Old B', ts: Date.now() - 3_600_000 },
    ];
    localStorage.setItem(JOURNEY_KEY, JSON.stringify(old));
    window.__cafConfig = { requireConsent: true };

    const journey = await import('./journey.js');
    const visitor = await import('./visitor.js');

    expect(localStorage.getItem(JOURNEY_KEY)).toBeNull();

    visitor.grantConsent();
    journey.recordCurrentPageView();

    const trail = journey.readTrail();
    expect(trail).toHaveLength(1);
    expect(trail[0]!.url).toBe(location.pathname);
  });

  it('records at module load with no consent signal when requireConsent is false (unchanged)', async () => {
    window.__cafConfig = { requireConsent: false };

    const journey = await import('./journey.js');

    expect(journey.readTrail()).toHaveLength(1);
    expect(localStorage.getItem(JOURNEY_KEY)).not.toBeNull();
  });

  it('records at module load when no client config is present (unchanged default)', async () => {
    const journey = await import('./journey.js');

    expect(journey.readTrail()).toHaveLength(1);
  });
});
