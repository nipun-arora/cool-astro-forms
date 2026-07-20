/**
 * Server-side journey duration recompute + cap enforcement (JRNY-02).
 *
 * The server NEVER trusts client-supplied step durations — every duration is
 * recomputed here from `ts` deltas. This module also re-enforces JRNY-01's
 * caps server-side (a malicious client could ship an oversized/forged
 * trail), sanitizes timestamps, and strips privacy-sensitive fields (query
 * strings always; `params` unless the site opts in via `journeyParams`)
 * before a step is ever persisted or emailed.
 *
 * Clean-room: written fresh against the JourneyStep/ServerJourneyStep
 * contracts (Plan 01), not derived from any commercial form-plugin source.
 */
import {
  JOURNEY_MAX_AGE_MS,
  JOURNEY_MAX_BYTES,
  JOURNEY_MAX_STEPS,
  STEP_DURATION_MAX_MS,
  STEP_TITLE_MAX,
  STEP_URL_MAX,
} from '../../limits.js';
import type { JourneyStep, ServerJourneyStep } from '../../types.js';

export interface RecomputeJourneyOptions {
  /** Params kept only when true (default false — dropped for privacy, D5). */
  journeyParams?: boolean;
}

export interface RecomputeJourneyResult {
  steps: ServerJourneyStep[];
  totalSteps: number;
  totalElapsedMs: number;
}

const EMPTY_RESULT: RecomputeJourneyResult = { steps: [], totalSteps: 0, totalElapsedMs: 0 };

/** Server-side equivalent of the client's stripQuery — no cross-import from client code. */
function stripQueryServer(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split('#')[0]!.split('?')[0]!;
  }
}

/** Query/hash stripped but origin KEPT — for external referrer-seed steps only. */
function stripQueryKeepOrigin(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split('#')[0]!.split('?')[0]!;
  }
}

function serializedByteLength(steps: unknown[]): number {
  return new TextEncoder().encode(JSON.stringify(steps)).length;
}

/**
 * Recomputes each step's server-authoritative `durationMs` from `ts` deltas
 * (JRNY-02), re-enforces JRNY-01's caps server-side, sanitizes timestamps,
 * and strips privacy-sensitive fields. Any incoming client-supplied
 * `duration` field is discarded — never read, only `url`/`title`/`ts`/
 * `params` are carried through.
 */
export function recomputeJourney(
  steps: JourneyStep[] | undefined,
  now: number,
  opts: RecomputeJourneyOptions = {},
): RecomputeJourneyResult {
  if (!steps || steps.length === 0) return EMPTY_RESULT;

  // 1. Timestamp sanitization: drop non-finite ts, clamp future ts to now,
  //    drop steps older than JOURNEY_MAX_AGE_MS.
  let sanitized = steps
    .filter((step) => Number.isFinite(step.ts))
    .map((step) => (step.ts > now ? { ...step, ts: now } : step))
    .filter((step) => now - step.ts <= JOURNEY_MAX_AGE_MS);

  // 2. Sort ascending by ts — defensive, the client trail should already be ordered.
  sanitized = [...sanitized].sort((a, b) => a.ts - b.ts);

  // 3. Cap step count — drop oldest.
  if (sanitized.length > JOURNEY_MAX_STEPS) {
    sanitized = sanitized.slice(sanitized.length - JOURNEY_MAX_STEPS);
  }

  // 4. Privacy + truncation: query strings always stripped; params dropped
  //    unless opts.journeyParams is true; url/title truncated to caps.
  //    Rebuilding a clean object here also structurally strips any
  //    unexpected extra property (e.g. a forged client `duration`).
  //    The external referrer-seed flag survives, and an external step keeps
  //    its ORIGIN (query still stripped) — that step IS the traffic source,
  //    and reducing it to a bare pathname destroys exactly the information
  //    the seed exists to carry.
  const privacyApplied: JourneyStep[] = sanitized.map((step) => {
    const cleaned: JourneyStep = {
      url: (step.external === true ? stripQueryKeepOrigin(step.url) : stripQueryServer(step.url)).slice(0, STEP_URL_MAX),
      title: step.title.slice(0, STEP_TITLE_MAX),
      ts: step.ts,
    };
    if (step.external === true) {
      cleaned.external = true;
    }
    if (opts.journeyParams && step.params) {
      cleaned.params = step.params;
    }
    return cleaned;
  });

  // 5. Compute durations from ts deltas — the client's duration field, if
  //    any survived this far, was never read above and is never read here.
  const withDurations: ServerJourneyStep[] = privacyApplied.map((step, i) => {
    const next = privacyApplied[i + 1];
    const raw = next ? next.ts - step.ts : now - step.ts;
    const durationMs = Math.min(Math.max(raw, 0), STEP_DURATION_MAX_MS);
    return { ...step, durationMs };
  });

  // 6. Cap serialized bytes — drop oldest. Safe post-duration: durations
  //    only depend on the NEXT step (or now), never on preceding steps, so
  //    dropping from the front never invalidates a surviving step's duration.
  let final = withDurations;
  while (final.length > 0 && serializedByteLength(final) > JOURNEY_MAX_BYTES) {
    final = final.slice(1);
  }

  const totalElapsedMs = final.reduce((sum, step) => sum + step.durationMs, 0);

  return { steps: final, totalSteps: final.length, totalElapsedMs };
}
