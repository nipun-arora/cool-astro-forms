/**
 * The abandon endpoint's business logic (ABND-02 gate, ABND-03 dedupe,
 * JRNY-02 server-recomputed durations) as a framework-free function.
 * `routes/abandon.ts` is the thin Astro `APIRoute` adapter around this.
 *
 * Ordered pipeline (RESEARCH.md system diagram): origin -> size cap ->
 * rate limit -> parse/unknown-site-or-form -> honeypot -> visitor identity
 * -> gate -> journey recompute -> atomic dedupe save -> fire-and-forget
 * notify. Every reject/no-op branch (steps 1-7) logs exactly one structured
 * line via the injected `deps.log`. Genuine backend errors (storage throw,
 * notify rejection, purge failure) log via the real `logError` import —
 * `deps.log` is reserved for request-reject/no-op events only.
 *
 * Clean-room: written fresh against the Plan 01-05 contracts, not derived
 * from any commercial form-plugin source.
 */
import { z } from 'zod';
import type { CoolFormsConfig } from '../../config.js';
import { MAX_PAYLOAD_BYTES } from '../../limits.js';
import { CAF_FIELD_NAME, type Geo, type JourneyStep, type WebhookEventType } from '../../types.js';
import type { AbandonedLeadEmailData } from '../notify.js';
import type { RateLimiter } from '../security/rate-limit.js';
import { isHoneypotTripped } from '../security/honeypot.js';
import { isSameOrigin } from '../security/origin-check.js';
import { withinSizeCap } from '../security/size-cap.js';
import type { StorageAdapter } from '../storage/adapter.js';
import { logError } from '../log.js';
import { recoveryEnabledForForm } from '../recovery/resolve.js';
import { recomputeJourney } from './journey-server.js';

export type AbandonReason = 'gate' | 'duplicate' | 'origin' | 'payload' | 'rate-limit' | 'invalid' | 'error';

export interface AbandonResponseBody {
  saved: boolean;
  reason?: AbandonReason;
  deduped?: boolean;
}

export interface HandleAbandonInput {
  body: string;
  headers: Headers;
  ip: string;
}

/** Matches src/server/log.ts's `log()` signature — the only shape deps.log needs. */
export type Logger = (event: string, data?: Record<string, unknown>) => void;

export interface HandleAbandonDeps {
  config: CoolFormsConfig;
  storage: StorageAdapter;
  notify: (data: AbandonedLeadEmailData) => Promise<unknown>;
  rateLimiter: RateLimiter;
  /** Structured logger for reject/no-op branches — injectable, spy in tests. */
  log: Logger;
  now?: () => number;
  /** IP-geolocation enrichment (GEO-01) — never throws; absence/failure resolves undefined and never blocks the save. */
  geo?: (ip: string) => Promise<Geo | undefined>;
  /** Turnstile verification (D3) — awaited exactly once on first row CREATION only; a {ok:false} result soft-logs a flag, never blocks or reverts the save. */
  verifyToken?: (token: string | undefined, ip: string) => Promise<{ ok: boolean }>;
  /**
   * Outbound entry.abandoned webhook delivery (HOOK-01) — fire-and-forget,
   * injected so this module stays network-free in tests. Mirrors the
   * `notify` seam: never awaited, never blocks/reverts the response.
   */
  deliverWebhook?: (type: WebhookEventType, data: unknown) => void;
}

export interface HandleAbandonResult {
  status: number;
  body: string;
}

const journeyStepSchema: z.ZodType<JourneyStep> = z.object({
  url: z.string(),
  title: z.string(),
  ts: z.number(),
  params: z.record(z.string(), z.string()).optional(),
  /** Referrer-seed marker from the client trail — the step that carries the traffic source. */
  external: z.boolean().optional(),
});

const abandonPayloadSchema = z.object({
  siteId: z.string().min(1),
  formId: z.string().min(1),
  visitorUuid: z.string().min(1),
  fields: z.record(z.string(), z.unknown()).default({}),
  journey: z.array(journeyStepSchema).optional(),
  pageUrl: z.string().optional(),
  referrer: z.string().optional(),
  honeypot: z.string().optional(),
  /** Name of the last field the visitor edited before abandoning (ANLY-01 D1). */
  lastField: z.string().optional(),
  /** Checkbox-mode consent opt-in (D3/RCV-01) — read ONLY when config.recovery.consentMode is 'checkbox'; ignored (never a consent basis) in 'auto' mode. */
  recoveryOptIn: z.boolean().optional(),
});

const EMAIL_KEY_PATTERN = /email/i;
const PHONE_KEY_PATTERN = /phone|tel/i;
const HOURLY_PURGE_INTERVAL_MS = 60 * 60 * 1000;

/** Module-level (per-process) gate: purgeExpired fires at most once per hour. */
let lastPurgeAtModule = 0;

/** Test-only reset hook for the module-level hourly purge gate. */
export function resetAbandonPurgeGate(): void {
  lastPurgeAtModule = 0;
}

function json(status: number, body: AbandonResponseBody): HandleAbandonResult {
  return { status, body: JSON.stringify(body) };
}

