/**
 * PayPal adapter (PAY-01, PAY-05, PAY-03) — plain REST via `fetch`, NO SDK
 * (locked: 03-CONTEXT.md D-providers, 03-RESEARCH.md Alternatives
 * Considered — a PayPal SDK would be the project's first optional-module
 * dependency). Every call takes an injectable `deps.fetch` so callers' unit
 * tests never hit the network (turnstile.ts's never-throws + injected
 * `fetch` contract).
 *
 * Checker B1 (trailingSlash pitfall, third strike): `createOrder` receives
 * FULLY-FORMED `returnUrl`/`cancelUrl` strings from the caller and passes
 * them through byte-verbatim into `application_context`. This module
 * performs ZERO URL construction, templating, or slash manipulation.
 *
 * 0.1.18: `captureOrder` — the capture call the package never made. Orders
 * were created with `intent: CAPTURE` and left APPROVED after the buyer's
 * approval, so no money moved and PAYMENT.CAPTURE.COMPLETED never fired.
 *
 * Clean-room: written fresh against developer.paypal.com/api/rest
 * (RESEARCH.md Code Examples, fetched 2026-07-17; Orders v2 capture, its
 * error list and the idempotency reference, fetched 2026-10-16; the Orders
 * v2 schema's `user_action` definitions, fetched 2026-10-16), not derived
 * from any commercial form-plugin source.
 */
import { randomUUID } from 'node:crypto';

const TIMEOUT_MS = 5000;

export interface PaypalDeps {
  fetch?: typeof fetch;
}

/** `api-m.paypal.com` when `PAYPAL_ENV==='live'`, else the sandbox host (default). */
export function paypalBaseUrl(): string {
  return process.env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}

/** True when both PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are set — PAY-04: the module stays inert (no routes/UI) without both. */
export function paypalConfigured(): boolean {
  return Boolean(process.env.PAYPAL_CLIENT_ID) && Boolean(process.env.PAYPAL_CLIENT_SECRET);
}

interface PaypalTokenResponseBody {
  access_token?: string;
}

/**
 * OAuth2 client-credentials token exchange (RESEARCH Code Example). Never
 * throws: an absent client id/secret, network error, non-2xx response, or
 * malformed body all resolve `undefined` — the turnstile.ts/geo.ts
 * never-throws contract.
 */
