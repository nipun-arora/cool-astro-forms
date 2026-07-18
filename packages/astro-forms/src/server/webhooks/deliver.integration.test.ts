/**
 * deliver.ts local-HTTP integration test (Validation Architecture: no
 * Playwright, no external network) — a REAL `node:http` server receives one
 * signed POST from deliverWebhook's DEFAULT (non-injected) fetch + schedule,
 * proving the full round-trip: sign -> POST -> receive -> verify.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { deliverWebhook, registerWebhookTargets, resetWebhookTargets } from './deliver.js';
import { verifyWebhookSignature } from './sign.js';

let server: Server | undefined;

afterEach(async () => {
  resetWebhookTargets();
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
});

describe('deliverWebhook — local HTTP integration', () => {
  it('delivers a real signed POST that verifyWebhookSignature accepts against the received body', async () => {
    const secret = 'integration-test-secret';
    let receivedBody = '';
    let receivedSignature: string | null = null;

    const received = new Promise<void>((resolve) => {
      server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          receivedBody = Buffer.concat(chunks).toString('utf8');
          receivedSignature = (req.headers['x-caf-signature'] as string | undefined) ?? null;
          res.writeHead(200);
          res.end();
          resolve();
        });
      });
    });

    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const port = (server?.address() as AddressInfo).port;

    registerWebhookTargets([{ url: `http://127.0.0.1:${port}/hook`, secret }]);
    deliverWebhook('entry.submitted', { entryId: 'entry-integration-1' });

    await received;

    expect(receivedBody.length).toBeGreaterThan(0);
    expect(receivedSignature).not.toBeNull();
    expect(verifyWebhookSignature(receivedBody, receivedSignature, secret)).toBe(true);

    const parsed = JSON.parse(receivedBody) as { type: string; data: { entryId: string } };
    expect(parsed.type).toBe('entry.submitted');
    expect(parsed.data.entryId).toBe('entry-integration-1');
  });
});
