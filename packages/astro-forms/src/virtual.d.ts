/**
 * Ambient declaration for the virtual config module. Provided at build time
 * by the coolForms() integration (Plan 08); the injected abandon route
 * imports it to reach the host's resolved, parsed CoolFormsConfig.
 *
 * `trailingSlash` rides along (Phase 2, checker B1) so server code (the
 * admin middleware guard, adminUrl()) can compute client-visible admin URLs
 * that match the host's Astro `trailingSlash` setting without re-deriving it.
 * `cspEnabled` (0.1.15) is true when the host enabled Astro's `security.csp`;
 * the admin pages read it before touching `Astro.csp`.
 */
declare module 'virtual:cool-astro-forms/config' {
  import type { CoolFormsConfig } from './config.js';

  const config: CoolFormsConfig & { trailingSlash?: 'always' | 'never' | 'ignore'; cspEnabled?: boolean };
  export default config;
}
