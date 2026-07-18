/**
 * Client-side user-journey trail (JRNY-01).
 *
 * Written fresh against MDN localStorage/URL specs — clean-room, not derived
 * from commercial form-plugin source. Tracks page views into a capped localStorage trail:
 * `{url (query-stripped), title, ts, params?}`. The server (Plan 06) recomputes
 * per-step durations from `ts` deltas; this module never computes or ships a
 * client-side duration (JRNY-02).
 */
import { JOURNEY_MAX_AGE_MS, JOURNEY_MAX_BYTES, JOURNEY_MAX_STEPS } from '../limits.js';
import type { JourneyStep } from '../types.js';

const STORAGE_KEY = '_caf_journey';

// ---------------------------------------------------------------------------
// Config global read by the client scripts (provided by the integration's
// injected config script — Plan 08). Declared here since journey.ts is the
// first client module to need it (journeyParams); capture.ts/visitor.ts
// import journey.ts (directly or transitively) so this ambient decl merges
// into the same TS program without a duplicate declaration.
// ---------------------------------------------------------------------------
export interface CafClientConfig {
  siteId?: string;
  requireConsent?: boolean;
  journeyParams?: boolean;
  forms?: Record<string, { capture?: { allow?: string[]; deny?: string[] } }>;
  /** Computed by the integration from the host's trailingSlash config. Falls back to '/api/forms/abandon' when absent. */
  abandonEndpoint?: string;
  /** Present only when Turnstile (D3) is active — consumed by the P04 widget loader. Absent when TURNSTILE_SITE_KEY/SECRET_KEY are unset. */
  turnstileSiteKey?: string;
  /** Computed by the integration from the host's trailingSlash config, same pattern as abandonEndpoint. Consumed by the P07 form_started ping. */
  startedEndpoint?: string;
  /**
   * Lead-recovery widget gate (RCV-01/D3) — populated by the integration's
   * buildPublicConfig (04-08) only when `recovery.enabled` is configured
   * host-side. Absent/enabled:false leaves both capture's fetch-reads-{saved}
   * seam and the standalone recovery-widget.ts inert (byte-identical to
   * Phase 3). `consentMode` defaults server-side to 'auto'; 'checkbox' is
   * the only mode where the widget renders an opt-in checkbox.
   *
   * `disabledForms` (04-10 gap closure — RCV-01/ROADMAP Phase 4 SC4
   * "per-form flag") lists the ids of forms whose per-form
   * `recovery.enabled:false` override turned recovery off for that form
   * specifically, while the site-wide switch (above) stays on for the
   * rest. Omitted entirely when no per-form override exists. Form ids are
   * ALREADY public in `__cafConfig.forms` — listing the disabled subset
   * here adds no new information class across the client boundary.
   */
  recovery?: { enabled?: boolean; consentMode?: 'auto' | 'checkbox'; disabledForms?: string[] };
}

