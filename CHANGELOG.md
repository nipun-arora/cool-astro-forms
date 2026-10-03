# Changelog

All notable changes to `cool-astro-forms` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
in spirit. While the package is pre-1.0 (`0.x`), a release that looks like a
small patch bump can still change a default — those changes are called out
below as **BREAKING** rather than held for a 1.0 major.

Entries are newest first.

## [0.1.15] - Unreleased

### Changed

- **BREAKING: Astro 6 is no longer supported. The `astro` peer range is now
  `^7.2.8` (it was `^6.0.0 || ^7.0.0`).** Astro 7.2.8 fixed a critical
  remote code execution in Astro's AVIF image optimization
  ([GHSA-26w7-cxv4-gfx2](https://github.com/advisories/GHSA-26w7-cxv4-gfx2)).
  The last Astro 6 release, 6.4.8, still has that hole and four other Astro
  advisories that were fixed during Astro 7, and Astro 6 pins `sharp` to
  0.34, which has two high severity advisories fixed only in the 0.35 line
  that Astro 7.2.9 requires. A range that still accepted Astro 6 let a site
  install this package on a release with a known code execution hole. The
  package's own code needed no change for Astro 7: the unit, end to end and
  quickstart checks pass on Astro 7.2.9 with `@astrojs/node` 11.1.4.
  - **Upgrading:** move the site to Astro 7.2.8 or a later 7.x release and an
    adapter release built for Astro 7 (for the Node adapter,
    `npm install astro@^7.2.8 @astrojs/node@^11.1.4`), then follow Astro's
    v7 upgrade guide for the site's own code. Your `coolForms()` config does
    not change. With npm 7 or later, installing 0.1.15 next to Astro 6 now
    stops with a peer dependency conflict (`ERESOLVE`) instead of
    installing.
  - **Known:** every Astro 7 release, 7.2.9 included, depends on
    `http-cache-semantics` `^4.2.0`, and its newest release, 4.2.0, has a
    high severity advisory
    ([GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp))
    with no fixed release yet, so `npm audit` still reports it on an Astro 7
    site. Astro imports it only in its build time cache for remote images.

### Fixed

- **Payments made through the admin "Create payment link" flow are now
  marked paid.** The flow creates a Stripe Payment Link and stores the link
  id (`plink_…`), but the Stripe webhook looked payments up only by the
  Checkout Session id (`cs_…`) that the link produces when someone pays. The
  lookup missed, the webhook logged `webhook.unknown-ref` and answered 200,
  and the payment stayed unpaid with no "payment received" email. The
  webhook now falls back to the session's `payment_link` id. Links created
  by earlier versions are matched as well once you upgrade.
  - **Upgrading:** check the Stripe dashboard for payments on admin-created
    links that `/forms-admin/payments` still shows as `link_created`; those
    were paid but never recorded. Mark them by hand or re-send the event
    from the Stripe dashboard after upgrading.
- The admin quote flow no longer hardcodes USD. It uses the new
  `payments.quoteCurrency` (default `'usd'`, so nothing changes unless you
  set it).
- The `recovery` key of a `templatesModule` is now used. It was typed and
  documented but never read, so the default recovery email went out even
  when a host supplied its own.
- `formatMoney` divided every amount by 100. Stripe amounts are in the
  currency's smallest unit, which is 1 for zero-decimal currencies (500 JPY
  is `500`) and 1/1000 for three-decimal ones (KWD, BHD, JOD, OMR, TND), so
  those rendered 100x or 10x off in emails and on the entry page. The admin
  payments table had the same division. Two-decimal currencies, AED
  included, render as before.

### Security

- **The Stripe webhook checks the money before marking a payment paid.** A
  validly signed `checkout.session.completed` used to flip the matched row
  to `paid` on its event type alone. Now the row flips only when the
  session's `payment_status` is `paid` and its `amount_total` and
  `currency` equal the stored row. Anything else is recorded on the
  payment's event log without the paid status and logged as
  `webhook.settlement-mismatch`. No email goes out, and no outbound
  `payment.paid` webhook fires. `checkout.session.async_payment_succeeded`
  is now handled too, so a delayed payment method that completes unpaid
  and settles later is marked paid when it settles.
  - **Upgrading:** if your account offers delayed payment methods, add
    `checkout.session.async_payment_succeeded` to the webhook endpoint's
    events in the Stripe dashboard. Refunds, disputes and expired sessions
    still do not change a payment's status in the admin (known limit).
- Admin-created Stripe Payment Links accept one completed checkout
  (`restrictions.completed_sessions.limit: 1`). Before, a quote link could
  be paid any number of times while the admin showed one amount.
- Under Astro's `security.csp`, the `/forms-admin` pages work: each page
  registers the hash of the admin stylesheet with `Astro.csp`, and the
  entry page's copy-link control runs from a bundled script instead of
  inline `onfocus`/`onclick` attributes and a `style` attribute. Before,
  the policy blocked the stylesheet (every admin page rendered unstyled)
  and the copy button. A host that sets its own CSP header can add the
  exported `ADMIN_STYLE_HASH` to its `style-src`; that one hash covers
  every admin page, the login page included. The login page now renders
  from the shared admin stylesheet like the other admin pages, so it no
  longer carries an Astro-built style block whose hash changed with every
  build. Like the other admin pages, it also stops loading the site's page
  scripts (the `window.__cafConfig` inline script, capture and journey),
  which keeps the login page out of the admin's own browser journey trail.
  Its look is unchanged (computed styles compared before and
  after at desktop and phone widths).
- **Recovery emails link only to your own site.** The "Resume your form"
  link was the page URL sent in the abandon request, unchecked. A script
  outside a browser can send any `Origin` header and, in `auto` consent
  mode, any email address, so it could make the site mail its own recovery
  email to anyone with a link to anywhere, `javascript:` and `data:`
  included. The link is now the abandoned page only when it is an http(s)
  URL on the `siteUrl` origin (a relative path is made absolute against
  `siteUrl`), and `siteUrl` otherwise. The check runs when the email is
  sent, so rows saved before the upgrade are covered, and a host
  `recovery` template receives the checked URL.
- **The admin quote email goes to one valid address or to `notifyTo`.** The
  entry field the quote email is sent to came from the visitor and was only
  trimmed. A comma list sent the quote to every address in it, and a value
  with a line break was read as an address group that delivered only to
  the injected address. A field value that is not a single valid address
  is now skipped, and the quote falls back to the form's `notifyTo` as it
  does when there is no email field.
- The built-in SQLite and Turso adapters write at most one payment row per
  provider reference (`providerRef`). The check and the insert are one
  statement, so two overlapping writes for the same Stripe session leave
  one row instead of a paid row with an unpaid twin.
- The Turnstile loader no longer loads Cloudflare's script on pages without
  a `[data-caf]` form. With both keys set it used to load on every page of
  the site. On a page with no form yet, the loader waits for the first
  `[data-caf]` form to appear (a `client:only` island, a form a script
  inserts, a view-transition navigation) and loads the script then, so a
  form rendered on the client still gets its widget.

### Added

- **Relay-mode email:** `EMAIL_AUTH=ip` sends through an IP-allowlisted
  SMTP relay (Google Workspace SMTP relay is the common case) with only
  `EMAIL_HOST` and `EMAIL_PORT` set. The transport never sends an AUTH
  command in this mode, even if `EMAIL_USER`/`EMAIL_PASS` are still set.
  Port 587 requires STARTTLS (`requireTLS`) and 465 uses implicit TLS.
  Before, a host with no user and password had every package email skipped
  in production. Credential mode (the default) is unchanged.
- **Sender address and name:** the From is `EMAIL_FROM`, then `EMAIL_USER`
  if it is an email address, then `NOTIFY_EMAIL`, then the old
  `noreply@cool-astro-forms.local` fallback. `EMAIL_FROM_NAME` adds a
  display name. When the From domain is not the `siteUrl` domain, the server
  logs one `notify.from-domain-mismatch` warning. `notify.smtp-unconfigured`
  now names the mode whose settings are missing.
  - **Upgrading:** if your environment sets `EMAIL_FROM` (some hosts set it
    for their own mailer), package emails now use it instead of
    `EMAIL_USER`. If `EMAIL_USER` is a username rather than an address (for
    example SendGrid's `apikey`), package emails now come from `EMAIL_FROM`
    or `NOTIFY_EMAIL` rather than that username.
- `createCheckoutForEntry` (from `cool-astro-forms/server`): creates a
  card-only Stripe Checkout Session for an existing entry and records it so
  the webhook can match it. It validates every input and confirms the entry
  exists before it calls Stripe. If the payment row cannot be written, it
  expires the session and returns an error instead of the URL, so a guest
  cannot be charged for a payment the admin does not know about.
  A call that reuses an idempotency key (a double-click, the same quote
  form posted again) gets Stripe's replay of the earlier session. A replay
  never writes a row and never expires the session: it returns the same
  URL when the earlier call recorded it, `replay-unrecorded` when it has
  not (yet), and `storage-error` when the row cannot be read. See
  docs/payments.md section 2a.
- `isAdminRequest(context)` (from `cool-astro-forms/server`): the package's
  admin-session check for a host's own pages and routes under
  `/forms-admin`. Fails closed. The session cookie is scoped to
  `/forms-admin`, so on any other path the browser never sends it and the
  check is always false; the first such call logs one
  `admin.is-admin-request-outside-admin-path` warning.
- `payments.adminQuote`: `'builtin'` (default), `'off'` (no create control,
  no `/forms-admin/payments/action` route), or `{ href }` (a "Create a
  quote" link to the host's own page, with `?entry=<id>` added to the query
  and any `#fragment` kept after it). A path `href`
  must resolve on your own site the way a browser reads it: `/\evil.com`,
  or two slashes with a tab or line break between them, both read as
  `//evil.com` and fail config validation.
- `payments.quoteCurrency`: the admin quote flow's currency (two-decimal
  currencies only; default `'usd'`).
- `escapeHtml`, `formatMoney` and the template types (`CafTemplates` and
  each template's data type) are exported from `cool-astro-forms/server` for
  host templates.

### Internal

- New contract test runs a signed Stripe event through the real webhook
  route, the real payment handler and real SQLite: a session created with
  `createCheckoutForEntry` is marked paid, a wrong amount is not, and a row
  keyed by a Payment Link id is matched through the session it produced.
- New SMTP-sink tests drive the real nodemailer transport over a socket and
  check the wire: no AUTH command in relay mode, the expected `MAIL FROM`
  and From header for both the abandoned-lead and payment-received emails.
- New e2e spec on a production build with `security.csp` on: every admin
  page, the "Create payment link" flow and the copy control, with zero
  `securitypolicyviolation` events. A second case swaps in a hand-written
  header that lists only `ADMIN_STYLE_HASH` and checks that the login page
  and the list views stay styled with zero violations.
- The middleware bridges `CAF_SITE_URL` from `siteUrl` (for the From-domain
  check), and the integration bakes `cspEnabled` into the virtual config.
- The playground and the quickstart check run on Astro 7.2.9 with
  `@astrojs/node` 11.1.4 (were 6.4.8 and 10.1.x). The refreshed lockfile
  also clears the svgo, js-yaml, smol-toml, postcss, nanoid and devalue
  advisories the old Astro 6 tree carried (`devalue` moves to 5.9.4).
- Astro 7's `astro dev` keeps a per project lock file and, under a coding
  agent, detaches into the background. The Playwright config now starts each
  playground dev instance with `--ignore-lock` and `ASTRO_DEV_BACKGROUND=1`
  so the suite's seven dev servers still run side by side in the
  foreground.

## [0.1.14] - 2026-10-03

### Security

- The admin CSV export (`/forms-admin/export.csv`) now neutralizes every
  spreadsheet formula trigger in the OWASP CSV Injection list. Nearly every
  cell in that file comes from a visitor: field values and field names from
  an abandoned draft, plus the `User-Agent` and `Referer` headers. Up to
  0.1.13 the export put a `'` in front of a cell only when it started with
  `=`, `+`, `-` or `@`, and quoted a cell only when it held a comma, a
  double quote or a line feed. That left two gaps:
  - A value starting with a tab, a carriage return or a line feed went out
    without the `'` prefix.
  - A bare carriage return inside a value went out unquoted. Spreadsheet
    importers can treat a bare carriage return as a row break, so a value
    such as `Thanks` + CR + `=HYPERLINK(...)` could open as a new row whose
    first cell was a live formula.

  A cell that starts with `=`, `+`, `-`, `@`, a tab, a carriage return or a
  line feed now gets the `'` prefix, and a cell that contains a comma, a
  double quote, a carriage return or a line feed is quoted with its inner
  quotes doubled. Field names in the header row get the same treatment.
  - **Upgrading:** nothing to change in your config or code, and ordinary
    values export exactly as before. CSV files exported by an earlier
    version can still carry a live formula: open old exports in a text
    editor, or import them with formula evaluation turned off, instead of
    double-clicking them.
- Every `/forms-admin/*` response now carries `Cache-Control: no-store,
  private` and `X-Content-Type-Options: nosniff`: the admin pages, the
  entry and payment actions, the login page and auth POST (including a
  failed login), both exports, the session guard's redirect to the login
  page, and error responses. Before this, the package set no caching
  headers at all, so a CDN that caches by file extension (Cloudflare caches
  `.csv` by default) could store an authenticated `export.csv` and serve it
  to the next visitor who requested that URL. Both exports already sent
  `Content-Disposition: attachment` and still do. The package's own
  middleware sets the headers, so no host configuration is needed.
  - **Upgrading:** nothing to change. If your CDN or proxy has a rule that
    forces caching and ignores origin `Cache-Control` (for example a
    "cache everything" rule with an edge TTL override), exclude
    `/forms-admin/*` from it, and purge any cached `/forms-admin/` URLs
    once after upgrading.

### Internal

- The SQLite and Turso adapters each kept their own copy of the CSV cell
  encoder. Both now import one shared `server/storage/csv.ts`, and the
  export's injection tests moved into the shared adapter contract, so both
  backends run the same cases. One of them parses the export the way a
  spreadsheet splits rows and checks that no cell begins with a formula
  trigger.

## [0.1.13] - 2026-10-01

### Security

- `nodemailer` raised from `^9.0.3` to `^10.0.13`. A fresh install of
  0.1.12 resolved `^9.0.3` to 9.1.1, which `npm audit` flags with two HIGH
  and three moderate advisories, all fixed by 10.0.13:
  - GHSA-v53p-9fqp-m79j (high): quadratic backtracking in the address
    parser's free-text fallback lets one long header value stall the event
    loop.
  - GHSA-prgh-xp8r-p3m5 (high): quadratic parsing of comment-joined
    addresses, same denial-of-service shape.
  - GHSA-g57g-f23g-4646 (moderate): a comment after the domain of a
    quoted local part produced a malformed envelope recipient.
  - GHSA-8vvx-rff5-p5rq (moderate): deeply nested recipient arrays
    bypassed the parser's depth limit and exhausted the stack.
  - GHSA-6vj9-mwq6-2f5v (moderate): the process-wide DNS cache reused one
    transport's TLS `servername` for another transport on the same host.
  The 9.0.3 copy pinned in this repo's own lockfile carried four further
  advisories fixed in 9.1.x (GHSA-2x7j-588g-ccc2 high, GHSA-8m3c-c648-2xjj,
  GHSA-wmmp-3585-3rmp, GHSA-cc9r-2j5m-2m83); 10.0.13 clears those too.
  - **Upgrading:** nothing to change in your config or code. If your site
    also lists `nodemailer` as its own dependency, bump that to
    `^10.0.13` as well; `npm audit` reports your copy separately from the
    one this package installs.

### Changed

- nodemailer 10 requires Node 20 or newer. This package already requires
  Node 22.12.0, so the supported runtime does not change.
- nodemailer 10 ships its own TypeScript declarations, so the
  `@types/nodemailer` dev dependency is gone. The package's emitted
  `server/notify.d.ts` still imports the `Transporter` type from
  `nodemailer`, which now resolves to those bundled declarations.

### Internal

- New `notify.test.ts` cases pin the exact `createTransport` options
  (SMTP and the `jsonTransport` fallback), the exact `sendMail` fields for
  all four package emails, the untouched return value, the rethrown error
  and failure log line, a refused SMTP connection settling as a rejection,
  and a real `jsonTransport` round trip. All passed on 9.0.3 before the
  bump and on 10.0.13 after it; `notify.ts` did not change.

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
