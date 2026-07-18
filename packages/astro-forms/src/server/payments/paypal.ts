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
 * Clean-room: written fresh against developer.paypal.com/api/rest
 * (RESEARCH.md Code Examples, fetched 2026-07-17), not derived from any
 * commercial form-plugin source.
 */

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
 * not build, template, or mutate them in any way. Never throws: a missing
 * token, network error, non-2xx response, malformed body, or an order with
 * no approval link all resolve `undefined`.
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
