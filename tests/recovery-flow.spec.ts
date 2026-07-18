/**
 * RCV-01 e2e (Plan 09) — proves the whole lead-recovery loop end to end
 * WITHOUT a live SMTP/Google account, against the dedicated RECOVERY_URL
 * instance (playwright.config.ts — `recovery.enabled:true` via
 * `CAF_E2E_RECOVERY_ENABLED`, `consentMode:'auto'`, `delayMins:60`):
 *
 *  - The widget's "progress saved" toast is asserted LIVE, in a real
 *    browser: an abandon save rides `capture.ts`'s `transmitReadingSaved()`
 *    fetch-reads-`{saved}` path (the RCV-01 eng lock), never a fire-and-
 *    forget beacon that can't confirm the save.
 *  - The lazy sweep, the follow-up dispatch, and the unsubscribe
 *    suppression are proven via the `request` fixture only (no browser) —
 *    the offline-deterministic path this plan's own text prefers: the
 *    production sweep is a lazy, per-process-gated, real-clock-driven
 *    side-effect with no way to observe "~60 minutes later" inside a fast
 *    run, so `apps/playground/src/pages/api/debug-recovery.ts` calls the
 *    REAL `runRecoverySweep`/`sendRecoveryEmail` directly with an advanced
 *    `now` (jsonTransport in dev — never a live SMTP hop) instead of
 *    stubbing anything out.
 *
 * Clean-room: written fresh against the Plan 04-06/04-07/04-08 route/widget
 * source and the D3/D4/D4a CONTEXT decisions, not derived from any WPForms
 * source (RESEARCH.md established recovery has no WPForms precedent).
 */
import type { APIRequestContext } from '@playwright/test';
import { test, expect } from '@playwright/test';
import { RECOVERY_URL } from '../playwright.config';
import { abandonPayload, fireExitIntent, postAbandon, resetState } from './helpers';

interface SweptSend {
  to: string;
  unsubscribeUrl: string;
  resumeUrl: string;
}

async function triggerSweep(request: APIRequestContext): Promise<{ sent: SweptSend[] }> {
  const res = await request.get(`${RECOVERY_URL}/api/debug-recovery?action=sweep`);
  if (!res.ok()) throw new Error(`debug-recovery sweep failed: ${res.status()}`);
  return (await res.json()) as { sent: SweptSend[] };
}

async function mintUnsubscribeUrl(request: APIRequestContext, visitorUuid: string): Promise<string> {
  const res = await request.get(
    `${RECOVERY_URL}/api/debug-recovery?action=unsubscribe-url&visitorUuid=${encodeURIComponent(visitorUuid)}`,
  );
  if (!res.ok()) throw new Error(`debug-recovery unsubscribe-url mint failed: ${res.status()}`);
  const body = (await res.json()) as { url: string };
  return body.url;
}

test.beforeEach(async ({ request }) => {
  await resetState(request, RECOVERY_URL);
});

test.describe('RCV-01 recovery widget — fetch-confirmed "progress saved" toast (real browser)', () => {
  test('an exit-intent abandon on the recovery-enabled instance renders the toast driven by a real {saved:true} response', async ({
    page,
  }) => {
    await page.goto(`${RECOVERY_URL}/`);

    // 04-10 gap closure: proves the public-subset wire shape end to end —
    // the playground defines no per-form override, so `disabledForms` must
    // be entirely absent (omitted, not []) from __cafConfig.recovery.
    const publicRecoveryConfig = await page.evaluate(() => window.__cafConfig?.recovery);
    expect(publicRecoveryConfig).toEqual({ enabled: true, consentMode: 'auto' });

    await page.fill('#email', 'recovery-toast@example.com');
    await fireExitIntent(page);

    const toast = page.locator('[data-caf-recovery-toast]');
    await expect(toast).toBeVisible({ timeout: 10_000 });
    await expect(toast).toContainText('progress is saved');
  });
});