export async function getAccessToken(deps?: PaypalDeps): Promise<string | undefined> {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) return undefined;

  const doFetch = deps?.fetch ?? fetch;
  try {
    const res = await doFetch(`${paypalBaseUrl()}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as PaypalTokenResponseBody;
    return typeof data.access_token === 'string' ? data.access_token : undefined;
  } catch {
    return undefined;
  }
}

export interface CreateOrderInput {
  totalCents: number;
  currency: string;
  entryId: string;
  /** Fully-formed redirect URL from the caller — passed through byte-verbatim (checker B1). Never mutated here. REQUIRED: PayPal's no-SDK approval redirect breaks without it. */
  returnUrl: string;
  /** Fully-formed redirect URL from the caller — passed through byte-verbatim (checker B1). Never mutated here. */
  cancelUrl: string;
}

export interface CreateOrderResult {
  approvalUrl: string;
  providerRef: string;
}

interface PaypalOrderLink {
  rel: string;
  href: string;
}

interface PaypalOrderResponseBody {
  id?: string;
  links?: PaypalOrderLink[];
}

/**
 * Creates a PayPal Order (v2, `intent: CAPTURE`) for redirect-only approval
 * — no JS SDK involved. `application_context.return_url`/`cancel_url` are
 * `input.returnUrl`/`input.cancelUrl` assigned verbatim; this function does
 * not build, template, or mutate them in any way.
 *
 * `user_action: 'PAY_NOW'` (0.1.18): Orders v2 defaults to `CONTINUE`, a
 * "Continue" button documented for an amount not yet final, where the payer
 * returns to the merchant without the payment being processed. The amount
 * here is final and the return page (paypal-return.ts) captures the order
 * at once, which is the documented `PAY_NOW` flow ("Pay Now" button). It
 * stays in `application_context` beside the two URLs: the reference marks
 * that object's fields deprecated in favour of
 * `payment_source.paypal.experience_context` but does not say they are
 * ignored, and moving one field alone would split the redirect settings
 * across two objects.
 *
 * Never throws: a missing token, network error, non-2xx response, malformed
 * body, or an order with no approval link all resolve `undefined`.
 */
export async function createOrder(
  input: CreateOrderInput,
  deps?: PaypalDeps,
): Promise<CreateOrderResult | undefined> {
  const accessToken = await getAccessToken(deps);
  if (!accessToken) return undefined;

  const doFetch = deps?.fetch ?? fetch;
  try {
    const res = await doFetch(`${paypalBaseUrl()}/v2/checkout/orders`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [
          {
            amount: { currency_code: input.currency, value: (input.totalCents / 100).toFixed(2) },
            custom_id: input.entryId,
          },
        ],
        application_context: {
          return_url: input.returnUrl,
          cancel_url: input.cancelUrl,
          // 0.1.18: the return page captures at once, so PayPal must show
          // "Pay Now", not its CONTINUE default (a button for flows that
          // return WITHOUT processing the payment).
          user_action: 'PAY_NOW',
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return undefined;

    const order = (await res.json()) as PaypalOrderResponseBody;
    if (typeof order.id !== 'string') return undefined;

    const approvalLink = order.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve');
    if (!approvalLink) return undefined;

    return { approvalUrl: approvalLink.href, providerRef: order.id };
  } catch {
    return undefined;
  }
}

/**
 * PayPal's documented order-id grammar (Orders v2 path parameter `id`:
 * `^[A-Z0-9]+$`, 1-36 characters). Anything else is refused before it can
 * reach a request path (0.1.18).
 */
const PAYPAL_ORDER_ID_PATTERN = /^[A-Z0-9]{1,36}$/;

/** True for a string shaped like a PayPal order id (`PAYPAL_ORDER_ID_PATTERN`). */
export function isPaypalOrderId(value: unknown): value is string {
  return typeof value === 'string' && PAYPAL_ORDER_ID_PATTERN.test(value);
}

/**
 * A fresh `PayPal-Request-Id` for each capture attempt (0.1.18). PayPal
 * replays the stored answer for a reused id instead of running the request
 * again (developer.paypal.com idempotency reference), so an id fixed per
 * order would replay an INSTRUMENT_DECLINED, or an ORDER_NOT_APPROVED hit
 * before approval, after the payer fixed it in PayPal: the order would never
 * capture. A second capture of a captured order is still refused by PayPal
 * itself (one capture per CAPTURE-intent order, `ORDER_ALREADY_CAPTURED`).
 */
function captureRequestId(): string {
  return randomUUID();
}

export type CaptureOrderResult =
  | {
      ok: true;
      /** The order's status after the call (`COMPLETED` once captured). */
      orderStatus: string | undefined;
      /** The capture's own status: `COMPLETED`, `PENDING`, `DECLINED`, `FAILED`… Undefined if PayPal sent no capture. */
      captureStatus: string | undefined;
    }
  | {
      ok: false;
      /** HTTP status of a non-2xx answer; absent for a refused id, a missing token or a network failure. */
      httpStatus?: number;
      /** PayPal's `details[0].issue` (e.g. `ORDER_ALREADY_CAPTURED`, `INSTRUMENT_DECLINED`), else the error `name`. */
      issue?: string;
      /** PayPal's `debug_id`, for a support ticket. */
      debugId?: string;
    };

interface PaypalCaptureResponseBody {
  status?: string;
  purchase_units?: Array<{ payments?: { captures?: Array<{ status?: string }> } }>;
}

interface PaypalErrorResponseBody {
  name?: string;
  debug_id?: string;
  details?: Array<{ issue?: string }>;
}

/**
 * Captures payment for an approved `intent: CAPTURE` order (0.1.18):
 * `POST /v2/checkout/orders/{id}/capture`, no body, `Prefer:
 * return=representation` so the capture's own status comes back, and a fresh
 * `PayPal-Request-Id` per attempt (`captureRequestId`), so a retry after a
 * decline or a not-yet-approved hit is a new request rather than a replay of
 * that failure. A reload or double hit of the return page cannot capture
 * twice because PayPal allows only one capture per CAPTURE-intent order and
 * answers a second with `ORDER_ALREADY_CAPTURED`.
 *
 * Returns what PayPal said and decides nothing: the caller
 * (payments/paypal-return.ts) maps it to what the payer sees, and the
 * verified PAYMENT.CAPTURE.COMPLETED webhook alone marks the row paid. The
 * response body (which carries payer details) is read only for the statuses
 * and is never returned or logged. Never throws: a malformed order id (no
 * network call at all), a missing token, a network error or an unreadable
 * body all resolve `{ ok: false }`.
 */
export async function captureOrder(orderId: string, deps?: PaypalDeps): Promise<CaptureOrderResult> {
  if (!isPaypalOrderId(orderId)) return { ok: false };

  const accessToken = await getAccessToken(deps);
  if (!accessToken) return { ok: false };

  const doFetch = deps?.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${paypalBaseUrl()}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': captureRequestId(),
        Prefer: 'return=representation',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { ok: false };
  }

  if (!res.ok) {
    try {
      const error = (await res.json()) as PaypalErrorResponseBody;
      const issue = error.details?.[0]?.issue ?? error.name;
      return {
        ok: false,
        httpStatus: res.status,
        ...(typeof issue === 'string' ? { issue } : {}),
        ...(typeof error.debug_id === 'string' ? { debugId: error.debug_id } : {}),
      };
    } catch {
      return { ok: false, httpStatus: res.status };
    }
  }

  try {
    const order = (await res.json()) as PaypalCaptureResponseBody;
    return {
      ok: true,
      orderStatus: typeof order.status === 'string' ? order.status : undefined,
      captureStatus: order.purchase_units?.[0]?.payments?.captures?.[0]?.status,
    };
  } catch {
    return { ok: false, httpStatus: res.status };
  }
}

interface PaypalVerifyResponseBody {
  verification_status?: string;
}

/**
 * Verifies an inbound PayPal webhook via the `verify-webhook-signature`
 * postback (T-03-09). `rawBody` MUST be the untouched request body; it is
 * parsed ONLY to build the `webhook_event` field the postback requires —
 * the raw string itself is never otherwise mutated (RESEARCH Code
 * Example). Never throws: an absent PAYPAL_WEBHOOK_ID, a missing token, a
 * network error, malformed body, or any status other than `'SUCCESS'` all
 * resolve `false`.
 */
export async function verifyPaypalWebhookSignature(
  rawBody: string,
  headers: Headers,
  deps?: PaypalDeps,
): Promise<boolean> {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) return false;

  const accessToken = await getAccessToken(deps);
  if (!accessToken) return false;

  const doFetch = deps?.fetch ?? fetch;
  try {
    const webhookEvent: unknown = JSON.parse(rawBody);
    const res = await doFetch(`${paypalBaseUrl()}/v1/notifications/verify-webhook-signature`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transmission_id: headers.get('paypal-transmission-id'),
        transmission_time: headers.get('paypal-transmission-time'),
        cert_url: headers.get('paypal-cert-url'),
        auth_algo: headers.get('paypal-auth-algo') ?? 'SHA256withRSA',
        transmission_sig: headers.get('paypal-transmission-sig'),
        webhook_id: webhookId,
        webhook_event: webhookEvent,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return false;

    const data = (await res.json()) as PaypalVerifyResponseBody;
    return data.verification_status === 'SUCCESS';
  } catch {
    return false;
  }
}
