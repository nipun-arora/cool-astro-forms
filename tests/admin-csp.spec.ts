/**
 * Admin pages under a Content Security Policy (0.1.15).
 *
 * A host that turns on Astro's `security.csp` gets a hash-based policy on
 * every SSR page (Astro sends it as a response header for on-demand routes,
 * so it applies to the admin pages even though they render their whole
 * document through `set:html`). Up to 0.1.14 that policy blocked the admin
 * shell's inline `<style>` (the admin rendered unstyled) and the entry
 * page's inline `onfocus`/`onclick` copy-link handlers. This spec drives
 * every admin page on a PRODUCTION build with CSP on and requires ZERO
 * `securitypolicyviolation` events, plus proof that the policy is really
 * active (the header is present) and that the styles and the copy control
 * really work (a page that loads nothing has no violations either).
 *
 * It also walks the built-in "Create payment link" flow against a local
 * Stripe mock and checks the request Stripe would receive: the link is
 * single-use (fleet bug F1 work) and priced in the configured currency.
 */
import { createServer, type Server } from 'node:http';
import { test, expect, type Page } from '@playwright/test';
import { ADMIN_STYLE_HASH } from 'cool-astro-forms/server/admin/_shared.js';
import { ADMIN_CSP_STRIPE_MOCK_PORT, ADMIN_CSP_URL, ADMIN_PASSWORD } from '../playwright.config';
import { abandonPayload, postAbandon } from './helpers';

let stripeMock: Server | undefined;
const stripeRequests: { path: string; body: string }[] = [];

test.beforeAll(async () => {
  stripeMock = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      stripeRequests.push({ path: req.url ?? '', body });
      if (req.method === 'POST' && req.url?.startsWith('/v1/payment_links')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: `plink_e2e_${stripeRequests.length}`,
            object: 'payment_link',
            url: `https://buy.stripe.com/test_e2e_${stripeRequests.length}`,
          }),
        );
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not mocked', type: 'invalid_request_error' } }));
    });
  });
  await new Promise<void>((resolve) => stripeMock?.listen(ADMIN_CSP_STRIPE_MOCK_PORT, '127.0.0.1', resolve));
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => stripeMock?.close(() => resolve()));
});

interface Violation {
  directive: string;
  blocked: string;
  sample: string;
}

/** Records every CSP violation from the very start of each document (before the head is parsed). */
async function watchViolations(page: Page): Promise<() => Promise<Violation[]>> {
  await page.addInitScript(() => {
    const store: Violation[] = [];
    (window as unknown as { __cafCspViolations: Violation[] }).__cafCspViolations = store;
    document.addEventListener('securitypolicyviolation', (event) => {
      store.push({ directive: event.violatedDirective, blocked: event.blockedURI, sample: event.sample });
    });
  });
  return async () =>
    page.evaluate(() => (window as unknown as { __cafCspViolations?: Violation[] }).__cafCspViolations ?? []);
}

async function expectStyledAdminShell(page: Page): Promise<void> {
  // The admin shell paints its nav bar #1a1a1a; an unstyled (CSP-blocked) page leaves it transparent.
  await expect(page.locator('nav[aria-label="Admin navigation"] ul')).toHaveCSS('background-color', 'rgb(26, 26, 26)');
}