test.describe('RCV-01/D3/D4 lazy sweep — deterministic single send + one-click unsubscribe suppression', () => {
  test('the sweep sends exactly one follow-up carrying a signed unsubscribe link; a repeat sweep never re-sends the same (now-claimed) row', async ({
    request,
  }) => {
    const visitorUuid = `recovery-sweep-${Math.random().toString(36).slice(2)}`;
    const payload = abandonPayload({
      visitorUuid,
      fields: { name: 'Recovery Sweep', email: 'recovery-sweep@example.com' },
    });

    const { status, body } = await postAbandon(request, payload, RECOVERY_URL, RECOVERY_URL);
    expect(status).toBe(200);
    expect(body?.saved).toBe(true);

    // consent_at (D3 auto-basis) is written fire-and-forget by
    // handle-abandon.ts (never awaited before the response) — poll the
    // sweep rather than assume the write landed by response time.
    let first: { sent: SweptSend[] } = { sent: [] };
    await expect
      .poll(
        async () => {
          first = await triggerSweep(request);
          return first.sent.length;
        },
        { timeout: 10_000 },
      )
      .toBe(1);

    expect(first.sent[0].to).toBe('recovery-sweep@example.com');
    expect(first.sent[0].unsubscribeUrl).toContain('/api/forms/recovery-unsubscribe?token=');
    expect(first.sent[0].resumeUrl).toBeTruthy();

    // markRecoverySent's atomic claim (BEGIN IMMEDIATE) means a second sweep
    // pass over the SAME row is a no-op — never a duplicate follow-up.
    const second = await triggerSweep(request);
    expect(second.sent).toHaveLength(0);
  });

  test('a valid unsubscribe link suppresses the visitor forever — proven independently of the "already sent" gate (D4a)', async ({
    request,
  }) => {
    const controlUuid = `recovery-control-${Math.random().toString(36).slice(2)}`;
    const suppressedUuid = `recovery-suppressed-${Math.random().toString(36).slice(2)}`;

    await postAbandon(
      request,
      abandonPayload({ visitorUuid: controlUuid, fields: { name: 'Control', email: 'recovery-control@example.com' } }),
      RECOVERY_URL,
      RECOVERY_URL,
    );
    await postAbandon(
      request,
      abandonPayload({
        visitorUuid: suppressedUuid,
        fields: { name: 'Suppressed', email: 'recovery-suppressed@example.com' },
      }),
      RECOVERY_URL,
      RECOVERY_URL,
    );

    // Mint + click the suppressed visitor's unsubscribe link BEFORE any
    // sweep ever runs for it — recovery_sent_at stays NULL going in, so a
    // subsequent exclusion can ONLY be explained by the suppression row
    // (`recovery_suppressions`), never by the separate "already claimed"
    // gate proven in the test above.
    const unsubscribeUrl = await mintUnsubscribeUrl(request, suppressedUuid);
    const unsubRes = await request.get(unsubscribeUrl);
    expect(unsubRes.status()).toBe(200);
    expect((await unsubRes.text()).toLowerCase()).toContain('unsubscribed');

    // Clicking it again is idempotent — same confirmation, no error.
    const unsubResAgain = await request.get(unsubscribeUrl);
    expect(unsubResAgain.status()).toBe(200);

    let swept: { sent: SweptSend[] } = { sent: [] };
    await expect
      .poll(
        async () => {
          swept = await triggerSweep(request);
          return swept.sent.some((s) => s.to === 'recovery-control@example.com');
        },
        { timeout: 10_000 },
      )
      .toBe(true);

    // The control visitor (no opt-out) DID get a follow-up in this exact
    // sweep pass — proving consent_at had landed for BOTH rows by the time
    // this assertion runs — while the equally-eligible, never-claimed
    // suppressed visitor's row never appears.
    expect(swept.sent.some((s) => s.to === 'recovery-suppressed@example.com')).toBe(false);

    // A forged/tampered token is rejected with the SAME generic message —
    // never a distinguishable "not found" vs "invalid" response (no
    // visitor-existence enumeration, T-04-23).
    const forgedRes = await request.get(
      `${RECOVERY_URL}/api/forms/recovery-unsubscribe?token=${suppressedUuid}.0000000000000000000000000000000000000000000000000000000000000000`,
    );
    expect(forgedRes.status()).toBe(400);
  });
});

// Live SMTP delivery (a real follow-up landing in an inbox, its unsubscribe
// link working over the public internet) is the deferred Phase-6 human
// drill (04-VALIDATION.md Human-needed) — not automated here, exactly like
// Phase 2's real-Cloudflare widget-UX check and Phase 3's live Stripe/PayPal
// drills.
