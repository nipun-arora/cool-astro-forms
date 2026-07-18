# Lead recovery — automated abandonment follow-up

A single automated follow-up email to a visitor who typed an email address
into a form and then left without submitting — off by default, opt-out
honored forever. No WPForms precedent exists for this feature (clean-room,
original design).

Nothing below is required to use the rest of the package. With
`recovery.enabled` unset (the default, `false`), the whole module is inert:
no widget script is injected, no unsubscribe route is injected, no
`consent_at` is ever recorded, and the sweep is a total no-op — byte-identical
to a pre-Phase-4 install.

## 1. Config

```ts
coolForms({
  // ...
  recovery: {
    enabled: true,
    delayMins: 60,        // minutes after last abandon activity before eligible
    consentMode: 'auto',  // 'auto' (default) | 'checkbox'
  },
});
```

| Field | Default | Purpose |
|---|---|---|
| `enabled` | `false` | The activation switch — recovery has no external provider key to gate on (unlike Turnstile/Stripe/PayPal), so this config value alone turns the whole feature on. |
| `delayMins` | `60` | How long after the visitor's last abandon activity before the lazy sweep becomes eligible to email this row. |
| `consentMode` | `'auto'` | See §2. |

## 2. Per-form control

The site-wide `recovery.enabled` switch above is the master gate — but a
host with multiple tagged forms can also turn recovery off for **one form
specifically** while leaving it on for the rest, via an optional per-form
override (ROADMAP Phase 4 SC4's "optional, per-form flag", closed in the
04-10 gap-closure plan):

```ts
coolForms({
  // ...
  recovery: { enabled: true }, // site-wide switch stays ON
  forms: {
    order: {
      notifyTo: 'owner@example.com',
      recovery: { enabled: false }, // recovery OFF for THIS form only
    },
    contact: {
      notifyTo: 'owner@example.com',
      // no override — inherits the site-wide switch (ON)
    },
  },
});
```

The precedence is a fixed 4-cell table — the site-wide switch is always the
hard gate:

| Site-wide `recovery.enabled` | Per-form `recovery.enabled` | Result for that form |
|---|---|---|
| `false` | absent | off |
| `false` | `true` | **still off** — a per-form `true` can NEVER override a site-wide off |
| `true` | absent | on (inherits the site-wide switch) |
| `true` | `false` | off for this form only |
| `true` | `true` | on |

Turning a form off stops **new** consent recording immediately (auto and
checkbox modes both), stops the widget's checkbox/toast for that form, and
switches its client transport back to the plain `sendBeacon` path. It does
**not** retroactively touch any lead who already consented while the form
was on — those pre-existing rows are simply excluded from the sweep going
forward (never claimed, never emailed) and age out naturally via the
`retentionDays` purge, the same as any other abandoned row.

## 3. Consent basis — auto vs checkbox

**`'auto'` (the owner default, CONTEXT D3):** no checkbox, no extra UI. Any
abandoned lead whose captured payload contains a **valid email address**
gets consent recorded automatically (`consent_at`, the timestamp the
qualifying email was first captured) — a phone number alone is never a
consent basis in auto mode, only a real email is. This is an explicit
product decision the package owner made: send one helpful follow-up to
someone who was clearly mid-form, on the theory that a single "finish where
you left off" email for a form the visitor actively typed into is the kind
of transactional-adjacent contact a site owner can defend, not marketing
spam. **You are responsible for your own legal basis under your
jurisdiction's rules** (GDPR/CAN-SPAM/etc.) — this package does not make
that determination for you; if `'auto'` isn't the right basis for your
audience, use `'checkbox'` instead.

