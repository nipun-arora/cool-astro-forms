/**
 * The public `cool-astro-forms/server` surface. Hosts import these names
 * directly; removing or renaming one breaks a consuming site at build time,
 * so the 0.1.15 additions are pinned here alongside the existing entry
 * point. (The packed-tarball check in scripts/verify-quickstart.mjs proves
 * the exports map resolves; this proves the module exports the names.)
 */
import { describe, expect, it } from 'vitest';
import * as server from './index.js';

describe('cool-astro-forms/server public exports', () => {
  it('keeps the existing runtime exports', () => {
    for (const name of ['recordSubmission', 'SqliteStorage', 'getDb', 'verifyTurnstile', 'verifyWebhookSignature']) {
      expect(typeof (server as Record<string, unknown>)[name]).toBe('function');
    }
  });

  it('exports the 0.1.15 payment and admin helpers', () => {
    expect(typeof server.createCheckoutForEntry).toBe('function');
    expect(typeof server.isAdminRequest).toBe('function');
  });

  it('exports escapeHtml and the currency-aware formatMoney for host email templates', () => {
    expect(server.escapeHtml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
    expect(server.formatMoney(500, 'jpy')).toBe('¥500');
  });
});