function reject(
  deps: HandleAbandonDeps,
  status: number,
  reason: AbandonReason,
  ctx: Record<string, unknown>,
): HandleAbandonResult {
  deps.log('abandon.reject', { reason, ...ctx });
  return json(status, { saved: false, reason });
}

/** Parses a `Cookie` header for a single named cookie value. */
function parseCookieValue(cookieHeader: string | null, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key === name) {
      const value = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }
  return undefined;
}

/** ABND-02 gate check: a valid email OR a non-empty phone-ish field. */
function hasValidEmailOrPhone(fields: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (EMAIL_KEY_PATTERN.test(key) && z.email().safeParse(trimmed).success) return true;
    if (PHONE_KEY_PATTERN.test(key)) return true;
  }
  return false;
}

/**
 * D3 auto-mode consent-basis check: a valid captured EMAIL only. Unlike the
 * ABND-02 gate above, a phone-only field never satisfies auto consent — D3's
 * basis is specifically "visitor-typed email", not any contact info.
 */
function hasValidEmail(fields: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (EMAIL_KEY_PATTERN.test(key) && z.email().safeParse(trimmed).success) return true;
  }
  return false;
}

/**
 * Reads the D3 Turnstile verification token from the `_caf` envelope
 * (`payload.fields[CAF_FIELD_NAME]`, a JSON string or already-parsed
 * object — mirrors record-submission.ts's parseCafEnvelope tolerance).
 * Absence, malformed JSON, or a wrong-shape envelope all resolve
 * `undefined` — never throws.
 */
function extractTurnstileToken(fields: Record<string, unknown>): string | undefined {
  const raw = fields[CAF_FIELD_NAME];
  if (raw === undefined || raw === null) return undefined;

  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const token = (parsed as { turnstileToken?: unknown }).turnstileToken;
  return typeof token === 'string' ? token : undefined;
}

function maybePurgeExpired(deps: HandleAbandonDeps, now: number): void {
  if (now - lastPurgeAtModule < HOURLY_PURGE_INTERVAL_MS) return;
  lastPurgeAtModule = now;
  try {
    deps.storage.purgeExpired(deps.config.retentionDays).catch((err: unknown) => {
      logError('storage.purge-failed', err);
    });
  } catch (err) {
    logError('storage.purge-failed', err);
  }
}

