/**
 * GET /forms-admin/export.csv (ADMN-03) — CSV export of the current view's
 * ENTIRE filtered dataset, reusing the already-tested storage.exportCsv()
 * (Phase 1; formula-injection-safe via csvCell — T-02-28). Deliberately does
 * NOT re-implement CSV logic (Research Don't-Hand-Roll: exportCsv is already
 * tested).
 *
 * parseEntryFilter is the SAME helper the list views use to build their own
 * EntryFilter from Astro.url.searchParams (checker B1 consistency — an
 * export mirrors the exact filter criteria, status/formId/search/from/to,
 * the calling view had applied). Its page-derived limit/offset defaults are
 * stripped here: the threat model's own trust-boundary language calls this
 * "export routes -> full data dump" — an export must return the ENTIRE
 * filtered dataset, never silently truncate to the admin UI's
 * DEFAULT_ENTRY_LIMIT (25) page size.
 *
 * Storage acquisition happens INSIDE the try/catch (mirrors routes/abandon.ts
 * — a migration/open failure resolves a logged 500, not an unlogged crash).
 * Route injection consolidated in Task 3 (integration.ts).
 */
import type { APIRoute } from 'astro';
import config from 'virtual:cool-astro-forms/config';
import { logError } from '../../log.js';
import { getStorageAdapter } from '../../storage/index.js';
import { parseEntryFilter } from '../../admin/_shared.js';

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  try {
    const storage = await getStorageAdapter(config);
    const filter = parseEntryFilter(url.searchParams);
    // CSV export always covers the entire filtered dataset (T-02-28) --
    // strip parseEntryFilter's page-derived limit/offset defaults so this
    // never silently truncates to a single admin-view page.
    delete filter.limit;
    delete filter.offset;
    const csv = await storage.exportCsv(filter);
    return new Response(csv, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="entries.csv"',
      },
    });
  } catch (err) {
    logError('admin.export-csv-failed', err);
    return new Response(null, { status: 500 });
  }
};