declare global {
  interface Window {
    __cafConfig?: CafClientConfig;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (test-first, no I/O)
// ---------------------------------------------------------------------------

/** Returns the URL's pathname only — query string and hash are removed. */
export function stripQuery(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    // Relative URL with no base (e.g. a bare path) — strip manually.
    return url.split('#')[0]!.split('?')[0]!;
  }
}

function serializedByteLength(trail: JourneyStep[]): number {
  return new TextEncoder().encode(JSON.stringify(trail)).length;
}

/**
 * Appends `step`; if the trail's last step shares the same (already-stripped)
 * url, updates that step's `ts` instead of appending (consecutive dedupe).
 * Pure — returns a new array, never mutates `trail`.
 */
export function pushStep(trail: JourneyStep[], step: JourneyStep): JourneyStep[] {
  const last = trail[trail.length - 1];
  if (last && last.url === step.url) {
    return [...trail.slice(0, -1), { ...last, ts: step.ts }];
  }
  return [...trail, step];
}

/**
 * Enforces the JRNY-01 caps: drops steps older than `JOURNEY_MAX_AGE_MS`,
 * then drops oldest steps until the trail is at most `JOURNEY_MAX_STEPS`
 * entries AND serializes to at most `JOURNEY_MAX_BYTES`. Pure.
 */
export function pruneTrail(trail: JourneyStep[], now: number): JourneyStep[] {
  let pruned = trail.filter((step) => now - step.ts <= JOURNEY_MAX_AGE_MS);

  if (pruned.length > JOURNEY_MAX_STEPS) {
    pruned = pruned.slice(pruned.length - JOURNEY_MAX_STEPS);
  }

  while (pruned.length > 0 && serializedByteLength(pruned) > JOURNEY_MAX_BYTES) {
    pruned = pruned.slice(1);
  }

  return pruned;
}

/**
 * When `trail` is empty and `referrer` is a non-empty EXTERNAL url (an origin
 * different from `currentOrigin`), prepends a synthetic first step marked
 * external. Same-origin or malformed referrers leave the trail unchanged.
 * The seeded step's `url` intentionally retains the referrer's origin (unlike
 * `stripQuery`'s page-view pathname) so it stays recognizable as external
 * even though `JourneyStep` carries no dedicated boolean field for it.
 */
export function seedReferrer(
  trail: JourneyStep[],
  referrer: string,
  currentOrigin: string,
  now: number,
): JourneyStep[] {
  if (trail.length > 0 || !referrer) return trail;

  let referrerUrl: URL;
  try {
    referrerUrl = new URL(referrer);
  } catch {
    return trail;
  }

  if (referrerUrl.origin === currentOrigin) return trail;

  const seedStep: JourneyStep & { external: true } = {
    url: `${referrerUrl.origin}${referrerUrl.pathname}`,
    title: referrerUrl.hostname,
    ts: now,
    external: true,
  };

  return [seedStep, ...trail];
}

// ---------------------------------------------------------------------------
// Stateful trail I/O — try/catch-wrapped localStorage with an in-memory
// fallback (Safari private mode THROWS on localStorage access, not just
// returns undefined — review S4-3).
// ---------------------------------------------------------------------------

let memoryFallbackTrail: JourneyStep[] = [];
let usingMemoryFallback = false;

function hasLocalStorage(): boolean {
  return typeof localStorage !== 'undefined';
}

export function readTrail(): JourneyStep[] {
  if (usingMemoryFallback || !hasLocalStorage()) return memoryFallbackTrail;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as JourneyStep[]) : [];
  } catch {
    usingMemoryFallback = true;
    return memoryFallbackTrail;
  }
}

export function writeTrail(trail: JourneyStep[]): void {
  if (usingMemoryFallback || !hasLocalStorage()) {
    memoryFallbackTrail = trail;
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trail));
  } catch {
    usingMemoryFallback = true;
    memoryFallbackTrail = trail;
  }
}

export function clearTrail(): void {
  memoryFallbackTrail = [];
  if (usingMemoryFallback || !hasLocalStorage()) return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    usingMemoryFallback = true;
  }
}

function extractParams(url: string): Record<string, string> | undefined {
  try {
    const params: Record<string, string> = {};
    new URL(url).searchParams.forEach((value, key) => {
      params[key] = value;
    });
    return Object.keys(params).length > 0 ? params : undefined;
  } catch {
    return undefined;
  }
}

export interface RecordPageViewInput {
  url: string;
  title: string;
  referrer: string;
  now: number;
  /** Params attached only when true (default false — dropped for privacy, D5). */
  journeyParams?: boolean;
}

/**
 * Composes stripQuery + seedReferrer + pushStep + pruneTrail and persists
 * the result. Returns the (already-pruned) trail.
 */
export function recordPageView(input: RecordPageViewInput): JourneyStep[] {
  let trail = readTrail();

  let currentOrigin = '';
  try {
    currentOrigin = new URL(input.url).origin;
  } catch {
    currentOrigin = '';
  }

  trail = seedReferrer(trail, input.referrer, currentOrigin, input.now);

  const step: JourneyStep = {
    url: stripQuery(input.url),
    title: input.title,
    ts: input.now,
  };

  if (input.journeyParams) {
    const params = extractParams(input.url);
    if (params) step.params = params;
  }

  trail = pushStep(trail, step);
  trail = pruneTrail(trail, input.now);
  writeTrail(trail);
  return trail;
}

// ---------------------------------------------------------------------------
// Browser bootstrap — records the current page view on module load and
// rebinds on every Astro View Transitions client-side navigation. SSR-guarded
// (no-ops when `document` is undefined). Registered exactly once (review S4-5).
// ---------------------------------------------------------------------------

let pageLoadListenerRegistered = false;

function recordCurrentPageView(): void {
  const journeyParams = typeof window !== 'undefined' && window.__cafConfig?.journeyParams === true;
  recordPageView({
    url: location.href,
    title: document.title,
    referrer: document.referrer,
    now: Date.now(),
    journeyParams,
  });
}

function initJourneyTracking(): void {
  if (typeof document === 'undefined') return;
  recordCurrentPageView();
  if (!pageLoadListenerRegistered) {
    document.addEventListener('astro:page-load', recordCurrentPageView);
    pageLoadListenerRegistered = true;
  }
}

initJourneyTracking();
