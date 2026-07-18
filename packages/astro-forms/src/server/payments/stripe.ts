/**
 * Stripe adapter (PAY-01, PAY-05) — thin wrapper around the official `stripe`
 * SDK. Server-only: `STRIPE_SECRET_KEY` is read exclusively here via
 * `process.env`, never surfaced through `buildPublicConfig` (T-03-10).
 * Every function takes an injectable `deps.client` so callers' unit tests
 * never hit the Stripe network (turnstile.ts/geo.ts never-network-in-tests
 * convention, generalized here as dependency injection since Stripe's own
 * calls aren't plain `fetch`).
 *
 * Checker B1 (trailingSlash pitfall, third strike): `createCheckoutSession`
 * receives FULLY-FORMED `successUrl`/`cancelUrl` strings from the caller
 * (03-05's payment-request handler, which computes them trailingSlash-aware
 * from server config) and passes them through byte-verbatim. This module
 * performs ZERO URL construction, templating, or slash manipulation.
 *
 * Clean-room: written fresh against docs.stripe.com/api (RESEARCH.md Code
 * Examples, fetched 2026-07-17), not derived from any WPForms source.
 */
import Stripe from 'stripe';
import { CHECKOUT_SESSION_TTL_MIN } from '../payment-constants.js';
import type { FeeBreakdownLine } from '../../types.js';

export interface StripeDeps {
  client?: Stripe;
}

/**
 * Reads `process.env.STRIPE_SECRET_KEY` and constructs a client. Returns
 * `undefined` when absent — PAY-04: the module stays inert (no client, no
 * network) without a configured key.
 *
 * `STRIPE_API_BASE_URL` (e2e-only route-seam mock, Plan 09 hard rule: no
 * live provider calls) redirects the SDK's HTTP client at a local mock
 * server instead of Stripe's real `api.stripe.com` — used exclusively by
 * `playwright.config.ts`'s dedicated PAY-PASS/PAY-FAIL instances so a
 * `sk_test_e2e_dummy` key never reaches Stripe's live network. Unset (and
 * therefore inert) in every real deployment; the SDK's own default host
 * applies unchanged. `maxNetworkRetries: 0` keeps the mocked path fast and
 * deterministic — no exponential-backoff retry against a loopback mock.
 */
export function getStripeClient(): Stripe | undefined {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return undefined;

  const mockBaseUrl = process.env.STRIPE_API_BASE_URL;
  if (mockBaseUrl) {
    const url = new URL(mockBaseUrl);
    return new Stripe(key, {
      host: url.hostname,
      protocol: url.protocol.replace(':', '') as 'http' | 'https',
      port: url.port || undefined,
      maxNetworkRetries: 0,
    });
  }

  return new Stripe(key);
}

/** Resolves the injected/env client or throws — callers are responsible for checking PAY-04 configuration before invoking a create function at all. */
function resolveClient(deps?: StripeDeps): Stripe {
  const client = deps?.client ?? getStripeClient();
  if (!client) {
    throw new Error('Stripe is not configured (STRIPE_SECRET_KEY missing)');
  }
  return client;
}

export interface CreatePaymentLinkInput {
  amountCents: number;
  currency: string;
  memo?: string;
  entryId: string;
}

export interface CreatePaymentLinkResult {
  url: string;
  providerRef: string;
}

/**
 * Ad-hoc Stripe Payment Link (PAY-01) — one `price_data` line item built
 * inline from `amountCents`, tagged with `metadata.entry_id` so an inbound
 * webhook (or manual lookup) can trace it back to the originating entry.
 * Payment Links automatically copy top-level metadata onto the resulting
 * Checkout Session, so no duplication into `payment_intent_data` is needed.
 */
export async function createPaymentLink(
  input: CreatePaymentLinkInput,
  deps?: StripeDeps,
): Promise<CreatePaymentLinkResult> {
  const client = resolveClient(deps);
  const link = await client.paymentLinks.create({
    line_items: [
      {
        price_data: {
          currency: input.currency,
          unit_amount: input.amountCents,
          product_data: { name: input.memo || 'Payment request' },
        },
        quantity: 1,
      },
    ],
    metadata: { entry_id: input.entryId },
  });
  return { url: link.url, providerRef: link.id };
}

export interface CreateCheckoutSessionInput {
  baseAmountCents: number;
  feeLines: FeeBreakdownLine[];
  currency: string;
  memo?: string;
  entryId: string;
  /** Fully-formed redirect URL from the caller — passed through byte-verbatim (checker B1). Never mutated here. */
  successUrl: string;
  /** Fully-formed redirect URL from the caller — passed through byte-verbatim (checker B1). Never mutated here. */
  cancelUrl: string;
}

export interface CreateCheckoutSessionResult {
  url: string;
  providerRef: string;
}

/**
 * Per-request Checkout Session (PAY-05) with a bounded expiry (unlike a
 * Payment Link). The base amount and each fee line are SEPARATE line_items
 * — not pre-summed — so the fee stays visible as its own line on Stripe's
 * hosted Checkout page and on the resulting receipt (D3).
 *
 * `success_url`/`cancel_url` are `input.successUrl`/`input.cancelUrl`
 * assigned verbatim — no template string, no `siteUrl` concatenation, no
 * trailing-slash handling of any kind happens in this function.
 */
export async function createCheckoutSession(
  input: CreateCheckoutSessionInput,
  deps?: StripeDeps,
): Promise<CreateCheckoutSessionResult> {
  const client = resolveClient(deps);

  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
    {
      price_data: {
        currency: input.currency,
        unit_amount: input.baseAmountCents,
        product_data: { name: input.memo ?? 'Payment' },
      },
      quantity: 1,
    },
    ...input.feeLines.map(
      (fee): Stripe.Checkout.SessionCreateParams.LineItem => ({
        price_data: {
          currency: input.currency,
          unit_amount: fee.amountCents,
          product_data: { name: fee.label },
        },
        quantity: 1,
      }),
    ),
  ];

  const session = await client.checkout.sessions.create({
    mode: 'payment',
    line_items: lineItems,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_SESSION_TTL_MIN * 60,
    metadata: { entry_id: input.entryId },
  });

  return { url: session.url ?? '', providerRef: session.id };
}

export type VerifyStripeWebhookResult = { ok: true; event: Stripe.Event } | { ok: false };

export interface VerifyStripeWebhookDeps {
  client?: Stripe;
  secret?: string;
}

/**
 * Verifies an inbound Stripe webhook via the official `constructEvent`
 * (T-03-08 — the SDK-recommended verification path; rejects on any
 * signature or timestamp-tolerance mismatch). `rawBody` MUST be the
 * untouched request body read BEFORE any JSON parsing (RESEARCH Pitfall 1).
 * Never throws: any verification failure — including an absent secret or
 * unconfigured client — resolves `{ok:false}`, matching turnstile.ts's
 * never-throws contract.
 */
export function verifyStripeWebhook(
  rawBody: string,
  signatureHeader: string,
  deps?: VerifyStripeWebhookDeps,
): VerifyStripeWebhookResult {
  const secret = deps?.secret ?? process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return { ok: false };

  const client = deps?.client ?? getStripeClient();
  if (!client) return { ok: false };

  try {
    const event = client.webhooks.constructEvent(rawBody, signatureHeader, secret);
    return { ok: true, event };
  } catch {
    return { ok: false };
  }
}
