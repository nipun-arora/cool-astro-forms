# GDPR mechanics

**This is not legal advice. Consult counsel for your jurisdiction before
relying on anything below to satisfy a legal obligation.** This package
cannot determine your lawful basis for processing, cannot know your
audience's jurisdiction, and cannot know your own privacy policy or
retention commitments — those are fact-specific legal calls only you (with
your own counsel) can make. What follows is an honest, mechanics-only
description of what this package actually does, and which GDPR concept each
mechanic is relevant to. It stops there — no jurisdiction-specific
lawful-basis determination, no claim of compliance, no "install this and
you're GDPR-ready" promise. Every mechanic described below is real, shipped
behavior — nothing here is aspirational or planned-but-not-built.

If GDPR (or a similar regime — CCPA, PIPEDA, etc.) doesn't apply to your
audience, none of this is required reading; every mechanic below is either
off by default or has a documented off switch, so an install with no
EU/UK/EEA traffic can ignore this file entirely.

## Mechanic → concept map

### Visitor UUID cookie (`_caf_uid`, 1 year)

A single pseudonymous identifier — a random UUID, not derived from any
personal data — stored in a `_caf_uid` cookie (and mirrored to
`localStorage` as a fallback if the cookie is cleared) with a 1-year
`Max-Age`. This is the join key every other mechanic below hangs off: it's
how an abandoned-then-later-submitted form gets recognized as the same
visitor, how the unsubscribe link resolves back to a suppression record,
and how `purgeVisitor()` (below) knows which rows belong to one person.

**Relevant concept:** this is a **pseudonymous identifier**, not anonymous
data — GDPR treats a persistent identifier capable of singling out an
individual (even without a name attached) as personal data. It carries no
directly identifying value on its own (no email, no name), but combined
with the fields a visitor actually types into a form, it is the linking key
that makes the rest of an entry personal data too.

### Journey trail (client-side page-view history)

A capped, client-side-only list of page views (`{url, title, ts}`, query
string always stripped unless `journeyParams` is explicitly turned on — see
below) recorded into `localStorage` and sent to the server alongside a form
submission/abandon, so the admin entry-detail view can show "what pages did
this visitor look at before they filled this in." It is bounded in both
step count and byte size, and steps older than a fixed age are pruned
automatically — it is not an unbounded browsing-history log.

**Relevant concept:** behavioral tracking tied to the same pseudonymous
identifier above — relevant to both **data minimisation** (the trail is
capped and query-stripped by default, see `journeyParams` below) and
whatever lawful basis you've established for tracking visitor behavior on
your own site.

### IP geolocation (per-entry, at save time)

Every saved entry is enriched with an IP-derived geo lookup (country/region,
via `ipwhois.io` by default) at the moment it's saved — a one-time lookup,
not an ongoing tracking mechanism. Private/local IPs are always skipped (no
network call made), and a lookup failure or timeout never blocks the save —
the entry's `geo` field is just left empty. The IP address itself is stored
on the entry alongside the geo result.

**Relevant concept:** IP addresses are personal data under GDPR (recognized
as such since *Breyer v Germany*, CJEU 2016) whenever they're processed
alongside other data capable of identifying someone — which an abandoned or
submitted form entry (email/phone/name fields) generally is. The geo lookup
and the stored IP are both in scope for whatever retention/erasure
commitments you make (see `retentionDays`/`purgeVisitor` below).

### Recovery follow-up email + the `'auto'` consent basis

When lead recovery is active (`recovery.enabled: true`, off by default), a
single automated follow-up email goes to a visitor who typed a valid email
address into a form and then abandoned it. The `'auto'` consent mode (the
package default when recovery is on) records consent automatically the
moment a qualifying email is captured — no checkbox, no extra UI — on the
product decision that a single "finish where you left off" email, sent once,
to someone who was actively mid-form on your own site, is a
transactional-adjacent contact a site owner can defend rather than cold
marketing. **This package does not decide your lawful basis for you** — if
`'auto'` isn't the right basis for your audience or jurisdiction (a common
GDPR analysis is legitimate interest under Art. 6(1)(f) vs. explicit
opt-in consent under Art. 6(1)(a), and which one actually fits your
specific case is exactly the kind of fact-specific call this file explicitly
does not make), switch to `consentMode: 'checkbox'` instead, which renders
an explicit opt-in checkbox and records consent only when a visitor checks
it before abandoning. See `docs/recovery.md` §3 for the full config
walkthrough.

**Relevant concept:** whichever consent mode you choose, this is the
mechanic that determines your **lawful basis for processing** (Art. 6) the
recovery email specifically — the one place in this package where the
choice of mechanic materially changes which legal basis you're relying on,
which is exactly why the choice is yours, not this package's.

### D4a — suppression survives erasure (by design, not by omission)

