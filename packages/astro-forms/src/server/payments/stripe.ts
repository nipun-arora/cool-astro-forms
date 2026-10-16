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
 * Examples, fetched 2026-07-17), not derived from any commercial form-plugin source.
 */
import Stripe from 'stripe';
import { CHECKOUT_SESSION_TTL_MIN } from '../payment-constants.js';
import type { FeeBreakdownLine } from '../../types.js';
import { findReusableStripeCustomer } from './customers.js';

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
  /** The payer's email. Prefills the Checkout email field through Stripe's `prefilled_email` link parameter. */
  customerEmail?: string;
}

export interface CreatePaymentLinkResult {
  url: string;
  providerRef: string;
}

/**
 * Ad-hoc Stripe Payment Link (PAY-01) — one `price_data` line item built
 * inline from `amountCents`, tagged with `metadata.entry_id` so an inbound
 * webhook (or manual lookup) can trace it back to the originating entry.
 * Payment Links copy top-level metadata onto the resulting Checkout Session;
 * `payment_intent_data` repeats `entry_id` (plus a description) on the
 * PaymentIntent, which is the object Stripe's Payments list shows.
 *
 * Customer attribution (0.1.17): `customer_creation: 'always'` makes Stripe
 * create a Customer when the link is paid; without it every payment was a
 * guest checkout and the dashboard counted no customers. Payment Links
 * cannot take an existing `customer` (API limitation), so a repeat payer gets
 * a new Customer per link. `customerEmail` is appended as `prefilled_email`.
 *
 * No `receipt_email` (0.1.18): unlike a Checkout Session, the Payment Links
 * API's `payment_intent_data` does not accept one, so a link payer gets a
 * Stripe receipt only when the dashboard's "Successful payments" customer
 * email setting is on.
 *
 * The returned `providerRef` is the LINK id (`plink_…`); the Checkout
 * Session a payer completes gets its own `cs_…` id at pay time, so the
 * Stripe webhook matches these rows through `session.payment_link` (0.1.15,
 * fleet bug F1). `restrictions.completed_sessions.limit: 1` makes Stripe
 * deactivate the link after its first completed checkout: one quote row, one
 * payment.
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
    customer_creation: 'always',
    payment_intent_data: {
      metadata: { entry_id: input.entryId },
      description: input.memo || 'Payment request',
    },
    restrictions: { completed_sessions: { limit: 1 } },
  });

  let url = link.url;
  if (input.customerEmail) {
    const prefilled = new URL(url);
    prefilled.searchParams.set('prefilled_email', input.customerEmail.trim());
    url = prefilled.toString();
  }
  return { url, providerRef: link.id };
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
  /** The payer's email. Matched to their existing Stripe Customer, else prefilled for the one Stripe creates (0.1.17). */
  customerEmail?: string;
  /**
   * The payer's name. Accepted for API compatibility but not sent to Stripe
   * (0.1.17 security): it is visitor input, and Checkout collects the
   * payer's own name.
   */
  customerName?: string;
  /**
   * `config.payments.payerReceipts` (0.1.18). `'always'` (also when absent)
   * sends `customerEmail` as `receipt_email`; `'dashboard'` never sends it,
   * so the dashboard's "Successful payments" setting alone decides.
   */
  payerReceipts?: 'always' | 'dashboard';
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
 *
 * Customer attribution (0.1.17): the email here is typed by an anonymous
 * visitor, so it is only ever LOOKED UP (`findReusableStripeCustomer`, see
 * customers.ts for the lifecycle). A payer whose earlier payment the webhook
 * adopted gets that Customer (`customer: <id>`), so a repeat payer's payments
 * share one Customer. Otherwise (a new payer, no email, or a failed lookup,
 * which never throws) the session sends `customer_creation: 'always'` plus
 * the normalized `customer_email` when known, so Stripe creates the Customer
 * only when the payer actually confirms. Stripe rejects `customer_creation`
 * or `customer_email` together with `customer`, so neither is ever sent with
 * it. Nothing a visitor types is written to a Customer: `customerName` is not
 * sent, and Checkout collects the payer's own name.
 *
 * A session with `customer` also sends `saved_payment_method_options:
 * { payment_method_save: 'disabled' }` (Stripe's documented default, sent
 * explicitly so the guarantee does not rest on a default) and never
 * `setup_future_usage`, so those Customers never hold a card Checkout would
 * show to the next person who types the same email; and, because this
 * session's payment methods come from the dashboard,
 * `excluded_payment_method_types: ['customer_balance']`: attaching an
 * email-matched Customer would otherwise enable bank transfers paid from
 * that Customer's cash balance, letting anyone who knows a payer's email
 * spend the payer's balance (0.1.17 audit).
 * `payment_intent_data` carries `entry_id` and a description on the
 * PaymentIntent, which is what Stripe's Payments list shows;
 * `client_reference_id` puts the entry id on the dashboard's session view
 * and exports.
 *
 * Payer receipt (0.1.18): when the payer's email is known,
 * `payment_intent_data.receipt_email` is set to the same normalized address.
 * Stripe documents that a live-mode payment with `receipt_email` gets a
 * receipt regardless of the dashboard's customer email settings (test mode
 * never sends automatic receipts). Up to 0.1.17 the pay page promised "Your
 * receipt goes here." while a receipt went out only if the "Successful
 * payments" setting was on. With no email, nothing is set: Checkout collects
 * one, and the dashboard setting decides.
 *
 * That override cuts both ways: a merchant who turned Stripe receipts off on
 * purpose gets them sent anyway, and a card tester can make the account mail
 * branded receipts to addresses typed on the pay page. `payerReceipts:
 * 'dashboard'` (config `payments.payerReceipts`) therefore never sends
 * `receipt_email`; only the receipt field changes, the customer fields stay
 * as above.
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

  const customerEmail = input.customerEmail?.trim().toLowerCase() || undefined;
  const customerId = customerEmail ? await findReusableStripeCustomer({ email: customerEmail }, client) : undefined;

  const session = await client.checkout.sessions.create({
    mode: 'payment',
    line_items: lineItems,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_SESSION_TTL_MIN * 60,
    metadata: { entry_id: input.entryId },
    client_reference_id: input.entryId,
    payment_intent_data: {
      metadata: { entry_id: input.entryId },
      description: input.memo ?? 'Payment',
      ...(customerEmail && input.payerReceipts !== 'dashboard' ? { receipt_email: customerEmail } : {}),
    },
    ...(customerId
      ? {
          customer: customerId,
          saved_payment_method_options: { payment_method_save: 'disabled' as const },
          excluded_payment_method_types: ['customer_balance' as const],
        }
      : {
          customer_creation: 'always' as const,
          ...(customerEmail ? { customer_email: customerEmail } : {}),
        }),
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
