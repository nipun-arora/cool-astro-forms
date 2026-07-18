/**
 * Analytics panel end-to-end (ANLY-01) — proves the funnel/abandonment-rate/
 * top-drop-off numbers the panel renders (P05) are REAL, driven entirely by
 * the playground's own tagged demo form: a first input fires the
 * form_started ping (P07), an abandon trigger lands a row carrying
 * lastField, and a submit converts it. Runs against the dedicated ADMIN_URL
 * instance (playwright.config.ts, port 4324) so /forms-admin is reachable —
 * same reasoning as tests/admin-views.spec.ts / tests/admin-export.spec.ts.
 * Geo is never mocked with a fake HTTP server: every request here comes
 * from localhost, which `lookupGeo`'s own private/local-IP skip already
 * short-circuits before any network call (geo.ts), so this suite never
 * touches the real ipwho.is provider.
 */
import { test, expect, type Page } from '@playwright/test';
import { ADMIN_PASSWORD, ADMIN_URL } from '../playwright.config';
import { fireExitIntent, resetState, waitFor, waitForAbandoned, waitForFormStarts } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetState(request, ADMIN_URL);
});

async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto(`${ADMIN_URL}/forms-admin/login`);
  await page.fill('#password', ADMIN_PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForURL(/\/forms-admin\/entries/);
}

test.describe('Analytics panel — real funnel/abandonment-rate/top-drop-off (ANLY-01)', () => {
  test('captured→converted funnel, a computed abandonment rate, and top-drop-off render real data end-to-end', async ({
    browser,
    request,
  }) => {
    test.setTimeout(45_000);

    // Visitor A: first input fires a form_started ping; edits phone LAST
    // (lastField); abandons (exit-intent) and never submits — stays
    // 'abandoned', feeding the funnel's abandoned count and top-drop-off's
    // last_field breakdown.
    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    await pageA.goto(`${ADMIN_URL}/`);
    await pageA.fill('#name', 'Visitor A');
    await pageA.fill('#email', 'visitor-a@example.com');
    await pageA.fill('#phone', '555-0100');
    await waitForFormStarts(request, 1, ADMIN_URL);
    await fireExitIntent(pageA);
    const [abandonedA] = await waitForAbandoned(request, 1, ADMIN_URL);
    expect(abandonedA!.fields.phone).toBe('555-0100');
    await contextA.close();

    // Visitor B: a SECOND, distinct form_started ping; abandons (creating a
    // second abandoned row), then submits — converts that row and creates a
    // 'submitted' sibling.
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await pageB.goto(`${ADMIN_URL}/`);
    await pageB.fill('#name', 'Visitor B');
    await pageB.fill('#email', 'visitor-b@example.com');
    await waitForFormStarts(request, 2, ADMIN_URL);
    await fireExitIntent(pageB);
    await waitFor(request, (entries) => entries.filter((e) => e.status === 'abandoned').length >= 2, 10_000, ADMIN_URL);

    await pageB.click('button[type=submit]');
    await expect(pageB.locator('#caf-submit-status')).toHaveText('Submitted — thank you.');
    await waitFor(request, (entries) => entries.some((e) => e.status === 'converted'), 10_000, ADMIN_URL);
    await contextB.close();

    // Admin: open the analytics panel and assert the REAL numbers.
    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await loginAsAdmin(adminPage);
    await adminPage.goto(`${ADMIN_URL}/forms-admin/analytics`);
    await expect(adminPage.locator('h1')).toContainText('Analytics');

    const funnelSection = adminPage.locator('section', { has: adminPage.getByRole('heading', { name: 'Funnel' }) });
    const funnelCells = funnelSection.locator('tbody tr td');
    await expect(funnelCells.nth(0)).toHaveText('2'); // started
    await expect(funnelCells.nth(1)).toHaveText('1'); // abandoned
    await expect(funnelCells.nth(2)).toHaveText('1'); // submitted
    await expect(funnelCells.nth(3)).toHaveText('1'); // converted
    await expect(funnelSection).toContainText('Abandonment rate: 50.0%');

    // Top drop-off: Visitor A's last-edited field (phone) is the only
    // abandoned row carrying a last_field — Visitor B's row converted, so
    // getTopDropOff's `status = 'abandoned'` filter no longer includes it.
    const dropOffSection = adminPage.locator('section', {
      has: adminPage.getByRole('heading', { name: 'Top drop-off fields' }),
    });
    await expect(dropOffSection.locator('td', { hasText: 'phone' })).toBeVisible();
    await expect(dropOffSection.locator('tbody tr')).toHaveCount(1);

    await adminContext.close();
  });
});
