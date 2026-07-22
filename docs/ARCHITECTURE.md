# ARCHITECTURE — as built (Phases 1-4; see the 0.1.2-0.1.10 addendum at the end for post-launch deltas)

> What actually exists in `packages/astro-forms/src` and how it fits together. Written 2026-07-17; Phase 4 (Drive + lead recovery) delta appended same day.
> Status: published to npm as `cool-astro-forms@0.1.1`.

## System shape

```
HOST ASTRO SITE (output:'server', @astrojs/node middleware, optional Express/Passenger wrapper)
│
├─ astro.config.mjs: coolForms({ siteId, siteUrl, forms, geo?, admin?, payments?… })
│    └─ integration.ts @ astro:config:setup
│        ├─ injectScript('head-inline', window.__cafConfig = <public subset>)   ← BEFORE modules (consent ordering)
│        │    (Phase 4: recovery{enabled,consentMode,disabledForms?} rides this subset ONLY when
│        │     recoveryActive; 04-10 appends `disabledForms` (per-form-off form ids, via
│        │     recoveryDisabledFormIds()) ONLY when non-empty — the no-override wire shape stays
│        │     byte-identical. Drive has NO field here at all — server-side only.)
│        ├─ injectScript('page', import capture.js / journey.js / turnstile-loader.js when keys)
│        ├─ injectRoute: /api/forms/abandon · /api/forms/started · /api/forms/canary
│        │              /forms-admin(+login/auth/entries/abandoned/payments/analytics/entry/[id]/entry-action/export.csv/export.db)
│        │              Phase 3 adds: /forms-pay(+success/paypal-return) · /api/forms/webhooks/{stripe,paypal} · payment-action
│        │              Phase 4 adds (config-gated, NOT env-gated — recovery.enabled IS the switch):
│        │                /api/forms/recovery-unsubscribe (only when recovery.enabled)
│        ├─ addMiddleware(order:'pre') → registerRuntimeConfig (CAF_DB_PATH, CAF_GEO_*, CAF_DRIVE_* bridge, boot purgeExpired)
│        │                              + admin session guard (exact-segment /forms-admin matcher)
│        │                              + Phase 4: maybeRunRecoverySweep (fire-and-forget, self-gated, every request)
│        └─ vite plugin: virtual:cool-astro-forms/config = resolved config + trailingSlash (+ templatesModule import)
│
├─ CLIENT (zero-dep, gzip budget 5120B asserted in tests: capture.js + journey.js transitive closure)
│    capture.ts  — stage fields on input/change (denylist: password/[data-caf-ignore]/csrf|token|card|cvv|ssn;
│                  FIELD_MAX_BYTES cap); 4 abandon triggers (exit-intent top, leaving-link, beforeunload,
│                  visibilitychange→hidden); sendBeacon → fetch keepalive fallback; 10s throttle;
│                  64KB ceiling → minimal-payload fallback; _caf envelope hidden input at submit
│                  (JSON {journey}); lastField tracking; sendFormStarted once per visitor+form
│                  (memory flag + localStorage guard); endpoint URLs from __cafConfig
│                  (abandonEndpoint/startedEndpoint — trailingSlash-computed, NEVER hardcoded);
│                  window.caf = { submitted(formId?), consentGranted() }; init at module load AND
│                  idempotent astro:page-load rebind (View Transitions)
│    journey.ts  — localStorage trail {url query-stripped, title, ts}; params dropped unless journeyParams;
│                  consecutive-URL dedupe; external-referrer seed; caps 100/10KB/1yr (limits.ts, both sides);
│                  safeRead/safeWrite try/catch → in-memory fallback (Safari private throws)
│    visitor.ts  — _caf_uid cookie (1yr, SameSite=Lax) + localStorage mirror w/ cookie restore;
│                  requireConsent keeps everything dormant until caf.consentGranted()
│    turnstile-loader.ts — injected only when keys; attaches token to abandon payload
│    recovery-widget.ts (Phase 4) — SEPARATE chunk (own gzip closure, excluded from the
│                  capture+journey budget), injected only when recovery.enabled; binds a
│                  caf:recovery-saved listener → "progress saved" toast (idempotent), and in
│                  consentMode:'checkbox' injects the opt-in checkbox on every [data-caf] form
│                  EXCEPT those listed in __cafConfig.recovery.disabledForms (04-10 per-form
│                  gap closure — checked per form before injectCheckbox()), wired to
│                  capture.ts's setRecoveryConsent(); capture.ts's attemptSend() itself
│                  switches transport from sendBeacon-first transmit() to a fetch-that-
│                  reads-{saved} transmitReadingSaved() ONLY when recoveryActive — the
│                  ONE eng lock (RCV-01): the toast must ride a real confirmed response,
│                  never a fire-and-forget beacon. A keys/config-off site never flips
│                  recoveryActive, keeping sendBeacon byte-identical to Phase 3.
│                  04-10: bindForm() computes recoveryActive PER FORM —
│                  `config.recovery?.enabled === true && !config.recovery.disabledForms
│                  ?.includes(formId)` — so a form listed in __cafConfig.recovery
│                  .disabledForms never switches transport even on a recovery-active site;
│                  the toast/checkbox correctly stay silent for that one form.
│
├─ SERVER
│    handlers/handle-abandon.ts — pipeline: origin → Content-Length precheck → readBodyCapped (streaming) →
│         rate limit → honeypot(204) → zod parse → gate (email-or-phone | always) → COOKIE-authoritative
│         visitorUuid → recomputeJourney (ts sanitize, caps, privacy, ServerJourneyStep durations) →
│         upsertAbandoned (atomic, site-scoped, already-converted no-op) → geo (never-blocks try/catch) →
│         verifyToken seam (Turnstile soft-log → _turnstile:'failed' flag persisted) →
│         fire-and-forget notify (create-only unless notifyOnUpdate) + purgeExpired (hourly, .catch) →
│         { saved, reason } + per-branch structured logs
│    record-submission.ts — NEVER-throws host hook: reads/strips fields._caf envelope, cookie visitorUuid,
│         optional ip arg (clientAddress; XFF fallback), geo default from runtime config,
│         convertAndCreateSubmitted (atomic, converts ALL matches within CONVERT_LOOKBACK_MS), repeat-submit log
│    geo/ — lookupGeo (ipwhois.io default, provider URL template config, 3s AbortSignal, private-IP skip)
│    notify.ts + templates.ts — nodemailer SMTP (EMAIL_HOST/PORT/USER/PASS), 5s timeouts, jsonTransport
│         outside prod (loud log if unconfigured in prod), escapeHtml everywhere, exported render helpers
│         (journey timeline/fields/geo line), templatesModule override seam (Phase 3: + paymentQuote/paymentReceived)
│    security/ — origin-check (full URL.origin, hard-reject mismatched Origin, Referer only when Origin absent),
│         size-cap (precheck + readBodyCapped + backstop), rate-limit (token bucket, TTL eviction, reset hook),
│         honeypot (_caf_hp), constant-time-compare (empty-buffer guard!), admin-session (HMAC, 7-day;
│         the session cookie's Secure flag is derived from the actual request — the request's own URL
│         protocol first, then a validated single-value X-Forwarded-Proto header for deployments that
│         terminate TLS at a reverse proxy — OR'd with NODE_ENV==='production', so a non-production HTTPS
│         deploy still gets a Secure cookie instead of relying on NODE_ENV alone), admin-secret (the
│         auto-generated HMAC signing key, when no explicit secret env var is set, is persisted to disk
│         owner-only — file mode 0600 — rather than under the process's default umask), turnstile.ts
│         (siteverify, never-throws)
│    admin/ — raw-source .astro pages (login/entries/abandoned/payments/analytics/entry-detail) + _shared.ts
│         (adminUrl(path, trailingSlash) — extension-segment exempt; parseEntryFilter; render helpers;
│         analytics panel HTML built in .ts, working around an Astro compiler bug)
│    routes/ — thin Astro APIRoute wrappers; admin/export-csv (strips pagination limit — full dump),
│         admin/export-db (better-sqlite3 db.backup snapshot), canary (Bearer CANARY_TOKEN, timingSafeEqual,
│         aggregate only), form-started (idempotent); Phase 4: recovery-unsubscribe (public GET, HMAC
│         token, no login, INSERT OR IGNORE idempotent, constant 400 on any invalid/forged/malformed token —
│         never enumerates visitors)
│    drive/ (Phase 4, DRV-01/DRV-02) — raw Drive v3 REST via `fetch`, NO googleapis SDK (D5, 207MB rejected):
│         drive.ts (refreshAccessToken — OAuth refresh-token exchange, ~50min in-process token cache;
│         resolveFolderId — list-then-create idempotent folder resolution, root/siteId/month levels cached,
│         entryId level never cached; uploadFile — <=5MiB multipart / >5MiB single-shot resumable, 3 retries
│         w/ [1000,2000]ms backoff; grantPermission — 'anyone'-reader grant, non-fatal on failure;
│         uploadFilesToDrive — the ONE orchestrator entrypoint, inert without GOOGLE_DRIVE_* env, NEVER
│         throws — every failure mode degrades to a per-file fallback outcome, DRV-02) · folder-path.ts
│         (buildFolderPath UTC YYYY-MM segments, escapeQueryValue, sanitizeName — traversal/control-char
│         neutralization). EVERY fetch carries `AbortSignal.timeout` (10s meta calls, 120s upload bodies) —
│         a stalled TCP connection never throws on its own, so without the abort the retry/fallback path can
│         never be reached and `recordSubmission` (AWAITED by the host's submit endpoint) would hang the
│         visitor's own response indefinitely.
│    recovery/ (Phase 4, RCV-01/D3/D4) — sweep.ts (`runRecoverySweep` — claims via `markRecoverySent`
│         BEFORE sending, BEGIN-IMMEDIATE atomic, so a concurrent/recycled-process race can never double-send;
│         `maybeRunRecoverySweep` — the lazy, per-process-gated, request-traffic-driven entrypoint,
│         RECOVERY_SWEEP_INTERVAL_MS=15min throttle, deliberately NOT `setTimeout` — Passenger recycles idle
│         workers, a timer-based schedule would be silently dropped) · unsubscribe-token.ts (D4 one-click
│         HMAC token over the visitor UUID ONLY, never the email — reuses the ONE hmacHex/tokensMatch
│         convention, webhooks/sign.ts's scheme, not a second signing scheme)
│    scripts/get-drive-token.mjs (Phase 4, dev-time only, never imported by any server route) — one-time
│         OAuth loopback-redirect consent CLI (OOB flow is dead since Jan 2023); prints the D6
│         Testing→Production 7-day-silent-expiry warning + the drive.file hand-created-folder pitfall
│    storage/ — StorageAdapter (ASYNC interface — Postgres/Turso portability locked at review):
│         createEntry/updateEntry/findAbandoned(siteId,…)/upsertAbandoned/convertAndCreateSubmitted/
│         listEntries(filter+limit/offset)/countEntries/getEntryById/deleteEntry/attachPayment/attachFiles/
│         exportCsv(formula-injection-escaped)/purgeVisitor(cascades, Phase 4: EXCLUDES recovery_suppressions —
│         D4a)/purgeExpired/recordFormStart/getFunnel/getTopDropOff (Phase 3 adds payment CRUD +
│         appendPaymentEventIfAbsent; Phase 4 adds getFilesByEntry/findRecoverableEntries/markConsent/
│         markRecoverySent(atomic claim)/suppressRecovery/isRecoverySuppressed)
│         SqliteStorage: WAL + busy_timeout, BEGIN IMMEDIATE transactions, prepared statements only,
│         additive-only user_version migrations + boot guard (newer-schema refuses) + prod pre-migration
│         VACUUM INTO backup (retain 3, apostrophe-escaped path), journal_mode logged at boot
│         Schema: entries (site_id, form_id, status CHECK[abandoned/submitted/converted/spam], fields/geo/
│         journey JSON, visitor_uuid, ip, ua, last_field, page_url, referrer, timestamps; Phase 4:
│         consent_at/recovery_sent_at (v4 migration, additive); dedupe idx site+visitor+form+status+updated,
│         status_created idx, Phase 4: idx_entries_recovery) · payments (entry_id NOT NULL, provider,
│         amount_cents, currency, status CHECK, pay_link_url, provider_ids/events JSON; Phase 3: provider_ref idx)
│         · files (Phase 4: real upload records — filename/sizeBytes/mime/storage[drive|email-only]/
│         driveFileId/driveLink, populated by attachFiles from recordSubmission's Drive outcome) ·
│         form_starts (unique visitor+form+site) · recovery_suppressions (Phase 4, v4 — visitor_uuid +
│         timestamp ONLY, no personal data; EXCLUDED from purgeVisitor's cascade — D4a)
│    log.ts — one-line JSON structured logger (stdout; Passenger captures); every reject/error branch logs
│
└─ DATA data/forms.db (gitignored; Hostinger git-deploys preserve the dir)
```

