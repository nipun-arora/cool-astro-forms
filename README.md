# cool-astro-forms

Form-abandonment capture for Astro: save the lead when a visitor types into your form and leaves without submitting. A self-hosted form backend with **zero external dependencies by default** — SQLite file storage plus your existing SMTP env vars — proven by **1,000+ unit tests** and a Playwright e2e suite.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

![cool-astro-forms admin](.github/assets/hero-admin.png)

`cool-astro-forms` instruments the Astro forms you already have; it is not a form builder. It rebuilds the lead-capture layer WordPress sites pay for in Pro-tier addons — abandonment capture, user-journey tracking, quote-first Stripe/PayPal payments, Google Drive uploads, automated lead-recovery emails — as one MIT Astro integration for server-output sites.

## Quickstart

Every step below is executed end-to-end by [`scripts/verify-quickstart.mjs`](./scripts/verify-quickstart.mjs): a real `npm pack` tarball installed into a scratch Astro project, built, served, and hit with a real abandon POST that lands a row in SQLite. If this section and that script ever disagree, the script is right.

### 1. Install

```bash
npm install cool-astro-forms @astrojs/node
```

Optional scaffold first — `init` writes a full `.env.example` (every optional env var this package reads) and appends `data/` to `.gitignore`:

```bash
npx cool-astro-forms init
```

`astro add cool-astro-forms` also works, but it inserts a **bare** `coolForms()` call that fails validation on your next `astro dev`/`astro build` — `siteId`, `siteUrl`, and each form's `notifyTo` are required, with no defaults. Replace the bare call with the snippet below.

### 2. Configure `astro.config.mjs`

Every field shown here is required:

```js
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import coolForms from 'cool-astro-forms';

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  integrations: [
    coolForms({
      siteId: 'my-site',
      siteUrl: 'http://localhost:4321', // must match the origin you actually serve on — swap for your real domain once deployed
      forms: {
        contact: { notifyTo: 'owner@example.com' },
      },
    }),
  ],
});
```

### 3. Tag a form

Add a `data-caf="<formId>"` attribute — no other markup changes are needed:

```html
<form data-caf="contact" method="post" action="/api/contact">
  <input type="text" name="name" />
  <input type="email" name="email" />
  <button type="submit">Send</button>
</form>
```

### 4. Build and run

```bash
npm run build
node dist/server/entry.mjs
```

The capture route is auto-injected at `/api/forms/abandon`. A visitor who types into that form and leaves lands a row in `data/forms.db` and a notification email at `notifyTo`. That is the entire adoption contract — one `coolForms()` call, one attribute. Payments, Drive uploads, lead recovery, and the admin UI stay completely inert until you opt in.

## Features

| Feature | Detail |
|---|---|
| Abandonment capture | Exit-intent, `beforeunload`, and tab-hidden triggers; dedupe window; per-form overrides |
| User-journey tracking | Per-visitor page trail, shown on each entry's timeline |
| IP geolocation | Every saved entry enriched (`GEO_PROVIDER` override supported); a failed lookup never blocks the save |
| `/forms-admin` UI | Entries, abandoned, payments, analytics funnel, CSV + `.db` export; server-rendered, password-protected |
| Payments | Quote-first Stripe Checkout + PayPal; shareable `/forms-pay?amount=` links; server-computed fees; inbound webhooks as the sole payment truth |
| Spam control | Cloudflare Turnstile (soft-fail), honeypot, rate limiting |
| File uploads | Google Drive via raw REST (no SDK) with email-attachment fallback — files are never lost |
| Lead recovery | One automated follow-up email per visitor, one-click unsubscribe honored forever |
| Outbound webhooks | Signed (`X-Caf-Signature`): `entry.submitted`, `entry.abandoned`, `payment.paid` |
| GDPR mechanics | `retentionDays` purge, `purgeVisitor()` erasure, `requireConsent` gating |
| Storage | SQLite file by default; optional Turso/libSQL for serverless hosts ([docs/serverless.md](./docs/serverless.md)) |

