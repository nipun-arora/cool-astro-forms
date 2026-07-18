# Contributing to Cool Astro Forms

Thanks for looking at this project. This is a solo-maintained, local-first
repository — there is intentionally no CI-gated PR workflow. The notes below
explain how the project is actually run so a contribution lands cleanly.

## Clean-room statement

This project is an independent, clean-room reimplementation of
form-abandonment capture, user-journey tracking, notification, payment, and
file-storage behaviors commonly found in WordPress form plugins and their
addons. No source code from WPForms, WPForms Pro, or any WPForms addon
(GPL-licensed) has been copied, translated, or otherwise incorporated into
this repository — see [NOTICE](./NOTICE) for the full statement.

Any contribution must uphold this: do not port, transcribe, or paraphrase
code from WPForms or any other GPL-licensed forms plugin into this codebase.
Product names ("WordPress", "WPForms") may only be used in a nominative,
descriptive sense (e.g. migration-comparison copy) — never implying
affiliation, sponsorship, or endorsement.

## Local-first workflow (Rule 13)

There is no required GitHub Actions check on pull requests and no merge
queue. Everything that gates a change runs on your own machine:

```bash
npm run typecheck                                    # tsc --noEmit
npm test                                              # vitest run, packages/astro-forms
npm run build                                         # tsup + tsc --emitDeclarationOnly
npm run test:e2e                                      # Playwright, full suite
npm run verify:quickstart                             # real npm pack + scratch-install + abandon roundtrip
npm pack --dry-run -w packages/astro-forms            # confirm the tarball contents
npm run audit:prod                                    # npm audit --omit=dev --audit-level=high
```

Run the full chain above (the same chain the phase gate runs) before opening
a PR. If everything is green locally, the change is ready for review — there
is no separate CI gate to wait on.

`.github/workflows/publish.yml` is the ONE exception to "no GitHub Actions in
this repo," and it exists solely because `npm publish --provenance` requires
GitHub-hosted OIDC (the only identity provider npm's provenance attestation
currently trusts). It is `workflow_dispatch`-only, never triggers on push or
pull_request, and is not a test runner or deploy gate — see the header
comment in that file for the full rationale.

## Running tests

- Unit tests: `npm test -w packages/astro-forms -- --run` (Vitest, colocated
  `*.test.ts` files next to the source they cover).
- CLI end-to-end: `npm test -w packages/astro-forms -- --run src/cli.test.ts`
  (spawns the built CLI against a temp directory — no network).
- Storage adapter contract: both `sqlite.test.ts` and `turso.test.ts` run the
  same `runStorageContract` suite; a new storage backend must pass it
  unmodified.
- Playwright e2e: `npm run test:e2e` (exercises the demo app in
  `apps/playground`).
- Quickstart proof: `npm run verify:quickstart` — a real `npm pack`, a fresh
  scratch Astro project (never this repo's own `node_modules`), a real
  install, build, and dev server, and a real abandonment POST asserted
  against the resulting SQLite row. The README quickstart section is written
  to match this script exactly; if they ever disagree, the script is right.

## Publishing checklist (owner-gated — not part of a normal contribution)

Publishing to npm and creating the public GitHub repository are owner-gated
actions, not something a contribution triggers. Before `npm publish` is ever
run, the following must all be true:

1. The full local gate above is green (typecheck, unit, e2e, build,
   quickstart, `npm pack --dry-run`, prod audit).
2. **A full security audit has been run and its findings addressed.** This
   is a BLOCKING precondition, not optional hygiene — it covers secrets
   handling, dependency risk, OWASP-class issues, and STRIDE threats on the
   sensitive surfaces this package ships: payment/webhook HMAC verification
   (Stripe/PayPal), the public unsubscribe/recovery route, Google Drive
   OAuth, and admin-session auth. Do not publish without it.
3. `.github/workflows/publish.yml` is dispatched by hand (`workflow_dispatch`
   with the `confirm: publish` input) by a maintainer who has personally
   confirmed steps 1 and 2 — never automated, never triggered by a push.
4. The `repository`, `homepage`, and `bugs` URLs in `package.json` point at
   the canonical repository (`github.com/nipun-arora/cool-astro-forms`).

## No AI-attribution policy

This project does not carry AI-tool attribution anywhere — not in commit
trailers, code comments, file headers, or documentation. Please do not add
authorship trailers crediting an AI assistant, banner text naming the tool
that produced a change, or any similar attribution string to a contribution.
