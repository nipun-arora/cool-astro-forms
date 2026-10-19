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
arrives and the payment still gets marked paid. (From 0.1.18 the PayPal
return page captures the approved order, but it never writes a status
either; see "Capture on return" in §4.)

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

### Who gets the "payment received" email (0.1.18)

When a verified webhook marks a payment paid, the package emails the owner
once. Up to 0.1.17 it read the address only as the `notifyTo` of the form
the payment's entry belongs to. A payment made on `/forms-pay`, or posted to
`/api/forms/pay/create-session` from a host's own pay page, belongs to a
`_payment_request` entry (§7) that no host registers as a form, so the owner
got no email and nothing was logged. Both payment webhooks (Stripe and
PayPal) now resolve the address the same way, in this order:

1. The `notifyTo` of the form the payment's entry belongs to. A host that
   registers a `_payment_request` form keeps getting its own address there.
2. `payments.notifyTo`, the new optional address for payments that belong to
   no configured form. It is validated like a form's `notifyTo`.
3. The `notifyTo` of the first form in `forms`, in config order.

```js
payments: {
  // Owner inbox for "payment received" emails from /forms-pay and
  // create-session payments (optional).
  notifyTo: 'accounts@example.com',
},
```

When none resolves, no email is sent and `payment.notify-skipped` is logged
with the reason only (no address, amount or payer data).

Upgrading: set `payments.notifyTo` if `/forms-pay` payments should reach a
different inbox than your first form's. Without it, those emails go to the
first form's `notifyTo`.

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

### Stripe Customers and the payer (0.1.17)

Through 0.1.16 every Stripe Checkout Session and Payment Link was a guest
checkout, so the Stripe dashboard showed "Customers created: 0" and a repeat
payer was never attributed. From 0.1.17:

- **Checkout Sessions use a Customer, and the package never creates one.**
  `/forms-pay` and `createCheckoutForEntry` only look the payer's email
  (lowercased and trimmed) up. A Customer is reused when it is tagged
  `metadata.source = 'cool-astro-forms'`, its email matches exactly, it is
  not deleted and Stripe lists no payment method on it; the session is then
  created with `customer: <id>`. The lookup runs `customers.list` and one
  Stripe Search in parallel on every call, and with several matches the
  oldest wins. When there is none (a new payer, no email, or a failed
  lookup), the session is created with `customer_creation: 'always'` plus
  the normalized `customer_email`, and Stripe creates the Customer only when
  the payer confirms the payment. An abandoned or scripted submit of the
  public pay page therefore leaves no Customer behind.
- **The webhook adopts the paying Customer.** When the Stripe webhook marks
  a payment paid (only the delivery that actually flips the row, not a
  duplicate delivery, a refund or a mismatched session), it tags
  `session.customer` with `metadata.source = 'cool-astro-forms'`. That is
  what makes the Customer reusable for the same email's next payment. The
  tag is best effort: a failure is logged as `stripe.customer-adopt-failed`
  (event id and Stripe error type only) and never changes the webhook's
  response. Admin quote Payment Link payments are tagged the same way.
- **The name is not written to Stripe.** `customerName` on
  `createCheckoutForEntry` is validated but not sent, and the `/forms-pay`
  Name field is stored on the payment-request entry only. Checkout collects
  the payer's own name.
- **It never blocks a payment.** When the lookup fails the session falls
  back to `customer_creation: 'always'` (plus `customer_email` when the
  email is known) and Stripe makes the Customer. The failure is logged as
  `stripe.customer-lookup-failed` with the error type only, never the email.
- **Restricted key permissions.** The lookup needs read access to Customers
  and PaymentMethods, and the adoption needs write access to Customers, on
  top of Checkout Sessions (and Payment Links for the admin quote flow).
  Without them payments still go through: the lookup or the adoption fails
  safe and is logged, and the payer gets a new Customer for each payment.
