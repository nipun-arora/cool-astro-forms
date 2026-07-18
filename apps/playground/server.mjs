// Minimal Express wrapper booting the BUILT astro artifact — mirrors
// a Phusion Passenger deployment shape (see docs/ARCHITECTURE.md
// A2): `@astrojs/node` in 'middleware' mode exports a Connect-style
// `handler` from the compiled `dist/server/entry.mjs`, which any Express
// app can mount directly. This is intentionally NOT a production-grade
// wrapper (no security headers, no redirects, no static-asset caching
// policy) — the playground only needs to prove the injected `/api/forms/*`
// routes survive this exact adapter + Express boundary, not replicate a
// full production stack.
import express from 'express';
import { handler } from './dist/server/entry.mjs';

// Same port the coolForms() config's siteUrl is baked to at build time
// (astro.config.mjs) — the abandon route's same-origin check only passes
// when this wrapper serves on that exact origin.
const PORT = process.env.PORT ?? 4321;

const app = express();
app.use(express.static('dist/client'));
app.use(handler);

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[playground] built artifact listening on http://localhost:${PORT}`);
});
