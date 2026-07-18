/**
 * coolForms(config) — the Astro integration (PKG-02) that wires the whole
 * package into a host site from `astro.config.mjs`.
 *
 * Built against the RAW Astro Integration API (RESEARCH.md §Alternatives
 * Considered — no astro-integration-kit: 2 injectRoute calls, 3 injectScript
 * calls, one updateConfig, one addMiddleware is small enough to hand-write
 * directly without a third-party dependency).
 */
import type { AstroIntegration } from 'astro';
import type { Plugin } from 'vite';
import type { CafClientConfig } from './client/journey.js';
import { parseConfig, type CoolFormsConfig } from './config.js';
import { recoveryDisabledFormIds } from './server/recovery/resolve.js';

const VIRTUAL_CONFIG_ID = 'virtual:cool-astro-forms/config';
const RESOLVED_VIRTUAL_CONFIG_ID = '\0' + VIRTUAL_CONFIG_ID;

function mapValues<T, U>(obj: Record<string, T>, fn: (value: T) => U): Record<string, U> {
  const result: Record<string, U> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = fn(value);
  }
  return result;
}

/**
 * Public config subset shipped to the client via `window.__cafConfig`.
 * PUBLIC ids + per-form capture allow/deny lists only — zero secrets, zero
 * notifyTo/dbPath/retentionDays (T-01-27). The full server config is only
 * ever reachable through the SSR-only virtual module below.
 *
 * `abandonEndpoint`/`startedEndpoint` ride along here (rather than being
 * re-derived client-side) because only the integration knows the host's
 * `trailingSlash` setting at build time.
 *
 * `turnstileSiteKey` (D3/BOT-01) is the ONLY Turnstile-related field that
 * ever reaches this public config — it's the PUBLIC site key by design.
 * TURNSTILE_SECRET_KEY never crosses this boundary (read server-side only,
 * in routes/abandon.ts).
 *
 * `recovery` (RCV-01/D3, 04-08) carries ONLY `{ enabled, consentMode }` when
 * `recoveryActive` — never `delayMins` (server-only sweep timing) and never
 * a recovery/Drive secret. Drive (DRV-01) has NO field here at all: its
 * config is read server-side only (record-submission.ts/middleware.ts),
 * gated on GOOGLE_DRIVE_* env keys, never bridged to the client.
 *
 * `recovery.disabledForms` (04-10 gap closure — RCV-01/ROADMAP Phase 4 SC4
 * "per-form flag") additionally rides the subset ONLY when at least one
 * form has a per-form `recovery.enabled:false` override — OMITTED entirely
 * (not `[]`) when none exists, keeping the existing no-override wire shape
 * byte-identical. Form ids are already public in `forms` above, so this
 * adds no new information class.
 */
function buildPublicConfig(
  config: CoolFormsConfig,
  abandonEndpoint: string,
  startedEndpoint: string,
  turnstileSiteKey?: string,
  recoveryActive?: boolean,
): CafClientConfig {
  const disabledForms = recoveryActive ? recoveryDisabledFormIds(config) : [];
  return {
    siteId: config.siteId,
    requireConsent: config.requireConsent,
    journeyParams: config.journeyParams,
    forms: mapValues(config.forms, (form) => ({ capture: form.capture })),
    abandonEndpoint,
    startedEndpoint,
    ...(turnstileSiteKey ? { turnstileSiteKey } : {}),
    ...(recoveryActive
      ? {
          recovery: {
            enabled: true,
            consentMode: config.recovery.consentMode,
            ...(disabledForms.length > 0 ? { disabledForms } : {}),
          },
        }
      : {}),
  };
}

/**
 * Computes the client-facing abandon endpoint from the host's
 * `trailingSlash` config. Hosts with `trailingSlash: 'always'`
 * never route a slashless POST to the injected `/api/forms/abandon` route
 * handler, so `capture.ts` must POST to the trailing-slash variant
 * (`/api/forms/abandon/`) on those hosts instead of the hardcoded slashless
 * path.
 */
