/**
 * Turnstile (D3/BOT-01) e2e — proves the real round trip: client widget
 * render against Cloudflare's live challenges.cloudflare.com (dummy testing
 * keys ONLY, never a real account) -> minted token -> abandon payload's
 * `_caf` envelope -> server-side `verifyTurnstile()` siteverify call -> the
 * D3 soft-log outcome (row KEPT, `fields._turnstile` persisted on failure).
 *
 * Two dedicated playground instances (playwright.config.ts's
 * TURNSTILE_PASS_URL/TURNSTILE_FAIL_URL) carry Cloudflare's documented
 * ALWAYS-PASS and ALWAYS-FAIL dummy key pairs so both outcomes get real
 * fidelity in the SAME run, without needing to flip env on an already-live
 * server process (TURNSTILE_SECRET_KEY is read once per request but from a
 * fixed process.env set at that server's own startup).
 */
import { test, expect } from '@playwright/test';
import { TURNSTILE_FAIL_URL, TURNSTILE_PASS_URL } from '../playwright.config';
import { abandonPayload, fireExitIntent, postAbandon, resetState, waitForAbandoned } from './helpers';

test.describe('Turnstile — ALWAYS-PASS dummy keys', () => {
  test.beforeEach(async ({ request }) => {
    await resetState(request, TURNSTILE_PASS_URL);
  });

  test('the widget script renders and a real minted token verifies with NO _turnstile flag persisted', async ({
    page,
    request,
  }) => {
    test.setTimeout(45_000);

    await page.goto(`${TURNSTILE_PASS_URL}/`);

    // Loader only injects when BOTH env keys are set (integration.ts) —
    // proves the conditional injection actually fired on this instance.
    await expect(page.locator('script[data-caf-turnstile-script]')).toHaveCount(1);

    // Cloudflare's ALWAYS-PASS test sitekey auto-completes without user
    // interaction and (for test sitekeys specifically) renders a lightweight
    // non-iframe widget — a `cf-turnstile-response` hidden input carrying the
    // dummy token directly, rather than the interactive-challenge iframe a
    // real sitekey uses. Wait for that input to gain a non-empty value, which
    // is also exactly when the `callback` we passed to turnstile.render()
    // fires and hands capture.ts its token via setTurnstileToken().
    await page.waitForFunction(
      () => {
        const input = document.querySelector<HTMLInputElement>(
          '[data-caf-turnstile] input[name="cf-turnstile-response"]',
        );
        return Boolean(input?.value);
      },
      { timeout: 20_000 },
    );

    await page.fill('#email', 'turnstile-pass@example.com');
    await fireExitIntent(page);

    const [row] = await waitForAbandoned(request, 1, TURNSTILE_PASS_URL);
    expect(row.fields.email).toBe('turnstile-pass@example.com');
    expect(row.fields._turnstile).toBeUndefined();
  });
});

test.describe('Turnstile — ALWAYS-FAIL dummy keys (D3 soft-log)', () => {
  test.beforeEach(async ({ request }) => {
    await resetState(request, TURNSTILE_FAIL_URL);
  });

  test('the widget script also renders on the ALWAYS-FAIL instance (injection is independent of pass/fail outcome)', async ({
    page,
  }) => {
    await page.goto(`${TURNSTILE_FAIL_URL}/`);
    await expect(page.locator('script[data-caf-turnstile-script]')).toHaveCount(1);
  });

  test('a failing verification still lands the save (soft-log) and persists fields._turnstile="failed" (checker B2)', async ({
    request,
  }) => {
    // Direct API POST rather than a full browser widget flow: Cloudflare's
    // documented ALWAYS-FAIL testing secret returns {success:false} for ANY
    // non-empty token — this exercises the real server-side siteverify round
    // trip deterministically, independent of headless-browser widget timing.
    const payload = abandonPayload({
      visitorUuid: `turnstile-fail-${Math.random().toString(36).slice(2)}`,
      fields: {
        email: 'turnstile-fail@example.com',
        _caf: JSON.stringify({ turnstileToken: 'e2e-non-empty-token' }),
      },
    });

    const { status, body } = await postAbandon(request, payload, TURNSTILE_FAIL_URL, TURNSTILE_FAIL_URL);
    expect(status).toBe(200);
    expect(body?.saved).toBe(true); // soft-log: the row is KEPT, never rejected (D3)

    const [row] = await waitForAbandoned(request, 1, TURNSTILE_FAIL_URL);
    expect(row.fields.email).toBe('turnstile-fail@example.com');
    expect(row.fields._turnstile).toBe('failed');
  });
});
