/**
 * Real-browser abandon-trigger drills (ABND-01) — jsdom cannot faithfully
 * fire beforeunload/visibilitychange/exit-intent (RESEARCH.md Pitfall 5),
 * so these run against the playground's real dev server via Playwright.
 * Every spec resets DB + rate-limiter + notify-health state in beforeEach.
 */
import { test, expect } from '@playwright/test';
import {
  entriesByStatus,
  fireExitIntent,
  fireVisibilityHidden,
  resetState,
  waitForAbandoned,
} from './helpers';

test.beforeEach(async ({ request }) => {
  await resetState(request);
});

test('exit-intent triggers an abandon save', async ({ page, request }) => {
  await page.goto('/');
  await page.fill('#email', 'exit-intent@example.com');
  await fireExitIntent(page);

  const [row] = await waitForAbandoned(request);
  expect(row.fields.email).toBe('exit-intent@example.com');
  expect(row.visitorUuid).toBeTruthy();
  expect(Array.isArray(row.journey)).toBe(true);
});

test('leaving-link click triggers an abandon save', async ({ page, request }) => {
  await page.goto('/');
  await page.fill('#email', 'leaving-link@example.com');
  await page.click('a[href="/two"]');

  const [row] = await waitForAbandoned(request);
  expect(row.fields.email).toBe('leaving-link@example.com');
});

test('beforeunload (navigating away) triggers an abandon save', async ({ page, request }) => {
  await page.goto('/');
  await page.fill('#email', 'beforeunload@example.com');
  await page.goto('/two');

  const [row] = await waitForAbandoned(request);
  expect(row.fields.email).toBe('beforeunload@example.com');
});

test('visibilitychange -> hidden triggers an abandon save', async ({ page, request }) => {
  await page.goto('/');
  await page.fill('#email', 'visibility@example.com');
  await fireVisibilityHidden(page);

  const [row] = await waitForAbandoned(request);
  expect(row.fields.email).toBe('visibility@example.com');
});

test('sendBeacon-unavailable falls back to fetch keepalive', async ({ page, request }) => {
  await page.addInitScript(() => {
    // @ts-expect-error test-only removal to force the fetch(keepalive) path
    delete window.navigator.sendBeacon;
  });
  await page.goto('/');
  await page.fill('#email', 'keepalive@example.com');
  await fireExitIntent(page);

  const [row] = await waitForAbandoned(request);
  expect(row.fields.email).toBe('keepalive@example.com');
});

test('plain page (no ClientRouter) captures via module-load init()', async ({ page, request }) => {
  await page.goto('/plain');
  await page.fill('#email', 'plain@example.com');
  await fireExitIntent(page);

  const [row] = await waitForAbandoned(request);
  expect(row.fields.email).toBe('plain@example.com');
});

test('10s throttle prevents an immediate second send', async ({ page, request }) => {
  await page.goto('/');
  await page.fill('#email', 'throttle@example.com');
  await fireExitIntent(page);
  await waitForAbandoned(request);

  // Immediately fire a second trigger — the shared per-form throttle should
  // suppress it client-side; no second row should ever appear.
  await fireExitIntent(page);
  await page.waitForTimeout(500);

  const abandoned = await entriesByStatus(request, 'abandoned');
  expect(abandoned.length).toBe(1);
});

test('no further abandon row is created after window.caf.submitted() success signal', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await page.fill('#email', 'submitted-signal@example.com');
  await fireExitIntent(page);
  await waitForAbandoned(request);

  await page.click('button[type=submit]');
  await expect(page.locator('#caf-submit-status')).toContainText('Submitted', { timeout: 10_000 });

  // Capture is fully unbound on submitted() (SIG-01/D4) — a further trigger
  // must not create a new abandoned row.
  await fireExitIntent(page);
  await page.waitForTimeout(500);

  const abandoned = await entriesByStatus(request, 'abandoned');
  expect(abandoned.length).toBe(0);
});