function computeAbandonEndpoint(trailingSlash: 'always' | 'never' | 'ignore' | undefined): string {
  return '/api/forms/abandon' + (trailingSlash === 'always' ? '/' : '');
}

/** Twin of computeAbandonEndpoint (P07/ANLY-01) — same trailingSlash-aware reasoning for the form_started ping. */
function computeStartedEndpoint(trailingSlash: 'always' | 'never' | 'ignore' | undefined): string {
  return '/api/forms/started' + (trailingSlash === 'always' ? '/' : '');
}

/**
 * Inline Vite plugin resolving `virtual:cool-astro-forms/config` to the
 * validated server-side full config (gate/window/notifyTo/siteUrl). Only
 * loaded into the SSR/server bundle — never shipped to the client (the
 * client gets the public subset above via `window.__cafConfig`).
 *
 * When `templatesModule` is set, the emitted module imports it and merges
 * the resolved `templates` export into the config object — Vite resolves
 * the host's own module, which is how template overrides become reachable
 * at runtime (item 15).
 */
function cafConfigVirtualPlugin(
  config: CoolFormsConfig,
  trailingSlash: 'always' | 'never' | 'ignore' | undefined,
): Plugin {
  return {
    name: 'cool-astro-forms:config',
    resolveId(id) {
      if (id === VIRTUAL_CONFIG_ID) return RESOLVED_VIRTUAL_CONFIG_ID;
      return undefined;
    },
    load(id) {
      if (id !== RESOLVED_VIRTUAL_CONFIG_ID) return undefined;
      if (config.templatesModule) {
        return [
          `import templates from ${JSON.stringify(config.templatesModule)};`,
          `export default { ...${JSON.stringify(config)}, templates, trailingSlash:${JSON.stringify(trailingSlash)} };`,
        ].join('\n');
      }
      return `export default { ...${JSON.stringify(config)}, trailingSlash:${JSON.stringify(trailingSlash)} };`;
    },
  };
}

/**
 * The `coolForms(config)` Astro integration — the single entry point a host
 * adds to `astro.config.mjs`. Validates config (throws on invalid shape),
 * injects the abandon route, the ops canary route, and the two client
 * scripts, exposes resolved config to the server via
 * `virtual:cool-astro-forms/config`, and externalizes `better-sqlite3` from
 * the SSR bundle (Pitfall 2).
 */
