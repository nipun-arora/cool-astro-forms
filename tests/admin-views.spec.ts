/**
 * Admin UI e2e (ADMN-02, JRNY-03, GEO-02 admin display) — a dedicated
 * playground instance (playwright.config.ts's ADMIN_URL) carries
 * FORMS_ADMIN_PASSWORD so /forms-admin is actually reachable; every other
 * spec's default instance leaves it unset (the routes exist but the login
 * POST stays permanently inert, matching a real host that never sets the
 * env var). Each browser-context `test()` gets its own fresh cookie jar, so
 * no explicit session teardown is needed between tests.
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

test.describe('Admin UI', () => {
  test('an unauthenticated request to /forms-admin/entries redirects to the login page', async ({ page }) => {
    await page.goto(`${ADMIN_URL}/forms-admin/entries`);
    await expect(page).toHaveURL(/\/forms-admin\/login/);
  });

  test('a wrong password redirects back to login with an error; the correct password sets a session and reaches Entries', async ({
    page,
  }) => {
    await page.goto(`${ADMIN_URL}/forms-admin/login`);
    await page.fill('#password', 'totally-wrong-password');
    await page.click('button[type=submit]');
    await expect(page).toHaveURL(/\/forms-admin\/login\?error=1/);
    await expect(page.locator('.error')).toBeVisible();

    await page.fill('#password', ADMIN_PASSWORD);
    await page.click('button[type=submit]');
    await expect(page).toHaveURL(/\/forms-admin\/entries/);
    await expect(page.locator('h1')).toContainText('Entries');
  });

  test('an abandoned entry seeded via postAbandon shows its geo/journey sections in the detail view (GEO-02 admin + JRNY-03)', async ({
    page,
    request,
  }) => {
    await postAbandon(
      request,
      abandonPayload({
        visitorUuid: `admin-e2e-detail-${Math.random().toString(36).slice(2)}`,
        fields: { email: 'admin-detail@example.com' },
        journey: [{ url: '/', title: 'Home', ts: Date.now() }],
      }),
      ADMIN_URL,
      ADMIN_URL,
    );
    const [row] = await waitForAbandoned(request, 1, ADMIN_URL);

    await loginAsAdmin(page);
    await page.goto(`${ADMIN_URL}/forms-admin/entries/${row!.id}`);
    await expect(page.locator('h1')).toContainText(row!.id);
    // Geo is Phase-2-populated from a real IP lookup, which this local e2e
    // run never triggers (loopback/private IP skip, D2) -- this asserts the
    // Geo/Journey SECTIONS render (reusing renderGeoLine/
    // renderJourneyTimelineHtml), not a live geo lookup result.
    await expect(page.locator('h2', { hasText: 'Geo' })).toBeVisible();
    await expect(page.locator('h2', { hasText: 'Journey' })).toBeVisible();
    await expect(page.locator('body')).toContainText('Home');
  });

  test('a turnstile-failed flag renders in both the Abandoned list and the entry detail (D3/B2 admin-visible)', async ({
    page,
    request,
  }) => {
    await postAbandon(
      request,
      abandonPayload({
        visitorUuid: `admin-e2e-turnstile-${Math.random().toString(36).slice(2)}`,
        fields: { email: 'turnstile-flag@example.com', _turnstile: 'failed' },
      }),
      ADMIN_URL,
      ADMIN_URL,
    );
    const [row] = await waitForAbandoned(request, 1, ADMIN_URL);

    await loginAsAdmin(page);

    await page.goto(`${ADMIN_URL}/forms-admin/abandoned`);
    await expect(page.locator('.flag-turnstile').first()).toBeVisible();

    await page.goto(`${ADMIN_URL}/forms-admin/entries/${row!.id}`);
    await expect(page.locator('.flag-turnstile').first()).toBeVisible();
  });

  test('the search filter narrows the Entries list', async ({ page, request }) => {
    await postAbandon(
      request,
      abandonPayload({
        visitorUuid: `admin-e2e-search-a-${Math.random().toString(36).slice(2)}`,
        fields: { email: 'findme-unique@example.com' },
      }),
      ADMIN_URL,
      ADMIN_URL,
    );
    await postAbandon(
      request,
      abandonPayload({
        visitorUuid: `admin-e2e-search-b-${Math.random().toString(36).slice(2)}`,
        fields: { email: 'other-lead@example.com' },
      }),
      ADMIN_URL,
      ADMIN_URL,
    );
    await waitForAbandoned(request, 2, ADMIN_URL);

    await loginAsAdmin(page);
    await page.goto(`${ADMIN_URL}/forms-admin/entries`);
    await expect(page.locator('tbody tr')).toHaveCount(2);

    await page.fill('#search', 'findme-unique');
    await page.click('form.filters button[type=submit]');
    await expect(page).toHaveURL(/search=findme-unique/);
    await expect(page.locator('tbody tr')).toHaveCount(1);
  });

  test('the analytics tab renders (EMPTY funnel state — no form_starts yet, client capture ships in P07)', async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await page.goto(`${ADMIN_URL}/forms-admin/analytics`);
    await expect(page.locator('h1')).toContainText('Analytics');
    await expect(page.locator('body')).toContainText('System health');
  });

  test('every admin page carries a noindex meta tag', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`${ADMIN_URL}/forms-admin/entries`);
    const content = await page.locator('meta[name="robots"]').getAttribute('content');
    expect(content).toBe('noindex');
  });
});
