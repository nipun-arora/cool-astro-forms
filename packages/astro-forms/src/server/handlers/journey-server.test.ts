import { describe, expect, it } from 'vitest';
import {
  JOURNEY_MAX_AGE_MS,
  JOURNEY_MAX_BYTES,
  JOURNEY_MAX_STEPS,
  STEP_DURATION_MAX_MS,
  STEP_TITLE_MAX,
  STEP_URL_MAX,
} from '../../limits.js';
import type { JourneyStep } from '../../types.js';
import { recomputeJourney } from './journey-server.js';

function makeStep(overrides: Partial<JourneyStep> = {}): JourneyStep {
  return { url: '/page', title: 'Page', ts: 0, ...overrides };
}

describe('recomputeJourney — server-computed durations (JRNY-02)', () => {
  it('computes each step duration from ts deltas; the last step uses now - ts', () => {
    const steps: JourneyStep[] = [
      makeStep({ url: '/a', title: 'A', ts: 1000 }),
      makeStep({ url: '/b', title: 'B', ts: 4000 }),
      makeStep({ url: '/c', title: 'C', ts: 9000 }),
    ];
    const result = recomputeJourney(steps, 10_000);
    expect(result.steps.map((s) => s.durationMs)).toEqual([3000, 5000, 1000]);
    expect(result.totalElapsedMs).toBe(9000);
    expect(result.totalSteps).toBe(3);
  });

  it('ignores a forged client-supplied duration field, deriving only from ts deltas', () => {
    const forged = { url: '/a', title: 'A', ts: 1000, duration: 999999 } as JourneyStep;
    const steps: JourneyStep[] = [forged, makeStep({ url: '/b', title: 'B', ts: 2000 })];
    const result = recomputeJourney(steps, 3000);
    expect(result.steps[0]!.durationMs).toBe(1000);
    expect(result.steps[0]!.durationMs).not.toBe(999999);
    expect((result.steps[0] as unknown as Record<string, unknown>).duration).toBeUndefined();
  });

  it('every output step satisfies ServerJourneyStep (numeric durationMs)', () => {
    const steps: JourneyStep[] = [makeStep({ ts: 1000 }), makeStep({ url: '/b', ts: 2000 })];
    const result = recomputeJourney(steps, 3000);
    for (const step of result.steps) {
      expect(typeof step.durationMs).toBe('number');
      expect(Number.isFinite(step.durationMs)).toBe(true);
    }
  });
});

describe('recomputeJourney — external referrer seed (traffic source)', () => {
  it('preserves external:true and the seed step origin so the traffic source survives recompute into storage and emails', () => {
    const steps: JourneyStep[] = [
      makeStep({ url: 'https://www.google.com/search', title: 'www.google.com', ts: 1000, external: true }),
      makeStep({ url: 'https://geeksite.example/python-help/?q=1', title: 'Python Help', ts: 2000 }),
    ];
    const result = recomputeJourney(steps, 3000);
    expect(result.steps[0]).toEqual(
      expect.objectContaining({ url: 'https://www.google.com/search', external: true }),
    );
    // Internal steps stay privacy-stripped to pathname, no external key.
    expect(result.steps[1]!.url).toBe('/python-help/');
    expect(result.steps[1]).not.toHaveProperty('external');
  });

  it('never invents an external flag: a client sending external on an internal-looking step keeps the flag but still loses query strings', () => {
    const steps: JourneyStep[] = [
      makeStep({ url: 'https://evil.example/landing?session=abc', title: 'evil', ts: 1000, external: true }),
    ];
    const result = recomputeJourney(steps, 2000);
    expect(result.steps[0]!.url).toBe('https://evil.example/landing');
    expect(result.steps[0]!.external).toBe(true);
  });
});

describe('recomputeJourney — server-side caps re-enforced', () => {
  it('drops oldest steps beyond JOURNEY_MAX_STEPS', () => {
    const steps: JourneyStep[] = Array.from({ length: JOURNEY_MAX_STEPS + 5 }, (_, i) =>
      makeStep({ url: `/page-${i}`, ts: i * 1000 }),
    );
    const now = (JOURNEY_MAX_STEPS + 5) * 1000;
    const result = recomputeJourney(steps, now);
    expect(result.steps).toHaveLength(JOURNEY_MAX_STEPS);
    expect(result.steps[0]!.url).toBe('/page-5');
  });

  it('drops oldest steps beyond JOURNEY_MAX_BYTES', () => {
    const longTitle = 'x'.repeat(200);
    const steps: JourneyStep[] = Array.from({ length: 60 }, (_, i) =>
      makeStep({ url: `/page-${i}`, title: longTitle, ts: i * 1000 }),
    );
    const now = 60_000;
    const beforeBytes = new TextEncoder().encode(JSON.stringify(steps)).length;
    expect(beforeBytes).toBeGreaterThan(JOURNEY_MAX_BYTES);

    const result = recomputeJourney(steps, now);
    const afterBytes = new TextEncoder().encode(JSON.stringify(result.steps)).length;
    expect(afterBytes).toBeLessThanOrEqual(JOURNEY_MAX_BYTES);
    expect(result.steps.length).toBeLessThan(60);
  });
});

