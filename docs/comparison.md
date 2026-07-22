# How cool-astro-forms compares

Standalone version of the README comparison, kept honest: every row names a capability, not a vendor. cool-astro-forms is an independent clean-room implementation, not affiliated with any commercial form product.

## The one-line difference

Hosted form services and WordPress form plugins receive submissions. cool-astro-forms also captures the visitors who typed and left without submitting, on your own infrastructure, and ships the operations layer around that lead: recovery emails, quote payments, and a self-hosted admin.

## Capability table

| Capability | WordPress forms stack (Pro + addons) | Hosted form SaaS | Self-hosted OSS form backends | cool-astro-forms |
|---|---|---|---|---|
| Abandonment / partial-entry capture | Paid addon | Not offered | Not offered | Built in |
| Automated lead-recovery emails | Via automation addons | Not offered | Not offered | Built in |
| Stripe / PayPal quote payments | Paid addons | Varies by plan | Not offered | Built in |
| Per-visitor journey + traffic source | Via analytics addons | Limited | Not offered | Built in |
| Admin UI + analytics | WordPress admin | Their dashboard | Minimal or none | `/forms-admin` |
| Where your data lives | Your WP database | Their servers | Your infrastructure | Your SQLite file |
| Form builder / markup generation | Built in | Built in | Rarely | Not offered (bring your own form) |
| Runtime requirement | PHP + WordPress | None (their servers) | Varies | Astro 6/7 server output |
| Cost | Annual per-site license | Monthly plan | Free | Free, MIT |

## When NOT to choose cool-astro-forms

- Your site is fully static and must stay that way (no server output, no server routes).
- You want a drag-and-drop form builder; this package instruments forms you already have.
- You want a zero-ops hosted inbox and don't care about abandoned leads or data ownership.

## When it is the right fit

- You run Astro with server output (or can add `@astrojs/node`) and want leads you currently lose: the visitors who type and leave.
- You left WordPress and miss the paid abandonment-capture addons.
- You want form data, payments, and lead ops on your own box: one SQLite file, your SMTP, MIT license.
