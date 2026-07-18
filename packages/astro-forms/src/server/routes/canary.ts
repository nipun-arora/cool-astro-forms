/**
 * Prod-safe ops canary (review S8.2-B) — the owner's Phase 1 heartbeat.
 * Instant email is otherwise the ONLY signal that abandon capture is
 * working, and it can fail invisibly (SMTP misconfig, silent production
 * skip). GET /api/forms/canary returns aggregate-only health data behind a
 * constant-time Bearer-token check. NO PII, no field data, ever (T-01-40).
 *
 * On hosts with `trailingSlash: 'always'`, point
 * monitoring/cron callers at GET /api/forms/canary/ (trailing slash) — the
 * slashless form is only reachable there via Astro's own redirect handling,
 * so cron config should target the correct form directly rather than rely
 * on a redirect hop.
 */
import type { APIRoute } from 'astro';
import config from 'virtual:cool-astro-forms/config';
import { logError } from '../log.js';
import { getNotifyHealth } from '../notify.js';
import { tokensMatch } from '../security/constant-time-compare.js';
import { getStorageAdapter } from '../storage/index.js';

export const prerender = false;

const DAY_MS = 24 * 60 * 60 * 1000;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export const GET: APIRoute = async ({ request }) => {
  // Dedicated token preferred so the admin password need not ride in
  // monitoring cron configs.
  const token = process.env.CANARY_TOKEN ?? process.env.FORMS_ADMIN_PASSWORD;
  if (!token) {
    return new Response(null, { status: 404 });
  }

  const authHeader = request.headers.get('authorization') ?? '';
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : '';
  if (!provided || !tokensMatch(provided, token)) {
    return new Response(null, { status: 401 });
  }

  try {
    const storage = await getStorageAdapter(config);
    const since = Date.now() - DAY_MS;

    const [count24h, recentAbandoned] = await Promise.all([
      storage.countEntries({ status: 'abandoned', from: since }),
      storage.listEntries({ status: 'abandoned', limit: 1 }),
    ]);

    return jsonResponse(200, {
      lastAbandonedAt: recentAbandoned[0]?.createdAt ?? null,
      lastNotifySuccessAt: getNotifyHealth().lastSuccessAt,
      count24h,
    });
  } catch (err) {
    logError('canary.failed', err);
    return new Response(null, { status: 500 });
  }
};
