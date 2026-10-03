# Payments + webhooks

Quote-first Stripe/PayPal payments (money in), verified inbound webhooks
(payment truth), and signed outbound webhooks (events out) — plus a
shareable, no-account-needed `/forms-pay` payment-request link.

Every payment route/page is **env-gated and inert by default (PAY-04)**: with
no provider key configured, this package injects zero payment routes, zero
payment pages, and zero payment UI — byte-identical to a pre-payments
install. Nothing below is required to use the rest of the package.

## 1. Environment setup

| Variable | Required | Purpose |
|---|---|---|
| `STRIPE_SECRET_KEY` | To enable Stripe | Server-only Stripe secret key (test or live). Enables `/forms-pay`, the admin quote-flow's "Pay with card" link, `createCheckoutForEntry`, and the inbound `/api/forms/webhooks/stripe` route. |
| `STRIPE_WEBHOOK_SECRET` | To verify inbound Stripe webhooks | The signing secret Stripe gives you for the endpoint below. Without it, `/api/forms/webhooks/stripe` rejects every delivery (fails closed — never processes an unverifiable event). |
| `PAYPAL_CLIENT_ID` | To enable PayPal | REST app client ID (sandbox or live). |
| `PAYPAL_CLIENT_SECRET` | To enable PayPal | REST app client secret. Both `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` must be set together — either alone leaves PayPal inert. |
| `PAYPAL_WEBHOOK_ID` | To verify inbound PayPal webhooks | The Webhook ID PayPal gives you for the endpoint below. Without it, `/api/forms/webhooks/paypal` rejects every delivery. |
| `PAYPAL_ENV` | No | `live` selects `api-m.paypal.com`; anything else (including unset) uses the sandbox API. |

Stripe and PayPal are independent — configure one, both, or neither.
`/forms-pay` and the admin quote-flow are injected whenever **either**
provider is configured (the page branches Stripe/PayPal per request); the
two inbound webhook routes and the PayPal approval-return page stay
provider-scoped to their own key pair.

### Registering the webhook endpoints

In each provider's dashboard, point the webhook configuration at:

- Stripe: `https://your-site.example/api/forms/webhooks/stripe`
  (events: `checkout.session.completed`, and from 0.1.15
  `checkout.session.async_payment_succeeded` if your account offers any
  delayed payment method)
- PayPal: `https://your-site.example/api/forms/webhooks/paypal`
  (event: `PAYMENT.CAPTURE.COMPLETED`)

If your host runs Astro with `trailingSlash: 'always'` (see the "trailing
slash" note under §3 below), append the trailing slash to both URLs — this
package's own client-visible URLs already account for it, but a URL you type
into a third-party dashboard does not compute itself.

**The inbound webhook is the sole source of payment truth.** Nothing else in
this package — not the browser landing back on `/forms-pay/success`, not the
admin quote-flow's redirect — ever flips a payment's status. If a visitor
closes the tab before the provider's redirect completes, the webhook still
arrives and the payment still gets marked paid.

### What the Stripe webhook checks before it marks a payment paid (0.1.15)

A valid signature is not enough. The webhook treats the matched row as the
contract and marks it `paid` only when all of these hold:

- the event is `checkout.session.completed` or
  `checkout.session.async_payment_succeeded`;
- the session's `payment_status` is `paid` (a delayed payment method
  completes the session `unpaid` first and settles later with
  `async_payment_succeeded`);
- the session's `amount_total` equals the row's stored amount, and its
  `currency` equals the row's currency (compared case-insensitively; for a
  session that Stripe converted with Adaptive Pricing under an API version
  before 2025-03-31, the original amount and currency under
  `currency_conversion` are compared instead).

