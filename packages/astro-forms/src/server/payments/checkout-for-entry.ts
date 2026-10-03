/**
 * createCheckoutForEntry (0.1.15) — the public, typed way for a host page to
 * take a card payment against an existing entry, for flows the built-in
 * admin quote form does not cover (a desk quote page in AED, a deposit, a
 * custom product name). Exported from `cool-astro-forms/server`.
 *
 * What it guarantees, in order:
 *  1. Every input is validated and the entry is looked up BEFORE Stripe is
 *     called, so a bad amount or an unknown entry can never produce a live
 *     checkout link.
 *  2. The session is card-only, so "completed" means "paid" for the common
 *     case; the Stripe webhook still checks `payment_status`, the amount and
 *     the currency against the stored row before marking anything paid.
 *  3. The payments row is written with the keys the webhook reads
 *     (`providerRef` = the `cs_…` session id), never an untyped object a
 *     caller could misspell.
 *  4. If that write fails, the session is expired at Stripe and its URL is
 *     never returned: a charge with no record cannot happen through this
 *     function.
 *
 * Never throws: every failure is a `{ ok: false, code }` result, mirroring
 * `recordSubmission`. After a `record-failed` result, retry with a NEW
 * `idempotencyKey`: Stripe replays the original (now expired) session for a
 * reused key.
 *
 * A call that reuses the key of an earlier call (a double-click, or the same
 * rendered quote form posted again) gets Stripe's replay of the first
 * session, which Stripe flags with the `Idempotent-Replayed: true` response
 * header. A replay never writes and never expires anything: that session
 * belongs to the earlier call, and its URL may already be with the payer.
 * When its row exists the call returns the same URL (one session, one row);
 * when it does not (the earlier call is still writing it, or it failed and
 * expired the session) the call returns `replay-unrecorded`. The row write
 * itself also refuses a second row for the same session, so a client that
 * exposes no response headers cannot produce a twin either.
 *
 * Clean-room: written against docs.stripe.com/api/checkout/sessions (create,
 * expire), not derived from any commercial form-plugin source.
 */
import type Stripe from 'stripe';
import { z } from 'zod';
import { log, logError } from '../log.js';
import type { StorageAdapter } from '../storage/adapter.js';
import { getStorageAdapter } from '../storage/index.js';

/** Stripe's documented Checkout Session expiry window: 30 minutes to 24 hours after creation. */
const MIN_EXPIRY_MS = 30 * 60_000;
const MAX_EXPIRY_MS = 24 * 60 * 60_000;
/** Stripe rejects idempotency keys longer than 255 characters. */
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

export interface CreateCheckoutForEntryInput {
  /** The entry the payment belongs to (from `recordSubmission`, or an admin page's `?entry=`). Must exist. */
  entryId: string;
  /**
   * The amount in the currency's smallest unit, exactly as Stripe's
   * `unit_amount` takes it: 250000 for AED 2,500.00, 500 for JPY 500. A
   * positive integer. Never take this from the payer.
   */
  amountCents: number;
  /** ISO 4217 code, any case (sent and stored lowercase). */
  currency: string;
  /** Pre-fills the Checkout email field; Stripe sends its receipt there when receipts are on in the dashboard. */
  customerEmail?: string;
  /** When the link stops working. Between 30 minutes and 24 hours from now (Stripe's limits); 23 hours is a safe default. */
  expiresAt: Date;
  /** Absolute http(s) URL; passed to Stripe verbatim (`{CHECKOUT_SESSION_ID}` templating works). */
  successUrl: string;
  /** Absolute http(s) URL; passed to Stripe verbatim. */
  cancelUrl: string;
  /**
   * Stripe idempotency key (1-255 characters). Use a fresh value per quote
   * (for example a UUID made when the quote form renders) and reuse it only
   * for the same create (a retry after a network error, or the same form
   * posted twice): the replay returns the first session and records no
   * second row. Never derive it from
   * the entry and amount: Stripe keeps a key for 24 hours, so a re-quote
   * inside that window would get the first, possibly expired, session back.
   */
  idempotencyKey: string;
  /** Extra string metadata for the session and its payment intent. `entry_id` is reserved (the package sets it). */
  metadata?: Record<string, string>;
  /** The line item name on the Checkout page and receipt. Default "Payment". */
  productName?: string;
}

export interface CreateCheckoutForEntryDeps {
  /** Injected Stripe client (tests); defaults to the `STRIPE_SECRET_KEY` client. */
  client?: Stripe;
  /** Injected storage (tests); defaults to the same env-selected adapter `recordSubmission` uses. */
  storage?: StorageAdapter;
  now?: () => number;
}

