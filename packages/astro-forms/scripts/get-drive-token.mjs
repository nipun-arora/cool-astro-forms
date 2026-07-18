#!/usr/bin/env node
/**
 * One-time Google Drive OAuth consent helper (DRV-02).
 *
 * Dev-time CLI the owner runs ONCE on their own machine to mint
 * `GOOGLE_DRIVE_REFRESH_TOKEN` for the runtime Drive module (`server/drive/
 * drive.ts`, 04-02) — never part of the deployed request path, never
 * imported by any server route.
 *
 * Uses the current LOOPBACK-REDIRECT flow (`http://127.0.0.1:<ephemeral
 * port>`) for a "Desktop app" OAuth client, requesting the non-sensitive
 * `drive.file` scope. `[CITED: developers.google.com/identity/protocols/
 * oauth2/native-app]`.
 *
 * The OOB ("out-of-band" / manual code-paste) flow this replaces was blocked
 * for new usage Feb 2022 and fully deprecated Jan 2023 `[CITED:
 * developers.google.com/identity/protocols/oauth2/resources/oob-migration]`
 * — any training-derived Drive OAuth sample that shows a manual code-paste
 * step is STALE. Do not resurrect it.
 *
 * Clean-room: written fresh against the cited Google identity docs
 * (04-RESEARCH.md State of the Art, fetched live 2026-07-17), not derived
 * from any commercial form-plugin source. Token-exchange shape mirrors `paypal.ts`'s
 * `getAccessToken()` (form-encoded POST to a token endpoint, parse JSON,
 * never throw) — same codebase precedent, different provider.
 *
 * Usage:
 *   export GOOGLE_DRIVE_CLIENT_ID=...
 *   export GOOGLE_DRIVE_CLIENT_SECRET=...
 *   node packages/astro-forms/scripts/get-drive-token.mjs
 *
 * *** D6 (BINDING, 04-CONTEXT.md) ***: once you have the refresh token, you
 * MUST set the OAuth consent screen's publishing status to "In Production"
 * in Google Cloud Console. `drive.file` is a non-sensitive scope, so this is
 * a single toggle with NO Google review. Left in "Testing", Google silently
 * expires every refresh token this app issues after EXACTLY 7 days
 * (RESEARCH Pitfall 1) — uploads work fine for a week, then start failing
 * with `invalid_grant`.
 *
 * Pitfall 2 (RESEARCH): `drive.file` only sees files/folders the app itself
 * created. Never hand-create the Drive root folder in the Drive UI first —
 * let the app create it on its first upload, or the app will silently make
 * a duplicate.
 */

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

/** Non-sensitive Drive scope (RESEARCH Package/Scope Legitimacy) — never drive.readonly/drive (full access). */
const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

const DEFAULT_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const DEFAULT_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Token-exchange request timeout — this is a one-time dev-time call, not a hot server path. */
const TOKEN_EXCHANGE_TIMEOUT_MS = 10_000;

/**
 * Builds the loopback-flow consent URL. `access_type=offline` +
 * `prompt=consent` are asserted explicitly (not left to Desktop-client
 * defaults) so a refresh token is always returned even on a repeat consent —
 * omitting either is the classic "no refresh_token in the response" bug.
 *
 * `authBase` resolution order: explicit param > `GOOGLE_OAUTH_AUTH_URL` env
 * (unit-test/owner override seam) > the real Google endpoint.
 */
export function buildAuthUrl({ clientId, redirectUri, authBase }) {
  const base = authBase ?? process.env.GOOGLE_OAUTH_AUTH_URL ?? DEFAULT_AUTH_URL;
  const url = new URL(base);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', DRIVE_FILE_SCOPE);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  return url;
}

/**
 * Exchanges the loopback-redirect `?code=` for a refresh token
 * (`grant_type=authorization_code`). Never throws: an absent
 * `refresh_token`, a non-2xx response, a malformed body, or a network error
 * all resolve `undefined` (mirrors `paypal.ts`'s `getAccessToken()`
 * never-throws tolerance).
 *
 * `tokenUrl` resolution order: explicit param > `GOOGLE_OAUTH_TOKEN_URL` env
 * (the same seam `drive.ts`'s `oauthTokenUrl()` reads, 04-02) > the real
 * Google endpoint.
 */
