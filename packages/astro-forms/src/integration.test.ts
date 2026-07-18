import { afterEach, describe, expect, it, vi } from 'vitest';
import coolForms from './integration.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function validUserConfig(overrides: Record<string, unknown> = {}) {
  return {
    siteId: 'demo-site',
    siteUrl: 'https://example.com',
    forms: {
      'contact-form': {
        notifyTo: 'owner@example.com',
        capture: { deny: ['ssn'] },
      },
    },
    ...overrides,
  };
}

interface HookSpies {
  config: { trailingSlash?: 'always' | 'never' | 'ignore' };
  injectRoute: ReturnType<typeof vi.fn>;
  injectScript: ReturnType<typeof vi.fn>;
  updateConfig: ReturnType<typeof vi.fn>;
  addMiddleware: ReturnType<typeof vi.fn>;
}

function runSetupHook(
  userConfig: Record<string, unknown> = validUserConfig(),
  astroConfig: { trailingSlash?: 'always' | 'never' | 'ignore' } = {},
): HookSpies {
  const integration = coolForms(userConfig);
  const spies: HookSpies = {
    config: astroConfig,
    injectRoute: vi.fn(),
    injectScript: vi.fn(),
    updateConfig: vi.fn(),
    addMiddleware: vi.fn(),
  };
  const hook = integration.hooks['astro:config:setup'] as unknown as (opts: HookSpies) => void;
  hook(spies);
  return spies;
}

// ---------------------------------------------------------------------------
// coolForms(config)
// ---------------------------------------------------------------------------

