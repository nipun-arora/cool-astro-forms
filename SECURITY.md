# Security policy

## Supported versions

Only the latest release published to npm receives security fixes. The 0.1.x line moves quickly; upgrade to the newest version before reporting.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private reporting instead: **Security tab > Report a vulnerability** on this repository. You will get a response within a few days.

Include what you can: the affected route or module (payments webhooks, admin auth, the abandon endpoint, Drive uploads, unsubscribe links), a reproduction, and the version you tested.

## Scope notes

- Payment state changes only through provider webhooks whose signatures are verified (Stripe HMAC, PayPal verification API). A bypass of that verification is the highest-severity report this package can receive.
- `/forms-admin` is gated by the `FORMS_ADMIN_PASSWORD` env var over a hashed session cookie. Weak deployments (no HTTPS, shared passwords) are host configuration, not package vulnerabilities, but auth-logic flaws absolutely are.
- The pre-publish process includes a blocking security audit; see [CONTRIBUTING.md](./CONTRIBUTING.md) for that checklist.