**`'checkbox'`:** the recovery widget renders an explicit opt-in checkbox on
the tagged form ("Email me a link to finish this form if I don't complete
it now.") — consent is recorded **only** when the visitor checks it before
abandoning. Reserved for owners and OSS consumers who want (or need)
explicit opt-in rather than the auto basis above.

Either way, `recovery.enabled:false` records nothing, ever — the config
switch is checked before any consent-recording code runs at all.

## 4. The "progress saved" widget

When recovery is active, a small toast appears after an abandon save:
*"Your progress is saved — we'll email you a link to finish."* This is not
a fire-and-forget claim — the toast is driven by a **real server response**:
the client's abandon transport switches from the normal `sendBeacon`
(fire-and-forget, unreadable) to a `fetch` call that reads the JSON
`{saved:true}` response body before dispatching the event the widget
listens for. If the save actually failed (network error, a rejected
request), no toast renders — the widget never claims a save the server
didn't confirm.

## 5. The follow-up email + one-click unsubscribe

A lazy, request-traffic-driven sweep (see §6) finds eligible rows — abandoned,
consented, not yet sent, not suppressed, past `delayMins` — and sends
**exactly one** follow-up per row, ever. The atomic claim
(`markRecoverySent`, a `BEGIN IMMEDIATE` transaction) happens *before* the
send is attempted, so two sweeps racing each other (or a process recycle
between the claim and the send) can never result in the same visitor getting
two emails.

Every follow-up carries a one-click, no-login unsubscribe link: a
`/api/forms/recovery-unsubscribe`-shaped route your host doesn't need to
build — the package injects it automatically whenever recovery is active. The link
is a signed HMAC token over the visitor's UUID (**never** the visitor's
email address — a leaked or forwarded link never discloses an address).
Clicking it is idempotent: a repeat click shows the same plain-text
confirmation, never an error. A forged, malformed, or tampered token
returns the exact same generic "invalid or expired" message regardless of
why it failed — the route never confirms or denies whether a given visitor
exists.

**Unsubscribing is honored forever.** Once a visitor opts out, the sweep's
own query excludes their visitor UUID permanently — there is no retry, no
re-consent flow, no way for a future abandon to re-trigger a follow-up for
that visitor, short of the visitor manually clearing their own
localStorage/cookie identity and generating a brand-new UUID.

### Retention rationale (binding design decision, D4a)

The suppression record (`recovery_suppressions` — just a visitor UUID and a
timestamp, **no personal data**) is deliberately **excluded** from
`purgeVisitor()`'s GDPR-erasure delete cascade. This is the canonical
suppression-list exception, not an oversight: a visitor's client-side UUID
**persists through an erasure** (it lives in a cookie/localStorage, not in
your database), so if the suppression row were deleted along with everything
else on an erasure request, the very next time that same visitor abandoned a
form, the sweep would have no record they ever opted out — silently
re-contacting someone who explicitly said stop. Retaining a minimal opt-out
marker (UUID + timestamp only) to honor an opt-out request is the standard,
defensible practice for suppression lists industry-wide; this package's
`purgeVisitor()` docstring records the same rationale in code.

## 6. Why a lazy sweep, not a cron job or `setTimeout`

There is no scheduled job and no `setTimeout()` anywhere in this feature.
Recovery is driven entirely by real request traffic: your host's own
middleware (already injected by `coolForms()`) checks, on every request,
whether it has been at least `RECOVERY_SWEEP_INTERVAL_MS` (15 minutes) since
the last sweep pass for this process, and if so, runs one pass — fire-and-
forget, never blocking the request that triggered it.

This tradeoff is deliberate: hosts commonly run under process managers
(Phusion Passenger and similar) that **recycle idle worker processes**. A
`setTimeout()`-scheduled send would be silently dropped the moment its
worker gets recycled before the timer fires — a follow-up that should have
gone out simply never does, with no error anywhere. Piggybacking on real
request traffic means the sweep only ever needs a *live* process to make
progress, which is exactly the guarantee a request-driven site already has.
The honest tradeoff: on a genuinely quiet site with long idle stretches
between visits, a follow-up may be a few minutes later than exactly
`delayMins` after the last request landed — never "silently dropped
forever," but not laser-precise either. There is no durable queue; a batch
(`BATCH_LIMIT`, 25 rows) is claimed and sent per pass.

## 7. What's deferred to a live drill

Live SMTP delivery — a real follow-up landing in a real inbox, its
unsubscribe link working over the public internet — is a deferred,
owner-gated human verification item (same category as Phase 2's real-
Cloudflare Turnstile widget check and Phase 3's live Stripe/PayPal drills).
The automated test suite proves the entire sweep/send/suppress loop against
nodemailer's `jsonTransport` (the same non-production fallback this
package's own tests use) — never a live SMTP account — so no owner mailbox
is required to verify this package works before you configure your own
`EMAIL_*` variables.