- **Security note: Customers the package did not tag are not reused.**
  The email is typed by whoever opens the pay page, and attaching a Customer
  to a Checkout Session makes Stripe show that Customer's saved cards, name
  and billing address to the person who typed the email. So a Customer with
  the same email that this package did not tag (for example one left by an
  earlier WordPress plugin, or another integration) is deliberately ignored:
  the payer gets a new Customer on their first payment, and the old record
  and its payments are untouched. Sessions that carry a Customer also set
  `saved_payment_method_options.payment_method_save: 'disabled'` (and never
  `setup_future_usage`), so Checkout never saves a card to the Customer or
  offers one back, and exclude `customer_balance`, so a matched Customer's
  cash balance cannot be spent by someone who only knows the email. Because
  an operator or another integration can still add a card to a tagged
  Customer, one is reused only when Stripe lists no payment method on it (if
  it holds one, or the check fails, which is logged as
  `stripe.customer-payment-methods-check-failed`, that Customer is skipped).
- **Admin quote Payment Links** are created with `customer_creation:
  'always'`, and the entry's email, when it has one, is prefilled on the
  link through Stripe's `prefilled_email` link parameter. Stripe's API does
  not let a Payment Link take an existing Customer, so a repeat payer on
  admin quote links still gets a new Customer per link. The webhook tags the
  paying Customer like any other, so later pay-page and
  `createCheckoutForEntry` payments by the same email reuse it. For one
  Customer per payer from the first payment, use `createCheckoutForEntry`
  (§2a).
- **The Payments list in Stripe is readable.** Every session the package
  creates sets `client_reference_id` to the entry id, and every PaymentIntent
  carries `entry_id` in its metadata and a description (the memo or product
  name, otherwise `Payment`; `Payment request` for an admin link with no
  memo).
- **The admin shows who paid.** When the Stripe webhook marks a payment
  paid it also records the Customer id and the payer's email on the payment
  row, in the same atomic write as the status change (storage migration v6
  adds the nullable `customer_ref` and `payer_email` columns to `payments`
  on the next boot). `/forms-admin/payments` has a Payer column, and an
  entry's payment rows show the payer and a "Stripe customer" link to the
  Customer in the Stripe dashboard (the test-mode dashboard for a test
  payment). Payments paid before the upgrade, guest checkouts and PayPal
  rows keep both columns empty.

### Payer receipts (0.1.18)

Up to 0.1.17 a Stripe receipt went out only when the dashboard's
"Successful payments" customer email setting was on, while the pay page said
"Your receipt goes here." regardless. From 0.1.18:

- **Checkout Sessions set `receipt_email`.** When the payer's email is known
  (the `/forms-pay` page, or `createCheckoutForEntry` with `customerEmail`),
  the session's `payment_intent_data.receipt_email` is the same normalized
  address. Stripe documents that a live-mode payment with `receipt_email`
  gets a receipt whatever the dashboard's customer email settings say.
  Test mode never sends automatic receipts. With no email known nothing is
  set: Checkout collects one, and the dashboard setting decides.
- **`payments.payerReceipts` chooses who sends it.** `'always'` (also when
  the key is absent) is the behaviour above. `'dashboard'` never sets
  `receipt_email`, so the dashboard's "Successful payments" setting alone
  decides.

  ```ts
  payments: {
    payerReceipts: 'dashboard', // leave receipts to the Stripe dashboard setting
  },
  ```

  The trade-off: `receipt_email` overrides the dashboard setting, and on the
  pay page the address is whatever the visitor typed, so that address gets a
  merchant-branded receipt. If you have turned Stripe receipts off on purpose,
  choose `'dashboard'`. `createCheckoutForEntry` does not read the integration
  config; pass the same value as its `payerReceipts` input (`'always'` or
  `'dashboard'`, absent means `'always'`).
- **Payment Links (admin quotes) are unaffected.** The Payment Links API
  takes no `receipt_email`, so a link payer gets a receipt only when the
  dashboard setting is on.
- **PayPal is unaffected.** The package never sends the payer's email to
  PayPal, and PayPal's own receipt rules apply.
