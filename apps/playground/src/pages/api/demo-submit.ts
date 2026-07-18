/**
 * DEV/e2e-only file-bearing submit endpoint (Plan 09, DRV-01/DRV-02).
 * `/api/upload` (the playground's OTHER submit endpoint, PKG-03 adoption
 * reference) never carries files — this is the SEPARATE host-adoption shape
 * a real host implements when it wants Drive uploads: decode real file
 * bytes into a `FileInput[]`, call `recordSubmission()`, and branch its OWN
 * email code on the returned `FileUploadOutcome[]` (D1 — the package sends
 * no submission-path email itself). DEV-gated (compile-time eliminated from
 * `astro build` output, T-01-31 precedent) + localhost-only, mirroring
 * `debug-entries.ts`'s posture — this file only exists to give
 * `tests/drive-upload.spec.ts` a real host endpoint to POST a file at
 * against the mock Drive server, not a route any package consumer ships.
 *
 * Response shape deliberately never serializes a raw fallback buffer over
 * the wire (`attached: boolean` only) — a REAL host attaches the buffer
 * itself, server-side, inside its own email code; echoing file bytes back
 * to the client here would be pointless and wasteful for what is only a
 * demo endpoint.
 */
import type { APIRoute } from 'astro';
import { recordSubmission } from 'cool-astro-forms/server';

export const prerender = false;

function isLocalhost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

interface DemoSubmitBody {
  filename?: string;
  dataBase64?: string;
  email?: string;
}

export const POST: APIRoute = async ({ request, clientAddress, url }) => {
  if (!import.meta.env.DEV) return new Response(null, { status: 404 });
  if (!isLocalhost(url.hostname)) return new Response(null, { status: 404 });

  const raw: unknown = await request.json().catch(() => null);
  if (!raw || typeof raw !== 'object') {
    return json(400, { ok: false, error: 'invalid body' });
  }

  const { filename, dataBase64, email } = raw as DemoSubmitBody;
  if (!filename || !dataBase64) {
    return json(400, { ok: false, error: 'filename and dataBase64 are required' });
  }

  const buffer = Buffer.from(dataBase64, 'base64');

  const result = await recordSubmission({
    siteId: 'playground',
    formId: 'demo',
    fields: email ? { email } : {},
    files: [{ filename, buffer, mimeType: 'text/plain' }],
    request,
    ip: clientAddress,
  });

  if (!result.ok) {
    return json(500, { ok: false });
  }

  // Host-facing outcome mapping (D1): driveLink present -> link it; a
  // fallbackBuffer present -> the host would attach it (never echoed here,
  // just a boolean); fallbackTooLarge -> neither, entry still saved.
  const files = (result.files ?? []).map((f) => ({
    filename: f.filename,
    driveLink: f.driveLink,
    attached: Boolean(f.fallbackBuffer),
    fallbackTooLarge: f.fallbackTooLarge ?? false,
  }));

  return json(200, { ok: true, entryId: result.entryId, files });
};
