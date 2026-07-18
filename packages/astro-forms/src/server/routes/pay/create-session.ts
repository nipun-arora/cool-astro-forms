/**
 * POST /api/forms/pay/create-session (PAY-05) — thin Astro `APIRoute`
 * wrapper around `handlePaymentRequest()`. Mirrors `routes/abandon.ts`:
 * Content-Length fast-reject + `readBodyCapped` streaming backstop BEFORE
 * ever buffering the full body, storage acquired INSIDE the try/catch (a
 * migration/open failure resolves a logged 500, not an unlogged crash).
 *
 * Redirect-URL computation (checker B1) lives entirely inside
 * `handlePaymentRequest` — this route passes the WHOLE virtual config
 * (including `trailingSlash`) straight through and never builds a URL
 * itself.
 */
import type { APIRoute } from 'astro';
import config from 'virtual:cool-astro-forms/config';
import { log, logError } from '../../log.js';
import { handlePaymentRequest, type ConfigWithTrailingSlash } from '../../payments/payment-request.js';
import { createOrder, paypalConfigured } from '../../payments/paypal.js';
import { createCheckoutSession } from '../../payments/stripe.js';
import { createRateLimiter } from '../../security/rate-limit.js';
import { contentLengthWithinCap, MAX_PAYLOAD_BYTES, readBodyCapped } from '../../security/size-cap.js';
import { getStorageAdapter } from '../../storage/index.js';
import { verifyTurnstile } from '../../turnstile.js';

export const prerender = false;

/**
 * DEDICATED rate-limiter bucket (T-03-20) — its own `createRateLimiter`
 * instance, module-level singleton reused per-process (mirrors
 * `rate-limit.ts`'s own `defaultRateLimiter` pattern), NEVER shared with
 * the abandon/login buckets. ~10 requests/minute steady-state (tighter
 * than abandon's 20/min — this endpoint creates money-moving artifacts).
 */
const paymentRequestRateLimiter = createRateLimiter({ capacity: 10, refillPerSec: 10 / 60 });

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const ip = clientAddress ?? '';

  // Fast path: reject via Content-Length before ever buffering the body.
  if (!contentLengthWithinCap(request.headers, MAX_PAYLOAD_BYTES)) {
    log('payment-request.reject', { reason: 'payload', ip });
    return new Response(JSON.stringify({ ok: false, reason: 'payload' }), { status: 413 });
  }

  // Streaming backstop: covers chunked/missing-Content-Length requests.
  const readResult = await readBodyCapped(request.body, MAX_PAYLOAD_BYTES);
  if (!readResult.ok) {
    log('payment-request.reject', { reason: 'payload', ip });
    return new Response(JSON.stringify({ ok: false, reason: 'payload' }), { status: 413 });
  }

  try {
    const storage = await getStorageAdapter(config);

    // D3/BOT-01: verifyTurnstile stays undefined (gate skipped, module
    // inert) unless TURNSTILE_SECRET_KEY is configured — the secret NEVER
    // reaches the client, only this server-side read (byte-identical
    // pattern to routes/abandon.ts).
    const turnstileSecret = process.env.TURNSTILE_SECRET_KEY;
    const verifyTurnstileDep = turnstileSecret
      ? (token: string | undefined, clientIp: string) =>
          verifyTurnstile(token, { secret: turnstileSecret, remoteip: clientIp })
      : undefined;

    // PAY-04: createPaypalOrder stays undefined (module inert, no PayPal
    // branch reachable) unless both PayPal env vars are configured.
    const createPaypalOrderDep = paypalConfigured() ? createOrder : undefined;

    const result = await handlePaymentRequest(
      { body: readResult.text, headers: request.headers, ip },
      {
        config: config as ConfigWithTrailingSlash,
        storage,
        createCheckoutSession,
        createPaypalOrder: createPaypalOrderDep,
        verifyTurnstile: verifyTurnstileDep,
        rateLimiter: paymentRequestRateLimiter,
        log,
      },
    );

    if (result.location) {
      return new Response(null, { status: result.status, headers: { Location: result.location } });
    }
    return new Response(result.body ?? '', { status: result.status });
  } catch (err) {
    logError('payment-request.route-failed', err, { ip });
    return new Response(JSON.stringify({ ok: false, reason: 'error' }), { status: 500 });
  }
};