export async function exchangeCodeForRefreshToken({
  code,
  clientId,
  clientSecret,
  redirectUri,
  fetch: fetchImpl,
  tokenUrl,
}) {
  const doFetch = fetchImpl ?? fetch;
  const url = tokenUrl ?? process.env.GOOGLE_OAUTH_TOKEN_URL ?? DEFAULT_TOKEN_URL;

  try {
    const body = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    const data = await res.json();
    return typeof data.refresh_token === 'string' ? data.refresh_token : undefined;
  } catch {
    return undefined;
  }
}

function printMissingEnvHelp() {
  console.error(
    [
      'GOOGLE_DRIVE_CLIENT_ID and GOOGLE_DRIVE_CLIENT_SECRET must both be set before running this script.',
      '',
      '1. In Google Cloud Console: create/reuse a project, enable the Google Drive API,',
      '   then create an OAuth client of type "Desktop app". Copy its client id + secret.',
      '2. Export them and re-run:',
      '     export GOOGLE_DRIVE_CLIENT_ID=...',
      '     export GOOGLE_DRIVE_CLIENT_SECRET=...',
      '     node packages/astro-forms/scripts/get-drive-token.mjs',
    ].join('\n'),
  );
}

/**
 * Runs the loopback flow end-to-end: starts an ephemeral local server, opens
 * the consent URL for the owner, catches the `?code=` redirect, exchanges it,
 * and prints `GOOGLE_DRIVE_REFRESH_TOKEN=...` plus the D6 + Pitfall-2
 * reminders. Only invoked when this file is run as the entrypoint (see the
 * `import.meta.url` guard below) — importing this module (e.g. from a test)
 * never opens a socket.
 */
async function main() {
  const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    printMissingEnvHelp();
    process.exitCode = 1;
    return;
  }

  const server = createServer((req, res) => {
    void handleRequest(req, res, { clientId, clientSecret, server });
  });

  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    const redirectUri = `http://127.0.0.1:${port}`;
    const authUrl = buildAuthUrl({ clientId, redirectUri });
    console.log('Open this URL in your browser and approve the drive.file consent:\n');
    console.log(authUrl.toString());
    console.log(`\nWaiting for the redirect on ${redirectUri} ...`);
  });
}

async function handleRequest(req, res, { clientId, clientSecret, server }) {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname !== '/') {
    res.writeHead(404).end();
    return;
  }

  const error = url.searchParams.get('error');
  if (error) {
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(
      `<h1>Consent denied</h1><p>${error}</p><p>You can close this tab.</p>`,
    );
    console.error(`\nGoogle returned an error: ${error}. No refresh token was minted.`);
    server.close();
    process.exitCode = 1;
    return;
  }

  const code = url.searchParams.get('code');
  if (!code) {
    res.writeHead(400).end('Missing ?code= in the redirect.');
    return;
  }

  res
    .writeHead(200, { 'Content-Type': 'text/html' })
    .end('<h1>Consent received</h1><p>You can close this tab and return to the terminal.</p>');

  const { port } = server.address();
  const redirectUri = `http://127.0.0.1:${port}`;
  const refreshToken = await exchangeCodeForRefreshToken({ code, clientId, clientSecret, redirectUri });

  server.close();

  if (!refreshToken) {
    console.error(
      '\nToken exchange failed — no refresh_token in the response.\n' +
        'Re-run the script. If it keeps failing, revoke any prior consent for this app at ' +
        'https://myaccount.google.com/permissions and try again (a repeat consent without a ' +
        'fresh prompt can omit the refresh token).',
    );
    process.exitCode = 1;
    return;
  }

  console.log(`\nGOOGLE_DRIVE_REFRESH_TOKEN=${refreshToken}`);
  console.log('\nPaste the three GOOGLE_DRIVE_* values (CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN) into your deploy');
  console.log('secrets. NEVER commit this token — it is a long-lived server secret, same handling as');
  console.log('STRIPE_SECRET_KEY / PAYPAL_CLIENT_SECRET.');
  console.log(
    '\n*** ACTION REQUIRED (D6) ***: Google silently expires this refresh token after EXACTLY 7 days while',
  );
  console.log('the OAuth consent screen is in "Testing" mode. Go to Google Cloud Console -> APIs & Services ->');
  console.log('OAuth consent screen and set the publishing status to "In Production". drive.file is a');
  console.log('non-sensitive scope, so this is a single toggle with NO Google review.');
  console.log(
    '\nReminder (Pitfall 2): do not hand-create the Drive root folder yourself in the Drive UI — the app',
  );
  console.log('must create it on its first upload, or drive.file will silently ignore the hand-made folder');
  console.log('and create a duplicate.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
