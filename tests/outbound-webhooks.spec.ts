/**
 * HOOK-01 outbound webhooks e2e (Plan 09) — proves the REAL, end-to-end
 * wiring live: astro.config.mjs's `webhooks[]` (gated on
 * `CAF_E2E_WEBHOOK_URL`) -> middleware.ts's `registerRuntimeConfig` ->
 * `registerWebhookTargets` -> a real lifecycle event through the playground
 * -> `deliverWebhook`'s real (non-injected) fetch -> a signed POST a local
 * `node:http` receiver verifies. This is the SAME round trip
 * `deliver.integration.test.ts` already proves at the module level
 * (deliverWebhook() called directly) — this file proves the INTEGRATION
 * wiring on top of it (env config -> live server -> real HTTP delivery),
 * which is the part deliver.integration.test.ts cannot cover.
 *
 * PAY_FAIL_URL (default trailingSlash) carries `CAF_E2E_WEBHOOK_URL` —
 * chosen over PAY_PASS_URL so the abandon-trigger helper needs no B1 slash
 * gymnastics; the ALWAYS-FAIL Turnstile pair on that instance never blocks
 * the abandon save (D3 soft-log — handle-abandon.ts never reverts on a
 * failed/absent token, it only flags the row).
 *
 * 0.1.18: `entry.abandoned` is deferred with the owner's alert (15 minutes
 * by default; the abandon beacon also fires on a mere tab switch), so these
 * specs trigger the real alert sweep through the playground's DEV-only
 * `/api/debug-recovery?action=abandon-alert-sweep` (clock advanced past the
 * delay) instead of waiting, and prove a submission inside the delay
 * cancels the webhook.
 *
 * Clean-room: written fresh against the RESEARCH.md no-durable-queue
 * decision and the real deliver.ts/sign.ts source, not derived from any
 * commercial form-plugin source.
 */
import { createServer, type Server } from 'node:http';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { verifyWebhookSignature } from 'cool-astro-forms/server';
import { PAY_FAIL_URL, WEBHOOK_RECEIVER_PORT } from '../playwright.config';
import { abandonPayload, postAbandon, resetState } from './helpers';

interface ReceivedDelivery {
  body: string;
  signature: string | null;
}

let receiver: Server | undefined;
let received: ReceivedDelivery[] = [];

test.beforeAll(async () => {
  receiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        body: Buffer.concat(chunks).toString('utf8'),
        signature: (req.headers['x-caf-signature'] as string | undefined) ?? null,
      });
      res.writeHead(200);
      res.end();
    });
  });
  await new Promise<void>((resolve) => receiver?.listen(WEBHOOK_RECEIVER_PORT, '127.0.0.1', resolve));
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => receiver?.close(() => resolve()));
});

test.beforeEach(async ({ request }) => {
  received = [];
  await resetState(request, PAY_FAIL_URL);
});

/** Runs the real deferred-alert sweep with its clock past the alert delay. */
async function runAlertSweep(request: APIRequestContext): Promise<void> {
  const res = await request.get(`${PAY_FAIL_URL}/api/debug-recovery?action=abandon-alert-sweep`);
  expect(res.ok()).toBe(true);
}

/** Webhook event types received so far, in arrival order. */
function receivedTypes(): string[] {
  return received.map((delivery) => (JSON.parse(delivery.body) as { type: string }).type);
}

test.describe('HOOK-01 outbound webhooks — real signed delivery to a local receiver', () => {
  test('an abandoned draft fires a signed entry.abandoned webhook the receiver verifies, once the alert delay has passed and not before', async ({
    request,
  }) => {
    const payload = abandonPayload({
      visitorUuid: `webhook-e2e-${Math.random().toString(36).slice(2)}`,
      fields: { name: 'Webhook E2E', email: 'webhook-e2e@example.com' },
    });

    const { status, body } = await postAbandon(request, payload, PAY_FAIL_URL, PAY_FAIL_URL);
    expect(status).toBe(200);
    expect(body?.saved).toBe(true);

    // Deferred: nothing goes out on the save itself (a tab switch looks
    // exactly like this POST).
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(received).toHaveLength(0);

    await runAlertSweep(request);

    // deliverWebhook is fire-and-forget (never awaited by the sweep) — poll
    // for the receiver's delivery rather than assuming it has landed.
    await expect.poll(() => received.length, { timeout: 10_000 }).toBeGreaterThan(0);

    const [delivery] = received;
    expect(delivery.signature).not.toBeNull();
    expect(verifyWebhookSignature(delivery.body, delivery.signature, 'e2e-webhook-secret')).toBe(true);

    const parsed = JSON.parse(delivery.body) as {
      type: string;
      data: { fields: Record<string, unknown> };
    };
    expect(parsed.type).toBe('entry.abandoned');
    expect(parsed.data.fields.email).toBe('webhook-e2e@example.com');

    // Never delivers more than once for a single first-time creation, even
    // when the sweep runs again.
    await runAlertSweep(request);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(received).toHaveLength(1);
  });

  test('a submission inside the alert delay cancels entry.abandoned: the receiver only ever sees entry.submitted', async ({
    request,
  }) => {
    const visitorUuid = `webhook-submit-${Math.random().toString(36).slice(2)}`;
    const payload = abandonPayload({ visitorUuid, fields: { name: 'Tab Switcher', email: 'tab-switch@example.com' } });

    const { body } = await postAbandon(request, payload, PAY_FAIL_URL, PAY_FAIL_URL);
    expect(body?.saved).toBe(true);

    // The visitor comes back to the tab and submits for real.
    const submit = await request.post(`${PAY_FAIL_URL}/api/upload`, {
      headers: { 'Content-Type': 'application/json' },
      data: { fields: { visitorUuid, name: 'Tab Switcher', email: 'tab-switch@example.com' } },
    });
    expect(submit.ok()).toBe(true);
    await expect.poll(() => receivedTypes(), { timeout: 10_000 }).toContain('entry.submitted');

    await runAlertSweep(request);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(receivedTypes()).toEqual(['entry.submitted']);
  });

  test('a tampered receiver-side body fails verification (proves the signature is over the exact bytes sent, not merely present)', async ({
    request,
  }) => {
    const payload = abandonPayload({
      visitorUuid: `webhook-tamper-${Math.random().toString(36).slice(2)}`,
    });

    await postAbandon(request, payload, PAY_FAIL_URL, PAY_FAIL_URL);
    await runAlertSweep(request);
    await expect.poll(() => received.length, { timeout: 10_000 }).toBeGreaterThan(0);

    const [delivery] = received;
    const tampered = delivery.body.replace('entry.abandoned', 'entry.submitted');

    expect(verifyWebhookSignature(tampered, delivery.signature, 'e2e-webhook-secret')).toBe(false);
    expect(verifyWebhookSignature(delivery.body, delivery.signature, 'wrong-secret')).toBe(false);
  });
});
