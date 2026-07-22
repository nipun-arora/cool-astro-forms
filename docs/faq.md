# FAQ

Short, self-contained answers to the questions we get most. Each answer stands on its own.

## Does cool-astro-forms work with static Astro sites?

No. It requires Astro 6 or 7 with `output: 'server'` and a server-capable adapter (for example `@astrojs/node`). The capture endpoint, admin UI, and payment routes are server routes; a fully static site has nothing for them to run on. If your site is static today, adding the Node adapter in server mode is the one prerequisite.

## How does form-abandonment capture work?

An injected client script stages field values as the visitor types (passwords and card-shaped fields are never staged). When one of four triggers fires (exit intent, external-link click, `beforeunload`, or the tab going hidden), the staged fields POST to `/api/forms/abandon`. The server gates the save with an origin check, rate limit, honeypot, and an email-or-phone requirement, then writes one SQLite row with the visitor's journey trail and IP geolocation attached and sends you a notification email.

## How is cool-astro-forms different from Formspree or Netlify Forms?

Formspree and Netlify Forms are hosted services that receive completed submissions; your data lives on their servers and abandoned entries are never seen. cool-astro-forms is self-hosted (your SQLite file, your SMTP), and it captures the visitors who never hit submit, which hosted endpoints cannot do. It also ships the layer around capture: recovery emails, quote payments over Stripe and PayPal, and a self-hosted admin UI.

## Does cool-astro-forms send my data to any external service?

Not by default. The default deployment is a SQLite file on your server plus your existing SMTP credentials for email. Optional modules only activate when you set their keys: Stripe/PayPal for payments, Google Drive for file uploads, Cloudflare Turnstile for spam checks, and an IP geolocation provider (configurable, with a public default).

## Does it support payments?

Yes, quote-first payments: create a payment link from any entry in the admin, or share `/forms-pay?amount=200` directly. The server recomputes every total (client values are preview only), checkout runs on Stripe Checkout or PayPal, and a payment is marked paid only by a signature-verified provider webhook. The pay page submits over fetch and hops to checkout as a plain GET, so edge bot-challenges cannot break it.

## Is it free?

Yes. MIT licensed, no hosted tier, no per-site license, no telemetry. The full feature set is in the open-source package.

## Does it build forms for me?

No. You keep your own `<form>` markup and tag it with one `data-caf` attribute. cool-astro-forms instruments forms you already have; a drag-and-drop builder is the one thing it deliberately does not do.

## Can I use it on serverless hosts?

Yes, with the Turso/libSQL storage backend instead of the default SQLite file, since serverless filesystems are ephemeral. See [serverless.md](./serverless.md) for the storage switch, explicit-secrets mode, and cold-start-safe rate limiting.

## Is it GDPR-friendly?

The mechanics are built in: `retentionDays` auto-purge, `purgeVisitor()` erasure for subject-access requests, optional `requireConsent` gating before any capture, and one-click unsubscribe on recovery emails that is honored forever. See [gdpr.md](./gdpr.md) for how each maps to the regulation.

## Is it production-ready?

It runs in production on a live services business, and versions 0.1.2 through 0.1.10 each shipped from a real finding there (persistence across redeploys, proxy CSRF behavior, edge bot-challenges on payment submits). 1,102 unit tests and a Playwright e2e suite cover it, and the README quickstart is verified against a packed tarball on every release.
