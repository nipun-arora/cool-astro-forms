/**
 * Outbound webhook delivery (HOOK-01): buildWebhookEvent, deliverWebhook
 * (in-process retry/backoff), registerWebhookTargets/getRegisteredTargets.
 *
 * NO durable queue (E3 descope, CEO review 2026-07-12 — RESEARCH.md
 * Alternatives Considered): delivery state lives entirely in this
 * process's memory. A process restart loses any retry still in flight.
 * This tradeoff is accepted and documented here + 03-CONTEXT.md (T-03-16)
 * rather than adding a queue dependency — the inbound payment-truth path
 * (03-07's Stripe/PayPal webhook receivers) is entirely unaffected by an
 * outbound delivery failure; outbound events are a best-effort feed to
 * Slack/n8n/Make, never the source of truth.
 *
 * Fire-and-forget contract: `deliverWebhook` NEVER throws and returns
 * synchronously (void) — callers (handle-abandon.ts, record-submission.ts)
 * must never await it before their own response/return.
 *
 * Clean-room: written fresh against the RESEARCH.md no-queue decision, not
 * derived from any commercial form-plugin source.
 */
import { monotonicFactory } from 'ulid';
import type { WebhookEventType, WebhookTarget } from '../../types.js';
import { log, logError } from '../log.js';
import { signWebhookPayload } from './sign.js';

const ulid = monotonicFactory();

const DELIVERY_TIMEOUT_MS = 5000;
const MAX_ATTEMPTS = 3;
/** Delay (ms) awaited before attempt 2 and attempt 3, respectively. */
const BACKOFF_MS: readonly number[] = [1000, 2000];

export interface WebhookEvent<T = unknown> {
  id: string;
  type: WebhookEventType;
  at: number;
  data: T;
}

/** Builds the JSON-serializable event envelope POSTed to every subscribed target. */
export function buildWebhookEvent<T>(type: WebhookEventType, data: T, now: number = Date.now()): WebhookEvent<T> {
  return { id: ulid(), type, at: now, data };
}

let registeredTargets: WebhookTarget[] = [];

/**
 * Registers the site's configured webhook targets (module singleton).
 * Called from middleware.ts's registerRuntimeConfig on every request
 * (cheap, idempotent — mirrors the CAF_DB_PATH/CAF_GEO_* env precedent) so
 * a non-virtual-config caller like record-submission.ts can still deliver.
 */
export function registerWebhookTargets(targets: WebhookTarget[]): void {
  registeredTargets = targets;
}

/** Returns the currently registered targets. */
export function getRegisteredTargets(): WebhookTarget[] {
  return registeredTargets;
}

/** Test-only reset for the module-level target registry. */
export function resetWebhookTargets(): void {
  registeredTargets = [];
}

type FetchLike = (url: string, init: RequestInit) => Promise<{ ok: boolean }>;
type ScheduleFn = (fn: () => void, ms: number) => void;

const defaultFetch: FetchLike = (url, init) => fetch(url, init);
const defaultSchedule: ScheduleFn = (fn, ms) => {
  setTimeout(fn, ms);
};

export interface DeliverWebhookDeps {
  /** Overrides the module's registered targets (test seam / explicit-target callers). */
  targets?: WebhookTarget[];
  /** Injectable fetch — defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Injectable delay primitive for the retry backoff — defaults to `setTimeout`. */
  schedule?: ScheduleFn;
  now?: () => number;
}

function targetSubscribes(target: WebhookTarget, type: WebhookEventType): boolean {
  return !target.events || target.events.includes(type);
}

function wait(scheduleFn: ScheduleFn, ms: number): Promise<void> {
  return new Promise((resolve) => scheduleFn(resolve, ms));
}

/** A single delivery attempt. Never throws — any fetch rejection/timeout resolves `false`. */
async function attemptOnce(target: WebhookTarget, body: string, fetchFn: FetchLike, now: number): Promise<boolean> {
  try {
    const signature = signWebhookPayload(body, target.secret, now);
    const res = await fetchFn(target.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Caf-Signature': signature },
      body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Delivers `body` to a single target with up to MAX_ATTEMPTS tries and exponential backoff between them. */
async function deliverToTarget(
  target: WebhookTarget,
  type: WebhookEventType,
  body: string,
  fetchFn: FetchLike,
  scheduleFn: ScheduleFn,
  now: number,
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const ok = await attemptOnce(target, body, fetchFn, now);
    if (ok) {
      log('webhook.delivered', { url: target.url, type, attempt });
      return;
    }
    if (attempt < MAX_ATTEMPTS) {
      await wait(scheduleFn, BACKOFF_MS[attempt - 1] ?? 0);
    }
  }
  log('webhook.exhausted', { url: target.url, type });
}

/**
 * Fires `type` to every registered (or `deps.targets`-overridden) target
 * subscribed to it. Signs + POSTs each; a non-2xx response or a thrown
 * fetch retries up to MAX_ATTEMPTS with exponential backoff, then logs
 * `webhook.exhausted`. On success, logs `webhook.delivered`.
 *
 * Fire-and-forget contract: NEVER throws, returns synchronously (void) —
 * callers must never await this. Zero subscribed targets is a silent
 * no-op (no fetch, no log).
 */
export function deliverWebhook<T>(type: WebhookEventType, data: T, deps: DeliverWebhookDeps = {}): void {
  try {
    const targets = (deps.targets ?? getRegisteredTargets()).filter((target) => targetSubscribes(target, type));
    if (targets.length === 0) return;

    const fetchFn = deps.fetch ?? defaultFetch;
    const scheduleFn = deps.schedule ?? defaultSchedule;
    const now = deps.now ? deps.now() : Date.now();
    const body = JSON.stringify(buildWebhookEvent(type, data, now));

    for (const target of targets) {
      deliverToTarget(target, type, body, fetchFn, scheduleFn, now).catch((err: unknown) => {
        logError('webhook.delivery-failed', err, { url: target.url, type });
      });
    }
  } catch (err) {
    logError('webhook.delivery-failed', err, { type });
  }
}
