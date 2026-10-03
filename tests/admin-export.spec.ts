/**
 * Admin export e2e (ADMN-03) — CSV/.db export routes sit behind the SAME
 * /forms-admin session guard as every other admin route (T-02-26); the
 * unauthenticated-redirect cases here prove that explicitly, since export
 * routes are easy to leave unauthenticated if wired as standalone .ts
 * routes outside the .astro page tree (Research). Runs against the
 * dedicated ADMIN_URL Playwright instance (playwright.config.ts, port
 * 4324) — carries FORMS_ADMIN_PASSWORD so /forms-admin is actually
 * reachable, and avoids the local port-4321 collision noted in 02-05's
 * SUMMARY (an unrelated sibling project's own dev server).
 */
import { test, expect, type Page } from '@playwright/test';
import { ADMIN_PASSWORD, ADMIN_URL } from '../playwright.config';
import { abandonPayload, postAbandon, resetState, waitForAbandoned } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetState(request, ADMIN_URL);
});

async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto(`${ADMIN_URL}/forms-admin/login`);
  await page.fill('#password', ADMIN_PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForURL(/\/forms-admin\/entries/);
}

// SQLite files begin with a fixed 16-byte magic header: the ASCII string
// "SQLite format 3" followed by a single NUL byte. Compared byte-for-byte
// (never embedded as a literal NUL character in this source file, which
// some toolchains silently truncate a string literal at).
const SQLITE_MAGIC_HEADER = Buffer.concat([Buffer.from('SQLite format 3', 'ascii'), Buffer.from([0])]);

test.describe('Admin export routes (ADMN-03)', () => {
  test('an unauthenticated GET /forms-admin/export.csv redirects to the login page (T-02-26)', async ({ page }) => {
    await page.goto(`${ADMIN_URL}/forms-admin/export.csv`);
    await expect(page).toHaveURL(/\/forms-admin\/login/);
  });

  test('an unauthenticated GET /forms-admin/export.db redirects to the login page (T-02-26)', async ({ page }) => {
    await page.goto(`${ADMIN_URL}/forms-admin/export.db`);
    await expect(page).toHaveURL(/\/forms-admin\/login/);
  });

  test('an authenticated GET /forms-admin/export.csv returns text/csv with an attachment header and at least the header row', async ({
    page,
    request,
  }) => {
    await postAbandon(
      request,
      abandonPayload({
        visitorUuid: `admin-export-csv-${Math.random().toString(36).slice(2)}`,
        fields: { email: 'export-csv@example.com' },
      }),
      ADMIN_URL,
      ADMIN_URL,
    );
    await waitForAbandoned(request, 1, ADMIN_URL);

    await loginAsAdmin(page);
    const res = await page.request.get(`${ADMIN_URL}/forms-admin/export.csv`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/csv');
    expect(res.headers()['content-disposition']).toContain('attachment');
    expect(res.headers()['content-disposition']).toContain('entries.csv');
    const body = await res.text();
    const lines = body.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(2); // header row + at least one entry
    expect(lines[0]).toContain('id');
  });

  test('an authenticated GET /forms-admin/export.db returns a non-empty SQLite attachment beginning with the SQLite magic header', async ({
    page,
  }) => {
    await loginAsAdmin(page);
    const res = await page.request.get(`${ADMIN_URL}/forms-admin/export.db`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('application/vnd.sqlite3');
    expect(res.headers()['content-disposition']).toContain('attachment');
    expect(res.headers()['content-disposition']).toContain('forms.db');
    const body = await res.body();
    expect(body.byteLength).toBeGreaterThan(0);
    expect(body.subarray(0, SQLITE_MAGIC_HEADER.length).equals(SQLITE_MAGIC_HEADER)).toBe(true);
  });

  // A CDN that caches by file extension (Cloudflare caches .csv by default)
  // would store an authenticated export and serve it to anyone, so every
  // admin response must forbid shared caching and MIME sniffing, including
  // the redirects. Redirects are read unfollowed (maxRedirects: 0).
  test('every admin response carries Cache-Control: no-store, private and X-Content-Type-Options: nosniff', async ({
    page,
    request,
  }) => {
    const expectAdminHeaders = (headers: Record<string, string>, what: string): void => {
      expect(headers['cache-control'], what).toBe('no-store, private');
      expect(headers['x-content-type-options'], what).toBe('nosniff');
    };

    const guardRedirect = await request.get(`${ADMIN_URL}/forms-admin/export.csv`, { maxRedirects: 0 });
    expect(guardRedirect.status()).toBeGreaterThanOrEqual(300);
    expect(guardRedirect.status()).toBeLessThan(400);
    expectAdminHeaders(guardRedirect.headers(), 'unauthenticated export.csv redirect');

    const loginFailure = await request.post(`${ADMIN_URL}/forms-admin/auth`, {
      headers: { Origin: ADMIN_URL },
      form: { password: 'definitely-wrong' },
      maxRedirects: 0,
    });
    expect(loginFailure.headers()['location']).toContain('/forms-admin/login?error=1');
    expectAdminHeaders(loginFailure.headers(), 'login failure redirect');

    await loginAsAdmin(page);
    for (const path of ['/forms-admin/export.csv', '/forms-admin/export.db', '/forms-admin/entries']) {
      const res = await page.request.get(`${ADMIN_URL}${path}`);
      expect(res.status(), path).toBe(200);
      expectAdminHeaders(res.headers(), path);
      if (path.startsWith('/forms-admin/export.')) {
        expect(res.headers()['content-disposition'], path).toContain('attachment');
      }
    }
  });

  test('the Entries view renders the Export CSV and Download .db links', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`${ADMIN_URL}/forms-admin/entries`);
    await expect(page.locator('a', { hasText: 'Export CSV' })).toBeVisible();
    await expect(page.locator('a', { hasText: 'Download .db' })).toBeVisible();
  });
});