Anything else is recorded on the payment's event log without the paid
status, logged as `webhook.settlement-mismatch` (with the reason
`not-paid`, `amount` or `currency`, and both sides' values), and answered
with 200 so Stripe does not retry it. No "payment received" email goes out
and no outbound `payment.paid` webhook fires. PayPal's webhook is unchanged.

Matching: a session is found by its own id (`cs_…`). If none matches and the
session came from a Stripe Payment Link, the link id (`plink_…`) is tried
next. Up to 0.1.14 the admin quote flow stored the link id while the webhook
only looked up the session id, so payments made through those links were
never marked paid and nobody was emailed. Links created by
0.1.14 or earlier are matched too once you upgrade.

**Known limit:** refunds, disputes and expired sessions do not change a
payment's status in `/forms-admin`. The webhook acknowledges those events
and leaves the row as it was, so reconcile refunds and disputes in the
Stripe dashboard.

## 2. Admin quote-flow

From an entry's detail page (`/forms-admin/entries/:id`), "Create payment
link" takes an amount + optional memo and creates either a Stripe Payment
Link or a PayPal order (your choice, no fee lines applied — this is an
owner-set amount, not a fee-augmented request-page total). The resulting
link is stored on the entry's payment row, shown with a copy button, and
auto-emailed to the visitor via the existing notify seam (fire-and-forget —
the copy-link UI is always shown regardless of whether the email send
succeeded).

From 0.1.15:

- The currency is `payments.quoteCurrency` (default `'usd'`, which is what
  the flow always charged before). It must be a two-decimal currency (AED,
  EUR, GBP and so on), because the form reads `200.50` as 20050 minor
  units; a zero- or three-decimal code fails config validation. For any
  other currency, build your own page with `createCheckoutForEntry` (§2a).
- Each Stripe Payment Link accepts one completed checkout
  (`restrictions.completed_sessions.limit: 1`): one quote row, one payment.
- `payments.adminQuote` decides what the entry page offers:

  ```js
  payments: {
    quoteCurrency: 'aed',
    // 'builtin' (default): the "Create payment link" form.
    // 'off': no control, and /forms-admin/payments/action is not injected.
    // { href }: a "Create a quote" link to your own page instead, with
    //   ?entry=<id> added to the query (before any #fragment); the
    //   built-in route is not injected.
    adminQuote: { href: '/forms-admin/quote/' },
  },
  ```

  `href` must be a site path starting with `/` or an http(s) URL. A path is
  checked the way a browser resolves it, so `/\evil.com` and a tab or line
  break between two slashes (both read as `//evil.com`) are rejected.

## 2a. Host-built checkouts: `createCheckoutForEntry` and `isAdminRequest` (0.1.15)

A desk that quotes from its own page (an AED amount set once availability is
confirmed, say, or a deposit with its own product name) can use two typed
helpers from `cool-astro-forms/server`. The page never touches the
package's storage internals:

```ts
// src/pages/forms-admin/quote/create.ts (a host route under /forms-admin)
import type { APIRoute } from 'astro';
import { createCheckoutForEntry, isAdminRequest } from 'cool-astro-forms/server';

export const prerender = false;

export const POST: APIRoute = async (context) => {
  // The package middleware already guards every /forms-admin path; check
  // again before creating anything that takes money. Keep this route under
  // /forms-admin: the admin cookie is only sent there.
  if (!isAdminRequest(context)) return new Response(null, { status: 401 });

  const body = await context.request.json();
  const result = await createCheckoutForEntry({
    entryId: body.entryId,
    amountCents: body.amountFils, // integer minor units, decided by the desk, never by the payer
    currency: 'aed',
    customerEmail: body.email, // optional
    expiresAt: new Date(Date.now() + 23 * 60 * 60 * 1000), // 30 minutes to 24 hours ahead
    successUrl: 'https://example.com/payment/received/',
    cancelUrl: 'https://example.com/payment/cancelled/',
    idempotencyKey: body.quoteId, // a fresh UUID per quote form render
    metadata: { booking_ref: body.ref }, // optional; entry_id is set for you
    productName: `Booking ${body.ref}`, // optional; default "Payment"
  });
  if (!result.ok) return Response.json({ error: result.code }, { status: 400 });
  return Response.json({ url: result.url, expiresAt: result.expiresAt });
};
```

`createCheckoutForEntry` never throws. In order, it:

1. validates every input (a positive integer amount, a three-letter
   currency, an expiry 30 minutes to 24 hours ahead, absolute http(s) URLs,
   a 1-255 character idempotency key, string metadata without `entry_id`)
   and returns `invalid-input` before anything else happens;
2. returns `stripe-not-configured` without `STRIPE_SECRET_KEY`, and
   `entry-not-found` or `storage-error` if the entry cannot be read, all
   before Stripe is called;
3. creates a card-only Checkout Session for exactly that amount, with
   `metadata.entry_id` on the session and its payment intent, under your
   idempotency key (`provider-error` if Stripe refuses);
4. records the payment row with the session id (`cs_…`) as its provider
   reference, which is what the webhook looks up;
5. if that write fails, expires the session at Stripe and returns
   `record-failed` (with `sessionExpired`) instead of the URL, so a guest can
   never be charged for a session the admin does not know about.

A reused key (a double-click, or the same rendered quote form posted twice)
makes Stripe replay the session it already created, flagged with the
`Idempotent-Replayed: true` response header. A replay never writes a row
and never expires the session, because the session belongs to the earlier
call and its link may already be with the payer:

- if the earlier call recorded the session, the helper returns the same
  URL;
- if it has not (it is still writing the row, or it failed and expired the
  session), the helper returns `replay-unrecorded` and no URL. Retry with
  the same key in a moment, or with a new key for a new session;
- if the row cannot be read, it returns `storage-error` and leaves the
  session open.

The built-in SQLite and Turso adapters also write at most one payment row
per provider reference, with the check and the insert in one statement. So
a paid payment never has an unpaid twin beside it, even when two posts of
the same form overlap.

After `record-failed`, retry with a new idempotency key: Stripe replays the
original (now expired) session for a reused key, for 24 hours. For the same
reason, do not derive the key from the entry and amount.

The amount is in the currency's smallest unit (`formatMoney` from
`cool-astro-forms/server` turns it back into a display string, for example
`AED 2,500.00`). A Stripe restricted key with write access to Checkout
Sessions is enough for this helper (it creates and, on failure, expires
sessions); the built-in Payment Link flow also needs Payment Links access.