export async function handleAbandon(
  input: HandleAbandonInput,
  deps: HandleAbandonDeps,
): Promise<HandleAbandonResult> {
  const now = deps.now ? deps.now() : Date.now();
  const ip = input.ip;

  // 1. Origin — the ONLY origin protection this route gets (Astro's
  // security.checkOrigin does not inspect application/json requests).
  if (!isSameOrigin(input.headers, deps.config.siteUrl)) {
    return reject(deps, 403, 'origin', { ip });
  }

  // 2. Size cap — backstop; the route wrapper already fast-path-rejects via
  // Content-Length before this handler ever sees the body.
  if (!withinSizeCap(input.body, MAX_PAYLOAD_BYTES)) {
    return reject(deps, 413, 'payload', { ip });
  }

  // 3. Rate limit
  if (!deps.rateLimiter.allow(ip, now)) {
    return reject(deps, 429, 'rate-limit', { ip });
  }

  // 4. Parse + validate — malformed JSON or unknown site/form id -> invalid.
  let raw: unknown;
  try {
    raw = JSON.parse(input.body);
  } catch {
    return reject(deps, 400, 'invalid', { ip });
  }

  const parsed = abandonPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    return reject(deps, 400, 'invalid', { ip });
  }
  const payload = parsed.data;

  if (payload.siteId !== deps.config.siteId) {
    return reject(deps, 400, 'invalid', { ip, siteId: payload.siteId });
  }
  const formConfig = deps.config.forms[payload.formId];
  if (!formConfig) {
    return reject(deps, 400, 'invalid', { ip, siteId: payload.siteId, formId: payload.formId });
  }

  const logCtx = { siteId: payload.siteId, formId: payload.formId, ip };

  // 5. Honeypot — checks both payload.honeypot AND fields[HONEYPOT_FIELD_NAME].
  if (isHoneypotTripped(payload.fields, payload.honeypot)) {
    deps.log('abandon.reject', { reason: 'honeypot', ...logCtx });
    return { status: 204, body: '' };
  }

  // 6. Visitor identity — the request's _caf_uid cookie is AUTHORITATIVE;
  // payload.visitorUuid is only a fallback (kills forged-uuid overwrite).
  const cookieUuid = parseCookieValue(input.headers.get('Cookie'), '_caf_uid');
  const visitorUuid = cookieUuid ?? payload.visitorUuid;

  // 7. Gate (ABND-02)
  const gateMode = formConfig.abandonment.require;
  if (gateMode === 'email-or-phone' && !hasValidEmailOrPhone(payload.fields)) {
    deps.log('abandon.reject', { reason: 'gate', ...logCtx });
    return json(200, { saved: false, reason: 'gate' });
  }

  // 8. Journey recompute (JRNY-02) — server-authoritative durations only.
  const recomputed = recomputeJourney(payload.journey, now, { journeyParams: deps.config.journeyParams });

  // 8b. Geo enrichment (GEO-01) — never blocks the save. lookupGeo's own
  // contract never throws, but a defensive catch guards against a buggy
  // injected test/host geo dep resolving geo undefined instead of rejecting
  // the whole pipeline.
  let geo: Geo | undefined;
  try {
    geo = deps.geo ? await deps.geo(ip) : undefined;
  } catch {
    geo = undefined;
  }

  // 9. Atomic dedupe save (ABND-03). The _caf transport envelope (Turnstile
  // token) is stripped from STORED fields — mirrors record-submission.ts;
  // token extraction below (9b) reads payload.fields, not the stored copy.
  const storedFields = { ...payload.fields };
  delete storedFields[CAF_FIELD_NAME];
  let result;
  try {
    result = await deps.storage.upsertAbandoned(
      {
        siteId: payload.siteId,
        formId: payload.formId,
        fields: storedFields,
        visitorUuid,
        ip,
        userAgent: input.headers.get('User-Agent') ?? undefined,
        journey: recomputed.steps,
        pageUrl: payload.pageUrl,
        referrer: payload.referrer,
        geo,
        lastField: payload.lastField,
      },
      formConfig.abandonment.dedupeWindowMins,
    );
  } catch (err) {
    logError('abandon.storage-failed', err, logCtx);
    return json(500, { saved: false, reason: 'error' });
  }

  if (result.outcome === 'already-converted') {
    // Phantom-abandon suppression — a recent submitted/converted row already
    // exists for this visitor+form; a queued beacon landed after a real
    // submit. No save, no notify.
    deps.log('abandon.reject', { reason: 'duplicate', ...logCtx });
    return json(200, { saved: false, reason: 'duplicate' });
  }

  // 9a. Consent-basis recording (D3/RCV-01) — fire-and-forget, idempotent
  // (markConsent only fills consent_at when it is currently NULL, so a
  // re-abandon never moves the timestamp). Auto mode: a valid captured
  // email is itself the consent basis (no checkbox). Checkbox mode: consent
  // is recorded ONLY when the payload explicitly opted in. Never awaited
  // before the response; a markConsent failure logs but never breaks the
  // save — same never-throws posture as notify/webhook delivery below.
  // recoveryEnabledForForm (04-10) is the per-form-scoped gate — it honors
  // an optional forms.<id>.recovery.enabled override while the site-wide
  // switch stays the hard gate (per-form true never overrides a site off).
  if (recoveryEnabledForForm(deps.config, payload.formId) && result.entry) {
    const shouldConsent =
      deps.config.recovery.consentMode === 'checkbox' ? payload.recoveryOptIn === true : hasValidEmail(payload.fields);
    if (shouldConsent) {
      deps.storage.markConsent(result.entry.id, now).catch((err: unknown) => {
        logError('recovery.consent-failed', err, logCtx);
      });
    }
  }

  // 9b. Turnstile-flag seam (D3) — verify only on first row CREATION.
  // Soft-log failure mode: the save is NEVER reverted, the response stays
  // {saved:true}; a failed/expired/rejecting check merely persists an
  // admin-visible flag on the just-created row (P05 renders it).
  if (deps.verifyToken && result.outcome === 'created' && result.entry) {
    try {
      const token = extractTurnstileToken(payload.fields);
      const verified = await deps.verifyToken(token, ip);
      if (!verified.ok) {
        await deps.storage.updateEntry(result.entry.id, {
          fields: { ...result.entry.fields, _turnstile: 'failed' },
        });
        deps.log('abandon.turnstile-failed', logCtx);
      }
    } catch (err) {
      logError('abandon.turnstile-check-failed', err, logCtx);
    }
  }

  // 9c. Outbound entry.abandoned webhook (HOOK-01) — fires ONLY on
  // first-time creation (never on a dedupe-update), fire-and-forget exactly
  // like notify below: never awaited, never blocks/reverts the response.
  if (result.outcome === 'created' && result.entry) {
    deps.deliverWebhook?.('entry.abandoned', {
      id: result.entry.id,
      siteId: payload.siteId,
      formId: payload.formId,
      fields: payload.fields,
      geo,
      createdAt: result.entry.createdAt,
    });
  }

  // 10. Fire-and-forget notify — AFTER the save, NEVER awaited before the
  // response. Fires on 'created' always; on 'updated' only when the form's
  // notifyOnUpdate is true (default false).
  const shouldNotify =
    result.outcome === 'created' || (result.outcome === 'updated' && formConfig.abandonment.notifyOnUpdate);
  if (shouldNotify) {
    deps
      .notify({
        siteId: payload.siteId,
        formId: payload.formId,
        notifyTo: formConfig.notifyTo,
        fields: payload.fields,
        journey: recomputed.steps,
        pageUrl: payload.pageUrl,
        referrer: payload.referrer,
        geo,
      })
      .catch((err: unknown) => {
        logError('notify.failed', err, logCtx);
      });
  }

  maybePurgeExpired(deps, now);

  return json(200, { saved: true, deduped: result.outcome === 'updated' });
}