export type CreateCheckoutForEntryErrorCode =
  /** An input failed validation. Nothing was created. */
  | 'invalid-input'
  /** No injected client and `STRIPE_SECRET_KEY` is unset. Nothing was created. */
  | 'stripe-not-configured'
  /**
   * The storage backend failed before Stripe was called (nothing was
   * created), or failed while looking up the row of a replayed session (the
   * session, made by an earlier call, was left open and not returned).
   */
  | 'storage-error'
  /** No entry has `entryId`. Nothing was created. */
  | 'entry-not-found'
  /** Stripe refused or failed the create (or returned no hosted URL). No row was written. */
  | 'provider-error'
  /** The session was created but its payments row could not be written; the session was expired (see `sessionExpired`). */
  | 'record-failed'
  /**
   * Stripe replayed the session an earlier call made with this
   * `idempotencyKey`, and no payments row exists for it: the earlier call is
   * still writing it, or it failed and expired the session. Nothing was
   * written or expired and no URL is returned. Retry with the same key in a
   * moment to get the URL once the row exists, or with a new key for a new
   * session.
   */
  | 'replay-unrecorded';

export type CreateCheckoutForEntryResult =
  | {
      ok: true;
      /** The hosted Checkout URL to send the payer. */
      url: string;
      /** The `cs_…` id, stored as the payment's `providerRef`. */
      sessionId: string;
      /** When Stripe will expire the session. */
      expiresAt: Date;
    }
  | {
      ok: false;
      code: CreateCheckoutForEntryErrorCode;
      message: string;
      /** Only on `record-failed`: true when Stripe confirmed the expiry; false when the expire call itself failed. */
      sessionExpired?: boolean;
    };

type Failure = Extract<CreateCheckoutForEntryResult, { ok: false }>;

function fail(code: CreateCheckoutForEntryErrorCode, message: string, extra: { sessionExpired?: boolean } = {}): Failure {
  return { ok: false, code, message, ...extra };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * True when Stripe answered with a replay of an earlier request's response
 * (`Idempotent-Replayed: true`). stripe-node puts the raw response on a
 * non-enumerable `lastResponse`: its `headers` are a plain lowercase object
 * from the Node HTTP client and a fetch `Headers` from the fetch client.
 * Anything else (an injected client with no response metadata) reads as a
 * fresh create.
 */
function isIdempotentReplay(session: unknown): boolean {
  const headers = (session as { lastResponse?: { headers?: unknown } } | null)?.lastResponse?.headers;
  if (!headers || typeof headers !== 'object') return false;
  const value =
    typeof (headers as { get?: unknown }).get === 'function'
      ? (headers as Headers).get('idempotent-replayed')
      : (headers as Record<string, unknown>)['idempotent-replayed'];
  return typeof value === 'string' && value.trim().toLowerCase() === 'true';
}

/** Returns an error message for the first invalid field, or undefined when the input is usable. */
function validate(input: CreateCheckoutForEntryInput, now: number): string | undefined {
  if (typeof input.entryId !== 'string' || input.entryId.trim() === '') return 'entryId is required';
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
    return 'amountCents must be a positive integer in the currency minor unit';
  }
  if (typeof input.currency !== 'string' || !/^[a-z]{3}$/i.test(input.currency)) {
    return 'currency must be a three-letter ISO 4217 code';
  }
  if (input.customerEmail !== undefined && !z.email().safeParse(input.customerEmail).success) {
    return 'customerEmail is not a valid email address';
  }
  if (!(input.expiresAt instanceof Date) || Number.isNaN(input.expiresAt.getTime())) {
    return 'expiresAt must be a valid Date';
  }
  const ahead = input.expiresAt.getTime() - now;
  if (ahead < MIN_EXPIRY_MS || ahead > MAX_EXPIRY_MS) {
    return 'expiresAt must be between 30 minutes and 24 hours from now (Stripe Checkout limits)';
  }
  if (typeof input.successUrl !== 'string' || !isHttpUrl(input.successUrl)) return 'successUrl must be an absolute http(s) URL';
  if (typeof input.cancelUrl !== 'string' || !isHttpUrl(input.cancelUrl)) return 'cancelUrl must be an absolute http(s) URL';
  if (
    typeof input.idempotencyKey !== 'string' ||
    input.idempotencyKey === '' ||
    input.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH
  ) {
    return 'idempotencyKey must be 1-255 characters';
  }
  if (input.metadata !== undefined) {
    for (const [key, value] of Object.entries(input.metadata)) {
      if (key === 'entry_id') return 'metadata.entry_id is reserved: the package sets it from entryId';
      if (typeof value !== 'string') return `metadata.${key} must be a string`;
    }
  }
  return undefined;
}

