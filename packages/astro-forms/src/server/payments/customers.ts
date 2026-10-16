/**
 * Stripe Customer attribution (0.1.17). Through 0.1.16 every Checkout
 * Session and Payment Link the package made was a guest checkout, so the
 * Stripe dashboard showed "Customers created: 0" while revenue came in and a
 * repeat payer never accumulated history.
 *
 * Lifecycle (0.1.17 security): anonymous input never creates or writes a
 * Stripe Customer. The email reaching checkout can be typed by an anonymous
 * visitor on the public /forms-pay page, so:
 *
 *  1. LOOKUP ONLY at checkout. `findReusableStripeCustomer` resolves an email
 *     to an existing Customer id or `undefined`. It never creates a Customer
 *     (an abandoned or scripted submit used to leave one behind per address),
 *     never updates one (a visitor-typed name used to stick to the email's
 *     Customer for good) and sends no idempotency key (a replayed key used to
 *     hand back a Customer without the eligibility checks below).
 *  2. Stripe CREATES the Customer. With no reusable id the session is created
 *     with `customer_creation: 'always'` (stripe.ts, checkout-for-entry.ts),
 *     so a Customer exists only once a payer actually confirms a payment.
 *  3. The webhook ADOPTS it. After a verified payment marks a row paid,
 *     `adoptStripeCustomer` tags `session.customer` with
 *     `metadata.source: 'cool-astro-forms'`, which is what makes it reusable
 *     for the same payer's next payment.
 *
 * A Customer is reusable only when ALL of these hold: not deleted, tagged
 * `metadata.source === 'cool-astro-forms'`, its email trimmed and lower-cased
 * equals the normalized input exactly, and `customers.listPaymentMethods(id,
 * { limit: 1 })` comes back empty. Checkout in payment mode given `customer`
 * prefills that Customer's most recently saved card, name and billing address
 * and offers its redisplayable cards, so an untagged Customer (an earlier
 * plugin's duplicates, another integration's records) or one holding any
 * payment method (an operator or a setup-mode Checkout can attach one) would
 * show a stranger someone else's card. A check that fails counts as "holds a
 * payment method": the Customer is skipped, never trusted. The sessions this
 * package builds for a Customer turn card saving off, so its own Customers
 * stay card-free.
 *
 * Lookup: `customers.list({ email, limit: 100 })` (reads the primary store
 * and matches the email exactly, case-sensitively, hence the lower-casing)
 * and one Search (`email:'…' AND metadata['source']:'cool-astro-forms'`,
 * eventually consistent, case-insensitive, so it catches a Customer whose
 * email Stripe stored as the payer typed it or an operator re-cased) run in
 * PARALLEL on every call. Running both every time keeps the lookup calls the
 * same whether or not the address has paid before (the old list-then-Search
 * order answered a known address faster); a match still costs one more call,
 * the saved-payment-method check below, so timing is narrowed, not closed. Search is
 * unavailable in some regions, so its failure only drops its results. Both
 * result sets are filtered by the rules above (Search matches word
 * sequences, not strict equality), de-duplicated, and the OLDEST eligible
 * Customer wins, so a payer with several tagged Customers converges on one.
 *
 * Never throws. Customer bookkeeping must never block a payment: any failure
 * is logged (Stripe's error type and code only, never the payer's email) and
 * resolves `undefined`, and the caller falls back to `customer_creation:
 * 'always'`. A failed payment-method check is logged the same way (as
 * `stripe.customer-payment-methods-check-failed`) but only skips that
 * Customer.
 *
 * Clean-room: written against docs.stripe.com/api/customers (list, search,
 * update), docs.stripe.com/api/payment_methods/customer_list,
 * docs.stripe.com/search#search-query-language and
 * docs.stripe.com/api/checkout/sessions/create (`customer`,
 * `customer_creation`), not derived from any commercial form-plugin source.
 */
import type Stripe from 'stripe';
import { logError } from '../log.js';

export interface FindReusableStripeCustomerInput {
  /** The payer's email, as typed. Trimmed and lower-cased here. */
  email: string;
}

/** `customers.list` page size: enough to see every duplicate of one email. */
const LIST_LIMIT = 100;
const SEARCH_LIMIT = 10;
/** `metadata.source` the webhook writes on a paying Customer, and the only kind the lookup returns. */
export const CUSTOMER_SOURCE = 'cool-astro-forms';

/** Escapes a value for a Stripe Search `field:'value'` clause: backslash first, then the quote. */
function escapeSearchValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** True for a customer Stripe returned as a deletion stub. */
function isDeleted(customer: unknown): boolean {
  return (customer as { deleted?: boolean }).deleted === true;
}

/**
 * A copy of the failure that carries only Stripe's error `type` and `code`.
 * Stripe error messages can echo request values, and the payer's email must
 * not reach the logs.
 */
function redactedError(err: unknown): Error {
  const { type, code } = (err ?? {}) as { type?: unknown; code?: unknown };
  const parts = [type, code].filter((part): part is string => typeof part === 'string');
  return new Error(parts.length > 0 ? parts.join(':') : 'unknown');
}

