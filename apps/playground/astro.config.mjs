import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import coolForms from 'cool-astro-forms';

// The playground mirrors a typical shared-hosting target shape (Phusion Passenger,
// RESEARCH.md A2): output:'server' + @astrojs/node in 'middleware' mode,
// wrapped by a minimal Express server (server.mjs) for the smoke:built
// script. `astro dev` still serves normally for local development and the
// Playwright webServer (playwright.config.ts).
//
// The dev server port is env-driven (PORT, default 4321 — mirrors
// server.mjs's own `process.env.PORT ?? 4321` convention) so the Playwright
// turnstile e2e (tests/turnstile.spec.ts) can spin up dedicated
// ALWAYS-PASS/ALWAYS-FAIL playground instances on their own ports without
// touching the default instance every other spec targets.
const port = Number(process.env.PORT ?? 4321);

// trailingSlash is env-driven (Plan 09, checker B1) — mirrors the PORT
// convention above so a dedicated Playwright instance can run a
// trailingSlash:'always' mode (playwright.config.ts's
// PAY_PASS_URL) without touching every other instance's slash behavior.
// Unset (the default) leaves Astro's own default in place.
const trailingSlashEnv = process.env.TRAILING_SLASH;

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'middleware' }),
  server: { port },
  ...(trailingSlashEnv ? { trailingSlash: trailingSlashEnv } : {}),
  integrations: [
    coolForms({
      siteId: 'playground',
      // Must match the port this instance actually serves on (item 18) — the
      // virtual config's siteUrl is baked in at build/dev-server-start time,
      // so the same-origin check in handleAbandon() only passes when a
      // request's real Origin matches it exactly.
      siteUrl: `http://localhost:${port}`,
      forms: {
        demo: {
          abandonment: { require: 'email-or-phone', dedupeWindowMins: 60 },
          notifyTo: 'owner@example.com',
        },
      },
      // Payments + webhooks demo config (Plan 09, PAY-05/HOOK-01). Fees and
      // caps are inert without a provider key (PAY-04) — set here so a
      // dedicated e2e instance carrying STRIPE_SECRET_KEY/PAYPAL_* actually
      // exercises real breakdown math on /forms-pay.
      payments: {
        payLinkFees: [{ label: 'Transaction charges', percent: 0.05 }],
        requestPage: {
          minAmountCents: 100,
          maxAmountCents: 500000,
          allowedCurrencies: ['usd'],
        },
      },
      // Outbound webhooks (HOOK-01) — ONLY present when CAF_E2E_WEBHOOK_URL
      // is set, so the outbound-webhook e2e spec can point this instance at
      // its own local receiver without every other instance carrying a dead
      // target. A REAL deployment sets `webhooks: [{ url: 'https://your-
      // receiver.example.com/hook', secret: '<random>', events: [...] }]`
      // directly in its own astro.config — this env-gate is test-only
      // plumbing, not the shape a host site should copy verbatim.
      webhooks: process.env.CAF_E2E_WEBHOOK_URL
        ? [
            {
              url: process.env.CAF_E2E_WEBHOOK_URL,
              secret: 'e2e-webhook-secret',
              events: ['entry.submitted', 'entry.abandoned', 'payment.paid'],
            },
          ]
        : [],
      // Drive file uploads (DRV-01/D2, Plan 09) — safe to set the VALUE
      // knobs unconditionally on every instance: activation is entirely
      // gated by the GOOGLE_DRIVE_* env keys (driveConfigured(), drive.ts)
      // checked at UPLOAD time, not by this config subtree's mere presence,
      // so every instance without those env keys stays fully inert
      // regardless. `linkAccess:'anyone'` mirrors CONTEXT D2's owner-explicit
      // choice (never the package's own safe 'private' default) so the
      // dedicated recovery/drive e2e instance below exercises the SAME
      // grantPermission path a real host accepting the caveat would use — a
      // real host that has NOT made that call should set `linkAccess:
      // 'private'` (the package default) instead.
      drive: {
        linkAccess: 'anyone',
        rootFolderName: 'playground-forms',
      },
      // Lead recovery (RCV-01/D3, Plan 09) — UNLIKE Drive above, `enabled`
      // IS the activation switch itself (integration.ts: recovery has no
      // external provider key to gate on, so config.recovery.enabled is read
      // directly) — setting it unconditionally to `true` here would turn the
      // recovery widget script + unsubscribe route + consent-write ON for
      // EVERY dedicated instance that shares this file (Turnstile/Admin/Pay),
      // not just the one instance meant to demo it. Env-gated the same way
      // `webhooks` above is, so only the dedicated RECOVERY_URL instance
      // (playwright.config.ts) actually activates it; every other instance
      // stays byte-identical to its pre-Phase-4 behavior. `delayMins`/
      // `consentMode` mirror a real host's shape (D3 owner defaults) since
      // the e2e debug-triggered sweep supplies its own advanced `now` and
      // does not depend on the real 60-minute wait.
      recovery: {
        enabled: process.env.CAF_E2E_RECOVERY_ENABLED === 'true',
        delayMins: 60,
        consentMode: 'auto',
      },
    }),
  ],
});

// Turnstile (D3/BOT-01): setting TURNSTILE_SITE_KEY + TURNSTILE_SECRET_KEY
// in the environment activates the widget — no config field needed here,
// coolForms() reads both vars directly from process.env at
// build/dev-server-start time (integration.ts). No live Cloudflare account
// required; Cloudflare documents two dummy testing pairs for exactly this
// purpose (never use these outside a test/CI environment):
//   ALWAYS-PASS: TURNSTILE_SITE_KEY=1x00000000000000000000AA
//                TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA
//   ALWAYS-FAIL: TURNSTILE_SITE_KEY=2x00000000000000000000AB
//                TURNSTILE_SECRET_KEY=2x0000000000000000000000000000000AA
// tests/turnstile.spec.ts drives both pairs via dedicated Playwright
// webServer entries (playwright.config.ts) to exercise the D3 soft-log/
// persisted-flag path end-to-end.

// form_started ping + last-edited-field capture (ANLY-01 D1): no new
// playground config needed — the tagged demo form (data-caf="demo") already
// exercises both once the package ships them: the first input into the form
// fires a form_started ping automatically (capture.ts), and whichever field
// the visitor edits last rides the abandon payload as lastField. Both are
// consumed by the /forms-admin/analytics panel's funnel/top-drop-off tables.

// Admin UI (ADMN-01/ADMN-02): setting FORMS_ADMIN_PASSWORD in the
// environment enables /forms-admin locally — the routes are always
// injected (integration.ts), but the login POST (routes/admin/auth.ts) is
// permanently inert (always rejects) without it, so the admin surface stays
// unreachable by default. Optionally also set FORMS_ADMIN_SECRET (the HMAC
// session-signing key); if omitted, one is generated once and persisted
// beside dbPath (data/.forms-admin-secret) on first use. Local dev:
//   FORMS_ADMIN_PASSWORD=your-password npm run dev -w apps/playground
// then visit /forms-admin/login. tests/admin-views.spec.ts drives a
// dedicated Playwright webServer entry (playwright.config.ts's ADMIN_URL)
// carrying a fixed test password end-to-end.