## Conventions that MUST hold (enforced by tests/reviews; breaking any of these has failed review before)

1. **Every client-visible URL is computed, never hardcoded** — trailingSlash from Astro config threads through `__cafConfig.abandonEndpoint`/`startedEndpoint`, `adminUrl()`, and (Phase 3) handler-computed provider success/cancel/return URLs. Extension-segment routes (`export.csv`) are exempt (Astro matches them slashless even on 'always').
2. **Every injected route/page needs its own `package.json` exports entry WITH the `"default"` condition** (+ tsup entry for .ts, or raw-source `files` inclusion for .astro). Astro resolves entrypoints via CJS `require.resolve`.
3. **Shared constants live in `limits.ts`/`types.ts`** — mirrored literals across client/server are forbidden (caught drifting once).
4. **Provider/IO calls behind injected deps** (`deps.geo`, `deps.notify`, `deps.verifyToken`, Phase 3 `deps.stripe/paypal`) — unit tests are network-free; every dep invocation is try/catch-guarded (a rejecting dep must never break a save).
5. **Webhook routes read the RAW body first** (`await request.text()`), verify signatures before ANY state change, and idempotency state lives in the DB.
6. **escapeHtml on every user-supplied value rendered anywhere** (emails + admin). Flags render as fixed labels on strict equality, never raw values.
7. **Optional modules are inert without keys** — byte-identical behavior, proven by dedicated tests incl. secret-substring leak checks.
8. **Additive-only migrations** — never rename/drop; boot guard refuses newer-schema DBs; git revert does NOT undo a migration (runbook in Phase-1 plans).
9. **Money math**: server recomputes everything from base amount; client totals are structurally unrepresentable in schemas; amounts parse via strict regexes (`amount` dollars `/^\d+(\.\d{1,2})?$/`, legacy `pay` cents `/^\d+$/`); Math.round for fee cents.
10. **Synthetic `_payment_request` entries are excluded from funnel analytics** (`PAYMENT_REQUEST_FORM_ID` constant) and default-hidden in the Entries view behind a chip.
11. **Phase 4: recovery is CONFIG-gated, not env-gated** — the ONE exception to "optional modules gate on a provider env key" (convention 7): recovery has no external provider, so `config.recovery.enabled` (read straight from the validated `CoolFormsConfig`, not `process.env`) is the injection gate in `integration.ts`. Drive stays env-gated as usual (`GOOGLE_DRIVE_*`), consistent with every other provider.
12. **DRV-02 is a hard, tested guarantee**: every Drive failure mode (auth fail, non-2xx, network throw, stall/timeout, oversize, keys-absent) degrades to a per-file fallback outcome with the submission entry STILL created — proven at the orchestrator level (`drive.test.ts`), the host-contract level (`record-submission.test.ts`), and the e2e level (`drive-upload.spec.ts`, mock-500 variant) — three independent layers, not one.
13. **The package sends NO new email on the real-submission path** (D1) — `recordSubmission()` only RETURNS a `FileUploadOutcome[]` for the host's own email code to branch on. The abandon and payment paths remain the only package-owned sends, plus Phase 4 adds exactly one more: the recovery follow-up (targets the VISITOR, `data.to`, the first package email that does NOT target `notifyTo`).
14. **04-10 gap closure: recovery is ALSO per-form-scoped**, not just site-wide — an optional `forms.<id>.recovery.enabled` override, resolved by the ONE shared `server/recovery/resolve.ts` (`recoveryEnabledForForm`/`recoveryDisabledFormIds`) every consumer (handle-abandon.ts consent gate, sweep.ts eligibility filter, capture.ts transport seam, recovery-widget.ts checkbox gating, integration.ts's public-config subset) imports rather than hand-rolling. The site-wide switch (convention 11) stays the hard gate: per-form `true` can never turn recovery on when the site switch is off. A disabled form's sweep rows are skipped WITHOUT burning the atomic claim (no new migration).

## Config surface (zod, `config.ts`)

`siteId`* · `siteUrl`* (z.url) · `forms{ id: { abandonment{ require: 'email-or-phone'|'always', dedupeWindowMins=60, notifyOnUpdate=false }, notifyTo, recovery?{ enabled? } (04-10, optional per-form override — ABSENT inherits the site-wide switch) } }` · `requireConsent=false` · `journeyParams=false` · `retentionDays=90` · `dbPath` (also CAF_DB_PATH) · `geo{ enabled, provider template, timeoutMs }` · `admin{ sessionTtlDays=7 }` · capture allow/deny lists · `templatesModule` (path, imported via virtual module) · Phase 3: `payments{ payLinkFees[{label,percent|flat_cents}], minAmountCents, maxAmountCents, currencies=['usd'], requestPage }`, `webhooks{ urls, secret }` · Phase 4: `drive{ linkAccess='private'|'anyone', rootFolderName='cool-astro-forms', attachmentFallbackMaxBytes=10485760 }`, `recovery{ enabled=false, delayMins=60, consentMode='auto'|'checkbox' }` (site-wide switch, unchanged by 04-10).
Env: `EMAIL_*` (SMTP), `FORMS_ADMIN_PASSWORD`, `CANARY_TOKEN`, `TURNSTILE_SITE_KEY/SECRET_KEY`, `CAF_DB_PATH`, `CAF_GEO_*`, Phase 3 `STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET/PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET/PAYPAL_ENV/CAF_WEBHOOK_SECRET`, Phase 4 `GOOGLE_DRIVE_CLIENT_ID/GOOGLE_DRIVE_CLIENT_SECRET/GOOGLE_DRIVE_REFRESH_TOKEN` (all three-or-none — `driveConfigured()` gate) + the middleware-bridged `CAF_DRIVE_LINK_ACCESS/CAF_DRIVE_ROOT_FOLDER/CAF_DRIVE_FALLBACK_MAX_BYTES` (W1 contract, not host-set directly) + test-only `GOOGLE_DRIVE_API_BASE_URL/GOOGLE_OAUTH_TOKEN_URL` (mock e2e seam, generalizes `STRIPE_API_BASE_URL`).

## Test architecture

- Unit/contract: vitest in-package (`getViteConfig`), jsdom for client, jsonTransport for email, mocked fetch for geo/turnstile/providers/Drive, backend-agnostic `adapter.contract.ts` reused by any future StorageAdapter (ADPT-01).
- E2E: Playwright at repo root, `workers:1`, desktop + Pixel-7 projects, DEDICATED PORTS (4324 admin, 4325 default, PAY instances 4326/4327 Phase 3, RECOVERY_URL 4328 Phase 4; never 4321 — collides with local dev servers), local non-Astro mock servers on their own fixed ports (STRIPE_MOCK 4390, WEBHOOK_RECEIVER 4391, DRIVE_MOCK 4393 Phase 4 — carries BOTH the OAuth token endpoint and the Drive v3 REST surface), per-spec reset via DEV-only `/api/debug-entries?action=reset` (also resets rate limiter + notify health), Phase 4 adds `/api/debug-recovery` (DEV/localhost-gated: `?action=sweep` calls the REAL `runRecoverySweep` directly with an advanced `now` — bypassing the module-level throttle entirely rather than waiting a real 60 minutes; `?action=unsubscribe-url` mints a signed token without running a sweep, isolating the D4a suppression exclusion from the separate "already sent" exclusion), dummy Turnstile keys against real Cloudflare, TRAILING_SLASH env-driven playground instance for 'always'-shape drills.
- Built-artifact smoke: `smoke:built` boots `astro build` output through the real Express wrapper (`server.mjs`) — a real Passenger/Express production shape.
- Gzip budget test resolves the real transitive dist closure (not entry shims): ≤5376B (capture+journey only — `recovery-widget.js` is a separate chunk, excluded; raised from 5120B in 04-07 for the recovery seam, measured 5257B after 04-10's per-form scoping, 119B headroom).

## Vendoring as a local tarball (pre-npm-publish workflow)

Before this package is published to npm, an adopting site can still take it as a dependency by vendoring a built tarball: `npm pack -w packages/astro-forms` produces `cool-astro-forms-<version>.tgz`, which a consumer checks into its own `vendor/` directory and installs with a `file:` dependency (e.g. `"cool-astro-forms": "file:vendor/cool-astro-forms-<version>.tgz"`) instead of a registry version. Upgrading means re-running `npm pack`, replacing the vendored tarball, and bumping the `file:` reference — the same integration surface (`coolForms()` config, `data-caf` tagging, `window.caf.submitted()`, `recordSubmission()`) applies whether the package is installed from a tarball or from npm.

## Phase 4 playground demo (Drive + lead recovery)

`apps/playground/astro.config.mjs` carries the `drive{}` VALUE knobs unconditionally (Drive activation is env-gated, `GOOGLE_DRIVE_*`, so the subtree's mere presence is inert everywhere else) but `recovery.enabled` reads `process.env.CAF_E2E_RECOVERY_ENABLED` — the ONE deviation from a literal `enabled:true`, because unlike Drive, `recovery.enabled` IS the activation switch itself (convention 11 above); hardcoding it true would have turned the widget/route/consent-write on for every OTHER dedicated e2e instance sharing the same config file (Turnstile/Admin/Payments), not just the one meant to demo it. Only `playwright.config.ts`'s dedicated `RECOVERY_URL` (4328) instance sets that env var. `apps/playground/src/pages/api/demo-submit.ts` (DEV/localhost-gated, never shipped) is the host-adoption reference for the `FileInput[]`→`recordSubmission()`→`FileUploadOutcome[]` contract a real site's own submit endpoint implements — mirrors `upload.ts`'s shape but adds real file bytes. `apps/playground/src/pages/api/debug-recovery.ts` is the DEV-only seam that makes the lazy, request-traffic-driven sweep observable inside a fast e2e run without a real 60-minute wait (see Test architecture above).

## Post-launch addendum (0.1.2 - 0.1.10, 2026-07-20/21)

Shipped against live production findings on the second consumer, one release per finding across 0.1.2-0.1.10. The architectural deltas over the Phases 1-4 text above:

- **recordSubmission enrichment return**: the ok-result now carries `journey?: ServerJourneyStep[]` and `geo?: Geo` (absent-when-empty, matching the optional `files` convention) so a host's own notification email renders the trail, source, and location with one read. The server journey recompute preserves the client's `external` referrer-seed step (flag + origin) instead of privacy-stripping it — that step IS the traffic source.
- **Client staging is checked-state-aware**: unchecked radios and checkboxes never stage their static `value` attribute (the checked radio wins its group; unchecked means absent).
- **Turnstile posture, fully evolved**: `remoteip` is not sent to siteverify (dual-stack visitors solve on one IP family and post on the other); every rejection carries Cloudflare's error code (short-circuited absent tokens synthesize `missing-input-response`); rejections on the payment route are recoverable for browsers (redirect back to the ORIGINATING page via same-origin Referer with `error`/`amount`/`code` in the query) and diagnosable for fetch clients (`code` in the JSON body); widgets pin `refresh-expired:'auto'`; submit buttons are token-gated on presence-not-shape.
- **Payment transports**: create-session is dual-dialect — `200 {ok:true,url}` for `Accept: application/json`, `302 Location` for navigations. The pay page submits over fetch and hops to checkout as a plain GET; native submit is the no-JS fallback. Edge bot-challenges structurally cannot complete on navigation POSTs; this transport is immune (docs/payments.md 3b).
- **Host deployment contracts hardened**: proxy-fronted hosts need `security.allowedDomains` (Astro only trusts X-Forwarded-Proto when it is non-empty; without it every urlencoded POST dies in Astro's CSRF origin check) — README quickstart + how-it-works carry the snippet; git-deploy hosts rebuild the app dir per release, so `dbPath` must point OUTSIDE the deploy directory (serverless.md; the package mkdirs the target and the admin-secret file follows `dbPath`).
- **templatesModule proven in production**: a host module default-exporting `{abandonedLead: NotifyTemplateFn}` fully rebrands the abandoned-lead email; the seam resolves via the emitted virtual config module with a project-root-absolute specifier.
