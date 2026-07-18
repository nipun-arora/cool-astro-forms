/**
 * POST /forms-admin/entries/action (ADMN-02) — status/delete/purge for the
 * admin entry-detail view. isSameOrigin (CSRF, T-02-22) is the ONLY origin
 * check this route needs of its own; the session guard already lives in
 * middleware.ts, which covers every /forms-admin/* path (T-02-23) — an
 * unauthenticated request never reaches this handler. Destructive actions
 * (delete/purge) are gated behind entry-detail.astro's required-checkbox
 * confirm control, not anything this route re-validates (the POST-vs-GET
 * distinction is the real CSRF-relevant control, T-02-25).
 *
 * Storage acquisition happens INSIDE the try/catch (mirrors routes/abandon.ts
 * — a migration/open failure resolves a logged 500, not an unlogged crash).
 * Route injection consolidated in P05 Task 3 (integration.ts).
 */
import type { APIRoute } from 'astro';
import config from 'virtual:cool-astro-forms/config';
import type { EntryStatus } from '../../../types.js';
import { logError } from '../../log.js';
import { isSameOrigin } from '../../security/origin-check.js';
import { getStorageAdapter } from '../../storage/index.js';
import { adminUrl } from '../../admin/_shared.js';

export const prerender = false;

const VALID_STATUSES: readonly EntryStatus[] = ['abandoned', 'submitted', 'converted', 'spam'];
type EntryAction = 'status' | 'delete' | 'purge';

type ConfigWithTrailingSlash = typeof config & { trailingSlash?: 'always' | 'never' | 'ignore' };

/** Reads a form-urlencoded/multipart or JSON body into a flat string map. Never throws. */
async function extractFields(request: Request): Promise<Record<string, string>> {
  const contentType = request.headers.get('content-type') ?? '';
  const out: Record<string, string> = {};
  try {
    if (contentType.includes('application/json')) {
      const body = (await request.json()) as Record<string, unknown>;
      for (const [k, v] of Object.entries(body)) if (typeof v === 'string') out[k] = v;
      return out;
    }
    const formData = await request.formData();
    for (const [k, v] of formData.entries()) if (typeof v === 'string') out[k] = v;
    return out;
  } catch {
    return out;
  }
}

function badRequest(): Response {
  return new Response(null, { status: 400 });
}

export const POST: APIRoute = async ({ request }) => {
  const trailingSlash = (config as ConfigWithTrailingSlash).trailingSlash;

  // 1. CSRF (T-02-22) — the ONLY origin protection this route gets of its
  // own; the auth session guard already covers this whole path prefix.
  if (!isSameOrigin(request.headers, config.siteUrl)) {
    return new Response(null, { status: 403 });
  }

  const fields = await extractFields(request);
  const id = fields.id;
  const action = fields.action as EntryAction | undefined;

  if (!id || (action !== 'status' && action !== 'delete' && action !== 'purge')) {
    return badRequest();
  }

  try {
    const storage = await getStorageAdapter(config);

    if (action === 'status') {
      const status = fields.status;
      if (!status || !(VALID_STATUSES as readonly string[]).includes(status)) {
        return badRequest();
      }
      await storage.updateEntry(id, { status: status as EntryStatus });
    } else if (action === 'delete') {
      // HARD delete (the ADMN-02 per-entry delete) — cascade covered by
      // P01's contract tests (deleteEntry).
      await storage.deleteEntry(id);
    } else {
      // purge (PRIV-01, visitor-wide GDPR erasure): visitorUuid is resolved
      // SERVER-side from the entry — a client-posted uuid is never trusted.
      const entry = await storage.getEntryById(id);
      if (!entry) return badRequest();
      await storage.purgeVisitor(entry.visitorUuid);
    }
  } catch (err) {
    logError('admin.entry-action-failed', err, { id, action });
    return new Response(null, { status: 500 });
  }

  const redirectTarget =
    action === 'delete' || action === 'purge' ? '/forms-admin/entries' : `/forms-admin/entries/${id}`;
  return new Response(null, {
    status: 302,
    headers: { Location: adminUrl(redirectTarget, trailingSlash) },
  });
};
