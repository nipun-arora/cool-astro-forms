# Google Drive file uploads

Real-bytes file uploads (assignments, attachments, any file a visitor
submits with a form) land in the owner's own Google Drive instead of being
lost or bloating email attachments — off by default, zero new runtime
dependencies (raw Drive v3 REST via `fetch`, no `googleapis` SDK — D5).

Nothing below is required to use the rest of the package. Without the three
`GOOGLE_DRIVE_*` environment variables set, the Drive module is **fully
inert**: `driveConfigured()` returns false, `uploadFilesToDrive()` never
makes a network call, and every file degrades straight to the fallback path
described in §3 — byte-identical to a pre-Phase-4 install.

## 1. One-time consent setup

Drive uploads authenticate as a single Google account you control (the
owner's own Drive, not a shared service) via OAuth refresh token — minted
**once**, on your own machine, with the bundled CLI:

```bash
export GOOGLE_DRIVE_CLIENT_ID=...
export GOOGLE_DRIVE_CLIENT_SECRET=...
node packages/astro-forms/scripts/get-drive-token.mjs
```

Before running it:

1. In [Google Cloud Console](https://console.cloud.google.com/), create or
   reuse a project and enable the **Google Drive API**.
2. Create an OAuth client of type **"Desktop app"** (not "Web application" —
   the script uses the loopback-redirect flow, `http://127.0.0.1:<ephemeral
   port>`, which only a Desktop-app client type permits). Copy its client ID
   and secret.
3. Export `GOOGLE_DRIVE_CLIENT_ID` / `GOOGLE_DRIVE_CLIENT_SECRET` and run the
   script above. It opens a Google consent URL in your terminal — visit it,
   approve access, and the script prints `GOOGLE_DRIVE_REFRESH_TOKEN=...`.

Set all three (`GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET`,
`GOOGLE_DRIVE_REFRESH_TOKEN`) in your deploy secrets — handle them exactly
like `STRIPE_SECRET_KEY`/`PAYPAL_CLIENT_SECRET`: long-lived server secrets,
**never** committed to source control.

| Variable | Required | Purpose |
|---|---|---|
| `GOOGLE_DRIVE_CLIENT_ID` | To enable Drive | OAuth client ID from your "Desktop app" client. |
| `GOOGLE_DRIVE_CLIENT_SECRET` | To enable Drive | OAuth client secret. |
| `GOOGLE_DRIVE_REFRESH_TOKEN` | To enable Drive | Minted once by `get-drive-token.mjs`. All three must be set together — any one missing leaves Drive fully inert. |

### *** ACTION REQUIRED — the "Testing → Production" toggle ***

Google **silently expires every refresh token this app issues after exactly
7 days** while the OAuth consent screen is left in "Testing" publishing
status. Uploads will work fine for a week and then start failing with
`invalid_grant` — with no warning beforehand.

Immediately after minting your refresh token: in Google Cloud Console, go to
**APIs & Services → OAuth consent screen** and set the publishing status to
**"In Production"**. `drive.file` (the only scope this package ever
requests) is a **non-sensitive** scope, so this is a single toggle with
**no Google review process** — do it before relying on the token for
anything real. The consent CLI's own printed output repeats this warning.

### Don't hand-create the root folder

This package requests only the `drive.file` scope — the app can only see
files and folders **it created itself**. Do not create the Drive root folder
(`drive.rootFolderName`, default `cool-astro-forms`) by hand in the Drive UI
first. Let the app create it on its own first upload; if you create it
yourself, `drive.file`'s restricted visibility means the app will silently
create a **duplicate** folder instead of finding your hand-made one.

## 2. Config

```ts
coolForms({
  // ...
  drive: {
    linkAccess: 'private',       // 'private' (default, safe) | 'anyone'
    rootFolderName: 'cool-astro-forms',
    attachmentFallbackMaxBytes: 10_485_760, // ~10MB
  },
});
```

| Field | Default | Purpose |
|---|---|---|
| `linkAccess` | `'private'` | See the caveat below. **The package default is `'private'`** — you must opt in to `'anyone'` explicitly. |
| `rootFolderName` | `cool-astro-forms` | The `/<root>` folder level under which everything is organized. |
| `attachmentFallbackMaxBytes` | `10485760` (~10MB) | Ceiling for the email-attachment fallback (§3) when a Drive upload fails — a conservative SMTP cap. |

Uploaded files are organized as:

```
/<rootFolderName>/<siteId>/<YYYY-MM>/<entryId>/<filename>
```

Folder creation is idempotent (Drive tolerates duplicate names; this package
lists-then-creates, per level, inside per-entry serialization) — a retried
or concurrent upload for the same entry never creates duplicate folders.

### The `linkAccess:'anyone'` caveat — verbatim

> With `'anyone'`, client-submitted files — assignments, personal
> information, anything a visitor attaches — are reachable by **anyone
> holding the URL**. There is no login check on the link itself.

This is a real, owner-facing tradeoff, not a hypothetical: with the safe
`'private'` default, a `webViewLink` your notification email carries opens
correctly for **you** (the Drive account owner) but shows visitors a
Google "Request access" wall if they click it too — an intentional
friction, not a bug. Setting `linkAccess:'anyone'` trades that safety for
convenience (a link that opens for literally anyone who has it, including a
visitor forwarding the email or reading it from a compromised mailbox). Only
opt in if you have made that call deliberately for your own use case; this
package makes no legal-compliance claim about that choice on your behalf.

## 3. The host integration contract

`recordSubmission()` is the **only** thing that talks to Drive. There is no
separate "Drive route" — Drive activates automatically, inside your own
submit endpoint, whenever you pass real file bytes:

```ts
import { recordSubmission } from 'cool-astro-forms/server';
import type { FileInput, FileUploadOutcome } from 'cool-astro-forms/server';

// inside your own POST handler
const result = await recordSubmission({
  siteId: 'your-site',
  formId: 'contact',
  fields,
  files: [{ filename: 'assignment.pdf', buffer, mimeType: 'application/pdf' }],
  request,
});

if (result.ok) {
  for (const outcome of result.files ?? []) {
    // YOUR OWN email code branches on the outcome — see below.
  }
}
```

`FileInput` (what you send in) is real bytes:

```ts
interface FileInput {
  filename: string;
  buffer: Buffer;
  mimeType?: string;
}
```

`FileUploadOutcome` (what you get back, one per file) is exactly one of
three shapes:

```ts
interface FileUploadOutcome {
  filename: string;
  driveLink?: string;         // upload succeeded — LINK it in your email
  fallbackBuffer?: Buffer;    // Drive failed/disabled, file fits the cap — ATTACH it yourself
  fallbackTooLarge?: boolean; // Drive failed/disabled AND the file exceeds the cap — neither; the submission is STILL saved
}
```

**The package sends no email of its own on the real-submission path.** This
is a deliberate design decision (CONTEXT D1), not an oversight: the package
has never emailed on real submissions (only the abandon and payment paths
email), and a real host's own submit endpoint already builds its own
notification email with its own branding and layout — Drive just hands back
the outcome for that email code to branch on.

### DRV-02 — a submission is never lost

Every Drive failure mode — an auth failure, a non-2xx response, a network
error, a stalled connection that times out, an over-ceiling file, or the
module simply being unconfigured — degrades to a fallback outcome. The
submission **entry itself is always saved**, regardless of what happens to
the file. `recordSubmission()` never throws because of a Drive problem; the
entry a visitor filled in never disappears because Drive was briefly down.

## 4. What's deferred to a live drill

The live Drive round-trip — a real file landing in
`/<root>/<siteId>/<YYYY-MM>/<entryId>/` and its `webViewLink` opening per the
configured `linkAccess` — is a deferred, owner-gated human verification
item (same category as Phase 2's real-Cloudflare Turnstile widget check and
Phase 3's live Stripe/PayPal drills). The automated test suite proves the
whole Drive orchestration (auth, folder resolution, retry/backoff, the
DRV-02 fallback guarantee) against a local mock server — never against a
live Google account — so no owner credentials are required to verify this
package works before you mint your own.
