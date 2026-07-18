/**
 * Shared Playwright e2e helpers (Plan 09) — DB reset/list via the
 * playground's dev-only `debug-entries` endpoint, real-browser abandon
 * trigger simulation, and small polling utilities. Not part of the package;
 * playground/test scaffolding only.
 */
import type { APIRequestContext, Page } from '@playwright/test';

// Mirrors playwright.config.ts's DEFAULT_URL — moved off 4321 (astro's own
// default) to a dedicated port so a local machine's unrelated dev server
// bound to 4321 can never get silently attached to by
// `reuseExistingServer` (see playwright.config.ts's own comment).
export const BASE_URL = 'http://localhost:4325';

export interface DebugEntry {
  id: string;
  siteId: string;
  formId: string;
  status: 'abandoned' | 'submitted' | 'converted' | 'spam';
  fields: Record<string, unknown>;
  visitorUuid: string;
  journey?: Array<{ url: string; title: string; ts: number; durationMs: number }>;
  createdAt: number;
  updatedAt: number;
}

/**
 * Resets entries + payments + files tables AND the package's per-process
 * test hooks. `baseUrl` defaults to the shared default-instance `BASE_URL`
 * — pass an alternate origin to target a dedicated Playwright webServer
 * instance (e.g. tests/turnstile.spec.ts's ALWAYS-PASS/ALWAYS-FAIL ports).
 */
export async function resetState(request: APIRequestContext, baseUrl: string = BASE_URL): Promise<void> {
  const res = await request.get(`${baseUrl}/api/debug-entries?action=reset`);
  if (!res.ok()) throw new Error(`debug reset failed: ${res.status()}`);
}

export async function listEntries(request: APIRequestContext, baseUrl: string = BASE_URL): Promise<DebugEntry[]> {
  const res = await request.get(`${baseUrl}/api/debug-entries`);
  if (!res.ok()) throw new Error(`debug list failed: ${res.status()}`);
  const body = (await res.json()) as { entries: DebugEntry[] };
  return body.entries;
}

/** Current form_starts row count (ANLY-01 D1) via the same debug endpoint. */
export async function formStartsCount(request: APIRequestContext, baseUrl: string = BASE_URL): Promise<number> {
  const res = await request.get(`${baseUrl}/api/debug-entries`);
  if (!res.ok()) throw new Error(`debug list failed: ${res.status()}`);
  const body = (await res.json()) as { formStarts: number };
  return body.formStarts;
}

/** Polls formStartsCount() until it reaches at least minCount or the timeout elapses. */
export async function waitForFormStarts(
  request: APIRequestContext,
  minCount: number,
  baseUrl: string = BASE_URL,
  timeoutMs = 10_000,
): Promise<number> {
  const start = Date.now();
  let last = 0;
  while (Date.now() - start < timeoutMs) {
    last = await formStartsCount(request, baseUrl);
    if (last >= minCount) return last;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`waitForFormStarts() timed out after ${timeoutMs}ms; last count: ${last}`);
}

export async function entriesByStatus(
  request: APIRequestContext,
  status: DebugEntry['status'],
  baseUrl: string = BASE_URL,
): Promise<DebugEntry[]> {
  const entries = await listEntries(request, baseUrl);
  return entries.filter((e) => e.status === status);
}

/** Polls `debug-entries` until `predicate` is true or the timeout elapses. */
export async function waitFor(
  request: APIRequestContext,
  predicate: (entries: DebugEntry[]) => boolean,
  timeoutMs = 10_000,
  baseUrl: string = BASE_URL,
): Promise<DebugEntry[]> {
  const start = Date.now();
  let last: DebugEntry[] = [];
  while (Date.now() - start < timeoutMs) {
    last = await listEntries(request, baseUrl);
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`waitFor() timed out after ${timeoutMs}ms; last entries: ${JSON.stringify(last)}`);
}

export async function waitForAbandoned(
  request: APIRequestContext,
  minCount = 1,
  baseUrl: string = BASE_URL,
): Promise<DebugEntry[]> {
  const entries = await waitFor(
    request,
    (all) => all.filter((e) => e.status === 'abandoned').length >= minCount,
    10_000,
    baseUrl,
  );
  return entries.filter((e) => e.status === 'abandoned');
}

/**
 * Real-browser exit-intent simulation: dispatches `mouseleave` directly ON
 * `document` (matching capture.ts's `document.addEventListener('mouseleave',
 * ...)` binding target — a bubble-phase listener on an ANCESTOR never fires
 * for a non-bubbling event dispatched at a descendant, so this must target
 * `document` itself, not a body/html selector) with `clientY <= 0`.
 */
export async function fireExitIntent(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.dispatchEvent(new MouseEvent('mouseleave', { clientY: -5, bubbles: true, cancelable: true }));
  });
}

/**
 * Real-browser tab-hidden simulation. Attempts CDP-emulated backgrounding
 * first (closer to real mobile-backgrounding fidelity); falls back to a
 * dispatched `visibilitychange` event when the CDP call is unavailable in
 * this Playwright/Chromium build. The fallback is PARTIAL FIDELITY — it
 * proves the listener wiring, not genuine OS-level backgrounding behavior
 * (RESEARCH.md Pitfall 5; real-device validation is a Phase 1.5 item).
 */
export async function fireVisibilityHidden(page: Page): Promise<void> {
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Page.setWebLifecycleState', { state: 'hidden' });
    await cdp.detach().catch(() => undefined);
  } catch {
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
  }
}

export function abandonPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    siteId: 'playground',
    formId: 'demo',
    visitorUuid: `visitor-${Math.random().toString(36).slice(2)}`,
    fields: { name: 'API Test', email: 'api-test@example.com' },
    journey: [],
    ...overrides,
  };
}

/**
 * `origin` (3rd arg) sets the request's `Origin` header — used by the
 * cross-origin-rejection spec to send a mismatched origin. `baseUrl` (4th
 * arg, new) is the actual host the POST targets; defaults to the shared
 * `BASE_URL` so every existing call site is unaffected. Pass BOTH when
 * targeting a dedicated instance whose `siteUrl` differs from `BASE_URL`
 * (e.g. tests/turnstile.spec.ts's ALWAYS-PASS/ALWAYS-FAIL ports) — the
 * same-origin check compares the two.
 */
export async function postAbandon(
  request: APIRequestContext,
  body: Record<string, unknown>,
  origin: string = BASE_URL,
  baseUrl: string = BASE_URL,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await request.post(`${baseUrl}/api/forms/abandon`, {
    headers: { 'Content-Type': 'application/json', Origin: origin },
    data: body,
  });
  const status = res.status();
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    json = null;
  }
  return { status, body: json };
}