## Leaving WordPress? A WPForms alternative for Astro

Form-abandonment capture is a proven, monetized feature on WordPress with no open-source equivalent for Astro or static sites — that gap is the reason this package exists. This is an independent, clean-room implementation, not affiliated with or endorsed by WPForms or any vendor named here (see [NOTICE](./NOTICE)); the table maps the features you lose leaving WordPress to what this provides:

| Capability | WordPress forms stack (Pro + addons) | Hosted form SaaS | Self-hosted OSS form backends | cool-astro-forms |
|---|---|---|---|---|
| Abandonment / partial-entry capture | Paid addon | Not offered | Not offered | Built in |
| Automated lead-recovery emails | Via automation addons | Not offered | Not offered | Built in |
| Stripe / PayPal quote payments | Paid addons | Varies by plan | Not offered | Built in |
| Admin UI + analytics | WordPress admin | Their dashboard | Minimal or none | `/forms-admin` |
| Where your data lives | Your WP database | Their servers | Your infrastructure | Your SQLite file |
| Cost | Annual per-site license | Monthly plan | Free | Free, MIT |

One deliberate trade-off: this package captures and manages form data — it does not generate form markup. A drag-and-drop form builder is the single WordPress feature it declines to replace.

## Docs

- [`docs/payments.md`](./docs/payments.md) — Stripe/PayPal setup, the `/forms-pay` contract, fee caveats, webhook receiver recipes
- [`docs/drive.md`](./docs/drive.md) — Google Drive uploads: one-time consent, the 7-day token-expiry pitfall, the fallback contract
- [`docs/recovery.md`](./docs/recovery.md) — lead-recovery emails: consent modes, per-form scoping, unsubscribe mechanics
- [`docs/serverless.md`](./docs/serverless.md) — Turso/libSQL storage, explicit secrets, cold-start-safe rate limiting
- [`docs/gdpr.md`](./docs/gdpr.md) — each retention, erasure, and consent mechanic mapped to the GDPR concept it serves

## FAQ

### How do I capture abandoned form entries on an Astro site?
Tag the form with `data-caf` and configure `coolForms()` — the injected client script stages typed values and POSTs them to `/api/forms/abandon` on exit-intent, `beforeunload`, or tab-hidden. The entry lands in SQLite with the visitor's journey trail and geolocation attached.

### What is a self-hosted alternative to WPForms for Astro or static sites?
This package: it rebuilds the WPForms-Pro-class lead-capture layer — abandonment capture, payments, uploads, recovery emails, admin UI — as one MIT Astro integration with no per-site license and no hosted service.

### How can I track partial form submissions without WordPress?
Every abandoned entry stores the fields typed so far, the last-edited field, and a `form_started` ping. `/forms-admin/analytics` turns those into a captured→converted funnel with abandonment rate and top drop-off fields.

### How do I add Stripe or PayPal quote payments to an Astro contact form?
Create a pay-link from any entry in the admin, or share `/forms-pay?amount=200` with no entry at all. The server recomputes every total, and inbound webhooks are the sole source of payment truth ([docs/payments.md](./docs/payments.md)).

### Is there an open-source form backend with an admin UI for Astro?
Yes — `/forms-admin` ships in this package: entries, abandoned leads, payments, analytics, CSV and `.db` export, enabled by a single `FORMS_ADMIN_PASSWORD` env var. Server-rendered, no client framework.

### How do I add file uploads to an Astro form without a SaaS?
Uploads land in your own Google Drive over raw REST (no SDK dependency), with an email-attachment fallback so a Drive failure never loses a file ([docs/drive.md](./docs/drive.md)).

## Contributing

Test and build commands, the clean-room statement, and the blocking pre-publish checklist (including a required security audit) live in [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT — see [LICENSE](./LICENSE).
