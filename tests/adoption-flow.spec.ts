/**
 * Full abandon->convert loop + SEC-01 origin boundary (PKG-02/PKG-03) —
 * install -> tag -> abandon -> convert, against the playground's real dev
 * server. Every spec resets DB + rate-limiter + notify-health state in
 * beforeEach.
 */
import { test, expect } from '@playwright/test';
import {
  BASE_URL,
  abandonPayload,
  entriesByStatus,
  fireExitIntent,
  listEntries,
  postAbandon,
  resetState,
  waitFor,
  waitForAbandoned,
} from './helpers';

test.beforeEach(async ({ request }) => {
  await resetState(request);
});

test('gate met (valid email) saves an abandoned row', async ({ request }) => {
  const { status, body } = await postAbandon(request, abandonPayload({ fields: { email: 'gate-met@example.com' } }));
  expect(status).toBe(200);
  expect(body?.saved).toBe(true);

  const abandoned = await entriesByStatus(request, 'abandoned');
  expect(abandoned.length).toBe(1);
});

test('gate unmet (no email or phone) does not save', async ({ request }) => {
  const { status, body } = await postAbandon(request, abandonPayload({ fields: { name: 'No Contact Info' } }));
  expect(status).toBe(200);
  expect(body?.saved).toBe(false);
  expect(body?.reason).toBe('gate');

  const abandoned = await entriesByStatus(request, 'abandoned');
  expect(abandoned.length).toBe(0);
});

test('dedupe: two abandons within the window from the same visitor keep ONE row', async ({ request }) => {
  const payload = abandonPayload({
    visitorUuid: 'dedupe-visitor-1',
    fields: { email: 'dedupe@example.com' },
  });

  const first = await postAbandon(request, payload);
  expect(first.status).toBe(200);
  expect(first.body?.saved).toBe(true);
  expect(first.body?.deduped).toBe(false);

  const second = await postAbandon(request, { ...payload, fields: { email: 'dedupe@example.com', note: 'update' } });
  expect(second.status).toBe(200);
  expect(second.body?.saved).toBe(true);
  expect(second.body?.deduped).toBe(true);

  const abandoned = await entriesByStatus(request, 'abandoned');
  expect(abandoned.length).toBe(1);
  expect(abandoned[0]?.visitorUuid).toBe('dedupe-visitor-1');
});

test('submit converts the abandoned row and creates a submitted entry with journey', async ({ page, request }) => {
  await page.goto('/');
  await page.fill('#email', 'convert@example.com');
  await fireExitIntent(page);
  await waitForAbandoned(request);

  await page.click('button[type=submit]');
  await expect(page.locator('#caf-submit-status')).toContainText('Submitted', { timeout: 10_000 });

  await waitFor(
    request,
    (entries) =>
      entries.some((e) => e.status === 'converted') && entries.some((e) => e.status === 'submitted'),
  );

  const entries = await listEntries(request);
  const converted = entries.find((e) => e.status === 'converted');
  const submitted = entries.find((e) => e.status === 'submitted');
  expect(converted).toBeTruthy();
  expect(submitted).toBeTruthy();
  expect(Array.isArray(submitted?.journey)).toBe(true);
  expect((submitted?.journey?.length ?? 0)).toBeGreaterThan(0);

  const abandoned = await entriesByStatus(request, 'abandoned');
  expect(abandoned.length).toBe(0);
});

test('cross-origin POST to /api/forms/abandon is rejected (403)', async ({ request }) => {
  const { status, body } = await postAbandon(
    request,
    abandonPayload({ fields: { email: 'cross-origin@example.com' } }),
    'https://evil.example',
  );
  expect(status).toBe(403);
  expect(body?.saved).toBe(false);
  expect(body?.reason).toBe('origin');

  const abandoned = await entriesByStatus(request, 'abandoned');
  expect(abandoned.length).toBe(0);
});

test('a filled honeypot produces no DB row (silent 204)', async ({ request }) => {
  const res = await request.post(`${BASE_URL}/api/forms/abandon`, {
    headers: { 'Content-Type': 'application/json', Origin: BASE_URL },
    data: abandonPayload({
      fields: { email: 'honeypot@example.com', _caf_hp: 'i-am-a-bot' },
    }),
  });
  expect(res.status()).toBe(204);

  const abandoned = await entriesByStatus(request, 'abandoned');
  expect(abandoned.length).toBe(0);
});

test('beacon-in-flight + immediate submit race creates no phantom abandoned row', async ({ page, request }) => {
  await page.goto('/');
  await page.fill('#email', 'race@example.com');

  // Fire the abandon beacon (queued, fire-and-forget) and immediately submit
  // — regardless of which HTTP request the server processes first, the
  // atomic upsertAbandoned/convertAndCreateSubmitted invariants must leave
  // zero 'abandoned' rows once both have landed.
  await fireExitIntent(page);
  await page.click('button[type=submit]');
  await expect(page.locator('#caf-submit-status')).toContainText('Submitted', { timeout: 10_000 });

  await waitFor(request, (entries) => entries.some((e) => e.status === 'submitted' || e.status === 'converted'));
  // Give a queued-but-slow abandon beacon a moment to land too, if it hasn't already.
  await page.waitForTimeout(500);

  const abandoned = await entriesByStatus(request, 'abandoned');
  expect(abandoned.length).toBe(0);
});

test('View Transitions: journey trail spans both pages and capture still fires after navigating back', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await page.fill('#email', 'view-transitions@example.com');

  // Client-side navigate index -> two -> back to index via ClientRouter.
  // NOTE: clicking the link is ALSO the leaving-link abandon trigger
  // (abandon-triggers.spec.ts covers it directly) — it fires immediately on
  // click, before /two's journey step even exists, and consumes the shared
  // 10s client-side throttle window. Wait that window out before the final
  // trigger below so it actually reaches the server with the full
  // multi-page journey instead of being silently throttled.
  await page.click('a[href="/two"]');
  await page.waitForURL('**/two');
  await page.click('a[href="/"]');
  await page.waitForURL(BASE_URL + '/');

  // The resurrected index page's form is a fresh DOM node after the
  // ClientRouter swap — re-typing here exercises astro:page-load re-init.
  await page.fill('#email', 'view-transitions@example.com');
  await page.waitForTimeout(10_500);
  await fireExitIntent(page);

  const rows = await waitFor(request, (entries) =>
    entries.some(
      (e) => e.status === 'abandoned' && (e.journey ?? []).some((step) => step.url.includes('/two')),
    ),
  );
  const row = rows.find((e) => e.status === 'abandoned')!;
  expect(row.fields.email).toBe('view-transitions@example.com');
  const urls = (row.journey ?? []).map((step) => step.url);
  expect(urls.some((u) => u === '/')).toBe(true);
  expect(urls.some((u) => u.includes('/two'))).toBe(true);
});
