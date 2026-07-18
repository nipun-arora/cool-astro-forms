/**
 * Thin Astro `APIRoute` wrapper around `handleAbandon()` (RESEARCH.md
 * Pattern 2). All gate/dedupe/journey/notify logic lives in
 * `handlers/handle-abandon.ts` — this file only adapts the Request/Response
 * boundary and builds the real (non-fake) dependencies.
 *
 * Storage acquisition happens INSIDE the try/catch (review S2-4): a
 * migration/open failure resolves a logged 500 instead of an unlogged crash.
 * No module-top-level DB open.
 */
import type { APIRoute } from 'astro';
import config from 'virtual:cool-astro-forms/config';
import { lookupGeo } from '../geo/geo.js';
import { log, logError } from '../log.js';
import type { NotifyTemplateFn } from '../notify.js';
import { sendAbandonedLeadEmail } from '../notify.js';
import { defaultRateLimiter, type RateLimiter } from '../security/rate-limit.js';
import { StorageBackedRateLimiter } from '../security/rate-limit-store.js';
import { contentLengthWithinCap, MAX_PAYLOAD_BYTES, readBodyCapped } from '../security/size-cap.js';
import type { StorageAdapter } from '../storage/adapter.js';
import { getStorageAdapter } from '../storage/index.js';
import { handleAbandon } from '../handlers/handle-abandon.js';
import { verifyTurnstile } from '../turnstile.js';
import { deliverWebhook } from '../webhooks/deliver.js';

export const prerender = false;

/**
 * The virtual config module only carries `CoolFormsConfig` today —
 * `templates` is the resolved-from-`templatesModule` seam Plan 08's
 * integration adds. Narrow-cast here rather than widening the ambient
 * `CoolFormsConfig` type, since Plan 08 owns that shape's final design.
 */
type ConfigWithTemplates = typeof config & { templates?: { abandonedLead?: NotifyTemplateFn } };

/**
 * Matches `defaultRateLimiter`'s options (rate-limit.ts) so the opt-in
 * storage-backed path is a like-for-like swap, not a stricter/looser limit.
 */
const STORAGE_RATE_LIMIT_OPTIONS = { capacity: 20, refillPerSec: 20 / 60 };

/**
 * Selects the abandon route's rate limiter per `config.rateLimit.store`
 * (D2 fix #1). 'storage' awaits the adapter-backed limiter's decision
 * up front and wraps the already-resolved boolean in a synchronous
 * `RateLimiter` shim — `handleAbandon`'s pipeline calls `.allow()`
 * synchronously (step 3) and is out of this plan's scope to change.
 * 'memory' (default, omitted) returns the SAME `defaultRateLimiter`
 * object every request — byte-identical to pre-Phase-5 behavior,
 * including object identity for `resetDefaultRateLimiter` (Plan 09).
 */
async function resolveRateLimiter(
  rateLimitStore: 'memory' | 'storage' | undefined,
  storage: StorageAdapter,
  ip: string,
): Promise<RateLimiter> {
  if (rateLimitStore !== 'storage') return defaultRateLimiter;
  const allowed = await new StorageBackedRateLimiter(storage, STORAGE_RATE_LIMIT_OPTIONS).allow(ip);
  return { allow: () => allowed, size: () => 0, clear: () => {} };
}

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const ip = clientAddress ?? '';

  // Fast path: reject via Content-Length before ever buffering the body.
  if (!contentLengthWithinCap(request.headers, MAX_PAYLOAD_BYTES)) {
    log('abandon.reject', { reason: 'payload', ip });
    return new Response(JSON.stringify({ saved: false, reason: 'payload' }), { status: 413 });
  }

  // Streaming backstop: covers chunked/missing-Content-Length requests.
  const readResult = await readBodyCapped(request.body, MAX_PAYLOAD_BYTES);
  if (!readResult.ok) {
    log('abandon.reject', { reason: 'payload', ip });
    return new Response(JSON.stringify({ saved: false, reason: 'payload' }), { status: 413 });
  }

  try {
    const storage = await getStorageAdapter(config);
    const templateOverride = (config as ConfigWithTemplates).templates?.abandonedLead;
    const geo = config.geo.enabled
      ? (lookupIp: string) => lookupGeo(lookupIp, { providerUrl: config.geo.providerUrl, timeoutMs: config.geo.timeoutMs })
      : undefined;

    // D3/BOT-01: verifyToken stays undefined (module inert, byte-identical
    // to Phase 1) unless TURNSTILE_SECRET_KEY is configured — the secret
    // NEVER reaches the client, only this server-side read.
    const turnstileSecret = process.env.TURNSTILE_SECRET_KEY;
    const verifyToken = turnstileSecret
      ? (token: string | undefined, clientIp: string) => verifyTurnstile(token, { secret: turnstileSecret, remoteip: clientIp })
      : undefined;

    // D2 fix #1 (ADPT-01): 'storage' awaits the adapter-backed persistent
    // limiter over the SAME storage adapter the handler already built;
    // 'memory' (default) keeps today's in-process defaultRateLimiter,
    // byte-identical, zero behavior change.
    const rateLimiter = await resolveRateLimiter(config.rateLimit?.store, storage, ip);

    const result = await handleAbandon(
      { body: readResult.text, headers: request.headers, ip },
      {
        config,
        storage,
        notify: (data) => sendAbandonedLeadEmail(data, { template: templateOverride }),
        rateLimiter,
        log,
        geo,
        verifyToken,
        deliverWebhook,
      },
    );

    // The WHATWG Response constructor throws for "null body status" codes
    // (204/205/304) when given ANY body, including an empty string — the
    // honeypot branch's {status:204, body:''} must pass a real `null` body,
    // not ''. Only caught here because this is the first place handleAbandon's
    // result actually flows through a real Response constructor (Plan 06's
    // own unit tests call handleAbandon() directly, never Response()).
    return new Response(result.status === 204 ? null : result.body, { status: result.status });
  } catch (err) {
    logError('abandon.route-failed', err, { ip });
    return new Response(JSON.stringify({ saved: false, reason: 'error' }), { status: 500 });
  }
};