export async function createCheckoutForEntry(
  input: CreateCheckoutForEntryInput,
  deps: CreateCheckoutForEntryDeps = {},
): Promise<CreateCheckoutForEntryResult> {
  const now = deps.now ? deps.now() : Date.now();

  const invalid = validate(input, now);
  if (invalid) return fail('invalid-input', invalid);

  // Loaded on demand: `cool-astro-forms/server` is imported by every host's
  // submit endpoint, and a host that never takes payments should not pay
  // for loading the Stripe SDK.
  const client = deps.client ?? (await import('./stripe.js')).getStripeClient();
  if (!client) return fail('stripe-not-configured', 'STRIPE_SECRET_KEY is not set');

  const entryId = input.entryId;
  const currency = input.currency.toLowerCase();

  let storage: StorageAdapter;
  try {
    storage = deps.storage ?? (await getStorageAdapter());
    const entry = await storage.getEntryById(entryId);
    if (!entry) return fail('entry-not-found', `no entry with id ${entryId}`);
  } catch (err) {
    logError('checkout-for-entry.storage-failed', err, { entryId });
    return fail('storage-error', 'the entry could not be read');
  }

  const metadata = { ...(input.metadata ?? {}), entry_id: entryId };
  let session: Stripe.Checkout.Session;
  try {
    session = await client.checkout.sessions.create(
      {
        mode: 'payment',
        payment_method_types: ['card'],
        line_items: [
          {
            price_data: {
              currency,
              unit_amount: input.amountCents,
              product_data: { name: input.productName || 'Payment' },
            },
            quantity: 1,
          },
        ],
        ...(input.customerEmail ? { customer_email: input.customerEmail } : {}),
        expires_at: Math.floor(input.expiresAt.getTime() / 1000),
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        metadata,
        payment_intent_data: { metadata },
      },
      { idempotencyKey: input.idempotencyKey },
    );
  } catch (err) {
    logError('checkout-for-entry.provider-failed', err, { entryId });
    return fail('provider-error', 'Stripe did not create the checkout session');
  }

  // A reused idempotency key (a double-click, a back-and-resubmit of the
  // same rendered quote form) makes Stripe replay the session an earlier
  // call created. That session is not this call's to write or to expire.
  const replayed = isIdempotentReplay(session);

  /** Best effort: true when Stripe confirms the session can no longer be paid. */
  const expireSession = async (): Promise<boolean> => {
    try {
      await client.checkout.sessions.expire(session.id);
      return true;
    } catch (err) {
      logError('checkout-for-entry.expire-failed', err, { entryId, sessionId: session.id });
      return false;
    }
  };

  if (!session.url) {
    if (!replayed) await expireSession();
    logError('checkout-for-entry.provider-failed', new Error('Stripe returned a session without a hosted URL'), {
      entryId,
      sessionId: session.id,
      replayed,
    });
    return fail('provider-error', 'Stripe returned a session without a hosted URL');
  }

  if (replayed) {
    // Read only. Writing here could race the earlier call's own write and
    // leave an unpaid twin beside the paid row; expiring here would kill a
    // link the payer may already hold.
    let existing: unknown;
    try {
      existing = await storage.getPaymentByProviderRef(session.id);
    } catch (err) {
      logError('checkout-for-entry.replay-lookup-failed', err, { entryId, sessionId: session.id });
      return fail('storage-error', 'the replayed checkout session could not be looked up; it was left open');
    }
    if (!existing) {
      log('checkout-for-entry.replay-unrecorded', { entryId, sessionId: session.id });
      return fail(
        'replay-unrecorded',
        'this idempotencyKey was used by an earlier call whose payment is not recorded (yet); nothing was written',
      );
    }
    log('checkout-for-entry.replayed', { entryId, sessionId: session.id });
    return { ok: true, url: session.url, sessionId: session.id, expiresAt: new Date(session.expires_at * 1000) };
  }

  try {
    // A fresh session. The adapter writes it only if no row has this
    // session id yet, in one statement, so even a client that hides the
    // replay header cannot leave two rows for one session.
    await storage.attachPayment(entryId, {
      provider: 'stripe',
      providerRef: session.id,
      amountCents: input.amountCents,
      currency,
      status: 'link_created',
      payLinkUrl: session.url,
    });
  } catch (err) {
    const sessionExpired = await expireSession();
    logError('checkout-for-entry.record-failed', err, { entryId, sessionId: session.id, sessionExpired });
    return fail('record-failed', 'the payment could not be recorded, so the checkout session was cancelled', {
      sessionExpired,
    });
  }

  log('checkout-for-entry.created', { entryId, sessionId: session.id, amountCents: input.amountCents, currency });
  return {
    ok: true,
    url: session.url,
    sessionId: session.id,
    expiresAt: new Date(session.expires_at * 1000),
  };
}
