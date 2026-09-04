# Changelog

All notable changes to `cool-astro-forms` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
in spirit. While the package is pre-1.0 (`0.x`), a release that looks like a
small patch bump can still change a default — those changes are called out
below as **BREAKING** rather than held for a 1.0 major.

Entries are newest first.

## [0.1.12] - 2026-09-04

### Changed

- **BREAKING: the `fee` selector on `/forms-pay` / `create-session` is now
  host opt-in.** New `payments.feeOverrides: 'off' | 'query'`, default
  `'off'`. Previously the pay page forwarded `?fee=` from its URL as a
  hidden form field and the server read `fee` from that same POSTed body:
  `fee=0` waived the configured `payLinkFees` and `fee=<key>` selected a
  `feePresets` entry — for any payer, not just the operator sharing the
  link. In `'off'` mode a `fee` field in the request or the page URL is now
  ignored and the configured `payLinkFees` are always charged; the pay page
  stops rendering the hidden `fee` input.
  - **Upgrading:** if you have already shared a `?fee=0` or `?fee=<preset>`
    link and depend on it waiving or swapping fees, set
    `feeOverrides: 'query'` to keep that link working — and know that doing
    so also lets a payer post the same field on their own. If you had
    blocked the `fee` field in your own reverse proxy or Express wrapper as
    a workaround, you can drop that guard once you're on 0.1.12 with the
    default `'off'`.

### Fixed

- Abandonment capture spent the page's single-use Turnstile token on every
  send, so a host gating its own submit endpoint with `verifyTurnstile`
  could answer a genuine visitor with `timeout-or-duplicate`. Capture now
  drops the token after a token-carrying send, and the loader resets every
  rendered widget so it re-solves for the visitor's real submit.
- `TURNSTILE_SITE_KEY` set without `TURNSTILE_SECRET_KEY` now also warns
  from the payment-request route (`routes/pay/create-session`), matching
  the existing abandon-route and build-time warnings. Previously the pay
  page rendered a live Turnstile widget while the endpoint's hard gate was
  silently inert.

### Added

- `verifyTurnstile` now returns a machine-readable `outcome`: `verified` |
  `rejected` | `skipped` | `unreachable`.
- `payment-request.fee-override-ignored` structured log event, emitted when
  a `fee` field arrives while `feeOverrides` is `'off'` — the request is
  never rejected, it proceeds at the configured price.
- Tests pinning the honeypot field's name, label, and `autocomplete="off"`
  against browser autofill.
- This changelog.

### Internal

- The Playwright pay-page spec's no-token assertion now expects the
  `code: 'missing-input-response'` field the 403 body has carried since
  0.1.9/0.1.10; the spec had been red on that one case since then.

## [0.1.11] - 2026-07-22

- Launch prep: "the lead-ops platform for Astro forms" positioning locked
  across `package.json`, both READMEs, and the social preview image;
  README overhaul (production-proof line, Hardened-in-production section,
  honest-claims fixes); `SECURITY.md` and GitHub issue templates added.
- Fixed: the abandon path stored the raw `_caf` transport envelope inside
  every saved entry's fields, visible in the admin and notification
  emails; now stripped before storage like `recordSubmission()` already
  did.
- Fixed: a notify test connected to a remote SMTP host that could
  black-hole on filtered networks instead of refusing instantly; now
  points at a local closed port.

## [0.1.10] - 2026-07-21

- Root cause of a multi-release production payment saga: edge
  bot-challenges cannot complete on a navigation POST. `create-session` now
  answers fetch clients `200 {ok:true, url}` and performs the checkout hop
  as a plain GET; native form submit remains the no-JS fallback.

## [0.1.9] - 2026-07-21

- Empty-token Turnstile rejections now short-circuit with a
  `missing-input-response` code instead of none; pay-page submit buttons
  are token-gated so a visitor can't click before the widget solves.

## [0.1.8] - 2026-07-21

- The Turnstile-reject redirect now carries Cloudflare's sanitized
  `?code=` query param, so the visitor's own URL is a diagnostic on hosts
  where application logs get wiped on every git-deploy release.

## [0.1.7] - 2026-07-21

- The reject redirect honors a same-origin `Referer`, so a host running its
  own branded pay page keeps working correctly; pay-page copy cleaned up.

## [0.1.6] - 2026-07-21

- `remoteip` is no longer sent to Turnstile's siteverify call (dual-stack
  visitors can solve the challenge on one IP family and post the form on
  another, causing false rejects); the reject log now carries Cloudflare's
  own `error-codes`.

## [0.1.5] - 2026-07-21

- Turnstile token-expiry recovery: a rejected payment now redirects back to
  the pay page with the error and amount preserved, a refreshed widget, and
  a one-click retry, instead of a raw JSON dead end.

## [0.1.4] - 2026-07-20

- The server journey recompute now preserves the `external` referrer-seed
  step (and its origin) instead of dropping it, so traffic source survives
  into stored entries and both notification emails.

## [0.1.3] - 2026-07-20

- `recordSubmission()`'s ok-result now returns `journey`/`geo` so a host's
  notification email can render them; fixed a staging bug where every
  unchecked radio/checkbox was read as if it were checked.

## [0.1.2] - 2026-07-19

- Added a package-level README with absolute URLs, since the npm listing
  page had none.

## [0.1.1] - 2026-07-18

- First npm publish.
