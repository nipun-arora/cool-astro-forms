/**
 * entry-action.ts tests — POST /forms-admin/entries/action (ADMN-02):
 * status/delete/purge for the admin entry-detail view. isSameOrigin is the
 * ONLY origin check this route needs of its own (T-02-22) — the session
 * guard already covers every /forms-admin/* path in middleware.ts
 * (T-02-23). purge resolves visitorUuid SERVER-side from the entry, never
 * trusting a client-posted uuid. Every redirect target is adminUrl-built
 * (checker B1).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { updateEntryMock, deleteEntryMock, purgeVisitorMock, getEntryByIdMock, sqliteStorageMock } = vi.hoisted(
  () => ({
    updateEntryMock: vi.fn(async () => ({})),
    deleteEntryMock: vi.fn(async () => true),
    purgeVisitorMock: vi.fn(async () => 3),
    getEntryByIdMock: vi.fn(async (): Promise<{ id: string; visitorUuid: string } | undefined> => undefined),
    sqliteStorageMock: vi.fn(function FakeSqliteStorage() {
      return {
        updateEntry: updateEntryMock,
        deleteEntry: deleteEntryMock,
        purgeVisitor: purgeVisitorMock,
        getEntryById: getEntryByIdMock,
      };
    }),
  }),
);

vi.mock('virtual:cool-astro-forms/config', () => ({
  default: {
    siteId: 'demo-site',
    siteUrl: 'https://example.com',
    dbPath: '/tmp/nonexistent/forms.db',
    trailingSlash: undefined as 'always' | 'never' | 'ignore' | undefined,
  },
}));
vi.mock('../../storage/db.js', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('../../storage/sqlite.js', () => ({ SqliteStorage: sqliteStorageMock }));
vi.mock('../../log.js', () => ({ log: vi.fn(), logError: vi.fn() }));

import config from 'virtual:cool-astro-forms/config';
import { POST } from './entry-action.js';

function makeRequest(body: Record<string, string>, origin = 'https://example.com'): Request {
  const form = new URLSearchParams(body);
  return new Request('https://example.com/forms-admin/entries/action', {
    method: 'POST',
    headers: { origin },
    body: form,
  });
}

async function callPost(body: Record<string, string>, origin = 'https://example.com'): Promise<Response> {
  const request = makeRequest(body, origin);
  return POST({ request } as unknown as Parameters<typeof POST>[0]);
}

describe('POST /forms-admin/entries/action', () => {
  beforeEach(() => {
    updateEntryMock.mockClear();
    deleteEntryMock.mockClear();
    purgeVisitorMock.mockClear();
    getEntryByIdMock.mockClear();
    (config as { trailingSlash?: 'always' | 'never' | 'ignore' }).trailingSlash = undefined;
  });

  it('rejects a cross-origin POST with 403 before dispatching any storage call', async () => {
    const res = await callPost({ id: 'e1', action: 'delete' }, 'https://evil.example');
    expect(res.status).toBe(403);
    expect(deleteEntryMock).not.toHaveBeenCalled();
  });

  it('action=status calls storage.updateEntry(id, {status}) with a validated status and redirects back to the detail view', async () => {
    const res = await callPost({ id: 'e1', action: 'status', status: 'submitted' });
    expect(updateEntryMock).toHaveBeenCalledWith('e1', { status: 'submitted' });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/forms-admin/entries/e1');
  });

  it('rejects action=status with an invalid status value (400, no storage mutation)', async () => {
    const res = await callPost({ id: 'e1', action: 'status', status: 'not-a-real-status' });
    expect(res.status).toBe(400);
    expect(updateEntryMock).not.toHaveBeenCalled();
  });

  it('action=delete dispatches storage.deleteEntry and redirects to the Entries list', async () => {
    const res = await callPost({ id: 'e1', action: 'delete' });
    expect(deleteEntryMock).toHaveBeenCalledWith('e1');
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/forms-admin/entries');
  });

  it('action=purge resolves the visitorUuid server-side from the entry, never trusting a client-posted uuid', async () => {
    getEntryByIdMock.mockResolvedValueOnce({ id: 'e1', visitorUuid: 'real-visitor-uuid' });
    const res = await callPost({ id: 'e1', action: 'purge', visitorUuid: 'forged-uuid' });
    expect(getEntryByIdMock).toHaveBeenCalledWith('e1');
    expect(purgeVisitorMock).toHaveBeenCalledWith('real-visitor-uuid');
    expect(purgeVisitorMock).not.toHaveBeenCalledWith('forged-uuid');
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/forms-admin/entries');
  });

  it('action=purge with an unknown id returns 400 without calling purgeVisitor', async () => {
    getEntryByIdMock.mockResolvedValueOnce(undefined);
    const res = await callPost({ id: 'missing', action: 'purge' });
    expect(res.status).toBe(400);
    expect(purgeVisitorMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid/unknown action with 400', async () => {
    const res = await callPost({ id: 'e1', action: 'wipe-everything' });
    expect(res.status).toBe(400);
  });

  it('rejects a missing id with 400', async () => {
    const res = await callPost({ action: 'delete' });
    expect(res.status).toBe(400);
  });

  it("honors trailingSlash:'always' on the delete redirect target", async () => {
    (config as { trailingSlash?: 'always' | 'never' | 'ignore' }).trailingSlash = 'always';
    const res = await callPost({ id: 'e1', action: 'delete' });
    expect(res.headers.get('Location')).toBe('/forms-admin/entries/');
  });

  it("honors trailingSlash:'always' on the status-update redirect target (back to the detail view)", async () => {
    (config as { trailingSlash?: 'always' | 'never' | 'ignore' }).trailingSlash = 'always';
    const res = await callPost({ id: 'e1', action: 'status', status: 'converted' });
    expect(res.headers.get('Location')).toBe('/forms-admin/entries/e1/');
  });
});