- **The copy promises less.** `/forms-pay/success` no longer says a receipt
  is on its way, because it cannot tell a session that carried a payer
  email from one that did not. The pay page's email hint reads "Your receipt
  goes here." only when card is the sole option, and "Card payment receipts
  go here." when PayPal is offered too; under `payerReceipts: 'dashboard'`
  the hint is hidden, because no `receipt_email` is sent.

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
    customerEmail: body.email, // optional; reuses the payer's Stripe Customer if one exists, else Stripe creates it at checkout
    customerName: body.name, // optional, up to 200 characters; validated, not sent to Stripe
    expiresAt: new Date(Date.now() + 23 * 60 * 60 * 1000), // 30 minutes to 24 hours ahead
    successUrl: 'https://example.com/payment/received/',
    cancelUrl: 'https://example.com/payment/cancelled/',
    idempotencyKey: body.quoteId, // a fresh UUID per quote form render
    metadata: { booking_ref: body.ref }, // optional; entry_id is set for you
    productName: `Booking ${body.ref}`, // optional; default "Payment"; cleaned and cut to 100 characters (0.1.18)
    payerReceipts: 'always', // optional (0.1.18); 'dashboard' leaves the payer receipt to the Stripe dashboard setting
  });
  if (!result.ok) return Response.json({ error: result.code }, { status: 400 });
  return Response.json({ url: result.url, expiresAt: result.expiresAt });
};
```

`createCheckoutForEntry` never throws. In order, it:

1. validates every input (a positive integer amount, a three-letter
   currency, an expiry 30 minutes to 24 hours ahead, absolute http(s) URLs,
   a 1-255 character idempotency key, string metadata without `entry_id`, a
   valid `customerEmail` and a `customerName` of at most 200 characters when
   given, and a `payerReceipts` of `'always'` or `'dashboard'` when given)
   and returns `invalid-input` before anything else happens;
2. returns `stripe-not-configured` without `STRIPE_SECRET_KEY`, and
   `entry-not-found` or `storage-error` if the entry cannot be read, all
   before Stripe is called;
3. when `customerEmail` is given, looks up the payer's Stripe Customer (see
   "Stripe Customers and the payer" above; it never creates one), then
   creates a card-only Checkout Session for exactly that amount, with
   `metadata.entry_id` on the session and its payment intent,
   `client_reference_id` set to the entry id, and `customer: <id>` (or
   `customer_creation: 'always'` plus `customer_email` when there is no
   reusable Customer, no email, or the lookup failed), under your
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

The Customer lookup is part of the request Stripe compares against the
first call. If a retry with the same key finds the lookup came out
differently (the first call found no Customer, so it was sent with
`customer_creation: 'always'`, and the retry now finds one, typically
because the payer paid in between and the webhook tagged their Customer, or
because the first lookup failed), Stripe would refuse the changed
parameters. The helper therefore resends once, under the same key, in the
first call's shape (no Customer), and Stripe replays the original session;
the replay rules above apply, and the Customer the retry resolved stays
unused until the next payment. The reverse case cannot be repaired: if the
first call carried a Customer and the retry finds none (its lookup failed,
or the Customer has since gained a card or been deleted), there is no
Customer id to resend, so the helper returns `provider-error` and changes
nothing. The same key works again once the lookup finds the Customer. A key
reused for genuinely different parameters mismatches in both shapes and also
ends in `provider-error`.

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
Sessions is enough to create the session (it creates and, on failure,
expires sessions), and from 0.1.17 it also needs read access to Customers
and PaymentMethods when you pass `customerEmail` (the lookup), plus write
access to Customers for the webhook's tagging; without them the payment
still works through the `customer_creation: 'always'` fallback. The
built-in Payment Link flow also needs Payment Links access.

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
inbound webhook confirms payment, to the address resolved under "Who gets
the 'payment received' email" in §1; `recovery` is the lead-recovery follow-up
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
| `&label=` | Optional display label/memo, HTML-escaped when rendered. Cleaned (0.1.18): trimmed, control characters removed, whitespace collapsed, cut to 100 characters. The page shows the cleaned label, and Stripe and the entry memo get the same text. |
| `&fee=0` | Disables fee lines entirely for this link — only honoured when `payments.feeOverrides: 'query'`; ignored by default (logged as `payment-request.fee-override-ignored`). |
| `&fee=<preset-key>` | Applies a named preset from `payments.feePresets` instead of the default `payments.payLinkFees` — only honoured when `payments.feeOverrides: 'query'`; ignored by default (logged as `payment-request.fee-override-ignored`). An unrecognized key silently falls back to the default fees (never an error). |
| `&currency=usd` | Optional currency override — must be in `payments.requestPage.allowedCurrencies` or the request is rejected. |
| `&email=` | Optional (0.1.17) — prefills the page's Email field, for example with a known client's address. The payer can still change it. |
| `&name=` | Optional (0.1.17) — prefills the page's Name field. |

**The pay page asks for the payer's email (0.1.17).** The page has a
required Email field and an optional Name field. The browser requires a
full address with a dot in the domain (`name@gmail` is refused before the
post). The server does not require an email, so this is not a breaking
change: a post to `/api/forms/pay/create-session` with no `email`, or a
blank one, is accepted, and Stripe still creates a Customer for the payment
(`customer_creation: 'always'`) but does not match repeat payments to one
Customer. Only an `email` that is present and malformed (not a valid
address, or longer than 254 characters) is rejected on the Stripe path, with
`400` and `{ ok: false, reason: 'invalid-email' }`, before the Turnstile
check and before any entry or Stripe session exists. The page then stays
where it is, shows an inline "That email address does not look right"
notice next to the field, and hands the Pay buttons back. When a post
bounces back to the page with an error (for example a Turnstile check that
failed or expired), the page keeps the `?email=` and `?name=` prefill. The
email and name (capped at 200 characters) are stored on the payment-request
entry (the name is not sent to Stripe), and the email is what lets the next
payment by the same address reuse the payer's Customer (see "Stripe
Customers and the payer" in §2). The PayPal path never rejects on email.

Upgrading: host-owned pay forms that post to `/api/forms/pay/create-session`
keep working unchanged. Add an `email` field (and optionally `name`) to get
repeat payers matched to one Customer.

If that form carries `data-caf` (for example so the Turnstile loader renders
its widget there), mark the payer fields `data-caf-ignore`. Otherwise the
abandonment capture stages the email, any leave trigger before the payer
presses Pay (a tab switch, an outbound link, the pointer leaving through the
top edge) saves an abandoned draft for that form, and create-session never
converts it, so the owner gets an "Abandoned" alert for a payer who paid.
`forms.<id>.capture.deny: ['email', 'name']` does the same from config. Do
not remove `data-caf` to avoid this: the loader renders the widget only on
`[data-caf]` forms, and create-session refuses a post without a token.

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

### Capture on return (0.1.18)

The package creates PayPal orders with `intent: CAPTURE`, so the payer's
approval alone moves no money: the order has to be captured. Up to 0.1.17
nothing captured it, and `PAYMENT.CAPTURE.COMPLETED` never fired. PayPal
sends the payer to `/forms-pay/paypal-return?token=<order id>&PayerID=…` once
they approve, and that page now captures the order on the server:

- **Only this install's orders.** The `token` must match a stored PayPal
  payment that is still `link_created`. An id from the query string is never
  sent to PayPal on trust.
- **No double capture.** Each attempt sends a fresh `PayPal-Request-Id`, and
  an order PayPal reports as already captured is treated as done.
- **The button reads "Pay Now".** Orders declare `user_action: 'PAY_NOW'`.
  PayPal's default, "Continue", is meant for a flow that returns the payer
  without processing the payment; this one captures on return.
- **The payer is told what happened:** received, still processing, declined
  or not yet approved, or a plain error. After a decline or an unfinished
  approval the page offers the stored approval link again, so the payer can
  choose another way to pay in PayPal.
- **The webhook still decides.** The return page never writes the payment
  row. The verified `PAYMENT.CAPTURE.COMPLETED` webhook stays the only
  writer of `paid`, and it is what sends the "payment received" email and
  fires `payment.paid`. "Payment received" on the page means PayPal accepted
  the capture.
- **Admin-quote PayPal orders return here too.** They previously returned to
  the site root and were never captured.

Upgrading: orders approved under 0.1.17 or earlier were never captured.
Check them in the PayPal dashboard.

Not yet drilled against the PayPal sandbox (§6).

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
them). From 0.1.17 the entry's fields also hold the payer's `email` and,
when given, `name`, so you can see who a payment request came from in the
Entries view.

By default, `/forms-admin/entries` also hides these synthetic rows from the
main list — a small "Payment requests hidden" chip with a
`?showPaymentRequests=1` link toggles them back into view. The **Payments**
admin view (`/forms-admin/payments`) always shows them regardless, since
that's the dedicated place to review payment activity. The full-dataset CSV
export never applies this exclusion — it's always a complete dump of the
current filter, payment-request rows included.
