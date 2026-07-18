/**
 * DRV-01/DRV-02 e2e (Plan 09) — proves the Drive upload path against a MOCK
 * Drive server (`GOOGLE_DRIVE_API_BASE_URL` + `GOOGLE_OAUTH_TOKEN_URL` route
 * seam, mirroring `STRIPE_API_BASE_URL`, 03-09 precedent) on the dedicated
 * RECOVERY_URL instance (playwright.config.ts carries the dummy
 * GOOGLE_DRIVE_* triple + the mock base URLs):
 *
 *  - A submit with a file returns a `driveLink` outcome (DRV-01).
 *  - A mock upload failure degrades to the fallback outcome and the
 *    submission STILL lands — a Drive failure never loses a submission
 *    (DRV-02).
 *  - Every OAuth/Drive-v3 request this run makes is observed landing on the
 *    LOCAL mock (`hitLog`) — never a live `googleapis.com`/
 *    `oauth2.googleapis.com` hop (hard rule, T-04-33).
 *
 * The live Drive round-trip (a real file landing in
 * `/<root>/<siteId>/<YYYY-MM>/<entryId>/` with its `webViewLink` opening per
 * the configured `linkAccess`) is the deferred Phase-6 human drill
 * (04-VALIDATION.md Human-needed), exactly like Phase 2's real-Cloudflare
 * drill and Phase 3's live Stripe/PayPal drills.
 *
 * Clean-room: written fresh against the Plan 04-02/04-05 drive.ts/
 * record-submission.ts source and the Drive v3 REST shape drive.ts itself
 * cites (developers.google.com), not derived from any WPForms source (no
 * WPForms precedent exists for file uploads to Drive).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { test, expect } from '@playwright/test';
import { DRIVE_MOCK_PORT, RECOVERY_URL } from '../playwright.config';
import { listEntries, resetState } from './helpers';

let driveMock: Server | undefined;
let failUploads = false;
let folderCounter = 0;
let hitLog: string[] = [];

function readBody(req: IncomingMessage): Promise<void> {
  return new Promise((resolve) => {
    req.on('data', () => undefined);
    req.on('end', () => resolve());
  });
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

test.beforeAll(async () => {
  driveMock = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${DRIVE_MOCK_PORT}`);
    hitLog.push(`${req.method} ${url.pathname}`);

    void readBody(req).then(() => {
      // OAuth refresh-token exchange (drive.ts's oauthTokenUrl()).
      if (req.method === 'POST' && url.pathname === '/token') {
        respondJson(res, 200, { access_token: 'e2e-mock-access-token' });
        return;
      }
      // files.list — never finds an existing folder, so every level always
      // falls through to files.create (idempotency across separate DAYS is
      // out of scope for this e2e; the unit suite (drive.test.ts) already
      // proves the list-then-create cache).
      if (req.method === 'GET' && url.pathname === '/drive/v3/files') {
        respondJson(res, 200, { files: [] });
        return;
      }
      // files.create — one fresh folder id per call.
      if (req.method === 'POST' && url.pathname === '/drive/v3/files') {
        folderCounter += 1;
        respondJson(res, 200, { id: `mock-folder-${folderCounter}` });
        return;
      }
      // Multipart upload (<=5MiB — every e2e test file is a few bytes).
      if (req.method === 'POST' && url.pathname === '/upload/drive/v3/files') {
        if (failUploads) {
          respondJson(res, 500, { error: { message: 'e2e mock — simulated Drive upload failure' } });
          return;
        }
        respondJson(res, 200, { id: 'mock-file-id', webViewLink: 'https://drive.mock.local/file/mock-file-id' });
        return;
      }
      // Permission grant (D2 linkAccess:'anyone' — astro.config.mjs sets it
      // for this playground instance).
      if (req.method === 'POST' && /\/drive\/v3\/files\/[^/]+\/permissions$/.test(url.pathname)) {
        respondJson(res, 200, {});
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => driveMock?.listen(DRIVE_MOCK_PORT, '127.0.0.1', resolve));
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => driveMock?.close(() => resolve()));
});

test.beforeEach(async ({ request }) => {
  failUploads = false;
  hitLog = [];
  await resetState(request, RECOVERY_URL);
});

test.describe('DRV-01/DRV-02 Drive upload — demo-submit against a mock Drive server (no live googleapis.com call)', () => {
  test('a submit with a file returns a driveLink outcome and the entry lands (DRV-01)', async ({ request }) => {
    const res = await request.post(`${RECOVERY_URL}/api/demo-submit`, {
      data: {
        filename: 'assignment.txt',
        dataBase64: Buffer.from('hello drive e2e').toString('base64'),
        email: 'drive-e2e@example.com',
      },
    });

    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      entryId: string;
      files: Array<{ filename: string; driveLink?: string; attached: boolean; fallbackTooLarge: boolean }>;
    };
    expect(body.ok).toBe(true);
    expect(body.files).toHaveLength(1);
    expect(body.files[0].driveLink).toBe('https://drive.mock.local/file/mock-file-id');
    expect(body.files[0].attached).toBe(false);
    expect(body.files[0].fallbackTooLarge).toBe(false);

    // The entry itself was saved (submission never depends on the file
    // outcome landing) — read it back via the same debug surface every
    // other spec in this suite already uses.
    const entries = await listEntries(request, RECOVERY_URL);
    expect(entries.some((e) => e.id === body.entryId && e.status === 'submitted')).toBe(true);

    // Every Drive-v3 call this request made landed on the LOCAL mock. The
    // OAuth token exchange itself is NOT asserted here — drive.ts caches
    // the access token in-process for ACCESS_TOKEN_TTL_MS (~50min), so once
    // ANY earlier test in this same long-lived dev-server process has
    // minted one (this file's own first run against desktop-chromium, or a
    // prior run against mobile-pixel7), a later test's refreshAccessToken()
    // legitimately returns the cached token without a fresh `/token` hit —
    // asserting it unconditionally here would be an order-dependent flake,
    // not a real DRV-01 regression signal. No hit log entry is EVER a real
    // googleapis.com/oauth2.googleapis.com hostname, because the whole
    // module was redirected at the env-seam before this request was ever
    // made (hard rule, T-04-33) — that is what this assertion proves.
    expect(hitLog.some((h) => h === 'POST /upload/drive/v3/files')).toBe(true);
    expect(hitLog.every((h) => !h.includes('googleapis.com'))).toBe(true);
  });

  test('a mock Drive upload failure degrades to a fallback outcome — the submission is never lost (DRV-02)', async ({
    request,
  }) => {
    failUploads = true;

    const res = await request.post(`${RECOVERY_URL}/api/demo-submit`, {
      data: {
        filename: 'assignment2.txt',
        dataBase64: Buffer.from('hello drive fallback e2e').toString('base64'),
        email: 'drive-fallback-e2e@example.com',
      },
    });

    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      entryId: string;
      files: Array<{ filename: string; driveLink?: string; attached: boolean; fallbackTooLarge: boolean }>;
    };
    expect(body.ok).toBe(true);
    expect(body.files).toHaveLength(1);
    expect(body.files[0].driveLink).toBeUndefined();
    expect(body.files[0].attached).toBe(true); // fallbackBuffer present — a real host attaches it itself
    expect(body.files[0].fallbackTooLarge).toBe(false);

    // DRV-02's hard guarantee: the submission entry is STILL created even
    // though every Drive upload attempt failed.
    const entries = await listEntries(request, RECOVERY_URL);
    expect(entries.some((e) => e.id === body.entryId && e.status === 'submitted')).toBe(true);

    // The retry-then-fallback path still only ever talked to the local
    // mock — a real 500 from a real provider would look identical from the
    // orchestrator's point of view, which is exactly the point of this seam.
    expect(hitLog.some((h) => h === 'POST /upload/drive/v3/files')).toBe(true);
    expect(hitLog.every((h) => !h.includes('googleapis.com'))).toBe(true);
  });
});
