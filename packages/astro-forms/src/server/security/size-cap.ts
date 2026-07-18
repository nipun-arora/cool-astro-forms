/**
 * Payload size cap guard for the /api/forms/abandon route (SEC-01,
 * RESEARCH.md Pitfall 4). Rejects oversized bodies before JSON parsing.
 *
 * `MAX_PAYLOAD_BYTES` is re-exported from `../../limits.js` — the single
 * source of truth shared by client and server — never re-declared here.
 *
 * Clean-room: written fresh against the Fetch/Streams spec, not derived
 * from any commercial form-plugin source.
 */
import { MAX_PAYLOAD_BYTES } from '../../limits.js';

export { MAX_PAYLOAD_BYTES };

/** Byte-length (UTF-8) check on an already-buffered body string. */
export function withinSizeCap(body: string | undefined, maxBytes: number): boolean {
  if (body === undefined) return true;
  return Buffer.byteLength(body, 'utf8') <= maxBytes;
}

/**
 * Fast-path pre-check reading the Content-Length header so the route can
 * reject BEFORE buffering `request.text()`. A missing or non-numeric header
 * defers to the streaming reader (`readBodyCapped`), which remains the
 * backstop for chunked requests that omit Content-Length entirely.
 */
export function contentLengthWithinCap(headers: Headers, maxBytes: number): boolean {
  const raw = headers.get('Content-Length');
  if (!raw) return true;
  const value = Number(raw);
  if (!Number.isFinite(value)) return true;
  return value <= maxBytes;
}

/**
 * Reads a request body stream, aborting (cancelling the reader and
 * returning `{ ok: false }`) as soon as the running byte total exceeds
 * `maxBytes` — covers chunked-transfer / missing-Content-Length requests
 * that `contentLengthWithinCap` cannot see.
 */
export async function readBodyCapped(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false }> {
  if (!body) return { ok: true, text: '' };

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { ok: false };
      }

      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return { ok: true, text };
  } catch {
    return { ok: false };
  }
}
