/**
 * export-csv.ts tests — GET /forms-admin/export.csv (ADMN-03): CSV export of
 * the current view's filtered entries, reusing the already-tested
 * storage.exportCsv() (Phase 1 formula-injection guard, T-02-28). Always
 * exports the ENTIRE filtered dataset, never just the currently-displayed
 * admin-view page (threat model: "export routes -> full data dump") —
 * parseEntryFilter's page-derived limit/offset defaults are stripped before
 * calling exportCsv so a plain /forms-admin/export.csv (or the Export CSV
 * link, which never appends page/limit) is never silently truncated to
 * DEFAULT_ENTRY_LIMIT (25) rows.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { exportCsvMock, sqliteStorageMock } = vi.hoisted(() => ({
  exportCsvMock: vi.fn(async () => 'id,siteId\n1,demo-site'),
  sqliteStorageMock: vi.fn(function FakeSqliteStorage() {
    return { exportCsv: exportCsvMock };
  }),
}));

vi.mock('virtual:cool-astro-forms/config', () => ({
  default: {
    siteId: 'demo-site',
    siteUrl: 'https://example.com',
    dbPath: '/tmp/nonexistent/forms.db',
  },
}));
vi.mock('../../storage/db.js', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('../../storage/sqlite.js', () => ({ SqliteStorage: sqliteStorageMock }));
vi.mock('../../log.js', () => ({ log: vi.fn(), logError: vi.fn() }));

import { GET } from './export-csv.js';

function makeContext(query = ''): Parameters<typeof GET>[0] {
  return { url: new URL(`https://example.com/forms-admin/export.csv${query}`) } as unknown as Parameters<
    typeof GET
  >[0];
}

describe('GET /forms-admin/export.csv', () => {
  beforeEach(() => {
    exportCsvMock.mockClear();
    exportCsvMock.mockResolvedValue('id,siteId\n1,demo-site');
  });

  it('returns 200 text/csv; charset=utf-8 with an attachment Content-Disposition of entries.csv', async () => {
    const res = await GET(makeContext());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="entries.csv"');
  });

  it('returns the exact body storage.exportCsv resolves', async () => {
    const res = await GET(makeContext());
    const body = await res.text();
    expect(body).toBe('id,siteId\n1,demo-site');
  });

  it('parses status/formId/search/from/to from searchParams (same filter shape the views use) and passes it to exportCsv', async () => {
    await GET(makeContext('?status=submitted&formId=contact&search=jane'));
    expect(exportCsvMock).toHaveBeenCalledWith({ status: 'submitted', formId: 'contact', search: 'jane' });
  });

  it('strips any page/limit query params -- CSV always exports the entire filtered dataset, never just the current page', async () => {
    await GET(makeContext('?status=submitted&page=2&limit=10'));
    expect(exportCsvMock).toHaveBeenCalledWith({ status: 'submitted' });
  });

  it('with no query params at all, exports without a limit/offset (not silently truncated to DEFAULT_ENTRY_LIMIT)', async () => {
    await GET(makeContext());
    expect(exportCsvMock).toHaveBeenCalledWith({});
  });

  it('resolves a logged 500 when storage.exportCsv throws (never an unlogged crash)', async () => {
    exportCsvMock.mockRejectedValueOnce(new Error('db down'));
    const res = await GET(makeContext());
    expect(res.status).toBe(500);
  });
});
