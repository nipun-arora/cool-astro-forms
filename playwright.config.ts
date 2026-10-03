import { defineConfig, devices } from '@playwright/test';

// Default instance (every spec that doesn't target a dedicated port above —
// abandon-triggers.spec.ts, adoption-flow.spec.ts). Historically 4321
// (astro's own default), but a LOCAL dev environment can easily have an
// unrelated project's own dev server already bound to 4321 — Playwright's
// `reuseExistingServer` then silently attaches to that unrelated server
// instead of failing loudly, producing confusing 404s (see 02-05's SUMMARY
// "Issues Encountered"). Moved to a dedicated port for the same reason the
// Turnstile/Admin instances below are dedicated: durable, not a workaround
// for one bad local machine state. tests/helpers.ts's BASE_URL mirrors this.
export const DEFAULT_URL = 'http://localhost:4325';

// Turnstile (D3/BOT-01) e2e — tests/turnstile.spec.ts needs the playground
// running with two DIFFERENT env-configured key pairs (Cloudflare's
// documented ALWAYS-PASS/ALWAYS-FAIL dummy testing pairs) to prove the D3
// soft-log/persisted-flag path end-to-end with real widget rendering + a
// real Cloudflare siteverify round trip. TURNSTILE_SECRET_KEY is read
// per-request inside a live server process (integration.ts/routes/abandon.ts
// both read process.env directly), so there is no way to flip it mid-run for
// an already-running server — dedicated instances on their own ports are the
// only way to get both outcomes with real fidelity. Never a real Cloudflare
// account.
export const TURNSTILE_PASS_URL = 'http://localhost:4322';
export const TURNSTILE_FAIL_URL = 'http://localhost:4323';

// Admin UI (ADMN-02) e2e — a dedicated instance carrying FORMS_ADMIN_PASSWORD
// so /forms-admin is actually reachable. Dedicated (not the default 4321
// instance) for the same reason the Turnstile pairs above are dedicated:
// `reuseExistingServer` may attach to an already-running dev server started
// without this env var, and the admin route's auth is fully env-gated at
// process startup (FORMS_ADMIN_PASSWORD is read per-request from
// process.env, but a manually-started dev server would simply never have
// it set).
export const ADMIN_URL = 'http://localhost:4324';
export const ADMIN_PASSWORD = 'e2e-admin-test-password';

// Payments + webhooks (Plan 09, PAY-05/HOOK-01) — two dedicated instances,
// same reasoning as Turnstile/Admin above: STRIPE_SECRET_KEY/trailingSlash
// are read once at this process's own startup, so both outcomes need their
// own port. PAY_PASS_URL ALSO runs `trailingSlash: 'always'` (checker B1) —
// the ONLY instance in this suite proving trailingSlash:'always' discipline
// live; every helper call against it must target the SLASHED path
// explicitly (confirmed empirically: astro dev does NOT redirect a
// slashless request under 'always', it 404s — LESSONS.md #3).
export const PAY_PASS_URL = 'http://localhost:4326';
export const PAY_FAIL_URL = 'http://localhost:4327';

// Local (non-Astro) HTTP servers the specs themselves stand up — NOT
// playground instances. Fixed ports (dedicated-port convention, LESSONS.md
// #25) so `STRIPE_API_BASE_URL`/`CAF_E2E_WEBHOOK_URL` can be baked into the
// webServer env BELOW (static, evaluated before either receiver exists) and
// still resolve correctly once the spec binds a listener on the same port.
//
// STRIPE_API_BASE_URL is the e2e route-seam mock (stripe.ts's
// `getStripeClient()`) — redirects the Stripe SDK's HTTP client off
// `api.stripe.com` entirely so a `sk_test_e2e_dummy` key NEVER makes a live
// provider call (hard rule). Set on BOTH pay instances defensively, even
// though PAY_FAIL_URL's Turnstile hard gate rejects before ever reaching
// this code path.
export const STRIPE_MOCK_PORT = 4390;
export const STRIPE_MOCK_BASE_URL = `http://127.0.0.1:${STRIPE_MOCK_PORT}`;

// CAF_E2E_WEBHOOK_URL points ONE instance's outbound webhook target at a
// local receiver tests/outbound-webhooks.spec.ts stands up — PAY_FAIL_URL
// (default trailingSlash) so the abandon-trigger helper needs no slash
// gymnastics.
export const WEBHOOK_RECEIVER_PORT = 4391;
export const WEBHOOK_RECEIVER_URL = `http://127.0.0.1:${WEBHOOK_RECEIVER_PORT}/hook`;

// Recovery + Drive (Plan 09, DRV-01/DRV-02/RCV-01) — ONE dedicated instance
// carries BOTH features: `CAF_E2E_RECOVERY_ENABLED=true` flips
// astro.config.mjs's env-gated `recovery.enabled` (see that file's comment —
// unlike Turnstile/Stripe/webhooks, recovery has no provider-key gate, so it
// needs its OWN env switch to stay off every other instance), and the
// GOOGLE_DRIVE_* triple + GOOGLE_DRIVE_API_BASE_URL/GOOGLE_OAUTH_TOKEN_URL
// redirect the Drive module's OAuth + REST calls entirely to a local mock
// server tests/drive-upload.spec.ts stands up on DRIVE_MOCK_PORT — the exact
// STRIPE_API_BASE_URL seam generalized (03-09 precedent). Dummy
// GOOGLE_DRIVE_CLIENT_ID/SECRET/REFRESH_TOKEN values only make
// `driveConfigured()` true; they are never sent to a real Google endpoint.
export const RECOVERY_URL = 'http://localhost:4328';