describe('recomputeJourney — timestamp sanitization', () => {
  it('drops a step with non-finite ts', () => {
    const steps = [makeStep({ url: '/bad', ts: Number.NaN }), makeStep({ url: '/good', ts: 1000 })];
    const result = recomputeJourney(steps, 2000);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.url).toBe('/good');
  });

  it('clamps a future ts to now', () => {
    const now = 5000;
    const steps = [makeStep({ url: '/future', ts: now + 60_000 })];
    const result = recomputeJourney(steps, now);
    expect(result.steps[0]!.ts).toBe(now);
    expect(result.steps[0]!.durationMs).toBe(0);
  });

  it('clamps a computed duration exceeding STEP_DURATION_MAX_MS', () => {
    const steps = [makeStep({ url: '/a', ts: 0 }), makeStep({ url: '/b', ts: STEP_DURATION_MAX_MS * 3 })];
    const now = STEP_DURATION_MAX_MS * 3 + 1000;
    const result = recomputeJourney(steps, now);
    expect(result.steps[0]!.durationMs).toBe(STEP_DURATION_MAX_MS);
    expect(result.steps[1]!.durationMs).toBe(1000);
  });

  it('drops a step older than JOURNEY_MAX_AGE_MS (a "13-month-old" step)', () => {
    const now = JOURNEY_MAX_AGE_MS + 10_000;
    const thirteenMonthsAgo = now - JOURNEY_MAX_AGE_MS - 1000;
    const steps = [makeStep({ url: '/old', ts: thirteenMonthsAgo }), makeStep({ url: '/recent', ts: now - 500 })];
    const result = recomputeJourney(steps, now);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.url).toBe('/recent');
  });
});

describe('recomputeJourney — server-side privacy enforcement', () => {
  it('strips query strings from step urls', () => {
    const steps = [makeStep({ url: '/a?token=x', ts: 1000 })];
    const result = recomputeJourney(steps, 2000);
    expect(result.steps[0]!.url).toBe('/a');
  });

  it('drops params entirely when journeyParams is false (default)', () => {
    const steps = [makeStep({ url: '/a', ts: 1000, params: { utm_source: 'ads' } })];
    const result = recomputeJourney(steps, 2000);
    expect(result.steps[0]!.params).toBeUndefined();
  });

  it('drops params entirely when journeyParams is explicitly false', () => {
    const steps = [makeStep({ url: '/a', ts: 1000, params: { utm_source: 'ads' } })];
    const result = recomputeJourney(steps, 2000, { journeyParams: false });
    expect(result.steps[0]!.params).toBeUndefined();
  });

  it('keeps params when journeyParams is true', () => {
    const steps = [makeStep({ url: '/a', ts: 1000, params: { utm_source: 'ads' } })];
    const result = recomputeJourney(steps, 2000, { journeyParams: true });
    expect(result.steps[0]!.params).toEqual({ utm_source: 'ads' });
  });

  it('truncates an oversized url to STEP_URL_MAX', () => {
    const longUrl = `/${'a'.repeat(STEP_URL_MAX + 100)}`;
    const steps = [makeStep({ url: longUrl, ts: 1000 })];
    const result = recomputeJourney(steps, 2000);
    expect(result.steps[0]!.url.length).toBe(STEP_URL_MAX);
  });

  it('truncates an oversized title to STEP_TITLE_MAX', () => {
    const longTitle = 'x'.repeat(STEP_TITLE_MAX + 100);
    const steps = [makeStep({ title: longTitle, ts: 1000 })];
    const result = recomputeJourney(steps, 2000);
    expect(result.steps[0]!.title.length).toBe(STEP_TITLE_MAX);
  });
});

describe('recomputeJourney — sorting + empty input', () => {
  it('sorts steps by ts ascending defensively before computing durations', () => {
    const steps = [makeStep({ url: '/b', ts: 4000 }), makeStep({ url: '/a', ts: 1000 })];
    const result = recomputeJourney(steps, 5000);
    expect(result.steps.map((s) => s.url)).toEqual(['/a', '/b']);
    expect(result.steps[0]!.durationMs).toBe(3000);
  });

  it('returns an empty result for undefined/empty input', () => {
    expect(recomputeJourney(undefined, 1000)).toEqual({ steps: [], totalSteps: 0, totalElapsedMs: 0 });
    expect(recomputeJourney([], 1000)).toEqual({ steps: [], totalSteps: 0, totalElapsedMs: 0 });
  });
});