`isAdminRequest(context)` takes Astro's `APIContext` or the `Astro` global
and returns `true` only for a valid, unexpired `/forms-admin` session
cookie, verified with the same secret as the package's own guard. It fails
closed (no cookie, a forged or expired token, or an unresolvable secret all
return `false`) and never throws.

Put host admin pages and routes under `/forms-admin`. The session cookie is
set with `Path=/forms-admin`, so the browser never sends it to `/api/quote`
or any other path outside that prefix, and `isAdminRequest` is always
`false` there. Under the prefix the package middleware also guards the
request, and `isAdminRequest` is the explicit second check. Called from a
path outside the prefix, it logs one `admin.is-admin-request-outside-admin-path`
warning naming the path. Do not widen the cookie path or drop the check to
make such a route work; move the route.

### Overriding transactional email templates

Set `templatesModule` in your `coolForms()` config to a host-relative module
path default-exporting a `CafTemplates` object:

```ts
export interface CafTemplates {
  abandonedLead?: (data) => { subject: string; text: string; html?: string };
  paymentQuote?: (data) => { subject: string; text: string; html?: string };
  paymentReceived?: (data) => { subject: string; text: string; html?: string };
  recovery?: (data) => { subject: string; text: string; html?: string };
}
```

Every key is optional — an omitted key falls back to this package's own
default template for that email. `paymentQuote` fires when a payment link is
created (admin quote-flow or `/forms-pay`); `paymentReceived` fires when the
inbound webhook confirms payment; `recovery` is the lead-recovery follow-up
(honoured from 0.1.15; earlier versions ignored it). The types
(`CafTemplates` and each template's data type), `escapeHtml` and the
currency-aware `formatMoney(amountMinorUnits, currency)` are exported from
`cool-astro-forms/server` for use in your templates module.

`escapeHtml` stops a value from breaking out of an attribute or tag. It does
not make a URL safe: a `javascript:` or `data:` link survives it unchanged.
The URLs the package hands your templates are already checked. The
recovery template's `resumeUrl` is the abandoned page only when that page is
an http(s) URL on your `siteUrl` origin, and your `siteUrl` otherwise
(docs/recovery.md). Any other URL you put in an `href` is yours to check.

## 3. The `/forms-pay` shared-link contract

`/forms-pay` is a public, unauthenticated page — anyone with the link can pay
the amount it encodes. Query parameters:

| Param | Meaning |
|---|---|
| `?amount=200` | Base amount in **DOLLARS** — the primary contract. Decimals allowed (`amount=199.50`), up to 2 places. Whole dollars or `\d+\.\d{1,2}` — no sign, no exponent notation, no thousands separators. |
| `?pay=20000` | Legacy alias in **CENTS** — kept for backward compatibility with pre-existing `?pay=` integrations. Non-negative integers only. |
| `&label=` | Optional display label/memo, HTML-escaped when rendered. |
| `&fee=0` | Disables fee lines entirely for this link — only honoured when `payments.feeOverrides: 'query'`; ignored by default (logged as `payment-request.fee-override-ignored`). |
| `&fee=<preset-key>` | Applies a named preset from `payments.feePresets` instead of the default `payments.payLinkFees` — only honoured when `payments.feeOverrides: 'query'`; ignored by default (logged as `payment-request.fee-override-ignored`). An unrecognized key silently falls back to the default fees (never an error). |
| `&currency=usd` | Optional currency override — must be in `payments.requestPage.allowedCurrencies` or the request is rejected. |

**`amount` and `pay` are distinct param names by design (D4)** — this makes a
100x unit mix-up structurally impossible. If `amount` is present in the
query string it always governs, valid or not; an invalid `amount` never
silently falls through to a `pay` value in a different unit.

The amount input on the page stays editable, but this is a **preview only**
— the server always recomputes the total from whatever base amount is
actually posted. No total or fee AMOUNT is ever read from the request; every
dollar figure charged is computed server-side from
`payments.payLinkFees`/`feePresets` and the posted base amount. The `fee`
SELECTOR above does exist in the request, and it is ignored unless the host
opts in — see below.

### Server-enforced caps

```ts
payments: {
  requestPage: {
    minAmountCents: 100,      // reject anything below this
    maxAmountCents: 500000,   // reject anything above this
    allowedCurrencies: ['usd'],
  },
},
```

Amounts outside `[minAmountCents, maxAmountCents]` or a currency outside the
whitelist are **rejected with a clean 400**, never silently clamped — a
silently-adjusted amount would be both a worse UX and a worse audit trail.

**`minAmountCents` must not be configured below Stripe's own per-currency
minimum charge floor** (commonly cited as $0.50 USD or the currency
equivalent — verify the authoritative table at
[docs.stripe.com/currencies](https://docs.stripe.com/currencies) before
finalizing, since Stripe's own limits can change). A config minimum set
below Stripe's floor doesn't produce a clean validation message — it lets
the request through to Stripe, which then rejects it with a raw API error.

### Fee configuration + the surcharge-legality caveat

```ts
payments: {
  payLinkFees: [{ label: 'Transaction charges', percent: 0.05 }],
  // or a flat amount instead of a percentage:
  // payLinkFees: [{ label: 'Processing fee', flatCents: 150 }],
  feePresets: {
    // referenced via ?fee=waived
    waived: [],
  },
  feeOverrides: 'query', // required for ?fee= links to work; a payer can post the same field
},
```

Each fee line is exactly one of `percent` (a decimal ratio, e.g. `0.05` for
5%, rounded to the nearest cent) or `flatCents` — never both, never neither.
Fee lines render as their own line items on the breakdown table and on
Stripe's hosted Checkout page/receipt (not pre-summed into the base amount).

### The fee selector is opt-in (0.1.12)

`payments.feeOverrides` defaults to `'off'`: any `fee` field in the request
or the page URL is ignored, and the configured `payLinkFees` are always
charged. This is the fail-closed default, because the pay page's `fee`
selector is read from the same POSTed body a payer controls — not from a
channel only the operator sharing the link can reach — so a payer could add
`fee=0` to their own form post exactly as easily as an operator could put it
in a link.

Set `feeOverrides: 'query'` to restore the previous behaviour (`?fee=0`
waives fees, `?fee=<preset-key>` swaps in a `feePresets` entry) for hosts
that knowingly share fee-free operator links and accept that a payer can
send the same field. An ignored `fee` field is never rejected — the request
proceeds at the configured price — but it is logged as
`payment-request.fee-override-ignored` with `{ ip }` so you can see the
attempts.

**Upgrading from a pre-0.1.12 version:** any `?fee=0`/`?fee=<preset>` link
you have already shared stops waiving or swapping fees after upgrading
unless you set `feeOverrides: 'query'`. If you previously blocked the `fee`
field yourself (a reverse proxy rule, an Express wrapper check) as a
workaround, you can drop that guard once you're on 0.1.12 with the default
`'off'`.

**This package computes and labels a fee line — it does not know or enforce
surcharge legality on your behalf.** Before shipping a non-zero
`payLinkFees` configuration, know that:

- Card network rules cap surcharges at roughly 3% (Visa) / 4% (Mastercard) —
  in practice, capped near 3% for merchants accepting both networks.
- **Debit and prepaid card transactions cannot be surcharged in any US
  state — this is federal law**, not state law. This package cannot know the
  card type before a charge completes, so `payLinkFees` should be labeled as
  a general "transaction fee"/"processing fee" — not asserted as a
  compliant "surcharge" — and applying it correctly for your card mix and
  jurisdiction is your responsibility.
- A small number of US states prohibit surcharging outright. **This package
  intentionally does not hardcode a state list** — such lists go stale and
  sources disagree on the current one. Consult current card-network rules
  and your state's current law before configuring a non-zero fee.
- Where surcharging is legal, disclosure is typically required at point of
  entry, point of sale, and on the receipt.

In short: `payLinkFees`/`feePresets` are a generic, owner-labeled config
value, not a tax- or surcharge-compliance engine. This package performs no
jurisdiction or card-type detection.

### Trailing slash (`trailingSlash: 'always'` hosts)

If your Astro config sets `trailingSlash: 'always'`, every client-visible
URL this package emits (the `/forms-pay` form action, the Stripe/PayPal
redirect URLs, the admin quote-flow's returnUrl/cancelUrl) is already
computed slash-correct — no action needed on your part. What IS your
responsibility: any URL you type by hand (a provider dashboard webhook URL,
a bookmarked admin link) must carry the trailing slash yourself — `astro
dev`/the production Node adapter do **not** auto-redirect a slashless
request to its slashed form; a mismatched request 404s outright rather than
silently working.

## 3b. Transports: fetch first, navigation fallback (0.1.10)

`POST /api/forms/pay/create-session` speaks two dialects, keyed on the `Accept` header:

- **Fetch/XHR client** (`Accept: application/json`): success is `200 {ok:true, url}` and the CLIENT performs the checkout hop itself (`location.assign(url)` — a plain GET). Failures are JSON with `reason` and, on a Turnstile reject, a sanitized Cloudflare `code` (`missing-input-response` / `timeout-or-duplicate` / `invalid-input-response`).
- **Form-navigation client** (`Accept: text/html`): success is the classic `302 Location:` redirect. A Turnstile reject 303s back to the page the visitor paid from (same-origin `Referer`, query preserved, `error=turnstile&amount=…&code=…` merged) or to `/forms-pay` when the Referer is absent/foreign.

The shipped pay page uses fetch and keeps the native submit as its no-JS fallback, and a HOST-OWNED payment page should do the same. Why this exists: edge bot-challenges (Cloudflare Managed Challenge, Bot Fight Mode) cannot complete on a navigation POST — an interstitial cannot replay the POST body — so a challenged form submit dies as an opaque 503/wedged tab. XHR is unchallengeable by design and the follow-up GET challenges cleanly. Found in production when a zone's own challenge settings ate every real-browser submit while identical curl requests passed. Submit buttons stay locked until the Turnstile widget's token exists in the form (ANY non-empty value: test sitekeys mint short dummy tokens) and re-lock if Cloudflare expire-clears it.

## 4. PayPal approval-link expiry

A PayPal order's approval link is time-limited — PayPal's documented
default is on the order of a few hours (extendable, per PayPal's own Orders
v2 documentation), not indefinite. **Verify the current exact window against
[PayPal's own Orders v2 API reference](https://developer.paypal.com/docs/api/orders/v2/)
before relying on a specific number** — this package does not hardcode or
enforce the window, it only surfaces the caveat: a payment link shared today
and clicked next week will show the visitor an expired-order error, not a
silent failure. If you need a durable, always-valid link, prefer the admin
quote-flow's Stripe Payment Link (no per-order expiry) over a PayPal order,
or regenerate the PayPal link before sharing it again.

## 5. HOOK-01 — outbound webhooks

Configure `webhooks[]` on `coolForms()` to receive signed, real-time events
whenever an entry is submitted, abandoned, or paid:

```ts
coolForms({
  // ...
  webhooks: [
    {
      url: 'https://your-receiver.example.com/hook',
      secret: 'a-long-random-secret-you-generate',
      events: ['entry.submitted', 'entry.abandoned', 'payment.paid'], // optional — omit to subscribe to all
    },
  ],
});
```

**SSRF warning: never source `webhooks[].url` from untrusted input** (a form
field, a query parameter, anything a visitor controls). `webhooks[]` is
static server configuration only — treat it exactly like `dbPath` or a
provider secret, not like user-supplied data. A webhook target sourced from
untrusted input lets an attacker make this server issue signed POST requests
to arbitrary internal or external hosts on your behalf.

### Signature scheme + verifying a delivery

Every delivery carries an `X-Caf-Signature` header: `t=<unix-seconds>,v1=<hex
HMAC-SHA256>` — the signature covers `${t}.${rawBody}` keyed by your
configured `secret` (the same `t=,v1=` shape Stripe's own webhooks use).
Verify it in your receiver with the exported helper:

```ts
import { verifyWebhookSignature } from 'cool-astro-forms/server';

const raw = await request.text(); // read the RAW body — never JSON.parse first
const ok = verifyWebhookSignature(raw, request.headers.get('x-caf-signature'), 'a-long-random-secret-you-generate');
if (!ok) return new Response('invalid signature', { status: 401 });

const event = JSON.parse(raw); // { id, type, at, data }
```

`verifyWebhookSignature` never throws — a missing header, a tampered body,
the wrong secret, or a timestamp outside the tolerance window all resolve
`false`.

### Delivery, retries, and the no-durable-queue tradeoff

Delivery is **in-process, fire-and-forget**: up to 3 attempts per event with
exponential backoff (1s, then 2s), then the failure is logged and dropped.
**There is no durable queue** — retry state lives entirely in this
process's memory, so a process restart mid-retry loses that retry (a
deliberate scope decision).
This never affects payment correctness: the inbound Stripe/PayPal webhooks
(§1) remain the sole source of payment truth regardless of any outbound
delivery outcome — outbound events are a best-effort notification feed to
Slack/n8n/Make, not a system of record. If you need guaranteed delivery,
have your receiver poll `/forms-admin` or the storage layer directly rather
than relying solely on outbound webhooks.

### Receiver recipes

**Slack** (via an [Incoming Webhook](https://api.slack.com/messaging/webhooks)) —
put a tiny relay in front of Slack's webhook URL (Slack's own endpoint
doesn't understand `X-Caf-Signature`, so verify here first, then forward a
Slack-shaped payload):

```ts
// e.g. an Astro API route or any small Node receiver
import { verifyWebhookSignature } from 'cool-astro-forms/server';

export async function POST(request: Request) {
  const raw = await request.text();
  if (!verifyWebhookSignature(raw, request.headers.get('x-caf-signature'), process.env.CAF_WEBHOOK_SECRET!)) {
    return new Response('invalid signature', { status: 401 });
  }
  const event = JSON.parse(raw) as { type: string; data: Record<string, unknown> };

  await fetch(process.env.SLACK_WEBHOOK_URL!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: `[${event.type}] ${JSON.stringify(event.data)}` }),
  });

  return new Response('ok', { status: 200 });
}
```

**n8n** — add a "Webhook" trigger node pointed at `webhooks[].url`, then a
"Function" node as the first step that recomputes the HMAC (Node's
`crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')`,
compared against the `v1=` segment of the `t=,v1=` header) before any
downstream node acts on the payload — n8n's webhook trigger doesn't verify
signatures for you.

**Make (Integromat)** — same shape: a "Webhooks" module receiving the raw
JSON, followed immediately by a "Tools > Set variable"/HMAC-verification
step (Make's "Digest" or a custom HTTP module calling out to a tiny
verification endpoint) before any downstream module consumes `data`. Do not
skip verification just because Make's webhook URL is unguessable — an
unverified receiver still trusts whatever hits the URL.

## 6. Live-provider drills are a human item

Everything above is exercised by this package's own automated test suite
using dummy keys (`sk_test_e2e_dummy`-shaped values, the Stripe SDK mocked
at the route seam, `stripe.webhooks.generateTestHeaderString` for signature
tests) — **no automated test in this repository ever makes a live call to
Stripe's or PayPal's real API.** The one thing that genuinely requires a
real test-mode account is clicking "Pay with card"/"Pay with PayPal" and
completing a real hosted Checkout/approval flow end to end. That drill is an
owner-gated human verification step, exactly like Phase 2's real-Cloudflare-account
Turnstile widget check — not required for this package's automated tests to
pass, and not something a CI pipeline should attempt.

## 7. The `_payment_request` synthetic entry + Entries-view visibility

Every standalone `/forms-pay` payment (as opposed to an admin quote-flow
payment tied to a real form submission) is recorded as a synthetic entry
with the reserved `formId: '_payment_request'` — this keeps `entry_id`
`NOT NULL` on the payments table without a breaking schema migration, and
keeps these synthetic rows out of your real funnel analytics (the
`/forms-admin/analytics` funnel/top-drop-off queries unconditionally exclude
them).

By default, `/forms-admin/entries` also hides these synthetic rows from the
main list — a small "Payment requests hidden" chip with a
`?showPaymentRequests=1` link toggles them back into view. The **Payments**
admin view (`/forms-admin/payments`) always shows them regardless, since
that's the dedicated place to review payment activity. The full-dataset CSV
export never applies this exclusion — it's always a complete dump of the
current filter, payment-request rows included.