export default function coolForms(userConfig: unknown): AstroIntegration {
  const config = parseConfig(userConfig);

  return {
    name: 'cool-astro-forms',
    hooks: {
      'astro:config:setup': ({ config: astroConfig, injectRoute, injectScript, updateConfig, addMiddleware }) => {
        // Astro's own route matching accounts for trailingSlash automatically
        // (the pattern below isn't a literal URL), but the client's raw
        // sendBeacon/fetch POST in capture.ts is NOT routed through Astro —
        // it bypasses the router's trailingSlash handling entirely, so the
        // exact endpoint string handed to the client (via computeAbandonEndpoint
        // below) must already carry the trailing slash on trailingSlash:'always'
        // such hosts — see capture.ts for the read side.
        injectRoute({
          pattern: '/api/forms/abandon',
          entrypoint: 'cool-astro-forms/server/routes/abandon.js',
        });
        injectRoute({
          pattern: '/api/forms/canary',
          entrypoint: 'cool-astro-forms/server/routes/canary.js',
        });
        // form_started counter ping (ANLY-01 D1) — same trailingSlash caveat
        // as abandon above: capture.ts's raw sendBeacon/fetch POST bypasses
        // Astro's router entirely, so the exact endpoint string handed to
        // the client must already carry the trailing slash on
        // trailingSlash:'always' hosts.
        injectRoute({
          pattern: '/api/forms/started',
          entrypoint: 'cool-astro-forms/server/routes/form-started.js',
        });

        // Admin surface (ADMN-01/ADMN-02) — consolidated here so P03's
        // login/auth files and P05's views/action route reach the host
        // without each plan editing this integration separately. `.astro`
        // entrypoints reference the RAW source export (tsup cannot compile
        // .astro — Research Pitfall 1); `.ts` route entrypoints reference
        // the compiled dist export, same pattern as abandon.js/canary.js
        // above. Astro's own router resolves static-vs-dynamic route
        // priority automatically, so injection order here doesn't matter.
        injectRoute({ pattern: '/forms-admin/login', entrypoint: 'cool-astro-forms/server/admin/login.astro' });
        injectRoute({ pattern: '/forms-admin/auth', entrypoint: 'cool-astro-forms/server/routes/admin/auth.js' });
        injectRoute({ pattern: '/forms-admin/entries', entrypoint: 'cool-astro-forms/server/admin/entries.astro' });
        injectRoute({
          pattern: '/forms-admin/abandoned',
          entrypoint: 'cool-astro-forms/server/admin/abandoned.astro',
        });
        injectRoute({ pattern: '/forms-admin/payments', entrypoint: 'cool-astro-forms/server/admin/payments.astro' });
        injectRoute({
          pattern: '/forms-admin/analytics',
          entrypoint: 'cool-astro-forms/server/admin/analytics.astro',
        });
        injectRoute({
          pattern: '/forms-admin/entries/[id]',
          entrypoint: 'cool-astro-forms/server/admin/entry-detail.astro',
        });
        injectRoute({
          pattern: '/forms-admin/entries/action',
          entrypoint: 'cool-astro-forms/server/routes/admin/entry-action.js',
        });
        // CSV/.db export (ADMN-03) — both sit under the guarded
        // /forms-admin/* prefix so the P03 session guard covers them
        // (T-02-26: export routes are easy to leave unauthenticated).
        injectRoute({
          pattern: '/forms-admin/export.csv',
          entrypoint: 'cool-astro-forms/server/routes/admin/export-csv.js',
        });
        injectRoute({
          pattern: '/forms-admin/export.db',
          entrypoint: 'cool-astro-forms/server/routes/admin/export-db.js',
        });

        injectScript('page', 'import "cool-astro-forms/client/journey.js";');
        injectScript('page', 'import "cool-astro-forms/client/capture.js";');

        const abandonEndpoint = computeAbandonEndpoint(astroConfig.trailingSlash);
        const startedEndpoint = computeStartedEndpoint(astroConfig.trailingSlash);

        // D3/BOT-01: the Turnstile module (widget loader + public site key)
        // activates ONLY when BOTH env keys are configured — one without the
        // other leaves the module fully inert (byte-identical to Phase 1).
        // TURNSTILE_SECRET_KEY is read here ONLY to gate this boolean; the
        // actual secret is read again, server-side only, in routes/abandon.ts.
        const turnstileActive = Boolean(process.env.TURNSTILE_SITE_KEY) && Boolean(process.env.TURNSTILE_SECRET_KEY);
        if (turnstileActive) {
          injectScript('page', 'import "cool-astro-forms/client/turnstile-loader.js";');
        }

        // PAY-04: every payment route/page is env-gated the same way as
        // Turnstile above — with no provider keys configured, ZERO payment
        // surface is injected (byte-identical to a pre-Phase-3 host). Only
        // presence of the provider's OWN keys is checked here; no payment
        // secret or fee config is ever added to buildPublicConfig (T-03-33).
        const stripeActive = Boolean(process.env.STRIPE_SECRET_KEY);
        const paypalActive = Boolean(process.env.PAYPAL_CLIENT_ID) && Boolean(process.env.PAYPAL_CLIENT_SECRET);
        const paymentsActive = stripeActive || paypalActive;

        if (paymentsActive) {
          // /forms-pay (PAY-05) — shared payment-request link + its
          // provider-agnostic create-session route + holding-state success
          // page. Injected whenever EITHER provider is configured since the
          // page itself branches Stripe/PayPal per-request.
          injectRoute({ pattern: '/forms-pay', entrypoint: 'cool-astro-forms/server/pay/pay.astro' });
          injectRoute({ pattern: '/forms-pay/success', entrypoint: 'cool-astro-forms/server/pay/success.astro' });
          injectRoute({
            pattern: '/api/forms/pay/create-session',
            entrypoint: 'cool-astro-forms/server/routes/pay/create-session.js',
          });
          // Admin quote-flow (PAY-01/PAY-02) sits under the guarded
          // /forms-admin/* prefix alongside the other admin action routes.
          injectRoute({
            pattern: '/forms-admin/payments/action',
            entrypoint: 'cool-astro-forms/server/routes/admin/payment-action.js',
          });
        }

        if (stripeActive) {
          // Inbound Stripe webhook (PAY-03) — the sole source of payment
          // truth. Provider-specific: only injected when Stripe itself is
          // configured, independent of PayPal.
          injectRoute({
            pattern: '/api/forms/webhooks/stripe',
            entrypoint: 'cool-astro-forms/server/routes/webhooks/stripe.js',
          });
        }

        if (paypalActive) {
          // Inbound PayPal webhook (PAY-03) + the PayPal approval-redirect
          // landing page (PAY-05) — both provider-specific to PayPal.
          injectRoute({
            pattern: '/api/forms/webhooks/paypal',
            entrypoint: 'cool-astro-forms/server/routes/webhooks/paypal.js',
          });
          injectRoute({
            pattern: '/forms-pay/paypal-return',
            entrypoint: 'cool-astro-forms/server/pay/paypal-return.astro',
          });
        }

        // RCV-01/D3 (04-08 chokepoint): the standalone unsubscribe route +
        // recovery widget script activate ONLY when the HOST CONFIG (not an
        // env key — recovery has no external provider to gate on) sets
        // `recovery.enabled`. Off (the default), ZERO recovery surface is
        // injected — byte-identical to Phase 3. Drive (DRV-01) needs NO
        // route injection at all: it runs host-called inside
        // recordSubmission, gated on GOOGLE_DRIVE_* env keys read there and
        // in middleware.ts — nothing for this integration to inject beyond
        // confirming (below) that buildPublicConfig never carries a Drive
        // field.
        const recoveryActive = config.recovery.enabled === true;
        if (recoveryActive) {
          injectRoute({
            pattern: '/api/forms/recovery-unsubscribe',
            entrypoint: 'cool-astro-forms/server/routes/recovery-unsubscribe.js',
          });
          injectScript('page', 'import "cool-astro-forms/client/recovery-widget.js";');
        }

        // HEAD-INLINE, not 'page' (item 28): the inline head script runs
        // before the deferred module scripts, so window.__cafConfig exists
        // by the time capture/journey/turnstile-loader init. With the old
        // 'page' ordering a requireConsent:true site would capture WITHOUT
        // consent on first load.
        injectScript(
          'head-inline',
          `window.__cafConfig=${JSON.stringify(
            buildPublicConfig(
              config,
              abandonEndpoint,
              startedEndpoint,
              turnstileActive ? process.env.TURNSTILE_SITE_KEY : undefined,
              recoveryActive,
            ),
          )};`,
        );

        updateConfig({
          vite: {
            // 'stripe' is server-only (RESEARCH: stripe SDK is server-only) —
            // kept external from the host's SSR bundle alongside
            // better-sqlite3 so the host build never tries to bundle it.
            ssr: { external: ['better-sqlite3', 'stripe'] },
            plugins: [cafConfigVirtualPlugin(config, astroConfig.trailingSlash)],
          },
        });

        addMiddleware({
          entrypoint: 'cool-astro-forms/server/middleware.js',
          order: 'pre',
        });
      },
    },
  };
}
