/**
 * admin/_shared.ts tests — adminUrl() is the single admin-URL builder every
 * emitted /forms-admin/* URL must go through (checker B1 / Phase-1.5 lesson:
 * a hardcoded slashless admin URL on a trailingSlash:'always' host was
 * rejected once already). Clean-room, exhaustive per trailingSlash mode.
 *
 * P05 extends this file (RED-first) with parseEntryFilter + the shared
 * nav/table render-helper link-suffix assertions (B1 at the render-helper
 * layer — every generated nav-tab href, row-detail link, and pagination
 * link must honor trailingSlash via adminUrl).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Entry, Payment } from '../../types.js';
import { PAYMENT_REQUEST_FORM_ID } from '../payment-constants.js';
import {
  adminUrl,
  applyEntriesDefaultExclusion,
  buildExportQueryString,
  DEFAULT_ENTRY_LIMIT,
  MAX_ENTRY_LIMIT,
  parseEntryFilter,
  parsePaymentFilter,
  ADMIN_STYLE_HASH,
  renderAdminPageHtml,
  renderAdminPageParts,
  renderAnalyticsPanelHtml,
  renderLoginPageHtml,
  renderEntryTableHtml,
  renderPaymentRequestChipHtml,
  renderPaymentsSectionHtml,
  renderPaymentsTableHtml,
} from './_shared.js';

describe('adminUrl', () => {
  it("appends a trailing slash when trailingSlash is 'always'", () => {
    expect(adminUrl('/forms-admin/entries', 'always')).toBe('/forms-admin/entries/');
  });

  it("leaves the path unchanged when trailingSlash is 'never'", () => {
    expect(adminUrl('/forms-admin/entries', 'never')).toBe('/forms-admin/entries');
  });

  it("leaves the path unchanged when trailingSlash is 'ignore'", () => {
    expect(adminUrl('/forms-admin/entries', 'ignore')).toBe('/forms-admin/entries');
  });

  it('leaves the path unchanged when trailingSlash is undefined', () => {
    expect(adminUrl('/forms-admin/entries')).toBe('/forms-admin/entries');
  });

  it("does not append a slash to an extension-style path (e.g. export.csv) under 'always'", () => {
    expect(adminUrl('/forms-admin/export.csv', 'always')).toBe('/forms-admin/export.csv');
  });

  it("does not double-slash a path that already ends with '/' under 'always'", () => {
    expect(adminUrl('/forms-admin/entries/', 'always')).toBe('/forms-admin/entries/');
  });

  it("preserves a query string, inserting the trailing slash before it under 'always'", () => {
    expect(adminUrl('/forms-admin/login?error=1', 'always')).toBe('/forms-admin/login/?error=1');
  });

  it("preserves a query string unchanged under 'never'", () => {
    expect(adminUrl('/forms-admin/login?error=1', 'never')).toBe('/forms-admin/login?error=1');
  });

  it("does not add a slash before a query string on an extension-style path under 'always'", () => {
    expect(adminUrl('/forms-admin/export.csv?range=30', 'always')).toBe('/forms-admin/export.csv?range=30');
  });

  it("does not double-slash a query-string path already ending in a slash under 'always'", () => {
    expect(adminUrl('/forms-admin/entries/?page=2', 'always')).toBe('/forms-admin/entries/?page=2');
  });
});

// ---------------------------------------------------------------------------
// parseEntryFilter — Astro.url.searchParams -> EntryFilter (P05, ADMN-02)
// ---------------------------------------------------------------------------

describe('parseEntryFilter', () => {
  function params(obj: Record<string, string>): URLSearchParams {
    return new URLSearchParams(obj);
  }

  it('maps status/formId/search directly when valid', () => {
    const filter = parseEntryFilter(params({ status: 'submitted', formId: 'contact', search: 'jane' }));
    expect(filter.status).toBe('submitted');
    expect(filter.formId).toBe('contact');
    expect(filter.search).toBe('jane');
  });

  it('ignores an invalid/garbage status value (never throws, status stays undefined)', () => {
    const filter = parseEntryFilter(params({ status: 'not-a-real-status' }));
    expect(filter.status).toBeUndefined();
  });

  it('computes offset from page+limit (page 1 -> offset 0)', () => {
    const filter = parseEntryFilter(params({ page: '1', limit: '10' }));
    expect(filter.limit).toBe(10);
    expect(filter.offset).toBe(0);
  });

  it('computes offset from page+limit (page 3, limit 10 -> offset 20)', () => {
    const filter = parseEntryFilter(params({ page: '3', limit: '10' }));
    expect(filter.offset).toBe(20);
  });

  it('defaults to page 1 / DEFAULT_ENTRY_LIMIT when page/limit are absent', () => {
    const filter = parseEntryFilter(params({}));
    expect(filter.offset).toBe(0);
    expect(filter.limit).toBe(DEFAULT_ENTRY_LIMIT);
  });

  it('clamps a limit above MAX_ENTRY_LIMIT', () => {
    const filter = parseEntryFilter(params({ limit: '99999' }));
    expect(filter.limit).toBe(MAX_ENTRY_LIMIT);
  });

  it('falls back to safe defaults for non-numeric/garbage page and limit (never throws)', () => {
    expect(() => parseEntryFilter(params({ page: 'abc', limit: 'xyz' }))).not.toThrow();
    const filter = parseEntryFilter(params({ page: 'abc', limit: 'xyz' }));
    expect(filter.offset).toBe(0);
    expect(filter.limit).toBe(DEFAULT_ENTRY_LIMIT);
  });

  it('falls back to safe defaults for zero/negative page and limit', () => {
    const filter = parseEntryFilter(params({ page: '0', limit: '-5' }));
    expect(filter.offset).toBe(0);
    expect(filter.limit).toBe(DEFAULT_ENTRY_LIMIT);
  });

  it('parses from/to as numeric epoch-ms strings', () => {
    const filter = parseEntryFilter(params({ from: '1700000000000', to: '1700003600000' }));
    expect(filter.from).toBe(1700000000000);
    expect(filter.to).toBe(1700003600000);
  });

  it('parses from/to as ISO date strings', () => {
    const filter = parseEntryFilter(params({ from: '2023-11-14T00:00:00.000Z' }));
    expect(filter.from).toBe(Date.parse('2023-11-14T00:00:00.000Z'));
  });

  it('ignores garbage from/to values without throwing', () => {
    expect(() => parseEntryFilter(params({ from: 'not-a-date' }))).not.toThrow();
    const filter = parseEntryFilter(params({ from: 'not-a-date' }));
    expect(filter.from).toBeUndefined();
  });

  it('ignores empty formId/search rather than setting empty strings', () => {
    const filter = parseEntryFilter(params({ formId: '', search: '' }));
    expect(filter.formId).toBeUndefined();
    expect(filter.search).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildExportQueryString — EntryFilter -> query string for the Export CSV
// link (ADMN-03). Deliberately omits page/limit (see the function's own
// docstring): CSV export always covers the entire filtered dataset.
// ---------------------------------------------------------------------------

describe('buildExportQueryString', () => {
  it('serializes status/formId/search/from/to when present', () => {
    const qs = buildExportQueryString({ status: 'submitted', formId: 'contact', search: 'jane', from: 1, to: 2 });
    expect(qs).toBe('status=submitted&formId=contact&search=jane&from=1&to=2');
  });

  it('returns an empty string for an empty filter', () => {
    expect(buildExportQueryString({})).toBe('');
  });

  it('never includes limit or offset, even when present on the filter', () => {
    const qs = buildExportQueryString({ status: 'submitted', limit: 25, offset: 50 });
    expect(qs).not.toContain('limit');
    expect(qs).not.toContain('offset');
  });
});

// ---------------------------------------------------------------------------
// renderAdminPageHtml — nav-tab links (checker B1 at the render-helper layer)
// ---------------------------------------------------------------------------

describe('renderAdminPageHtml', () => {
  it("every nav-tab href ends with '/' under trailingSlash:'always' (B1)", () => {
    const html = renderAdminPageHtml({
      title: 'Entries',
      active: 'entries',
      trailingSlash: 'always',
      bodyHtml: '<p>x</p>',
    });
    // Scoped to the <nav> element only -- the page shell also carries a
    // Download .db toolbar link (ADMN-03), which is deliberately
    // extension-exempt (slashless) under 'always' and asserted separately
    // below, not folded into this nav-tab-only assertion.
    const navHtml = html.match(/<nav aria-label="Admin navigation">.*?<\/nav>/s)?.[0] ?? '';
    const hrefs = [...navHtml.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!.split('?')[0]!);
    expect(hrefs.length).toBe(4); // Entries/Abandoned/Payments/Analytics
    for (const href of hrefs) expect(href.endsWith('/')).toBe(true);
  });

  it('leaves nav-tab hrefs slashless when trailingSlash is undefined', () => {
    const html = renderAdminPageHtml({ title: 'Entries', active: 'entries', bodyHtml: '' });
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);
    for (const href of hrefs) expect(href.endsWith('/')).toBe(false);
  });

  it('includes the noindex meta tag', () => {
    const html = renderAdminPageHtml({ title: 'Entries', active: 'entries', bodyHtml: '' });
    expect(html).toContain('<meta name="robots" content="noindex" />');
  });

  it('marks the active tab with aria-current="page"', () => {
    const html = renderAdminPageHtml({ title: 'Abandoned', active: 'abandoned', bodyHtml: '' });
    expect(html).toMatch(/href="\/forms-admin\/abandoned"[^>]*aria-current="page"/);
  });

  // ---------------------------------------------------------------------------
  // "Download .db" link (ADMN-03) -- present in every page shell, built via
  // adminUrl, extension-exempt under trailingSlash:'always' (B1).
  // ---------------------------------------------------------------------------

  it('renders a "Download .db" link to /forms-admin/export.db', () => {
    const html = renderAdminPageHtml({ title: 'Entries', active: 'entries', bodyHtml: '' });
    expect(html).toMatch(/<a href="\/forms-admin\/export\.db">Download \.db<\/a>/);
  });

  it("the Download .db link stays extension-exempt (no trailing slash) under trailingSlash:'always' (B1)", () => {
    const html = renderAdminPageHtml({ title: 'Entries', active: 'entries', trailingSlash: 'always', bodyHtml: '' });
    expect(html).toContain('href="/forms-admin/export.db"');
    expect(html).not.toContain('href="/forms-admin/export.db/"');
  });
});

// ---------------------------------------------------------------------------
// renderEntryTableHtml — EMPTY/ERROR/SUCCESS states + row/pagination links
// (checker B1 at the render-helper layer)
// ---------------------------------------------------------------------------

describe('renderEntryTableHtml', () => {
  function makeEntry(overrides: Partial<Entry> = {}): Entry {
    return {
      id: 'e1',
      siteId: 'site',
      formId: 'contact',
      status: 'abandoned',
      fields: {},
      visitorUuid: 'visitor-1',
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      ...overrides,
    };
  }

  it('renders the EMPTY state when entries is an empty array', () => {
    const html = renderEntryTableHtml({ entries: [], total: 0, filter: {}, basePath: '/forms-admin/entries' });
    expect(html).toContain('No entries found.');
    expect(html).not.toContain('<table>');
  });

  it('renders the EMPTY state when entries is undefined (never queried)', () => {
    const html = renderEntryTableHtml({
      entries: undefined,
      total: 0,
      filter: {},
      basePath: '/forms-admin/entries',
    });
    expect(html).toContain('No entries found.');
  });

  it('renders the ERROR state when error is true, never a table', () => {
    const html = renderEntryTableHtml({
      entries: undefined,
      total: 0,
      filter: {},
      basePath: '/forms-admin/entries',
      error: true,
    });
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('<table>');
  });

  it('renders a table row per entry with escaped cell values', () => {
    const html = renderEntryTableHtml({
      entries: [makeEntry({ formId: '<script>alert(1)</script>' })],
      total: 1,
      filter: {},
      basePath: '/forms-admin/entries',
    });
    expect(html).toContain('<table>');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it("every row-detail link and pagination link ends with '/' under trailingSlash:'always' (B1)", () => {
    const entries = [makeEntry({ id: 'e1' }), makeEntry({ id: 'e2' })];
    const html = renderEntryTableHtml({
      entries,
      total: 50,
      filter: { limit: 2, offset: 10 },
      trailingSlash: 'always',
      basePath: '/forms-admin/entries',
    });
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)]
      .map((m) => m[1]!.split('?')[0]!)
      // The Export CSV link is deliberately extension-exempt (slashless)
      // under 'always' -- asserted separately below, excluded here.
      .filter((href) => !href.includes('.'));
    expect(hrefs.length).toBeGreaterThanOrEqual(4); // 2 row links + prev + next
    for (const href of hrefs) expect(href.endsWith('/')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // "Export CSV" link (ADMN-03) -- carries the current view's filter
  // criteria (never page/limit -- CSV always exports the entire filtered
  // dataset), built via adminUrl, extension-exempt under 'always' (B1).
  // ---------------------------------------------------------------------------

  it('renders an Export CSV link carrying the current filter criteria (status/formId/search/from/to)', () => {
    const html = renderEntryTableHtml({
      entries: [makeEntry()],
      total: 1,
      filter: { status: 'submitted', formId: 'contact', search: 'jane' },
      basePath: '/forms-admin/entries',
    });
    expect(html).toContain('href="/forms-admin/export.csv?status=submitted&amp;formId=contact&amp;search=jane"');
  });

  it('omits page/limit from the Export CSV link even when the current filter is paginated (pagination links legitimately keep their own limit=/page=)', () => {
    const html = renderEntryTableHtml({
      entries: [makeEntry()],
      total: 1,
      filter: { status: 'submitted', limit: 25, offset: 50 },
      basePath: '/forms-admin/entries',
    });
    expect(html).toContain('href="/forms-admin/export.csv?status=submitted"');
    const exportHref = html.match(/href="(\/forms-admin\/export\.csv[^"]*)"/)?.[1] ?? '';
    expect(exportHref).not.toContain('limit=');
    expect(exportHref).not.toContain('offset=');
  });

  it('renders a plain (query-less) Export CSV link when the filter has no criteria', () => {
    const html = renderEntryTableHtml({
      entries: [],
      total: 0,
      filter: {},
      basePath: '/forms-admin/entries',
    });
    expect(html).toContain('href="/forms-admin/export.csv"');
  });

  it("the Export CSV link stays extension-exempt (no trailing slash) under trailingSlash:'always' (B1)", () => {
    const html = renderEntryTableHtml({
      entries: [makeEntry()],
      total: 1,
      filter: { status: 'submitted' },
      trailingSlash: 'always',
      basePath: '/forms-admin/entries',
    });
    expect(html).toContain('href="/forms-admin/export.csv?status=submitted"');
    expect(html).not.toContain('href="/forms-admin/export.csv?status=submitted/"');
  });

  it('renders the Export CSV link in the EMPTY and ERROR states too (a fresh export query is independent of what this page load showed)', () => {
    const empty = renderEntryTableHtml({ entries: [], total: 0, filter: { status: 'spam' }, basePath: '/forms-admin/entries' });
    expect(empty).toContain('href="/forms-admin/export.csv?status=spam"');

    const error = renderEntryTableHtml({
      entries: undefined,
      total: 0,
      filter: { status: 'spam' },
      basePath: '/forms-admin/entries',
      error: true,
    });
    expect(error).toContain('href="/forms-admin/export.csv?status=spam"');
  });

  it('honors custom columns over the default set', () => {
    const html = renderEntryTableHtml({
      entries: [makeEntry()],
      total: 1,
      filter: {},
      basePath: '/forms-admin/abandoned',
      columns: [{ header: 'Bot check', cell: () => '<span class="flag-turnstile">bot-check failed</span>' }],
    });
    expect(html).toContain('Bot check');
    expect(html).toContain('flag-turnstile');
  });

  it('omits the status filter dropdown when showStatusFilter is false', () => {
    const html = renderEntryTableHtml({
      entries: [],
      total: 0,
      filter: {},
      basePath: '/forms-admin/abandoned',
      showStatusFilter: false,
    });
    expect(html).not.toContain('id="status"');
  });
});

// ---------------------------------------------------------------------------
// renderAnalyticsPanelHtml — funnel + abandonment rate + top-drop-off +
// system-health (ANLY-01 render, D4 tab). Deliberately a plain .ts function
// (see its own docstring) rather than inline analytics.astro frontmatter
// logic — a confirmed @astrojs/compiler parser bug duplicates the
// frontmatter's `export const prerender` statement when this exact shape of
// ternary/template-literal-heavy logic lives inline in a .astro frontmatter.
// ---------------------------------------------------------------------------

describe('renderAnalyticsPanelHtml', () => {
  it('renders the ERROR state when error is true, regardless of funnel/dropOff data', () => {
    const html = renderAnalyticsPanelHtml({
      funnel: { started: 5, abandoned: 2, submitted: 1, converted: 1 },
      dropOff: [{ field: 'email', count: 2 }],
      health: { dbSizeBytes: 1024, oldestUnconvertedAt: undefined, lastNotifySuccessAt: undefined },
      error: true,
    });
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('<table>');
  });

  it('renders the EMPTY funnel state when funnel is undefined (no form_starts recorded yet)', () => {
    const html = renderAnalyticsPanelHtml({
      funnel: undefined,
      dropOff: [],
      health: { dbSizeBytes: undefined, oldestUnconvertedAt: undefined, lastNotifySuccessAt: undefined },
    });
    expect(html).toContain('No funnel data yet');
    expect(html).not.toContain('<table>');
  });

  it('renders the EMPTY funnel state when every funnel count is zero', () => {
    const html = renderAnalyticsPanelHtml({
      funnel: { started: 0, abandoned: 0, submitted: 0, converted: 0 },
      dropOff: [],
      health: { dbSizeBytes: undefined, oldestUnconvertedAt: undefined, lastNotifySuccessAt: undefined },
    });
    expect(html).toContain('No funnel data yet');
  });

  it('renders the funnel table + computed abandonment rate when data exists', () => {
    const html = renderAnalyticsPanelHtml({
      funnel: { started: 10, abandoned: 4, submitted: 3, converted: 3 },
      dropOff: [],
      health: { dbSizeBytes: undefined, oldestUnconvertedAt: undefined, lastNotifySuccessAt: undefined },
    });
    expect(html).toContain('<table>');
    expect(html).toContain('Abandonment rate: 40.0%');
  });

  it('renders the EMPTY drop-off state when dropOff is empty', () => {
    const html = renderAnalyticsPanelHtml({
      funnel: undefined,
      dropOff: [],
      health: { dbSizeBytes: undefined, oldestUnconvertedAt: undefined, lastNotifySuccessAt: undefined },
    });
    expect(html).toContain('No drop-off data yet.');
  });

  it('renders a drop-off table row per field with escaped values', () => {
    const html = renderAnalyticsPanelHtml({
      funnel: undefined,
      dropOff: [{ field: '<script>alert(1)</script>', count: 3 }],
      health: { dbSizeBytes: undefined, oldestUnconvertedAt: undefined, lastNotifySuccessAt: undefined },
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('formats DB size in bytes/KB/MB and renders n/a when unavailable', () => {
    const bytes = renderAnalyticsPanelHtml({
      funnel: undefined,
      dropOff: [],
      health: { dbSizeBytes: 512, oldestUnconvertedAt: undefined, lastNotifySuccessAt: undefined },
    });
    expect(bytes).toContain('DB size: 512 B');

    const mb = renderAnalyticsPanelHtml({
      funnel: undefined,
      dropOff: [],
      health: { dbSizeBytes: 5 * 1024 * 1024, oldestUnconvertedAt: undefined, lastNotifySuccessAt: undefined },
    });
    expect(mb).toContain('MB');

    const na = renderAnalyticsPanelHtml({
      funnel: undefined,
      dropOff: [],
      health: { dbSizeBytes: undefined, oldestUnconvertedAt: undefined, lastNotifySuccessAt: undefined },
    });
    expect(na).toContain('DB size: n/a');
  });

  it('renders ISO timestamps for oldestUnconvertedAt/lastNotifySuccessAt when present, n/a when absent', () => {
    const ts = 1700000000000;
    const html = renderAnalyticsPanelHtml({
      funnel: undefined,
      dropOff: [],
      health: { dbSizeBytes: undefined, oldestUnconvertedAt: ts, lastNotifySuccessAt: ts },
    });
    expect(html).toContain(new Date(ts).toISOString());

    const empty = renderAnalyticsPanelHtml({
      funnel: undefined,
      dropOff: [],
      health: { dbSizeBytes: undefined, oldestUnconvertedAt: undefined, lastNotifySuccessAt: undefined },
    });
    expect(empty).toContain('Oldest unconverted abandoned entry: n/a');
    expect(empty).toContain('Last notify success: n/a');
  });

  it('always renders the reject-counts n/a line (not persisted this phase)', () => {
    const html = renderAnalyticsPanelHtml({
      funnel: undefined,
      dropOff: [],
      health: { dbSizeBytes: undefined, oldestUnconvertedAt: undefined, lastNotifySuccessAt: undefined },
    });
    expect(html).toContain('Reject counts: n/a');
  });
});

// ---------------------------------------------------------------------------
// applyEntriesDefaultExclusion + renderPaymentRequestChipHtml (checker B2) —
// synthetic _payment_request rows hidden by default, visible show/hide chip.
// ---------------------------------------------------------------------------

describe('applyEntriesDefaultExclusion', () => {
  it('sets filter.excludeFormId to the shared PAYMENT_REQUEST_FORM_ID constant by default (no showPaymentRequests param)', () => {
    const filter = applyEntriesDefaultExclusion({}, new URLSearchParams());
    expect(filter.excludeFormId).toBe(PAYMENT_REQUEST_FORM_ID);
  });

  it('leaves excludeFormId unset when showPaymentRequests=1 is present', () => {
    const filter = applyEntriesDefaultExclusion({}, new URLSearchParams({ showPaymentRequests: '1' }));
    expect(filter.excludeFormId).toBeUndefined();
  });

  it('still excludes for any other showPaymentRequests value (e.g. "0", "true")', () => {
    const filter = applyEntriesDefaultExclusion({}, new URLSearchParams({ showPaymentRequests: '0' }));
    expect(filter.excludeFormId).toBe(PAYMENT_REQUEST_FORM_ID);
  });

  it('mutates and returns the same filter object passed in', () => {
    const filter = { status: 'submitted' as const };
    const result = applyEntriesDefaultExclusion(filter, new URLSearchParams());
    expect(result).toBe(filter);
    expect(result.status).toBe('submitted');
  });
});

describe('renderPaymentRequestChipHtml', () => {
  it('renders the "hidden — show" label + sets showPaymentRequests=1 when currently hidden', () => {
    const html = renderPaymentRequestChipHtml(new URLSearchParams(), undefined);
    expect(html).toContain('Payment requests hidden — show');
    expect(html).toContain('href="/forms-admin/entries?showPaymentRequests=1"');
  });

  it('renders the "showing — hide" label + removes showPaymentRequests when currently shown', () => {
    const html = renderPaymentRequestChipHtml(new URLSearchParams({ showPaymentRequests: '1' }), undefined);
    expect(html).toContain('Showing payment requests — hide');
    expect(html).not.toContain('showPaymentRequests');
  });

  it('preserves the rest of the query string while flipping showPaymentRequests', () => {
    const html = renderPaymentRequestChipHtml(new URLSearchParams({ status: 'submitted', page: '2' }), undefined);
    expect(html).toContain('status=submitted');
    expect(html).toContain('page=2');
    expect(html).toContain('showPaymentRequests=1');
  });

  it("honors trailingSlash:'always' on the chip href (B1)", () => {
    const html = renderPaymentRequestChipHtml(new URLSearchParams(), 'always');
    expect(html).toContain('href="/forms-admin/entries/?showPaymentRequests=1"');
  });
});

// ---------------------------------------------------------------------------
// parsePaymentFilter + renderPaymentsTableHtml (D5) — the full Payments
// admin list view.
// ---------------------------------------------------------------------------

describe('parsePaymentFilter', () => {
  function params(obj: Record<string, string>): URLSearchParams {
    return new URLSearchParams(obj);
  }

  it('maps a valid provider/status directly', () => {
    const filter = parsePaymentFilter(params({ provider: 'stripe', status: 'paid' }));
    expect(filter.provider).toBe('stripe');
    expect(filter.status).toBe('paid');
  });

  it('ignores an invalid/garbage provider or status value (never throws)', () => {
    const filter = parsePaymentFilter(params({ provider: 'venmo', status: 'not-a-real-status' }));
    expect(filter.provider).toBeUndefined();
    expect(filter.status).toBeUndefined();
  });

  it('computes offset from page+limit (page 1 -> offset 0)', () => {
    const filter = parsePaymentFilter(params({ page: '1', limit: '10' }));
    expect(filter.limit).toBe(10);
    expect(filter.offset).toBe(0);
  });

  it('clamps a limit above MAX_ENTRY_LIMIT', () => {
    const filter = parsePaymentFilter(params({ limit: '99999' }));
    expect(filter.limit).toBe(MAX_ENTRY_LIMIT);
  });

  it('defaults to page 1 / DEFAULT_ENTRY_LIMIT when page/limit are absent', () => {
    const filter = parsePaymentFilter(params({}));
    expect(filter.offset).toBe(0);
    expect(filter.limit).toBe(DEFAULT_ENTRY_LIMIT);
  });
});

describe('renderPaymentsTableHtml', () => {
  function makePayment(overrides: Partial<Payment> = {}): Payment {
    return {
      id: 'p1',
      entryId: 'e1',
      provider: 'stripe',
      amountCents: 20050,
      currency: 'usd',
      status: 'link_created',
      payLinkUrl: 'https://pay.stripe.com/link_abc',
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      ...overrides,
    };
  }

  it('renders the EMPTY state when payments is an empty array', () => {
    const html = renderPaymentsTableHtml({ payments: [], total: 0, filter: {}, basePath: '/forms-admin/payments' });
    expect(html).toContain('No payments found.');
    expect(html).not.toContain('<table>');
  });

  it('renders the EMPTY state when payments is undefined (never queried)', () => {
    const html = renderPaymentsTableHtml({
      payments: undefined,
      total: 0,
      filter: {},
      basePath: '/forms-admin/payments',
    });
    expect(html).toContain('No payments found.');
  });

  it('renders the ERROR state when error is true, never a table', () => {
    const html = renderPaymentsTableHtml({
      payments: undefined,
      total: 0,
      filter: {},
      basePath: '/forms-admin/payments',
      error: true,
    });
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('<table>');
  });

  it('renders a row per payment with Created/Amount/Currency/Provider/Status/Entry/Pay-link columns, all escaped', () => {
    const html = renderPaymentsTableHtml({
      payments: [makePayment({ entryId: '<script>alert(1)</script>' })],
      total: 1,
      filter: {},
      basePath: '/forms-admin/payments',
    });
    expect(html).toContain('<table>');
    expect(html).toContain('200.50'); // amount, dollars, no currency symbol (distinct Currency column)
    expect(html).toContain('USD');
    expect(html).toContain('stripe');
    expect(html).toContain('link_created');
    expect(html).toContain('Pay link');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it("shows the Amount column in the row's own currency decimals: 500 JPY reads 500, not 5.00; 250000 AED reads 2500.00", () => {
    const html = renderPaymentsTableHtml({
      payments: [
        makePayment({ id: 'p-jpy', amountCents: 500, currency: 'jpy' }),
        makePayment({ id: 'p-aed', amountCents: 250000, currency: 'aed' }),
      ],
      total: 2,
      filter: {},
      basePath: '/forms-admin/payments',
    });
    expect(html).toContain('<td>500</td><td>JPY</td>');
    expect(html).not.toContain('<td>5.00</td>');
    expect(html).toContain('<td>2500.00</td><td>AED</td>');
  });

  it('links the Entry cell to /forms-admin/entries/{entryId}, trailingSlash-aware (B1)', () => {
    const html = renderPaymentsTableHtml({
      payments: [makePayment({ entryId: 'e42' })],
      total: 1,
      filter: {},
      trailingSlash: 'always',
      basePath: '/forms-admin/payments',
    });
    expect(html).toContain('href="/forms-admin/entries/e42/"');
  });

  it('renders a provider + status filter form', () => {
    const html = renderPaymentsTableHtml({
      payments: [],
      total: 0,
      filter: { provider: 'paypal', status: 'paid' },
      basePath: '/forms-admin/payments',
    });
    expect(html).toContain('id="payment-provider"');
    expect(html).toContain('id="payment-status"');
    expect(html).toMatch(/<option value="paypal" selected>/);
    expect(html).toMatch(/<option value="paid" selected>/);
  });

  it('renders pagination links built via adminUrl, honoring trailingSlash', () => {
    const html = renderPaymentsTableHtml({
      payments: [makePayment(), makePayment({ id: 'p2' })],
      total: 50,
      filter: { limit: 2, offset: 10 },
      trailingSlash: 'always',
      basePath: '/forms-admin/payments',
    });
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!.split('?')[0]!).filter((h) => !h.includes('.'));
    for (const href of hrefs) expect(href.endsWith('/')).toBe(true);
  });

  it('renders "n/a" absent an amount, and empty cells gracefully for a missing provider/status/payLinkUrl', () => {
    const html = renderPaymentsTableHtml({
      payments: [
        makePayment({ amountCents: undefined, provider: undefined, status: undefined, payLinkUrl: undefined }),
      ],
      total: 1,
      filter: {},
      basePath: '/forms-admin/payments',
    });
    expect(html).toContain('<table>');
    expect(html).not.toContain('undefined');
  });
});

// ---------------------------------------------------------------------------
// 0.1.15 — admin pages under a Content Security Policy. A strict CSP (Astro's
// security.csp, or a host header) blocks an inline <style> whose hash is not
// listed, every inline event handler attribute, and every style="" attribute.
// The admin shell's one <style> is registered by hash, so the hash must be
// computed from the exact bytes the shell emits; the copy-link control moved
// to data attributes driven by a bundled script.
// ---------------------------------------------------------------------------

describe('admin CSP support (0.1.15)', () => {
  it('ADMIN_STYLE_HASH is the sha256 of the exact <style> body renderAdminPageHtml emits (so a registered hash always matches)', () => {
    const html = renderAdminPageHtml({ title: 'Entries', active: 'entries', bodyHtml: '' });
    const styleBody = html.match(/<style>([\s\S]*?)<\/style>/)![1]!;
    const expected = `sha256-${createHash('sha256').update(styleBody, 'utf8').digest('base64')}`;
    expect(ADMIN_STYLE_HASH).toBe(expected);
  });

  it('renderAdminPageParts splits the document after </main>, and start + newline + end is byte-identical to renderAdminPageHtml', () => {
    const opts = { title: 'Entry e1', active: 'entries' as const, trailingSlash: 'always' as const, bodyHtml: '<p>x</p>' };
    const { start, end } = renderAdminPageParts(opts);
    expect(start.endsWith('</main>')).toBe(true);
    expect(end).toBe('</body>\n</html>');
    expect(`${start}\n${end}`).toBe(renderAdminPageHtml(opts));
  });

  it('no admin render helper emits an inline event handler or a style attribute', () => {
    const page = renderAdminPageHtml({ title: 'T', active: 'payments', bodyHtml: '' });
    const section = renderPaymentsSectionHtml({
      entryId: 'e1',
      payments: [paymentRow()],
      providerConfigured: true,
      paymentActionUrl: '/forms-admin/payments/action',
      adminQuote: 'builtin',
      quoteCurrency: 'usd',
    });
    for (const html of [page, section]) {
      expect(html).not.toMatch(/\son[a-z]+\s*=/i);
      expect(html).not.toMatch(/\sstyle\s*=/i);
    }
  });
});

// The login page is the one admin page a host's own CSP header must also
// cover. Up to this fix it carried its own Astro-processed <style>: minified,
// scoped with a build-dependent data-astro-cid, so its hash changed per build
// and no host could list it in advance. Under the documented setup (add
// ADMIN_STYLE_HASH to style-src) the login page rendered unstyled.
describe('admin login page under a host-written CSP (0.1.15)', () => {
  const loginSource = readFileSync(new URL('./login.astro', import.meta.url), 'utf8');

  it('login.astro has no <style> block of its own: its only inline style is the shared admin stylesheet, so ADMIN_STYLE_HASH covers it', () => {
    expect(loginSource).not.toMatch(/<style[\s>]/i);
  });

  it('login.astro registers ADMIN_STYLE_HASH with Astro.csp only when CSP is on, like every other admin page', () => {
    expect(loginSource).toMatch(/if \(config\.cspEnabled\) Astro\.csp\?\.insertStyleHash\(ADMIN_STYLE_HASH\);/);
  });

  it('renderLoginPageHtml emits exactly one inline <style>, and it hashes to ADMIN_STYLE_HASH', () => {
    const html = renderLoginPageHtml({ actionUrl: '/forms-admin/auth/', hasError: false });
    const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]!);
    expect(styles).toHaveLength(1);
    expect(`sha256-${createHash('sha256').update(styles[0]!, 'utf8').digest('base64')}`).toBe(ADMIN_STYLE_HASH);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
  });

  it('renderLoginPageHtml is the unauthenticated page: noindex, no admin nav, no .db download link, the form posts to the given action', () => {
    const html = renderLoginPageHtml({ actionUrl: '/forms-admin/auth/', hasError: false });
    expect(html).toContain('<meta name="robots" content="noindex" />');
    expect(html).not.toContain('<nav');
    expect(html).not.toContain('export.db');
    expect(html).toContain('<form method="post" action="/forms-admin/auth/">');
    expect(html).toContain('<input id="password" name="password" type="password" autocomplete="current-password" required />');
    expect(html).not.toContain('role="alert"');
  });

  it('renderLoginPageHtml shows the error only when asked, and escapes the action URL', () => {
    const html = renderLoginPageHtml({ actionUrl: '/a"b<c', hasError: true });
    expect(html).toContain('<p class="error" role="alert">Incorrect password. Please try again.</p>');
    expect(html).toContain('action="/a&quot;b&lt;c"');
  });
});

function paymentRow(overrides: Partial<Payment> = {}): Payment {
  return {
    id: 'p1',
    entryId: 'e1',
    provider: 'stripe',
    amountCents: 250000,
    currency: 'aed',
    status: 'link_created',
    payLinkUrl: 'https://buy.stripe.com/test_<x>',
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    ...overrides,
  };
}

describe('renderPaymentsSectionHtml (entry detail, 0.1.15)', () => {
  const base = {
    entryId: 'e1',
    payments: [] as Payment[],
    providerConfigured: true,
    paymentActionUrl: '/forms-admin/payments/action',
    adminQuote: 'builtin' as const,
    quoteCurrency: 'usd',
  };

  it('a payment row shows status, the currency-formatted amount, and a copy control wired by data attributes to its read-only link input', () => {
    const html = renderPaymentsSectionHtml({ ...base, payments: [paymentRow()] });
    expect(html).toContain('<strong>link_created</strong>');
    expect(html).toContain('AED\u00a02,500.00');
    expect(html).toContain('id="caf-pay-link-p1"');
    expect(html).toContain('class="pay-link-input"');
    expect(html).toContain('data-caf-select-on-focus');
    expect(html).toContain('data-caf-copy-target="caf-pay-link-p1"');
    expect(html).toContain('value="https://buy.stripe.com/test_&lt;x&gt;"');
  });

  it("'builtin' with a provider configured renders the Create payment link form, labelled in the quote currency", () => {
    const html = renderPaymentsSectionHtml({ ...base, quoteCurrency: 'aed' });
    expect(html).toContain('action="/forms-admin/payments/action"');
    expect(html).toContain('<input type="hidden" name="entryId" value="e1" />');
    expect(html).toContain('Amount (AED)');
    expect(html).toContain('Create payment link');
  });

  it("'builtin' with no provider configured keeps the 0.1.14 hint instead of a form", () => {
    const html = renderPaymentsSectionHtml({ ...base, providerConfigured: false });
    expect(html).toContain('No payment provider is configured');
    expect(html).not.toContain('Create payment link');
  });

  it("'off' renders no create control at all, only the payment list", () => {
    const html = renderPaymentsSectionHtml({ ...base, adminQuote: 'off', payments: [paymentRow()] });
    expect(html).not.toContain('<form');
    expect(html).not.toContain('Create payment link');
    expect(html).not.toContain('No payment provider is configured');
    expect(html).toContain('caf-pay-link-p1');
  });

  it('{ href } renders a link to the host quote page carrying the entry id, and no built-in form, provider or not', () => {
    for (const providerConfigured of [true, false]) {
      const html = renderPaymentsSectionHtml({
        ...base,
        providerConfigured,
        entryId: 'e 1&x',
        adminQuote: { href: '/forms-admin/quote/' },
      });
      expect(html).toContain('<a href="/forms-admin/quote/?entry=e%201%26x">Create a quote</a>');
      expect(html).not.toContain('<form');
    }
    const withQuery = renderPaymentsSectionHtml({ ...base, adminQuote: { href: 'https://desk.example.com/q?src=admin' } });
    expect(withQuery).toContain('href="https://desk.example.com/q?src=admin&amp;entry=e1"');
  });

  // The host quote page reads `entry` from the query string. A query
  // parameter written after a `#` is part of the fragment, which the page
  // never sees as a parameter, so the id must go before the fragment.
  it('{ href } with a #fragment puts entry=<id> in the query, before the fragment', () => {
    const cases: [string, string][] = [
      ['/forms-admin/quote/#form', '/forms-admin/quote/?entry=e1#form'],
      ['/forms-admin/quote/#form?x=1', '/forms-admin/quote/?entry=e1#form?x=1'],
      ['https://desk.example.com/q?src=admin#top', 'https://desk.example.com/q?src=admin&entry=e1#top'],
    ];
    for (const [href, expected] of cases) {
      const html = renderPaymentsSectionHtml({ ...base, adminQuote: { href } });
      const rendered = /<a href="([^"]*)">Create a quote<\/a>/.exec(html)?.[1]?.replaceAll('&amp;', '&');
      expect(rendered).toBe(expected);
      expect(new URL(rendered!, 'https://site.example').searchParams.get('entry')).toBe('e1');
    }
  });

  it('renders the EMPTY state when there are no payments', () => {
    expect(renderPaymentsSectionHtml(base)).toContain('No payments yet.');
  });
});