describe('coolForms', () => {
  it('returns an AstroIntegration with name "cool-astro-forms" and an astro:config:setup hook', () => {
    const integration = coolForms(validUserConfig());
    expect(integration.name).toBe('cool-astro-forms');
    expect(typeof integration.hooks['astro:config:setup']).toBe('function');
  });

  it('throws on invalid config (missing siteId and siteUrl)', () => {
    expect(() => coolForms({})).toThrow();
  });

  it('throws when siteUrl is missing', () => {
    expect(() => coolForms({ siteId: 'x', forms: {} })).toThrow();
  });

  describe('astro:config:setup hook', () => {
    it('injects the abandon, canary, and form_started routes with their package entrypoints', () => {
      const { injectRoute } = runSetupHook();
      expect(injectRoute).toHaveBeenCalledWith({
        pattern: '/api/forms/abandon',
        entrypoint: 'cool-astro-forms/server/routes/abandon.js',
      });
      expect(injectRoute).toHaveBeenCalledWith({
        pattern: '/api/forms/canary',
        entrypoint: 'cool-astro-forms/server/routes/canary.js',
      });
      expect(injectRoute).toHaveBeenCalledWith({
        pattern: '/api/forms/started',
        entrypoint: 'cool-astro-forms/server/routes/form-started.js',
      });
    });

    it('injects both client scripts at the page stage', () => {
      const { injectScript } = runSetupHook();
      expect(injectScript).toHaveBeenCalledWith('page', expect.stringContaining('cool-astro-forms/client/journey.js'));
      expect(injectScript).toHaveBeenCalledWith('page', expect.stringContaining('cool-astro-forms/client/capture.js'));
    });

    it('injects window.__cafConfig at the head-inline stage (before the page modules)', () => {
      const { injectScript } = runSetupHook();
      const headInlineCall = injectScript.mock.calls.find(([stage]) => stage === 'head-inline');
      expect(headInlineCall).toBeDefined();
      expect(headInlineCall![1]).toContain('window.__cafConfig=');
    });

    it('window.__cafConfig excludes secrets — only public ids + capture allow/deny lists cross the boundary', () => {
      const { injectScript } = runSetupHook();
      const [, content] = injectScript.mock.calls.find(([stage]) => stage === 'head-inline')!;
      expect(content).toContain('"siteId":"demo-site"');
      expect(content).toContain('"deny":["ssn"]');
      expect(content).not.toContain('notifyTo');
      expect(content).not.toContain('dbPath');
      expect(content).not.toContain('retentionDays');
    });

    it('window.__cafConfig carries a slashless abandonEndpoint when the host has no trailingSlash set (default)', () => {
      const { injectScript } = runSetupHook();
      const [, content] = injectScript.mock.calls.find(([stage]) => stage === 'head-inline')!;
      expect(content).toContain('"abandonEndpoint":"/api/forms/abandon"');
    });

    it("window.__cafConfig carries a trailing-slash abandonEndpoint when the host's trailingSlash is 'always'", () => {
      const { injectScript } = runSetupHook(validUserConfig(), { trailingSlash: 'always' });
      const [, content] = injectScript.mock.calls.find(([stage]) => stage === 'head-inline')!;
      expect(content).toContain('"abandonEndpoint":"/api/forms/abandon/"');
    });

    it("window.__cafConfig carries a slashless abandonEndpoint when the host's trailingSlash is 'never' or 'ignore'", () => {
      const never = runSetupHook(validUserConfig(), { trailingSlash: 'never' });
      const [, neverContent] = never.injectScript.mock.calls.find(([stage]) => stage === 'head-inline')!;
      expect(neverContent).toContain('"abandonEndpoint":"/api/forms/abandon"');

      const ignore = runSetupHook(validUserConfig(), { trailingSlash: 'ignore' });
      const [, ignoreContent] = ignore.injectScript.mock.calls.find(([stage]) => stage === 'head-inline')!;
      expect(ignoreContent).toContain('"abandonEndpoint":"/api/forms/abandon"');
    });

    it('window.__cafConfig carries a slashless startedEndpoint when the host has no trailingSlash set (default)', () => {
      const { injectScript } = runSetupHook();
      const [, content] = injectScript.mock.calls.find(([stage]) => stage === 'head-inline')!;
      expect(content).toContain('"startedEndpoint":"/api/forms/started"');
    });

    it("window.__cafConfig carries a trailing-slash startedEndpoint when the host's trailingSlash is 'always'", () => {
      const { injectScript } = runSetupHook(validUserConfig(), { trailingSlash: 'always' });
      const [, content] = injectScript.mock.calls.find(([stage]) => stage === 'head-inline')!;
      expect(content).toContain('"startedEndpoint":"/api/forms/started/"');
    });

    it('registers the pre-order middleware with its package entrypoint', () => {
      const { addMiddleware } = runSetupHook();
      expect(addMiddleware).toHaveBeenCalledWith({
        entrypoint: 'cool-astro-forms/server/middleware.js',
        order: 'pre',
      });
    });

    it('externalizes better-sqlite3 from the SSR bundle and registers the config virtual-module plugin', () => {
      const { updateConfig } = runSetupHook();
      expect(updateConfig).toHaveBeenCalledTimes(1);
      const arg = updateConfig.mock.calls[0]![0];
      expect(arg.vite.ssr.external).toContain('better-sqlite3');
      expect(arg.vite.plugins).toHaveLength(1);
      expect(arg.vite.plugins[0].name).toBe('cool-astro-forms:config');
    });
  });

  describe('cool-astro-forms:config virtual plugin', () => {
    function getPlugin(
      userConfig: Record<string, unknown> = validUserConfig(),
      astroConfig: { trailingSlash?: 'always' | 'never' | 'ignore' } = {},
    ) {
      const { updateConfig } = runSetupHook(userConfig, astroConfig);
      return updateConfig.mock.calls[0]![0].vite.plugins[0];
    }

    it('resolveId resolves the virtual specifier to a \\0-prefixed id', () => {
      const plugin = getPlugin();
      const resolved = plugin.resolveId('virtual:cool-astro-forms/config');
      expect(resolved).toBe('\0virtual:cool-astro-forms/config');
      expect(plugin.resolveId('some/other/id')).toBeUndefined();
    });

    it('load returns a module exporting the validated server-side config', () => {
      const plugin = getPlugin();
      const resolved = plugin.resolveId('virtual:cool-astro-forms/config');
      const loaded = plugin.load(resolved) as string;
      expect(loaded).toContain('export default');
      expect(loaded).toContain('"siteId":"demo-site"');
      expect(loaded).toContain('"notifyTo":"owner@example.com"');
    });

    it('load returns undefined for any other module id', () => {
      const plugin = getPlugin();
      expect(plugin.load('/some/other/file.ts')).toBeUndefined();
    });

    it('with templatesModule set, load emits an import statement and merges templates into the default export', () => {
      const plugin = getPlugin(validUserConfig({ templatesModule: './my-templates.js' }));
      const resolved = plugin.resolveId('virtual:cool-astro-forms/config');
      const loaded = plugin.load(resolved) as string;
      expect(loaded).toContain('import templates from');
      expect(loaded).toContain('./my-templates.js');
      expect(loaded).toContain('templates,');
    });

    // B1 (checker) — the host's trailingSlash must ride into the virtual
    // config so server code (adminUrl, middleware guard) can compute
    // correct client-visible admin URLs without re-deriving it.
    it("carries trailingSlash:'always' in the emitted module source for an 'always' host", () => {
      const plugin = getPlugin(validUserConfig(), { trailingSlash: 'always' });
      const resolved = plugin.resolveId('virtual:cool-astro-forms/config');
      const loaded = plugin.load(resolved) as string;
      expect(loaded).toContain('trailingSlash:"always"');
    });

    it("carries trailingSlash:'always' even when templatesModule is set", () => {
      const plugin = getPlugin(validUserConfig({ templatesModule: './my-templates.js' }), {
        trailingSlash: 'always',
      });
      const resolved = plugin.resolveId('virtual:cool-astro-forms/config');
      const loaded = plugin.load(resolved) as string;
      expect(loaded).toContain('trailingSlash:"always"');
      expect(loaded).toContain('import templates from');
    });

    it('carries an undefined trailingSlash when the host has none configured', () => {
      const plugin = getPlugin();
      const resolved = plugin.resolveId('virtual:cool-astro-forms/config');
      const loaded = plugin.load(resolved) as string;
      expect(loaded).toContain('trailingSlash:undefined');
    });
  });

  // ---------------------------------------------------------------------------
  // Turnstile (D3/BOT-01) — env-gated conditional injection. Module MUST stay
  // fully inert (no siteKey in window.__cafConfig, no loader script injected)
  // unless BOTH env keys are present.
  // ---------------------------------------------------------------------------
  describe('Turnstile (D3/BOT-01) — env-gated conditional injection', () => {
    const ORIGINAL_SITE_KEY = process.env.TURNSTILE_SITE_KEY;
    const ORIGINAL_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY;

    afterEach(() => {
      if (ORIGINAL_SITE_KEY === undefined) delete process.env.TURNSTILE_SITE_KEY;
      else process.env.TURNSTILE_SITE_KEY = ORIGINAL_SITE_KEY;
      if (ORIGINAL_SECRET_KEY === undefined) delete process.env.TURNSTILE_SECRET_KEY;
      else process.env.TURNSTILE_SECRET_KEY = ORIGINAL_SECRET_KEY;
    });

    function loaderInjected(injectScript: ReturnType<typeof vi.fn>): boolean {
      return injectScript.mock.calls.some(
        ([stage, code]) => stage === 'page' && String(code).includes('turnstile-loader'),
      );
    }

    it('omits turnstileSiteKey and never injects the loader when both env keys are unset', () => {
      delete process.env.TURNSTILE_SITE_KEY;
      delete process.env.TURNSTILE_SECRET_KEY;
      const { injectScript } = runSetupHook();
      const [, content] = injectScript.mock.calls.find(([stage]) => stage === 'head-inline')!;
      expect(content).not.toContain('turnstileSiteKey');
      expect(loaderInjected(injectScript)).toBe(false);
    });

    it('omits turnstileSiteKey and the loader when only TURNSTILE_SITE_KEY is set (secret missing)', () => {
      process.env.TURNSTILE_SITE_KEY = '1x00000000000000000000AA';
      delete process.env.TURNSTILE_SECRET_KEY;
      const { injectScript } = runSetupHook();
      const [, content] = injectScript.mock.calls.find(([stage]) => stage === 'head-inline')!;
      expect(content).not.toContain('turnstileSiteKey');
      expect(loaderInjected(injectScript)).toBe(false);
    });

    it('omits turnstileSiteKey and the loader when only TURNSTILE_SECRET_KEY is set (site key missing)', () => {
      delete process.env.TURNSTILE_SITE_KEY;
      process.env.TURNSTILE_SECRET_KEY = '1x0000000000000000000000000000000AA';
      const { injectScript } = runSetupHook();
      const [, content] = injectScript.mock.calls.find(([stage]) => stage === 'head-inline')!;
      expect(content).not.toContain('turnstileSiteKey');
      expect(loaderInjected(injectScript)).toBe(false);
    });

    it('injects turnstileSiteKey into window.__cafConfig and injects the loader when BOTH env keys are present', () => {
      process.env.TURNSTILE_SITE_KEY = '1x00000000000000000000AA';
      process.env.TURNSTILE_SECRET_KEY = '1x0000000000000000000000000000000AA';
      const { injectScript } = runSetupHook();
      const [, content] = injectScript.mock.calls.find(([stage]) => stage === 'head-inline')!;
      expect(content).toContain('"turnstileSiteKey":"1x00000000000000000000AA"');
      expect(loaderInjected(injectScript)).toBe(true);
    });

    it('never leaks TURNSTILE_SECRET_KEY into window.__cafConfig', () => {
      process.env.TURNSTILE_SITE_KEY = '1x00000000000000000000AA';
      process.env.TURNSTILE_SECRET_KEY = 'super-secret-value';
      const { injectScript } = runSetupHook();
      const [, content] = injectScript.mock.calls.find(([stage]) => stage === 'head-inline')!;
      expect(content).not.toContain('super-secret-value');
    });
  });

  // ---------------------------------------------------------------------------
  // Admin route injection (P05 consolidation — ADMN-01/ADMN-02). Every
  // /forms-admin/* route P03/P05 built is injected from this single
  // integration; .astro entrypoints reference the raw source export, .ts
  // route entrypoints reference the compiled dist export.
  // ---------------------------------------------------------------------------
  describe('admin route injection (P05 consolidation)', () => {
    it('injects every /forms-admin route with its correct pattern + entrypoint', () => {
      const { injectRoute } = runSetupHook();
      const expectedRoutes: { pattern: string; entrypoint: string }[] = [
        { pattern: '/forms-admin/login', entrypoint: 'cool-astro-forms/server/admin/login.astro' },
        { pattern: '/forms-admin/auth', entrypoint: 'cool-astro-forms/server/routes/admin/auth.js' },
        { pattern: '/forms-admin/entries', entrypoint: 'cool-astro-forms/server/admin/entries.astro' },
        { pattern: '/forms-admin/abandoned', entrypoint: 'cool-astro-forms/server/admin/abandoned.astro' },
        { pattern: '/forms-admin/payments', entrypoint: 'cool-astro-forms/server/admin/payments.astro' },
        { pattern: '/forms-admin/analytics', entrypoint: 'cool-astro-forms/server/admin/analytics.astro' },
        { pattern: '/forms-admin/entries/[id]', entrypoint: 'cool-astro-forms/server/admin/entry-detail.astro' },
        {
          pattern: '/forms-admin/entries/action',
          entrypoint: 'cool-astro-forms/server/routes/admin/entry-action.js',
        },
        {
          pattern: '/forms-admin/export.csv',
          entrypoint: 'cool-astro-forms/server/routes/admin/export-csv.js',
        },
        {
          pattern: '/forms-admin/export.db',
          entrypoint: 'cool-astro-forms/server/routes/admin/export-db.js',
        },
      ];
      for (const route of expectedRoutes) {
        expect(injectRoute).toHaveBeenCalledWith(route);
      }
    });

    it('injects exactly 13 routes total (3 public routes + 10 admin routes) with no payment env keys set', () => {
      const { injectRoute } = runSetupHook();
      expect(injectRoute).toHaveBeenCalledTimes(13);
    });
  });

  // ---------------------------------------------------------------------------
  // Payments (PAY-04) — env-gated conditional injection, mirrors the Turnstile
  // describe block above. With NO Stripe/PayPal env keys, zero payment
  // routes/pages are injected and no payment secret reaches
  // window.__cafConfig. Every gate is independent: Stripe-only, PayPal-only,
  // and both-configured are each asserted separately.
  // ---------------------------------------------------------------------------
  describe('Payments (PAY-04) — env-gated conditional injection', () => {
    const PAYMENT_ENV_VARS = ['STRIPE_SECRET_KEY', 'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET'] as const;
    const ORIGINAL: Record<string, string | undefined> = {};
    for (const key of PAYMENT_ENV_VARS) ORIGINAL[key] = process.env[key];

    afterEach(() => {
      for (const key of PAYMENT_ENV_VARS) {
        if (ORIGINAL[key] === undefined) delete process.env[key];
        else process.env[key] = ORIGINAL[key];
      }
    });

    const PAYMENT_ROUTE_PATTERNS = [
      '/forms-pay',
      '/forms-pay/success',
      '/api/forms/pay/create-session',
      '/forms-admin/payments/action',
      '/api/forms/webhooks/stripe',
      '/api/forms/webhooks/paypal',
      '/forms-pay/paypal-return',
    ];

    function injectedPatterns(injectRoute: ReturnType<typeof vi.fn>): string[] {
      return injectRoute.mock.calls.map(([call]) => (call as { pattern: string }).pattern);
    }

    it('with no Stripe/PayPal env keys set, injects none of the 7 payment route/page patterns', () => {
      for (const key of PAYMENT_ENV_VARS) delete process.env[key];
      const { injectRoute } = runSetupHook();
      const patterns = injectedPatterns(injectRoute);
      for (const pattern of PAYMENT_ROUTE_PATTERNS) {
        expect(patterns).not.toContain(pattern);
      }
      expect(injectRoute).toHaveBeenCalledTimes(13);
    });

    it('with no Stripe/PayPal env keys set, window.__cafConfig contains no STRIPE/PAYPAL secret substring', () => {
      for (const key of PAYMENT_ENV_VARS) delete process.env[key];
      const { injectScript } = runSetupHook();
      const [, content] = injectScript.mock.calls.find(([stage]) => stage === 'head-inline')!;
      expect(content).not.toMatch(/STRIPE|PAYPAL/i);
    });

    it('with STRIPE_SECRET_KEY set (PayPal unset), injects the Stripe-gated + paymentsActive-gated routes with correct entrypoints, and omits the PayPal-only routes', () => {
      delete process.env.PAYPAL_CLIENT_ID;
      delete process.env.PAYPAL_CLIENT_SECRET;
      process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
      const { injectRoute } = runSetupHook();

      expect(injectRoute).toHaveBeenCalledWith({
        pattern: '/forms-pay',
        entrypoint: 'cool-astro-forms/server/pay/pay.astro',
      });
      expect(injectRoute).toHaveBeenCalledWith({
        pattern: '/forms-pay/success',
        entrypoint: 'cool-astro-forms/server/pay/success.astro',
      });
      expect(injectRoute).toHaveBeenCalledWith({
        pattern: '/api/forms/pay/create-session',
        entrypoint: 'cool-astro-forms/server/routes/pay/create-session.js',
      });
      expect(injectRoute).toHaveBeenCalledWith({
        pattern: '/forms-admin/payments/action',
        entrypoint: 'cool-astro-forms/server/routes/admin/payment-action.js',
      });
      expect(injectRoute).toHaveBeenCalledWith({
        pattern: '/api/forms/webhooks/stripe',
        entrypoint: 'cool-astro-forms/server/routes/webhooks/stripe.js',
      });

      const patterns = injectedPatterns(injectRoute);
      expect(patterns).not.toContain('/api/forms/webhooks/paypal');
      expect(patterns).not.toContain('/forms-pay/paypal-return');

      // 13 base + 4 paymentsActive-gated + 1 stripeActive-gated
      expect(injectRoute).toHaveBeenCalledTimes(18);
    });

    it('with PayPal keys set (Stripe unset), injects the PayPal-gated + paymentsActive-gated routes, and omits the Stripe-only webhook route', () => {
      delete process.env.STRIPE_SECRET_KEY;
      process.env.PAYPAL_CLIENT_ID = 'paypal-client-id';
      process.env.PAYPAL_CLIENT_SECRET = 'paypal-client-secret';
      const { injectRoute } = runSetupHook();

      expect(injectRoute).toHaveBeenCalledWith({
        pattern: '/api/forms/webhooks/paypal',
        entrypoint: 'cool-astro-forms/server/routes/webhooks/paypal.js',
      });
      expect(injectRoute).toHaveBeenCalledWith({
        pattern: '/forms-pay/paypal-return',
        entrypoint: 'cool-astro-forms/server/pay/paypal-return.astro',
      });
      expect(injectRoute).toHaveBeenCalledWith({
        pattern: '/forms-pay',
        entrypoint: 'cool-astro-forms/server/pay/pay.astro',
      });

      const patterns = injectedPatterns(injectRoute);
      expect(patterns).not.toContain('/api/forms/webhooks/stripe');

      // 13 base + 4 paymentsActive-gated + 2 paypalActive-gated
      expect(injectRoute).toHaveBeenCalledTimes(19);
    });

    it('with only one of PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET set (Stripe unset), paypalActive stays false — no payment routes injected', () => {
      delete process.env.STRIPE_SECRET_KEY;
      process.env.PAYPAL_CLIENT_ID = 'paypal-client-id';
      delete process.env.PAYPAL_CLIENT_SECRET;
      const { injectRoute } = runSetupHook();
      expect(injectRoute).toHaveBeenCalledTimes(13);
    });

    it('with BOTH Stripe and PayPal keys set, injects all 7 payment route/page patterns', () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
      process.env.PAYPAL_CLIENT_ID = 'paypal-client-id';
      process.env.PAYPAL_CLIENT_SECRET = 'paypal-client-secret';
      const { injectRoute } = runSetupHook();
      const patterns = injectedPatterns(injectRoute);
      for (const pattern of PAYMENT_ROUTE_PATTERNS) {
        expect(patterns).toContain(pattern);
      }
      // 13 base + 4 paymentsActive-gated + 1 stripeActive-gated + 2 paypalActive-gated
      expect(injectRoute).toHaveBeenCalledTimes(20);
    });

    it('ssr.external contains stripe alongside better-sqlite3', () => {
      const { updateConfig } = runSetupHook();
      const arg = updateConfig.mock.calls[0]![0];
      expect(arg.vite.ssr.external).toContain('stripe');
      expect(arg.vite.ssr.external).toContain('better-sqlite3');
    });
  });

  // ---------------------------------------------------------------------------
  // Lead recovery (RCV-01/D3, 04-08 chokepoint) — CONFIG-gated conditional
  // injection, mirroring the Turnstile/Payments matrices above. Unlike those,
  // recovery has no external provider key to check: the gate is entirely
  // `config.recovery.enabled` (host config, not env). With recovery off (the
  // default), ZERO recovery surface is injected — byte-identical to Phase 3.
  // Drive (DRV-01) contributes NO injected route at all, regardless of
  // GOOGLE_DRIVE_* env presence, since it runs host-called inside
  // recordSubmission rather than through this integration.
  // ---------------------------------------------------------------------------
  describe('Lead recovery (RCV-01/D3) — config-gated conditional injection', () => {
    function widgetInjected(injectScript: ReturnType<typeof vi.fn>): boolean {
      return injectScript.mock.calls.some(
        ([stage, code]) => stage === 'page' && String(code).includes('recovery-widget'),
      );
    }

    function routeInjected(injectRoute: ReturnType<typeof vi.fn>): boolean {
      return injectRoute.mock.calls.some(
        ([call]) => (call as { pattern: string }).pattern === '/api/forms/recovery-unsubscribe',
      );
    }

    it('with recovery unset (default), injects neither the route nor the widget script, and __cafConfig carries no recovery key', () => {
      const { injectRoute, injectScript } = runSetupHook();
      expect(routeInjected(injectRoute)).toBe(false);
      expect(widgetInjected(injectScript)).toBe(false);
      // Unchanged from the pre-recovery base — byte-identical to Phase 3.
      expect(injectRoute).toHaveBeenCalledTimes(13);
      const [, content] = injectScript.mock.calls.find(([stage]) => stage === 'head-inline')!;
      expect(content).not.toContain('"recovery"');
    });

    it('with recovery.enabled:false explicitly, injects neither the route nor the widget script, and __cafConfig carries no recovery key', () => {
      const { injectRoute, injectScript } = runSetupHook(validUserConfig({ recovery: { enabled: false } }));
      expect(routeInjected(injectRoute)).toBe(false);
      expect(widgetInjected(injectScript)).toBe(false);
      expect(injectRoute).toHaveBeenCalledTimes(13);
      const [, content] = injectScript.mock.calls.find(([stage]) => stage === 'head-inline')!;
      expect(content).not.toContain('"recovery"');
    });

    it('with recovery.enabled:true, injects the unsubscribe route + widget script with correct entrypoints, and __cafConfig carries the {enabled, consentMode} subset', () => {
      const { injectRoute, injectScript } = runSetupHook(
        validUserConfig({ recovery: { enabled: true, consentMode: 'checkbox' } }),
      );
      expect(injectRoute).toHaveBeenCalledWith({
        pattern: '/api/forms/recovery-unsubscribe',
        entrypoint: 'cool-astro-forms/server/routes/recovery-unsubscribe.js',
      });
      expect(injectScript).toHaveBeenCalledWith('page', expect.stringContaining('cool-astro-forms/client/recovery-widget.js'));
      // 13 base + 1 recoveryActive-gated route.
      expect(injectRoute).toHaveBeenCalledTimes(14);
      const [, content] = injectScript.mock.calls.find(([stage]) => stage === 'head-inline')!;
      expect(content).toContain('"recovery":{"enabled":true,"consentMode":"checkbox"}');
    });

    it('with recovery.enabled:true and consentMode omitted, __cafConfig defaults the subset to consentMode:"auto"', () => {
      const { injectScript } = runSetupHook(validUserConfig({ recovery: { enabled: true } }));
      const [, content] = injectScript.mock.calls.find(([stage]) => stage === 'head-inline')!;
      expect(content).toContain('"recovery":{"enabled":true,"consentMode":"auto"}');
    });

    it('__cafConfig never carries delayMins or a recovery/Drive secret substring — recovery ON (T-04-30)', () => {
      const { injectScript } = runSetupHook(validUserConfig({ recovery: { enabled: true, delayMins: 90 } }));
      const [, content] = injectScript.mock.calls.find(([stage]) => stage === 'head-inline')!;
      expect(content).not.toContain('delayMins');
      expect(content).not.toMatch(/GOOGLE_DRIVE|DRIVE_SECRET|driveSecret|recoverySecret|refreshToken/i);
    });

    it('__cafConfig never carries delayMins or a recovery/Drive secret substring — recovery OFF (T-04-30)', () => {
      const { injectScript } = runSetupHook();
      const [, content] = injectScript.mock.calls.find(([stage]) => stage === 'head-inline')!;
      expect(content).not.toContain('delayMins');
      expect(content).not.toMatch(/GOOGLE_DRIVE|DRIVE_SECRET|driveSecret|recoverySecret|refreshToken/i);
    });

    // -----------------------------------------------------------------
    // Per-form recovery override matrix delta (04-10 gap closure —
    // RCV-01/ROADMAP Phase 4 SC4 "per-form flag"). RED-first: written
    // before buildPublicConfig ships `disabledForms`.
    // -----------------------------------------------------------------

    it('one form with recovery.enabled:false: __cafConfig.recovery.disabledForms carries exactly that form id', () => {
      const { injectScript } = runSetupHook(
        validUserConfig({
          recovery: { enabled: true },
          forms: {
            'contact-form': { notifyTo: 'owner@example.com', capture: { deny: ['ssn'] } },
            'newsletter-form': { notifyTo: 'other@example.com', recovery: { enabled: false } },
          },
        }),
      );
      const [, content] = injectScript.mock.calls.find(([stage]) => stage === 'head-inline')!;
      expect(content).toContain('"recovery":{"enabled":true,"consentMode":"auto","disabledForms":["newsletter-form"]}');
    });

    it('no per-form overrides: __cafConfig.recovery has NO disabledForms key at all (omitted, not [])', () => {
      const { injectScript } = runSetupHook(validUserConfig({ recovery: { enabled: true, consentMode: 'checkbox' } }));
      const [, content] = injectScript.mock.calls.find(([stage]) => stage === 'head-inline')!;
      expect(content).toContain('"recovery":{"enabled":true,"consentMode":"checkbox"}');
      expect(content).not.toContain('disabledForms');
    });

    it('route/script injection is UNCHANGED by a per-form override — still injected while the site switch is on', () => {
      const { injectRoute, injectScript } = runSetupHook(
        validUserConfig({
          recovery: { enabled: true },
          forms: {
            'contact-form': { notifyTo: 'owner@example.com', recovery: { enabled: false } },
          },
        }),
      );
      expect(routeInjected(injectRoute)).toBe(true);
      expect(widgetInjected(injectScript)).toBe(true);
    });

    it('route/script injection stays absent when the site switch is OFF, even with a per-form enabled:true override', () => {
      const { injectRoute, injectScript } = runSetupHook(
        validUserConfig({
          recovery: { enabled: false },
          forms: {
            'contact-form': { notifyTo: 'owner@example.com', recovery: { enabled: true } },
          },
        }),
      );
      expect(routeInjected(injectRoute)).toBe(false);
      expect(widgetInjected(injectScript)).toBe(false);
    });

    // ---------------------------------------------------------------------
    // Drive (DRV-01) — host-called inside recordSubmission, NOT injected by
    // this integration. Asserted independently of GOOGLE_DRIVE_* presence:
    // the integration's route surface must never grow because of Drive keys
    // (T-04-32 boundary — Drive's own env-gating lives in drive.ts).
    // ---------------------------------------------------------------------
    describe('Drive (DRV-01) — host-called, contributes zero injected routes', () => {
      const DRIVE_ENV_VARS = [
        'GOOGLE_DRIVE_CLIENT_ID',
        'GOOGLE_DRIVE_CLIENT_SECRET',
        'GOOGLE_DRIVE_REFRESH_TOKEN',
      ] as const;
      const ORIGINAL: Record<string, string | undefined> = {};
      for (const key of DRIVE_ENV_VARS) ORIGINAL[key] = process.env[key];

      afterEach(() => {
        for (const key of DRIVE_ENV_VARS) {
          if (ORIGINAL[key] === undefined) delete process.env[key];
          else process.env[key] = ORIGINAL[key];
        }
      });

      it('injects the unchanged 13-route base when GOOGLE_DRIVE_* keys are absent', () => {
        for (const key of DRIVE_ENV_VARS) delete process.env[key];
        const { injectRoute } = runSetupHook();
        expect(injectRoute).toHaveBeenCalledTimes(13);
      });

      it('injects the unchanged 13-route base even when all three GOOGLE_DRIVE_* keys are present', () => {
        process.env.GOOGLE_DRIVE_CLIENT_ID = 'client-id';
        process.env.GOOGLE_DRIVE_CLIENT_SECRET = 'client-secret';
        process.env.GOOGLE_DRIVE_REFRESH_TOKEN = 'refresh-token';
        const { injectRoute } = runSetupHook();
        expect(injectRoute).toHaveBeenCalledTimes(13);
      });

      it('never leaks a GOOGLE_DRIVE_* value into __cafConfig even when the keys are present', () => {
        process.env.GOOGLE_DRIVE_CLIENT_ID = 'client-id';
        process.env.GOOGLE_DRIVE_CLIENT_SECRET = 'super-secret-drive-value';
        process.env.GOOGLE_DRIVE_REFRESH_TOKEN = 'super-secret-refresh-value';
        const { injectScript } = runSetupHook();
        const [, content] = injectScript.mock.calls.find(([stage]) => stage === 'head-inline')!;
        expect(content).not.toContain('super-secret-drive-value');
        expect(content).not.toContain('super-secret-refresh-value');
      });
    });

    // ---------------------------------------------------------------------
    // Storage backend selection (05-04, ADPT-01) — read server-side only
    // (getStorageAdapter/registerRuntimeConfig); buildPublicConfig is NEVER
    // extended with a storage field under either backend (T-05-11 no-leak
    // invariant, mirrors the Drive/Turnstile-secret-absence tests above).
    // ---------------------------------------------------------------------
    describe('storage backend selection (ADPT-01) — never leaks to the client', () => {
      it('never leaks a storage kind/url/token into __cafConfig under the default sqlite backend', () => {
        const { injectScript } = runSetupHook(validUserConfig({ storage: { kind: 'sqlite' } }));
        const [, content] = injectScript.mock.calls.find(([stage]) => stage === 'head-inline')!;
        expect(content).not.toContain('"storage"');
        expect(content).not.toContain('sqlite');
      });

      it('never leaks a storage kind/url/token into __cafConfig under storage.kind: "turso", even with CAF_TURSO_* set', () => {
        process.env.CAF_TURSO_DATABASE_URL = 'libsql://example.turso.io';
        process.env.CAF_TURSO_AUTH_TOKEN = 'super-secret-turso-token';
        const { injectScript } = runSetupHook(validUserConfig({ storage: { kind: 'turso' } }));
        const [, content] = injectScript.mock.calls.find(([stage]) => stage === 'head-inline')!;
        expect(content).not.toContain('"storage"');
        expect(content).not.toContain('turso');
        expect(content).not.toContain('super-secret-turso-token');
        delete process.env.CAF_TURSO_DATABASE_URL;
        delete process.env.CAF_TURSO_AUTH_TOKEN;
      });
    });
  });
});
