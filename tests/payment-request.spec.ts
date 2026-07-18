/**
 * PAY-05 e2e (Plan 09) — the shareable payment-request page render + the
 * create-session server gates, driven WITHOUT a real Stripe/PayPal account
 * (RESEARCH.md Validation Architecture — the live "click pay -> hosted
 * Checkout" hop is a documented human item, exactly like Phase 2's real-
 * Cloudflare drill). Covers:
 *
 *  - GET /forms-pay render: ?amount= (dollars) and ?pay= (legacy cents
 *    alias, D4) both resolve to the same server-computed breakdown; the
 *    Turnstile widget markup renders.
 *  - B1 (trailingSlash pitfall, live proof): PAY_PASS_URL runs
 *    `trailingSlash: 'always'` — the rendered create-session form action
 *    ends in '/', and a POST to that slashed action reaches the server
 *    (never an Astro 404 router miss — confirmed empirically that `astro
 *    dev` does NOT redirect a slashless request under 'always', LESSONS.md
 *    #3). The SAME request also proves server-side amount-range validation
 *    live.
 *  - A well-formed POST carrying a REAL Cloudflare ALWAYS-PASS Turnstile
 *    token (LESSONS.md #29 — real infra, dummy key, no account) reaches the
 *    provider boundary. `STRIPE_API_BASE_URL` (playwright.config.ts,
 *    stripe.ts's e2e route-seam mock) redirects the dummy `sk_test_e2e_dummy`
 *    key's SDK calls to a LOCAL mock this file stands up — the phase hard
 *    rule is "no live provider calls anywhere"; hitting a real
 *    `api.stripe.com` even for an expected auth failure would violate it.
 *    The mock always answers with a Stripe-shaped error, so the observed
 *    response is a clean 500 `{reason:'error'}` — never a validation/
 *    turnstile 4xx — proving every local gate passed before the provider
 *    call was attempted.
 *  - PAY_FAIL_URL (ALWAYS-FAIL Turnstile pair, default trailingSlash): a
 *    POST with no token is hard-rejected 403 BEFORE any provider call
 *    (verifyTurnstile short-circuits `{ok:false}` on an absent token without
 *    ever contacting Cloudflare — payment-request.ts step 6).
 *
 * Clean-room: written fresh against 03-CONTEXT.md's D1-D4 decisions and the
 * real route/handler source (payment-request.ts, pay.astro, stripe.ts), not
 * derived from any WPForms/legacy source.
 */
import { createServer, type Server } from 'node:http';
import { test, expect } from '@playwright/test';
import { PAY_FAIL_URL, PAY_PASS_URL, STRIPE_MOCK_PORT } from '../playwright.config';

let stripeMock: Server | undefined;
let stripeMockHits = 0;

test.beforeAll(async () => {
  stripeMockHits = 0;
  stripeMock = createServer((req, res) => {
    stripeMockHits++;
    // A well-shaped Stripe error envelope (RESEARCH.md-documented error
    // contract) — the SDK parses this into a thrown StripeError regardless
    // of the specific type/code, which create-session.ts's catch-all turns
    // into a clean 500 `{ok:false, reason:'error'}`. No live Stripe network
    // hop happens at any point (hard rule).
    res.writeHead(402, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: { message: 'e2e mock — no live Stripe account', type: 'card_error', code: 'card_declined' },
      }),
    );
  });
  await new Promise<void>((resolve) => stripeMock?.listen(STRIPE_MOCK_PORT, '127.0.0.1', resolve));
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => stripeMock?.close(() => resolve()));
});

test.describe('PAY-05 /forms-pay render — breakdown math + legacy alias + Turnstile widget', () => {
  test('?amount= (dollars) renders the editable input prefilled + a server-computed breakdown table', async ({
    page,
  }) => {
    // PAY_PASS_URL runs trailingSlash:'always' — the page itself must be
    // requested at the slashed path too (B1).
    await page.goto(`${PAY_PASS_URL}/forms-pay/?amount=200`);

    await expect(page.locator('#amount')).toHaveValue('200.00');
    await expect(page.locator('#pay-subtotal')).toHaveText('200.00');
    await expect(page.locator('#pay-fee-0')).toHaveText('10.00'); // Transaction charges, 5% of $200
    await expect(page.locator('#pay-total')).toHaveText('210.00');
    await expect(page.locator('.cf-turnstile[data-sitekey]')).toHaveCount(1);
  });

  test('?pay= (legacy cents alias, D4) renders the identical $200.00 subtotal', async ({ page }) => {
    await page.goto(`${PAY_PASS_URL}/forms-pay/?pay=20000`);

    await expect(page.locator('#pay-subtotal')).toHaveText('200.00');
    await expect(page.locator('#pay-fee-0')).toHaveText('10.00');
    await expect(page.locator('#pay-total')).toHaveText('210.00');
  });
});