test('every admin page renders with zero CSP violations under Astro security.csp, styled and working', async ({
  page,
  request,
  context,
  browserName,
}) => {
  const violations = await watchViolations(page);
  const consoleCspErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && /Content Security Policy/i.test(msg.text())) consoleCspErrors.push(msg.text());
  });

  // Login: the policy is really on (header present), and the page is clean.
  const loginResponse = await page.goto(`${ADMIN_CSP_URL}/forms-admin/login`);
  const policy = loginResponse?.headers()['content-security-policy'] ?? '';
  expect(policy).toContain('style-src');
  expect(policy).toContain('script-src');
  expect(await violations()).toEqual([]);

  // Seed one abandoned entry through the real capture route.
  const email = `csp-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const seeded = await postAbandon(
    request,
    abandonPayload({ fields: { name: 'CSP Check', email }, journey: [{ url: '/', title: 'Home', ts: Date.now() }] }),
    ADMIN_CSP_URL,
    ADMIN_CSP_URL,
  );
  expect(seeded.status).toBe(200);

  await page.fill('#password', ADMIN_PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForURL(/\/forms-admin\/entries/);
  expect(await violations()).toEqual([]);
  await expectStyledAdminShell(page);

  for (const path of ['abandoned', 'payments', 'analytics']) {
    const response = await page.goto(`${ADMIN_CSP_URL}/forms-admin/${path}`);
    expect(response?.headers()['content-security-policy'] ?? '').toContain('style-src');
    expect(await violations(), `/forms-admin/${path}`).toEqual([]);
    await expectStyledAdminShell(page);
  }

  // Entry detail, reached the way an owner does: search, then View.
  await page.goto(`${ADMIN_CSP_URL}/forms-admin/entries?search=${encodeURIComponent(email)}`);
  await page.getByRole('link', { name: 'View' }).first().click();
  await expect(page.locator('h1')).toContainText('Entry ');
  expect(await violations()).toEqual([]);
  await expectStyledAdminShell(page);

  // Built-in quote flow: create a Stripe payment link against the mock.
  await page.fill('#payment-amount', '200.50');
  await page.selectOption('#payment-provider', 'stripe');
  await page.getByRole('button', { name: 'Create payment link' }).click();
  await expect(page.locator('.pay-link-input')).toHaveCount(1);
  expect(await violations()).toEqual([]);

  const linkCreate = stripeRequests.find((r) => r.path.startsWith('/v1/payment_links'));
  expect(linkCreate, 'the admin flow called Stripe').toBeDefined();
  const params = new URLSearchParams(linkCreate!.body);
  expect(params.get('restrictions[completed_sessions][limit]')).toBe('1');
  expect(params.get('line_items[0][price_data][currency]')).toBe('usd');
  expect(params.get('line_items[0][price_data][unit_amount]')).toBe('20050');

  // The copy control works from the bundled script (no inline handlers left).
  const input = page.locator('.pay-link-input');
  await expect(input).toHaveAttribute('value', /https:\/\/buy\.stripe\.com\/test_e2e_/);
  await input.focus();
  const selected = await input.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd, el.value.length]);
  expect(selected[0]).toBe(0);
  expect(selected[1]).toBe(selected[2]);
  if (browserName === 'chromium') {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ADMIN_CSP_URL });
    await page.getByRole('button', { name: 'Copy link' }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toMatch(/^https:\/\/buy\.stripe\.com\/test_e2e_/);
  }
  expect(await violations()).toEqual([]);
  expect(consoleCspErrors).toEqual([]);
});

// A host that writes its own CSP header instead of turning on Astro's
// security.csp is told (both READMEs) to add the exported ADMIN_STYLE_HASH to
// its style-src. That one hash must cover every admin page that runs no
// script: the login page included. Up to the fix the login page carried its
// own Astro-processed <style> with a build-dependent hash, so under exactly
// this policy it painted unstyled while the list views were fine.
test('a host-written CSP header listing only ADMIN_STYLE_HASH keeps the login page and the list views styled', async ({
  page,
}) => {
  const policy = `default-src 'self'; script-src 'self'; style-src 'self' '${ADMIN_STYLE_HASH}'`;
  await page.route(`${ADMIN_CSP_URL}/forms-admin/**`, async (route) => {
    const request = route.request();
    if (request.method() !== 'GET' || request.resourceType() !== 'document') return route.continue();
    const response = await route.fetch({ maxRedirects: 0 });
    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': policy } });
  });
  const violations = await watchViolations(page);

  const login = await page.goto(`${ADMIN_CSP_URL}/forms-admin/login`);
  expect(login?.headers()['content-security-policy']).toBe(policy);
  expect(await violations()).toEqual([]);
  // Unstyled, the page background stays transparent and the card has no white panel.
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(245, 245, 245)');
  await expect(page.locator('main.login')).toHaveCSS('background-color', 'rgb(255, 255, 255)');

  await page.fill('#password', ADMIN_PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForURL(/\/forms-admin\/entries/);
  expect(await violations()).toEqual([]);
  await expectStyledAdminShell(page);
});
