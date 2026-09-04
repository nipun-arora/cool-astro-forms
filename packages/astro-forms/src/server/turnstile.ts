/**
 * verifyTurnstile(token, opts) — server-side Cloudflare Turnstile siteverify
 * helper (BOT-01). Exported from `cool-astro-forms/server` so a HOST's own
 * submit endpoint can gate a real submission the same way the abandon route
 * gates a save (the package cannot gate a route it does not own).
 *
 * Never throws — every failure mode (absent token/secret, network error,
 * timeout, malformed JSON) resolves `ok:false`. The abandon route's D3
 * soft-log seam and any host submit endpoint both depend on this contract:
 * a Cloudflare outage must never turn into an unhandled rejection.
 *
 * ## Read `outcome`, not just `ok`
 *
 * `ok:false` alone is four different situations, and a host that treats them
 * alike either drops real leads or runs an inert bot gate. `outcome` names
 * which one it is, so the host never has to infer it from the presence of
 * error codes:
 *
 *   'verified'    — Cloudflare said yes.
 *   'rejected'    — no token, or Cloudflare said no. Refuse the submission.
 *   'skipped'     — no TURNSTILE_SECRET_KEY was passed, so nothing was
 *                   checked at all. NOT a rejection. Accept the submission
 *                   and surface the gap (this helper also emits one
 *                   `turnstile.inert` warning per process).
 *   'unreachable' — Cloudflare gave no usable verdict: network error,
 *                   3s timeout, malformed body, or `success:false` with no
 *                   error codes. Accept the submission; an outage must not
 *                   refuse every real visitor.
 *
 * ## Host submit endpoints: the token is single-use, and the package spends it
 *
 * The abandonment capture posts the live widget token on exit intent, an
 * outbound link click, a tab switch, or unload, and the abandon route spends
 * it at siteverify when it first creates a row. A visitor who moused out and
 * came back can therefore reach your submit button holding a token that
 * Cloudflare has already retired — you would see `timeout-or-duplicate` for
 * a genuine person.
 *
 * The client mitigates this: after any abandon send that carried a token,
 * capture.ts drops the staged token and asks the Turnstile widget to reset,
 * so the widget re-solves and repopulates its own `cf-turnstile-response`
 * input with a fresh one. That closes the common case but not all of it —
 * the re-mint takes a moment, and in managed mode it can require another
 * interaction. So a host endpoint MUST still treat one `timeout-or-duplicate`
 * (or `missing-input-response`) as recoverable rather than as a bot:
 * respond with the error codes, have the page call `turnstile.reset()`,
 * wait for the fresh token, and retry the submission exactly once. Only a
 * second rejection is a real refusal.
 *
 * Clean-room: written fresh against Cloudflare's documented siteverify
 * contract (developers.cloudflare.com/turnstile), not derived from any
 * commercial form-plugin source.
 */
import { warn } from './log.js';

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

/** Machine-readable verdict — see the module header for what each one obliges a host to do. */
export type VerifyTurnstileOutcome = 'verified' | 'rejected' | 'skipped' | 'unreachable';

export interface VerifyTurnstileResult {
  ok: boolean;
  outcome: VerifyTurnstileOutcome;
  errorCodes?: string[];
}

interface SiteverifyResponseBody {
  success?: boolean;
  'error-codes'?: string[];
}

// ---------------------------------------------------------------------------
// Inert-gate warning (one per process, never per request)
//
// A bot gate that is switched off by a missing env var looks exactly like a
// bot gate that is working: no rejections, no errors, no log lines. Hosts
// have found this out from the Cloudflare dashboard telling them siteverify
// was never called. One warning on the first skip, naming the key, is enough
// to make the gap greppable in the boot log without adding a line per
// request.
// ---------------------------------------------------------------------------

let inertWarningEmitted = false;

/**
 * Emits at most ONE `turnstile.inert` warning for the life of the process.
 * `where` says which path noticed the gap, so a host can tell "my own submit
 * endpoint called the verifier with no secret" from "the abandon route never
 * verified anything".
 */
export function warnTurnstileInert(where: string, data?: Record<string, unknown>): void {
  if (inertWarningEmitted) return;
  inertWarningEmitted = true;
  warn('turnstile.inert', {
    where,
    missingConfig: 'TURNSTILE_SECRET_KEY',
    effect: 'Turnstile tokens are not being verified; submissions are accepted unchecked',
    ...data,
  });
}

/** Test-only: re-arms the once-per-process warning so cases stay independent. */
export function resetTurnstileInertWarning(): void {
  inertWarningEmitted = false;
}

/**
 * POSTs `{secret, response: token, remoteip?, idempotency_key?}` to
 * Cloudflare's siteverify endpoint. Short-circuits WITHOUT calling `fetch`
 * when `token` or `opts.secret` is absent/empty — nothing to verify, and this
 * is what keeps the module byte-identical-inert when the caller (e.g. the
 * abandon route) has no configured secret.
 */
export async function verifyTurnstile(
  token: string | undefined,
  opts: VerifyTurnstileOptions,
): Promise<VerifyTurnstileResult> {
  // No configured secret = nothing was checked ('skipped', not a rejection —
  // config absence is not a client failure, so no code). Reaching this branch
  // at all means a caller intended to verify and could not, so it is worth
  // the one-per-process warning. No token = a client-side failure that must
  // carry Cloudflare's own code for it, so downstream diagnostics (reject
  // logs, recovery-redirect ?code=) can distinguish clicked-before-solve from
  // expired/reused without server access.
  if (!opts.secret) {
    warnTurnstileInert('verifyTurnstile');
    return { ok: false, outcome: 'skipped' };
  }
  if (!token) return { ok: false, outcome: 'rejected', errorCodes: ['missing-input-response'] };

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
    const ok = data.success === true;
    const errorCodes = data['error-codes'];
    if (errorCodes && errorCodes.length > 0) {
      return { ok, outcome: ok ? 'verified' : 'rejected', errorCodes };
    }
    // A `success:false` with no error codes tells us nothing about WHY, which
    // is the same position a timeout leaves us in — treat it as unreachable
    // rather than blaming the visitor.
    return { ok, outcome: ok ? 'verified' : 'unreachable' };
  } catch {
    return { ok: false, outcome: 'unreachable' };
  }
}