test.describe('PAY-05 create-session — server gates live (PAY_PASS_URL, trailingSlash:always)', () => {
  test('B1: the form action is trailing-slash-shaped, and POSTing an out-of-range amount reaches the server with a clean 400 (never a router-miss 404)', async ({
    page,
    request,
  }) => {
    await page.goto(`${PAY_PASS_URL}/forms-pay/?amount=200`);

    const action = await page.locator('#pay-form').getAttribute('action');
    expect(action).toBe('/api/forms/pay/create-session/');
    expect(action?.endsWith('/')).toBe(true);

    // 500000 cents ($5000) is the configured maxAmountCents ceiling — one
    // cent over it is a clean, deterministic amount-range rejection.
    const res = await request.post(`${PAY_PASS_URL}${action}`, {
      headers: { Origin: PAY_PASS_URL },
      form: { amount: '5000.01', currency: 'usd' },
    });

    expect(res.status()).toBe(400); // NOT 404 — the injected route + slash discipline are live
    const body = (await res.json()) as { ok: boolean; reason?: string };
    expect(body).toEqual({ ok: false, reason: 'amount-range' });
  });

  test('a well-formed POST carrying a real ALWAYS-PASS Turnstile token reaches the provider boundary — a clean 500 provider error, never a validation/turnstile 4xx', async ({
    page,
    request,
  }) => {
    // Real Cloudflare widget round trip against a heavier page (/forms-pay
    // ships more JS/CSS than the root demo page turnstile.spec.ts's own
    // ALWAYS-PASS test loads) PLUS a follow-up API POST — give MORE headroom
    // than that precedent's 45s/20s budget, since this test does strictly
    // more work under the same real-infra variability (LESSONS.md #29;
    // observed flaking under full-suite concurrent load at 45s/20s).
    test.setTimeout(60_000);

    await page.goto(`${PAY_PASS_URL}/forms-pay/?amount=200`);

    const action = await page.locator('#pay-form').getAttribute('action');

    // Real Cloudflare ALWAYS-PASS dummy-key round trip (LESSONS.md #29) —
    // the test sitekey auto-completes without user interaction and
    // populates the widget's hidden response input directly.
    await page.waitForFunction(
      () => {
        const input = document.querySelector<HTMLInputElement>('.cf-turnstile input[name="cf-turnstile-response"]');
        return Boolean(input?.value);
      },
      { timeout: 30_000 },
    );
    const token = await page.locator('.cf-turnstile input[name="cf-turnstile-response"]').inputValue();
    expect(token.length).toBeGreaterThan(0);

    const hitsBefore = stripeMockHits;
    const res = await request.post(`${PAY_PASS_URL}${action}`, {
      headers: { Origin: PAY_PASS_URL },
      form: { amount: '200', currency: 'usd', 'cf-turnstile-response': token },
    });

    // 500 (provider error) proves origin/payload/rate-limit/validation/
    // turnstile ALL passed — a gate rejection would be 400/403, never 500.
    expect(res.status()).toBe(500);
    const body = (await res.json()) as { ok: boolean; reason?: string };
    expect(body).toEqual({ ok: false, reason: 'error' });
    // Reached the LOCAL mock (not a validation/turnstile short-circuit) —
    // and never any live api.stripe.com network hop (hard rule).
    expect(stripeMockHits).toBe(hitsBefore + 1);
  });
});

test.describe('PAY-05 create-session — Turnstile hard gate (PAY_FAIL_URL, ALWAYS-FAIL pair)', () => {
  test('a POST with no Turnstile token is rejected 403 BEFORE any provider call', async ({ request }) => {
    const hitsBefore = stripeMockHits;

    const res = await request.post(`${PAY_FAIL_URL}/api/forms/pay/create-session`, {
      headers: { Origin: PAY_FAIL_URL },
      form: { amount: '200', currency: 'usd' },
    });

    expect(res.status()).toBe(403);
    const body = (await res.json()) as { ok: boolean; reason?: string };
    expect(body).toEqual({ ok: false, reason: 'turnstile' });
    expect(stripeMockHits).toBe(hitsBefore); // never reached the provider boundary
  });
});

// The successful hosted-Checkout redirect (a real Stripe/PayPal test-mode
// account completing a real session and landing on /forms-pay/success) is
// the owner-gated human live-key drill (RESEARCH.md Validation
// Architecture) — not automated here, exactly like Phase 2's real-Cloudflare
// widget-UX check (LESSONS.md #29).
