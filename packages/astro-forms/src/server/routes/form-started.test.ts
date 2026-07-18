/**
 * form-started.ts tests — POST /api/forms/started (ANLY-01 D1): idempotent
 * form_started counter ping (capture.ts fires this once per visitor+form on
 * first input). isSameOrigin + size-cap mirror routes/abandon.ts (this
 * route also receives application/json, so Astro's built-in
 * security.checkOrigin never inspects it — T-01-08 precedent). An
 * unknown site/form is a quiet no-op 204 (never reveals config shape);
 * malformed input is 400; storage never blocks the route from resolving.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { recordFormStartMock, sqliteStorageMock } = vi.hoisted(() => ({
  recordFormStartMock: vi.fn(async () => undefined),
  sqliteStorageMock: vi.fn(function FakeSqliteStorage() {
    return { recordFormStart: recordFormStartMock };
  }),
}));

vi.mock('virtual:cool-astro-forms/config', () => ({
  default: {
    siteId: 'demo-site',
    siteUrl: 'https://example.com',
    dbPath: 'data/forms.db',
    forms: { demo: { notifyTo: 'owner@example.com' } },
  },
}));
vi.mock('../storage/db.js', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('../storage/sqlite.js', () => ({ SqliteStorage: sqliteStorageMock }));
vi.mock('../log.js', () => ({ log: vi.fn(), logError: vi.fn() }));

import { POST } from './form-started.js';

function makeRequest(body: unknown, origin = 'https://example.com'): Request {
  return new Request('https://example.com/api/forms/started', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', origin },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function callPost(body: unknown, origin = 'https://example.com'): Promise<Response> {
  const request = makeRequest(body, origin);
  return POST({ request } as unknown as Parameters<typeof POST>[0]);
}

describe('POST /api/forms/started', () => {
  beforeEach(() => {
    recordFormStartMock.mockClear();
  });

  it('rejects a cross-origin POST with 403 before calling storage', async () => {
    const res = await callPost({ siteId: 'demo-site', formId: 'demo', visitorUuid: 'v1' }, 'https://evil.example');
    expect(res.status).toBe(403);
    expect(recordFormStartMock).not.toHaveBeenCalled();
  });

  it('calls storage.recordFormStart with the validated payload and returns 204', async () => {
    const res = await callPost({ siteId: 'demo-site', formId: 'demo', visitorUuid: 'visitor-1' });
    expect(res.status).toBe(204);
    expect(recordFormStartMock).toHaveBeenCalledWith('demo-site', 'demo', 'visitor-1');
  });

  it('an unknown siteId is a quiet no-op 204 without calling storage', async () => {
    const res = await callPost({ siteId: 'other-site', formId: 'demo', visitorUuid: 'v1' });
    expect(res.status).toBe(204);
    expect(recordFormStartMock).not.toHaveBeenCalled();
  });

  it('an unknown formId is a quiet no-op 204 without calling storage', async () => {
    const res = await callPost({ siteId: 'demo-site', formId: 'not-a-real-form', visitorUuid: 'v1' });
    expect(res.status).toBe(204);
    expect(recordFormStartMock).not.toHaveBeenCalled();
  });

  it('malformed JSON returns 400 without calling storage', async () => {
    const res = await callPost('{not json');
    expect(res.status).toBe(400);
    expect(recordFormStartMock).not.toHaveBeenCalled();
  });

  it('a payload missing a required field returns 400 without calling storage', async () => {
    const res = await callPost({ siteId: 'demo-site', formId: 'demo' });
    expect(res.status).toBe(400);
    expect(recordFormStartMock).not.toHaveBeenCalled();
  });

  it('resolves a logged 500 when storage.recordFormStart throws, never an unhandled rejection', async () => {
    recordFormStartMock.mockRejectedValueOnce(new Error('db failure'));
    const res = await callPost({ siteId: 'demo-site', formId: 'demo', visitorUuid: 'visitor-1' });
    expect(res.status).toBe(500);
  });

  it('an oversized body is rejected via Content-Length before JSON parsing', async () => {
    const request = new Request('https://example.com/api/forms/started', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        origin: 'https://example.com',
        'Content-Length': String(60_000),
      },
      body: JSON.stringify({ siteId: 'demo-site', formId: 'demo', visitorUuid: 'v1' }),
    });
    const res = await POST({ request } as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(413);
    expect(recordFormStartMock).not.toHaveBeenCalled();
  });
});
