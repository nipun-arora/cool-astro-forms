/**
 * The PAY-05 payment-request endpoint's business logic (D1-D4) as a
 * framework-free function — mirrors `handle-abandon.ts`'s pattern exactly.
 * `routes/pay/create-session.ts` is the thin Astro `APIRoute` adapter around
 * this handler.
 *
 * Ordered pipeline: origin -> size cap -> dedicated rate limiter -> parse
 * base amount -> validate (reject, never clamp) -> Turnstile HARD gate ->
 * server-side fee breakdown -> compute redirect URLs -> create the synthetic
 * `_payment_request` entry -> create the checkout session/order -> attach
 * the payment row -> 302 redirect.
 *
 * Checker B1 (third strike on the trailingSlash pitfall class): THIS handler
 * owns every client-visible redirect-URL computation. It builds FULL
 * success/cancel/return URLs from `config.siteUrl` + the shared `adminUrl`
 * slash rule (imported read-only from `admin/_shared.js` — no file
 * modification, no wave-3 conflict) and hands them to the injected
 * `createCheckoutSession`/`createPaypalOrder` deps, which assign them
 * verbatim (T-03-21). Never trusts a client-sent total/fee — there is no
 * such field anywhere in this module's request-parsing surface (T-03-18).
 *
 * Clean-room: written fresh against 03-CONTEXT.md's D1-D4 decisions and
 * 03-RESEARCH.md's system diagram, not derived from any commercial form-plugin/legacy
 * source (a legacy `?pay=`-style quote page is the UX reference only, per
 * 03-CONTEXT.md).
 */
import { ulid } from 'ulid';
import type { CoolFormsConfig } from '../../config.js';
import { MAX_PAYLOAD_BYTES } from '../../limits.js';
import type { FeeBreakdownLine } from '../../types.js';
import { adminUrl } from '../admin/_shared.js';
import { logError } from '../log.js';
import { PAYMENT_REQUEST_FORM_ID } from '../payment-constants.js';
import type { RateLimiter } from '../security/rate-limit.js';
import { isSameOrigin } from '../security/origin-check.js';
import { withinSizeCap } from '../security/size-cap.js';
import type { StorageAdapter } from '../storage/adapter.js';
import { computeBreakdown, parseAmountParam, resolveFeeLines, validatePaymentRequest } from './pricing.js';

export type PaymentRequestRejectReason =
  | 'origin'
  | 'payload'
  | 'rate-limit'
  | 'invalid'
  | 'amount-range'
  | 'currency'
  | 'turnstile'
  | 'error';

export interface PaymentRequestResponseBody {
  ok: boolean;
  reason?: PaymentRequestRejectReason;
}

export interface HandlePaymentRequestInput {
  /**
   * Raw POSTed body — form-urlencoded (amount/pay/currency/fee/label/
   * provider/cf-turnstile-response). Parsed the same way a query string is
   * (D4): `new URLSearchParams(body)` has identical key=value&key=value
   * grammar, so `pricing.ts`'s functions apply unmodified.
   */
  body: string;
  headers: Headers;
  ip: string;
}

/** `trailingSlash` rides on the virtual config module (checker B1 cast precedent — middleware.ts/admin/*.astro). */
export type ConfigWithTrailingSlash = CoolFormsConfig & { trailingSlash?: 'always' | 'never' | 'ignore' };

/** Matches src/server/log.ts's `log()` signature (handle-abandon.ts precedent). */
export type Logger = (event: string, data?: Record<string, unknown>) => void;

export interface CreateCheckoutSessionDepInput {
  baseAmountCents: number;
  feeLines: FeeBreakdownLine[];
  currency: string;
  memo?: string;
  entryId: string;
  successUrl: string;
  cancelUrl: string;
}

export interface CreateCheckoutSessionDepResult {
  url: string;
  providerRef: string;
}

export interface CreatePaypalOrderDepInput {
  totalCents: number;
  currency: string;
  entryId: string;
  returnUrl: string;
  cancelUrl: string;
}

export interface CreatePaypalOrderDepResult {
  approvalUrl: string;
  providerRef: string;
}