/** The HTTP status Stripe answered a failed call with, when there is one. */
function statusCodeOf(err: unknown): number | undefined {
  const statusCode = (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof statusCode === 'number' ? statusCode : undefined;
}

/**
 * True when Stripe answered with a replay of an earlier request's response
 * (`Idempotent-Replayed: true`). stripe-node puts the raw response on a
 * non-enumerable `lastResponse`: its `headers` are a plain lowercase object
 * from the Node HTTP client and a fetch `Headers` from the fetch client.
 * Anything else (an injected client with no response metadata) reads as a
 * fresh create. Used by checkout-for-entry.ts for its session replays.
 */
export function isIdempotentReplay(response: unknown): boolean {
  const headers = (response as { lastResponse?: { headers?: unknown } } | null)?.lastResponse?.headers;
  if (!headers || typeof headers !== 'object') return false;
  const value =
    typeof (headers as { get?: unknown }).get === 'function'
      ? (headers as Headers).get('idempotent-replayed')
      : (headers as Record<string, unknown>)['idempotent-replayed'];
  return typeof value === 'string' && value.trim().toLowerCase() === 'true';
}

/**
 * Every live, tagged customer whose email, trimmed and lower-cased, is
 * exactly `email`, de-duplicated by id, oldest first. An untagged or
 * differently tagged customer never matches, whatever the query that
 * returned it.
 */
function eligibleOldestFirst(customers: Stripe.Customer[], email: string): Stripe.Customer[] {
  const age = (customer: Stripe.Customer) => customer.created ?? Number.MAX_SAFE_INTEGER;
  const byId = new Map<string, Stripe.Customer>();
  for (const customer of customers) {
    if (isDeleted(customer) || customer.metadata?.source !== CUSTOMER_SOURCE) continue;
    if (customer.email?.trim().toLowerCase() !== email) continue;
    if (!byId.has(customer.id)) byId.set(customer.id, customer);
  }
  return [...byId.values()].sort((a, b) => age(a) - age(b));
}

/**
 * True only when Stripe confirms the customer holds no payment method, so
 * Checkout has no saved card to prefill for whoever typed the email. A
 * failed check answers false: the customer is skipped, never trusted.
 */
async function holdsNoPaymentMethod(client: Stripe, id: string): Promise<boolean> {
  try {
    const methods = await client.customers.listPaymentMethods(id, { limit: 1 });
    return methods.data.length === 0;
  } catch (err) {
    logError('stripe.customer-payment-methods-check-failed', redactedError(err), {
      customerId: id,
      statusCode: statusCodeOf(err),
    });
    return false;
  }
}

/**
 * Returns the id of the oldest reusable Stripe Customer for `input.email`, or
 * `undefined` when there is none or Stripe could not be asked. Read-only:
 * never creates, updates or deletes a Customer.
 */
export async function findReusableStripeCustomer(
  input: FindReusableStripeCustomerInput,
  client: Stripe,
): Promise<string | undefined> {
  try {
    const email = input.email.trim().toLowerCase();
    if (!email) return undefined;

    // Both start in the same tick (an async arrow runs to its first await
    // synchronously), and a synchronous throw becomes a rejection.
    const [listed, searched] = await Promise.allSettled([
      (async () => client.customers.list({ email, limit: LIST_LIMIT }))(),
      (async () =>
        client.customers.search({
          query: `email:'${escapeSearchValue(email)}' AND metadata['source']:'${CUSTOMER_SOURCE}'`,
          limit: SEARCH_LIMIT,
        }))(),
    ]);
    if (listed.status === 'rejected') throw listed.reason;
    const found = [...listed.value.data, ...(searched.status === 'fulfilled' ? searched.value.data : [])];

    for (const candidate of eligibleOldestFirst(found, email)) {
      if (await holdsNoPaymentMethod(client, candidate.id)) return candidate.id;
    }
    return undefined;
  } catch (err) {
    logError('stripe.customer-lookup-failed', redactedError(err), { statusCode: statusCodeOf(err) });
    return undefined;
  }
}

/**
 * Tags `customerId` as this package's (`metadata.source`) so the payer's
 * next payment can reuse it. Call ONLY after a verified payment marked a row
 * paid (routes/webhooks/stripe.ts): the Customer is then one Stripe created
 * for a payer who actually paid, or one already tagged. Writes nothing but
 * the tag (a metadata update merges keys and is idempotent), and only to a
 * `cus_` id.
 *
 * Never throws: answers false on any failure, logged as
 * `stripe.customer-adopt-failed` with the caller's context (the event id)
 * and Stripe's error type and code, never the customer id or an email.
 */
export async function adoptStripeCustomer(
  customerId: string,
  client: Stripe,
  context: { eventId: string },
): Promise<boolean> {
  if (!customerId.startsWith('cus_')) return false;
  try {
    await client.customers.update(customerId, { metadata: { source: CUSTOMER_SOURCE } });
    return true;
  } catch (err) {
    logError('stripe.customer-adopt-failed', redactedError(err), {
      eventId: context.eventId,
      statusCode: statusCodeOf(err),
    });
    return false;
  }
}
