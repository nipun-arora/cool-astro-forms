/**
 * DEV-ONLY debug endpoint (Plan 09, RCV-01) — mirrors `debug-entries.ts`'s
 * gating posture (`import.meta.env.DEV` + localhost-only, dead-code-
 * eliminated from production builds). NEVER shipped as part of the package.
 *
 * The real production recovery sweep (`maybeRunRecoverySweep`, fired from
 * middleware on every request) is a lazy, per-process-gated, real-clock-
 * driven side-effect — there is no way to observe "one qualifying row gets
 * exactly one follow-up ~60 minutes later" inside a fast Playwright run
 * without either a real wait or reaching the ungated orchestrator directly.
 * Two actions, both read-only with respect to the module-level sweep gate
 * (this endpoint NEVER touches `maybeRunRecoverySweep`'s throttle):
 *
 *  - `?action=sweep` calls `runRecoverySweep` directly with `now` advanced
 *    past `config.recovery.delayMins` and an injected `send` that captures
 *    `{to, unsubscribeUrl, resumeUrl}` for the spec to assert on while ALSO
 *    forwarding to the real `sendRecoveryEmail` (jsonTransport in dev — no
 *    live SMTP), so the actual production send path is exercised, not
 *    stubbed out.
 *  - `?action=unsubscribe-url&visitorUuid=...` mints a validly-signed
 *    unsubscribe link for a visitor WITHOUT running a sweep first (so
 *    `recovery_sent_at` stays NULL going in) — this isolates "the visitor
 *    opted out" (D4a suppression) from "the row was already claimed" as two
 *    independently-provable `findRecoverableEntries` exclusions.
 */
import type { APIRoute } from 'astro';
import { getDb, SqliteStorage } from 'cool-astro-forms/server';
import {
  resolveRecoverySecret,
  runRecoverySweep,
  sendRecoveryEmail,
  signUnsubscribeToken,
  type RecoveryEmailData,
} from 'cool-astro-forms/server/test-hooks.js';
// eslint-disable-next-line import/no-unresolved -- resolved by the coolForms() Vite plugin at build/dev-server-start time (integration.ts)
import config from 'virtual:cool-astro-forms/config';

export const prerender = false;

function isLocalhost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

type ConfigWithTrailingSlash = typeof config & { trailingSlash?: 'always' | 'never' | 'ignore' };

function recoveryUnsubscribeEndpoint(cfg: ConfigWithTrailingSlash): string {
  return `${cfg.siteUrl}/api/forms/recovery-unsubscribe${cfg.trailingSlash === 'always' ? '/' : ''}`;
}

export const GET: APIRoute = async ({ url }) => {
  if (!import.meta.env.DEV) return new Response(null, { status: 404 });
  if (!isLocalhost(url.hostname)) return new Response(null, { status: 404 });

  const cfg = config as ConfigWithTrailingSlash;
  const action = url.searchParams.get('action');

  if (action === 'unsubscribe-url') {
    const visitorUuid = url.searchParams.get('visitorUuid');
    if (!visitorUuid) return json(400, { error: 'visitorUuid is required' });
    const secret = resolveRecoverySecret(cfg.dbPath);
    const token = signUnsubscribeToken(visitorUuid, secret);
    return json(200, { url: `${recoveryUnsubscribeEndpoint(cfg)}?token=${token}` });
  }

  if (action === 'sweep') {
    const storage = new SqliteStorage(getDb());
    const sent: Array<{ to: string; unsubscribeUrl: string; resumeUrl: string }> = [];
    // Advances the injected `now` past `delayMins` so findRecoverableEntries'
    // cutoff includes a row that was, in real wall-clock time, updated only
    // moments ago — the SAME `now`-injection seam sweep.test.ts already
    // covers at the unit level; this just drives it through the real,
    // live server + real sqlite file instead of an in-memory double.
    const now = Date.now() + cfg.recovery.delayMins * 60_000 + 5_000;

    await runRecoverySweep({
      storage,
      config: cfg,
      now: () => now,
      send: async (data: RecoveryEmailData) => {
        sent.push({ to: data.to, unsubscribeUrl: data.unsubscribeUrl, resumeUrl: data.resumeUrl });
        return sendRecoveryEmail(data);
      },
    });

    return json(200, { sent });
  }

  return json(400, { error: 'unknown action' });
};