export interface HandlePaymentRequestDeps {
  config: ConfigWithTrailingSlash;
  storage: StorageAdapter;
  /** Injected Stripe adapter (payments/stripe.ts's createCheckoutSession) — never network in tests. */
  createCheckoutSession: (input: CreateCheckoutSessionDepInput) => Promise<CreateCheckoutSessionDepResult>;
  /** Injected PayPal adapter (payments/paypal.ts's createOrder) — undefined when PayPal is not configured (PAY-04). */
  createPaypalOrder?: (input: CreatePaypalOrderDepInput) => Promise<CreatePaypalOrderDepResult | undefined>;
  /** Undefined when TURNSTILE_SECRET_KEY is not configured — the gate is skipped entirely (module stays inert, PAY-04-adjacent). */
  verifyTurnstile?: (token: string | undefined, ip: string) => Promise<{ ok: boolean }>;
  /** DEDICATED bucket (T-03-20) — its own createRateLimiter instance, never shared with abandon/login. */
  rateLimiter: RateLimiter;
  /** Structured logger for reject/no-op branches — injectable, spy in tests. */
  log: Logger;
  now?: () => number;
}

export interface HandlePaymentRequestResult {
  status: number;
  /** Present on a 302 — the caller (create-session.ts) sets this as the Location header. */
  location?: string;
  body?: string;
}

function json(status: number, body: PaymentRequestResponseBody): HandlePaymentRequestResult {
  return { status, body: JSON.stringify(body) };
}

function reject(
  deps: HandlePaymentRequestDeps,
  status: number,
  reason: PaymentRequestRejectReason,
  ctx: Record<string, unknown>,
): HandlePaymentRequestResult {
  deps.log('payment-request.reject', { reason, ...ctx });
  return json(status, { ok: false, reason });
}

/**
 * cents -> a dollars string matching pricing.ts's `AMOUNT_DOLLARS_PATTERN`
 * grammar (`/^\d+(\.\d{1,2})?$/`). `toFixed(2)` always emits exactly 2
 * decimal digits, which the pattern accepts unconditionally — used to build
 * the cancelUrl's `?amount=` round-trip back into `/forms-pay`.
 */
function centsToDollarsString(cents: number): string {
  return (cents / 100).toFixed(2);
}

