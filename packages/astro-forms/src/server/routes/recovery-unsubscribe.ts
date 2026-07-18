/**
 * D4 one-click public unsubscribe route — `GET /api/forms/recovery-unsubscribe
 * ?token=...`. The email footer link this route serves is the SOLE
 * authorization: no session, no login, no admin guard. `handleRecoveryUnsubscribe`
 * is a framework-free core (unit-tested without Astro, RESEARCH Pattern 2 —
 * the handle-abandon.ts/routes/abandon.ts split, collapsed into one file here
 * since both halves are small); the exported `GET` is the thin Astro
 * `APIRoute` adapter that reads the query, builds the real dependencies, and
 * turns the result into a plain-text `Response`.
 *
 * Contract (T-04-22/T-04-23):
 *  - A VALID token (`verifyUnsubscribeToken`, HMAC over the visitor UUID —
 *    unsubscribe-token.ts) resolves the visitorUuid and suppresses it via
 *    `storage.suppressRecovery` — an `INSERT OR IGNORE`, so calling this
 *    route twice with the same token is idempotent: same 200 confirmation
 *    both times, no error on the second call.
 *  - A missing/malformed/forged token returns the SAME constant 400 message
 *    regardless of why it failed — never reveals whether a visitor with
 *    that UUID exists (no enumeration), and `suppressRecovery` is never
 *    called on that path.
 *  - The handler never throws: a `suppressRecovery` storage failure is
 *    caught, logged, and answered with a clean message — never a stack
 *    leak to the visitor's browser.
 *
 * D4a (04-CONTEXT.md, BINDING): the suppression row this route writes
 * SURVIVES GDPR erasure — `purgeVisitor` (storage/sqlite.ts) deliberately
 * excludes `recovery_suppressions` from its delete cascade, because the
 * client-side visitor UUID persists through an erasure too. Without that
 * exclusion, erasing a visitor would silently re-enable recovery email to
 * someone who explicitly opted out — this route's "unsubscribed forever"
 * promise depends on that erasure exception holding.
 *
 * Route injection (Astro `injectRoute`) + packaging (package.json exports +
 * tsup entry) are deferred to the 04-08 chokepoint plan, which depends on
 * this one — this file only creates the route + its handler logic.
 *
 * Clean-room: written fresh against the Plan 04/D4 HMAC-token contract, not
 * derived from any WPForms source (RESEARCH.md established recovery has no
 * WPForms precedent).
 */
import type { APIRoute } from 'astro';
import config from 'virtual:cool-astro-forms/config';
import { logError } from '../log.js';
import { verifyUnsubscribeToken, resolveRecoverySecret } from '../recovery/unsubscribe-token.js';
import { getStorageAdapter } from '../storage/index.js';
import type { StorageAdapter } from '../storage/adapter.js';

export const prerender = false;

const INVALID_TOKEN_MESSAGE = 'This unsubscribe link is invalid or expired.';
const CONFIRMED_MESSAGE = "You've been unsubscribed from recovery emails.";
const FAILURE_MESSAGE = 'Something went wrong. Please try again later.';

export interface HandleRecoveryUnsubscribeInput {
  /** Raw `?token=` query value — `null` when absent (URLSearchParams.get's own contract). */
  token: string | null;
  storage: StorageAdapter;
  /** The HMAC signing secret — resolveRecoverySecret(config.dbPath) in production. */
  secret: string;
  now?: () => number;
}

export interface HandleRecoveryUnsubscribeResult {
  status: number;
  body: string;
}

/**
 * The framework-free core. Never throws: a `storage.suppressRecovery`
 * rejection is caught, logged via `logError`, and answered with a clean
 * generic message rather than propagating.
 */
export async function handleRecoveryUnsubscribe(
  input: HandleRecoveryUnsubscribeInput,
): Promise<HandleRecoveryUnsubscribeResult> {
  const visitorUuid = verifyUnsubscribeToken(input.token, input.secret);
  if (!visitorUuid) {
    // Constant response for every "not a valid token" reason (missing,
    // malformed, forged) — never distinguishes them, so a probing request
    // can never learn whether a given visitor exists (T-04-23).
    return { status: 400, body: INVALID_TOKEN_MESSAGE };
  }

  const now = input.now ? input.now() : Date.now();
  try {
    await input.storage.suppressRecovery(visitorUuid, now);
  } catch (err) {
    logError('recovery.unsubscribe-failed', err, { visitorUuid });
    return { status: 500, body: FAILURE_MESSAGE };
  }

  return { status: 200, body: CONFIRMED_MESSAGE };
}

function textResponse(result: HandleRecoveryUnsubscribeResult): Response {
  return new Response(result.body, {
    status: result.status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

export const GET: APIRoute = async ({ request }) => {
  const token = new URL(request.url).searchParams.get('token');

  // Storage/secret acquisition happens INSIDE the try/catch (mirrors
  // routes/abandon.ts — a migration/open failure resolves a logged 500,
  // not an unlogged crash).
  try {
    const storage = await getStorageAdapter(config);
    const secret = resolveRecoverySecret(config.dbPath);
    const result = await handleRecoveryUnsubscribe({ token, storage, secret });
    return textResponse(result);
  } catch (err) {
    logError('recovery.unsubscribe-route-failed', err);
    return textResponse({ status: 500, body: FAILURE_MESSAGE });
  }
};