// Admin pages under a Content Security Policy (0.1.15) — the ONLY instance
// that is a production build (`astro build` + the Express wrapper), because
// Astro emits its CSP from built output only, never from `astro dev`.
// `CAF_E2E_CSP=true` turns on `security.csp` in apps/playground's config
// (env-gated, LESSONS #35). It also carries the admin password and a dummy
// Stripe key routed to a local mock on ADMIN_CSP_STRIPE_MOCK_PORT, so the
// built-in "Create payment link" flow renders and can be driven end to end
// (tests/admin-csp.spec.ts stands the mock up; no live Stripe call).
export const ADMIN_CSP_URL = 'http://localhost:4329';
export const ADMIN_CSP_STRIPE_MOCK_PORT = 4394;
export const DRIVE_MOCK_PORT = 4393;
export const DRIVE_MOCK_BASE_URL = `http://127.0.0.1:${DRIVE_MOCK_PORT}`;

// Astro 7 changed `astro dev` in two ways that break a suite running several
// playground dev servers side by side (0.1.15, LESSONS #68). Every
// foreground `astro dev` writes a lock file in the project's `.astro/` and
// refuses to start while another dev server of the same project is alive,
// and under an AI coding agent it detaches into the background, so the
// command Playwright launched exits at once. `--ignore-lock` skips the lock
// (no check, no write), and ASTRO_DEV_BACKGROUND, the variable Astro sets on
// its own background child, skips the agent check, so every instance below
// runs in the foreground under Playwright's control.
const PLAYGROUND_DEV = 'npm run dev -w apps/playground -- --ignore-lock';
const PLAYGROUND_DEV_ENV = { ASTRO_DEV_BACKGROUND: '1' };

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  reporter: [['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    trace: 'on-first-retry',
    baseURL: DEFAULT_URL,
  },
  webServer: [
    {
      command: PLAYGROUND_DEV,
      url: DEFAULT_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: { ...PLAYGROUND_DEV_ENV, PORT: '4325' },
    },
    {
      command: PLAYGROUND_DEV,
      url: TURNSTILE_PASS_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        ...PLAYGROUND_DEV_ENV,
        PORT: '4322',
        TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
        TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
      },
    },
    {
      command: PLAYGROUND_DEV,
      url: TURNSTILE_FAIL_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        ...PLAYGROUND_DEV_ENV,
        PORT: '4323',
        TURNSTILE_SITE_KEY: '2x00000000000000000000AB',
        TURNSTILE_SECRET_KEY: '2x0000000000000000000000000000000AA',
      },
    },
    {
      command: PLAYGROUND_DEV,
      url: ADMIN_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        ...PLAYGROUND_DEV_ENV,
        PORT: '4324',
        FORMS_ADMIN_PASSWORD: ADMIN_PASSWORD,
      },
    },
    {
      command: PLAYGROUND_DEV,
      url: PAY_PASS_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        ...PLAYGROUND_DEV_ENV,
        PORT: '4326',
        STRIPE_SECRET_KEY: 'sk_test_e2e_dummy',
        STRIPE_API_BASE_URL: STRIPE_MOCK_BASE_URL,
        TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
        TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
        TRAILING_SLASH: 'always',
      },
    },
    {
      command: PLAYGROUND_DEV,
      url: PAY_FAIL_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        ...PLAYGROUND_DEV_ENV,
        PORT: '4327',
        STRIPE_SECRET_KEY: 'sk_test_e2e_dummy',
        STRIPE_API_BASE_URL: STRIPE_MOCK_BASE_URL,
        TURNSTILE_SITE_KEY: '2x00000000000000000000AB',
        TURNSTILE_SECRET_KEY: '2x0000000000000000000000000000000AA',
        CAF_E2E_WEBHOOK_URL: WEBHOOK_RECEIVER_URL,
      },
    },
    {
      command: PLAYGROUND_DEV,
      url: RECOVERY_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        ...PLAYGROUND_DEV_ENV,
        PORT: '4328',
        CAF_E2E_RECOVERY_ENABLED: 'true',
        GOOGLE_DRIVE_CLIENT_ID: 'e2e-dummy-client-id',
        GOOGLE_DRIVE_CLIENT_SECRET: 'e2e-dummy-client-secret',
        GOOGLE_DRIVE_REFRESH_TOKEN: 'e2e-dummy-refresh-token',
        GOOGLE_DRIVE_API_BASE_URL: DRIVE_MOCK_BASE_URL,
        GOOGLE_OAUTH_TOKEN_URL: `${DRIVE_MOCK_BASE_URL}/token`,
      },
    },
    {
      // Build first (siteUrl and the CSP switch are baked at build time),
      // then serve the build through apps/playground/server.mjs.
      command: 'npm run build -w apps/playground && npm start -w apps/playground',
      url: ADMIN_CSP_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: {
        PORT: '4329',
        CAF_E2E_CSP: 'true',
        FORMS_ADMIN_PASSWORD: ADMIN_PASSWORD,
        STRIPE_SECRET_KEY: 'sk_test_e2e_dummy',
        STRIPE_API_BASE_URL: `http://127.0.0.1:${ADMIN_CSP_STRIPE_MOCK_PORT}`,
      },
    },
  ],
  projects: [
    {
      name: 'desktop-chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-pixel7',
      use: { ...devices['Pixel 7'] },
    },
  ],
});