Once a visitor unsubscribes from recovery emails, their opt-out is permanent
— honored forever, with no re-consent flow and no way for a later abandon to
re-trigger a follow-up, short of that visitor manually resetting their own
browser identity. The suppression record itself (`recovery_suppressions` —
just the visitor UUID and a timestamp, **no personal data beyond the
pseudonymous identifier itself**) is **deliberately excluded** from
`purgeVisitor()`'s erasure cascade below. This is the canonical
suppression-list exception, not an oversight: the visitor's UUID lives in
their own cookie/localStorage, not your database, so it **survives** an
erasure request on your end regardless of what you delete. If the
suppression row were deleted along with everything else on an erasure
request, the very next time that same visitor abandoned a form, the recovery
sweep would have no record they ever opted out — silently re-contacting
someone who explicitly said stop, which is a worse outcome than retaining a
minimal opt-out marker.

**Relevant concept:** this is a **data-minimisation-vs-erasure tradeoff**,
resolved the way industry-standard suppression lists resolve it everywhere
(this is standard, defensible practice, not unique to this package) — the
narrowest possible retained record (UUID + timestamp, nothing else) in
service of honoring an opt-out request permanently, rather than a full
erasure that would silently undo the opt-out on the visitor's next visit.

### `purgeVisitor(visitorUuid)` — the erasure hook

A single function, exported for your own admin/support tooling to call (and
already wired into the admin UI's per-entry "purge" action): given a visitor
UUID, it hard-deletes every entry for that visitor and cascades to their
attached payments and files, all in one transaction — with the D4a
suppression exception immediately above being the one deliberate carve-out.
It is a **hook**, not a self-service portal — this package doesn't know how
a visitor should authenticate a deletion request to you; wiring
`purgeVisitor()` into whatever "delete my data" flow your own site exposes
(a support-email process, a self-service form, whatever fits your
operation) is your integration work.

**Relevant concept:** the **right to erasure** (Art. 17). `purgeVisitor()`
is this package's answer to "how do I actually delete someone's data when
asked" — a real cascading delete, not a soft-flag or a status change.

### `retentionDays` — storage-limitation window

Abandoned entries older than `retentionDays` (config default: **90 days**)
are removed by an opportunistic `purgeExpired()` sweep — the same
lazy-sweep model recovery uses (driven by real request traffic, no cron
job). Submitted/converted entries are not touched by this sweep; it only
prunes abandoned rows that never converted. Configure a shorter or longer
window to match your own privacy policy's stated retention commitment.

**Relevant concept:** **storage limitation** (Art. 5(1)(e)) — data shouldn't
be kept longer than necessary for the purpose it was collected for.
`retentionDays` is the knob that enforces whatever retention period your own
privacy policy commits to for abandoned-but-never-submitted data.

### `requireConsent` — the capture consent gate

When `requireConsent: true` (default `false`), the client-side capture
module stays completely dormant — no cookie written, no localStorage
touched, no network activity begun — until the host page explicitly signals
consent via the client API (`grantConsent()`, or setting
`window.__cafConsent = true` directly). This is a real gate checked before
any data-touching code runs, not a UI-only checkbox that the underlying
capture logic ignores.

**Relevant concept:** this is the mechanic you'd wire up if your chosen
lawful basis for capturing abandonment/journey data at all is **consent**
(Art. 6(1)(a)) rather than another basis — e.g. gating capture behind your
site's existing cookie-consent banner. Whether consent is in fact the
correct basis for your specific capture activity, versus e.g. legitimate
interest, is again the fact-specific legal call this file does not make for
you.

### `journeyParams` — off by default (data minimisation)

The client-side journey trail (above) always strips query strings from
tracked URLs by default (`journeyParams: false`, the config default) — a
tracked page view is just the pathname, with any query parameters dropped
before anything is stored. Setting `journeyParams: true` opts back into
capturing query parameters verbatim, which is occasionally useful for
campaign-attribution analysis but also the mechanic most likely to
accidentally capture something sensitive a visitor put in a URL
(a search term, an email in a magic-link query param, a UTM value someone
hand-crafted with PII in it). The safe default is off.

**Relevant concept:** **data minimisation** (Art. 5(1)(c)) — collect the
least data necessary. Query-stripping by default is this package choosing
the minimal-capture posture out of the box; turning `journeyParams` on is an
explicit, informed choice you make, not something this package defaults
into for you.

## What this file does not cover

- **No jurisdiction-specific lawful-basis determination.** Whether Art.
  6(1)(a) (consent) or Art. 6(1)(f) (legitimate interest) is the right
  basis for any given mechanic above depends on facts about your business,
  your audience, and your specific processing activity that only you (and
  your counsel) can assess.
- **No data processing agreement, no Article 30 records template, no
  cookie-banner implementation, no international-transfer (SCC) guidance.**
  Those are organizational/legal artifacts this package has no visibility
  into and cannot generate on your behalf.
- **No jurisdiction beyond EU/UK/EEA-centric mechanics.** CCPA, PIPEDA, and
  other regimes have their own distinct requirements (a "right to opt out
  of sale," different consent thresholds, etc.) that are not addressed
  here — the mechanics above happen to be broadly reusable, but this file
  makes no claim of coverage beyond describing what they do.

If you need a formal compliance sign-off, treat this file as an engineering
reference for your counsel to review alongside the actual source (every
mechanic above links back to a real, named function or config field you can
go read) — not as a substitute for that review.
