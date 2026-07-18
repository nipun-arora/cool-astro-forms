/**
 * size-cap.ts tests — payload size cap enforcement (SEC-01, RESEARCH.md
 * Pitfall 4). Clean-room, written fresh against the Fetch/Streams specs.
 */
import { describe, expect, it } from 'vitest';
import {
  contentLengthWithinCap,
  MAX_PAYLOAD_BYTES,
  readBodyCapped,
  withinSizeCap,
} from './size-cap.js';

describe('MAX_PAYLOAD_BYTES', () => {
  it('is re-exported from the shared limits module (single source of truth)', () => {
    expect(MAX_PAYLOAD_BYTES).toBe(50_000);
  });
});

describe('withinSizeCap', () => {
  it('returns false for a body over the cap', () => {
    expect(withinSizeCap('x'.repeat(50_001), 50_000)).toBe(false);
  });

  it('returns true for a body within the cap', () => {
    expect(withinSizeCap('{}', 50_000)).toBe(true);
  });

  it('returns true for a body exactly at the cap', () => {
    expect(withinSizeCap('x'.repeat(50_000), 50_000)).toBe(true);
  });

  it('returns true for an undefined body', () => {
    expect(withinSizeCap(undefined, 50_000)).toBe(true);
  });

  it('returns true for an empty body', () => {
    expect(withinSizeCap('', 50_000)).toBe(true);
  });

  it('measures UTF-8 byte length, not JS string length, for multi-byte characters', () => {
    // Each '€' is 3 bytes in UTF-8 but 1 UTF-16 code unit in JS string length.
    const body = '€'.repeat(20_000); // 60,000 bytes, 20,000 JS chars
    expect(body.length).toBeLessThan(50_000);
    expect(withinSizeCap(body, 50_000)).toBe(false);
  });
});

describe('contentLengthWithinCap', () => {
  it('returns false when Content-Length exceeds the cap', () => {
    const headers = new Headers({ 'Content-Length': '60000' });
    expect(contentLengthWithinCap(headers, 50_000)).toBe(false);
  });

  it('returns true when Content-Length is within the cap', () => {
    const headers = new Headers({ 'Content-Length': '1000' });
    expect(contentLengthWithinCap(headers, 50_000)).toBe(true);
  });

  it('defers to the streaming reader (returns true) when Content-Length is absent', () => {
    const headers = new Headers();
    expect(contentLengthWithinCap(headers, 50_000)).toBe(true);
  });

  it('defers to the streaming reader (returns true) when Content-Length is non-numeric', () => {
    const headers = new Headers({ 'Content-Length': 'not-a-number' });
    expect(contentLengthWithinCap(headers, 50_000)).toBe(true);
  });
});

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i]));
        i += 1;
      } else {
        controller.close();
      }
    },
  });
}

describe('readBodyCapped', () => {
  it('returns {ok:true, text} for a body within the cap', async () => {
    const stream = streamFromChunks(['{"a":1}']);
    const result = await readBodyCapped(stream, 50_000);
    expect(result).toEqual({ ok: true, text: '{"a":1}' });
  });

  it('aborts mid-stream and returns {ok:false} once the running total exceeds the cap, with no Content-Length header involved (chunked case)', async () => {
    // 5 chunks of 20 bytes each = 100 bytes total, cap set to 50 — must abort
    // partway through without ever consulting a Content-Length header.
    const chunk = 'x'.repeat(20);
    const stream = streamFromChunks([chunk, chunk, chunk, chunk, chunk]);
    const result = await readBodyCapped(stream, 50);
    expect(result).toEqual({ ok: false });
  });

  it('returns {ok:true, text:""} for a null body', async () => {
    const result = await readBodyCapped(null, 50_000);
    expect(result).toEqual({ ok: true, text: '' });
  });
});
