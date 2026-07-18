import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    integration: 'src/integration.ts',
    // `cli` is the `bin` entry (package.json) for `npx cool-astro-forms
    // init` (CLI-01, D5). esbuild preserves a leading `#!/usr/bin/env node`
    // hashbang for an entry's OWN output only when the source file starts
    // with one — src/cli.ts's literal first line — so dist/cli.js comes
    // out executable-shaped with no tsup `banner` needed (a banner would
    // prepend to EVERY emitted file, corrupting turso.js/routes/client
    // scripts that must never carry a shebang).
    cli: 'src/cli.ts',
    'server/index': 'src/server/index.ts',
    'server/routes/abandon': 'src/server/routes/abandon.ts',
    'server/routes/canary': 'src/server/routes/canary.ts',
    'server/routes/form-started': 'src/server/routes/form-started.ts',
    'server/routes/admin/auth': 'src/server/routes/admin/auth.ts',
    'server/routes/admin/entry-action': 'src/server/routes/admin/entry-action.ts',
    'server/routes/admin/export-csv': 'src/server/routes/admin/export-csv.ts',
    'server/routes/admin/export-db': 'src/server/routes/admin/export-db.ts',
    'server/routes/admin/payment-action': 'src/server/routes/admin/payment-action.ts',
    'server/routes/webhooks/stripe': 'src/server/routes/webhooks/stripe.ts',
    'server/routes/webhooks/paypal': 'src/server/routes/webhooks/paypal.ts',
    'server/routes/pay/create-session': 'src/server/routes/pay/create-session.ts',
    'server/routes/recovery-unsubscribe': 'src/server/routes/recovery-unsubscribe.ts',
    'server/admin/_shared': 'src/server/admin/_shared.ts',
    'server/middleware': 'src/server/middleware.ts',
    'server/storage/turso': 'src/server/storage/turso.ts',
    'server/test-hooks': 'src/server/test-hooks.ts',
    'client/capture': 'src/client/capture.ts',
    'client/journey': 'src/client/journey.ts',
    'client/turnstile-loader': 'src/client/turnstile-loader.ts',
    'client/recovery-widget': 'src/client/recovery-widget.ts',
  },
  format: ['esm'],
  // Declarations are emitted by `tsc --emitDeclarationOnly` in the build
  // script: tsup's dts worker requires the JavaScript TypeScript compiler
  // API, which the native typescript@7 toolchain no longer ships.
  dts: false,
  clean: true,
  treeshake: true,
  // 'virtual:cool-astro-forms/config' is only ever resolved by Vite at the
  // HOST site's build time (via the inline plugin the coolForms() integration
  // registers through updateConfig — src/integration.ts). Our own package
  // build must leave the specifier unresolved in the emitted bundle rather
  // than trying (and failing) to resolve it itself.
  // '@libsql/client' is an OPTIONAL peer dep (Phase 5 Plan 03, ADPT-01) —
  // its native libsql binding must never be bundled, same treatment as
  // better-sqlite3: a default sqlite host that never imports turso.js gets
  // zero Turso code (and zero @libsql/client resolution attempt) in its bundle.
  external: ['better-sqlite3', 'astro', 'virtual:cool-astro-forms/config', 'stripe', '@libsql/client'],
});