export async function handlePaymentRequest(
  input: HandlePaymentRequestInput,
  deps: HandlePaymentRequestDeps,
): Promise<HandlePaymentRequestResult> {
  const now = deps.now ? deps.now() : Date.now();
  const ip = input.ip;

  // 1. Origin — same-origin only; this is a money-creating endpoint.
  if (!isSameOrigin(input.headers, deps.config.siteUrl)) {
    return reject(deps, 403, 'origin', { ip });
  }

  // 2. Size cap — backstop; the route wrapper already fast-path-rejects via
  // Content-Length before this handler ever sees the body.
  if (!withinSizeCap(input.body, MAX_PAYLOAD_BYTES)) {
    return reject(deps, 413, 'payload', { ip });
  }

  // 3. Rate limit — DEDICATED bucket (T-03-20), never abandon/login's.
  if (!deps.rateLimiter.allow(ip, now)) {
    return reject(deps, 429, 'rate-limit', { ip });
  }

  // 4. Parse the posted base amount. A form-urlencoded POST body has the
  // same key=value&key=value grammar as a query string, so pricing.ts's
  // functions apply unmodified (D4).
  const params = new URLSearchParams(input.body);
  const baseAmountCents = parseAmountParam(params);
  const requestPage = deps.config.payments.requestPage;
  const currency = (params.get('currency') ?? requestPage.allowedCurrencies[0] ?? 'usd').toLowerCase();

  // 5. Validate — REJECT, never clamp (D4). There is no totalCents/feeCents
  // field anywhere in this parsing surface for a client to lie about
  // (T-03-18/T-03-19).
  const validation = validatePaymentRequest({ baseAmountCents, currency }, requestPage);
  if (!validation.ok) {
    return reject(deps, 400, validation.reason, { ip });
  }
  const amountCents = baseAmountCents as number;

  // 6. Turnstile HARD gate (T-03-20) — unlike the abandon route's soft-log,
  // an absent/failing check here is a hard reject BEFORE any entry or
  // checkout session exists (avoids junk sessions / owner Payments-view
  // spam). Skipped entirely when the caller has no configured secret.
  if (deps.verifyTurnstile) {
    const token = params.get('cf-turnstile-response') ?? undefined;
    const verified = await deps.verifyTurnstile(token, ip);
    if (!verified.ok) {
      // A Turnstile token is single-use and expires after ~300s, so a real
      // visitor who dawdled on the page (or double-submitted) hits this gate
      // with a dead token. A browser form post must land back on the pay
      // page — fresh widget, error banner, amount preserved — never on a
      // raw-JSON dead end. Programmatic clients keep the 403 JSON contract.
      if (input.headers.get('accept')?.includes('text/html')) {
        deps.log('payment-request.reject', { reason: 'turnstile', ip, recovery: 'redirect' });
        return {
          status: 303,
          location:
            deps.config.siteUrl +
            adminUrl('/forms-pay', deps.config.trailingSlash) +
            '?error=turnstile&amount=' +
            centsToDollarsString(amountCents),
        };
      }
      return reject(deps, 403, 'turnstile', { ip });
    }
  }

  // 7. Server-side fee breakdown (D3) — always recomputed from the base
  // amount, never trusts any client-sent total/fee value.
  const feeLines = resolveFeeLines(params, deps.config.payments);
  const breakdown = computeBreakdown(amountCents, feeLines);

  // 8. Redirect URLs (checker B1) — computed HERE, trailingSlash-aware, via
  // the shared adminUrl slash rule (path-generic despite the name). The
  // injected adapters receive these fully-formed and never construct URLs
  // themselves (T-03-21, no open-redirect surface from query input).
  const trailingSlash = deps.config.trailingSlash;
  const successUrl =
    deps.config.siteUrl + adminUrl('/forms-pay/success', trailingSlash) + '?session_id={CHECKOUT_SESSION_ID}';
  const cancelUrl =
    deps.config.siteUrl + adminUrl('/forms-pay', trailingSlash) + '?amount=' + centsToDollarsString(amountCents);
  const returnUrl = deps.config.siteUrl + adminUrl('/forms-pay/paypal-return', trailingSlash);

  const memo = params.get('label') ?? undefined;
  const provider = params.get('provider') === 'paypal' ? 'paypal' : 'stripe';

  try {
    const entry = await deps.storage.createEntry({
      siteId: deps.config.siteId,
      formId: PAYMENT_REQUEST_FORM_ID,
      status: 'submitted',
      fields: { amountCents, currency, memo, source: 'payment-request' },
      // No pre-existing visitor session backs a standalone payment-request
      // link (RESEARCH Pattern 2) — a fresh synthetic identity anchors this
      // one-off entry, matching sqlite.ts's own id-generation convention.
      visitorUuid: ulid(),
    });

    if (provider === 'paypal' && deps.createPaypalOrder) {
      const order = await deps.createPaypalOrder({
        totalCents: breakdown.totalCents,
        currency,
        entryId: entry.id,
        returnUrl,
        cancelUrl,
      });
      if (!order) {
        deps.log('payment-request.provider-failed', { ip, provider: 'paypal', entryId: entry.id });
        return json(502, { ok: false, reason: 'error' });
      }
      await deps.storage.attachPayment(entry.id, {
        provider: 'paypal',
        amountCents: breakdown.totalCents,
        currency,
        status: 'link_created',
        payLinkUrl: order.approvalUrl,
        providerRef: order.providerRef,
      });
      return { status: 302, location: order.approvalUrl };
    }

    const session = await deps.createCheckoutSession({
      baseAmountCents: amountCents,
      feeLines: breakdown.lines,
      currency,
      memo,
      entryId: entry.id,
      successUrl,
      cancelUrl,
    });
    await deps.storage.attachPayment(entry.id, {
      provider: 'stripe',
      amountCents: breakdown.totalCents,
      currency,
      status: 'link_created',
      payLinkUrl: session.url,
      providerRef: session.providerRef,
    });
    return { status: 302, location: session.url };
  } catch (err) {
    logError('payment-request.storage-failed', err, { ip });
    return json(500, { ok: false, reason: 'error' });
  }
}
