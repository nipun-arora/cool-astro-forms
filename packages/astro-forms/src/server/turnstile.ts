/**
 * verifyTurnstile(token, opts) — server-side Cloudflare Turnstile siteverify
 * helper (BOT-01). Exported from `cool-astro-forms/server` so a HOST's own
 * submit endpoint can gate a real submission the same way the abandon route
 * gates a save (the package cannot gate a route it does not own).
 *
 * Never throws — every failure mode (absent token/secret, network error,
 * timeout, malformed JSON) resolves `{ok:false}`. The abandon route's D3
 * soft-log seam and any host submit endpoint both depend on this contract:
 * a Cloudflare outage must never turn into an unhandled rejection.
 *
 * Clean-room: written fresh against Cloudflare's documented siteverify
 * contract (developers.cloudflare.com/turnstile), not derived from any
 * commercial form-plugin source.
 */
const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TIMEOUT_MS = 3000;

export interface VerifyTurnstileOptions {
  /** TURNSTILE_SECRET_KEY — server-side only, never shipped to the client. */
  secret: string;
  /** The visitor's IP — optional per Cloudflare's siteverify contract. */
  remoteip?: string;
  /** Reuses the caller's idempotency key for safe retries (Research: don't hand-roll retry dedupe). */
  idempotencyKey?: string;
}

export interface VerifyTurnstileResult {
  ok: boolean;
  errorCodes?: string[];
}

interface SiteverifyResponseBody {
  success?: boolean;
  'error-codes'?: string[];
}

/**
 * POSTs `{secret, response: token, remoteip?, idempotency_key?}` to
 * Cloudflare's siteverify endpoint. Short-circuits `{ok:false}` WITHOUT
 * calling `fetch` when `token` or `opts.secret` is absent/empty — nothing to
 * verify, and this is what keeps the module byte-identical-inert when the
 * caller (e.g. the abandon route) has no configured secret.
 */
export async function verifyTurnstile(
  token: string | undefined,
  opts: VerifyTurnstileOptions,
): Promise<VerifyTurnstileResult> {
  // No configured secret = module inert (config absence, not a client
  // failure — no code). No token = a client-side failure that must carry
  // Cloudflare's own code for it, so downstream diagnostics (reject logs,
  // recovery-redirect ?code=) can distinguish clicked-before-solve from
  // expired/reused without server access.
  if (!opts.secret) return { ok: false };
  if (!token) return { ok: false, errorCodes: ['missing-input-response'] };

  try {
    const body: Record<string, string> = { secret: opts.secret, response: token };
    if (opts.remoteip) body.remoteip = opts.remoteip;
    if (opts.idempotencyKey) body.idempotency_key = opts.idempotencyKey;

    const res = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const data = (await res.json()) as SiteverifyResponseBody;
    const errorCodes = data['error-codes'];
    return errorCodes && errorCodes.length > 0
      ? { ok: data.success === true, errorCodes }
      : { ok: data.success === true };
  } catch {
    return { ok: false };
  }
}
