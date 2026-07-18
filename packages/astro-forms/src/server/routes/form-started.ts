/**
 * POST /api/forms/started (ANLY-01 D1) — idempotent form_started counter
 * ping. `capture.ts` fires this via sendBeacon on the first qualifying
 * input into a tagged form, once per visitor+form. Thin Astro `APIRoute`
 * adapter, mirroring `routes/abandon.ts`'s shape: isSameOrigin (this route
 * also receives application/json, so Astro's built-in
 * `security.checkOrigin` never inspects it — T-01-08 precedent) -> size cap
 * -> parse/validate -> quiet no-op on an unknown site/form (never reveals
 * config shape) -> `storage.recordFormStart` (INSERT OR IGNORE, so a
 * duplicate ping from a racing/replayed beacon is a correctness no-op, not
 * an error). Stores only siteId + formId + visitorUuid + ts — no PII
 * (T-02-31).
 *
 * Storage acquisition happens INSIDE the try/catch (mirrors routes/abandon.ts
 * — a migration/open failure resolves a logged 500, not an unlogged crash).
 *
 * Clean-room: written fresh against the Plan 01/07 contracts, not derived
 * from any WPForms source.
 */
import { z } from 'zod';
import type { APIRoute } from 'astro';
import config from 'virtual:cool-astro-forms/config';
import { logError } from '../log.js';
import { isSameOrigin } from '../security/origin-check.js';
import { contentLengthWithinCap, MAX_PAYLOAD_BYTES, readBodyCapped } from '../security/size-cap.js';
import { getStorageAdapter } from '../storage/index.js';

export const prerender = false;

const startedPayloadSchema = z.object({
  siteId: z.string().min(1),
  formId: z.string().min(1),
  visitorUuid: z.string().min(1),
});

export const POST: APIRoute = async ({ request }) => {
  // 1. Origin (T-01-08) — the ONLY origin protection this route gets, same
  // reasoning as routes/abandon.ts: application/json bypasses Astro's
  // built-in security.checkOrigin entirely.
  if (!isSameOrigin(request.headers, config.siteUrl)) {
    return new Response(null, { status: 403 });
  }

  // 2. Size cap — fast-path via Content-Length, then a streaming backstop.
  if (!contentLengthWithinCap(request.headers, MAX_PAYLOAD_BYTES)) {
    return new Response(null, { status: 413 });
  }
  const readResult = await readBodyCapped(request.body, MAX_PAYLOAD_BYTES);
  if (!readResult.ok) {
    return new Response(null, { status: 413 });
  }

  // 3. Parse + validate.
  let raw: unknown;
  try {
    raw = JSON.parse(readResult.text);
  } catch {
    return new Response(null, { status: 400 });
  }

  const parsed = startedPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    return new Response(null, { status: 400 });
  }
  const { siteId, formId, visitorUuid } = parsed.data;

  // 4. Unknown site/form -> quiet no-op (never reveal which sites/forms are
  // configured — same posture as handle-abandon.ts's own unknown-form check).
  if (siteId !== config.siteId || !config.forms[formId]) {
    return new Response(null, { status: 204 });
  }

  try {
    const storage = await getStorageAdapter(config);
    await storage.recordFormStart(siteId, formId, visitorUuid);
  } catch (err) {
    logError('form-started.storage-failed', err, { siteId, formId });
    return new Response(null, { status: 500 });
  }

  return new Response(null, { status: 204 });
};
