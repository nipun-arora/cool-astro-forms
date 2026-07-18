/**
 * Shared /forms-admin helpers (Phase 2). Home for `adminUrl()` — the single
 * builder every emitted admin URL (middleware redirects, login form action,
 * post-login redirect) MUST go through (checker B1 / Phase-1.5 lesson: a
 * hardcoded slashless admin URL on a trailingSlash:'always' host was
 * rejected once already). P05 extends this file with entry-filter/render
 * helpers shared between the admin list views (entries/abandoned/payments +
 * the page shell every P05 view reuses) — it is a compiled .ts module.
 * login.astro (P03) intentionally stays a standalone page, not built from
 * these render helpers (it IS the unauthenticated entry point, no nav).
 * P05 also ships this file's raw TypeScript source (package.json `files`)
 * alongside the `.astro` pages' compiled exports-map entry, so a host's own
 * Vite build can resolve the pages' `./_shared.js` relative import at build
 * time (Research Pitfall 1).
 */
import type {
  DropOffRow,
  Entry,
  EntryFilter,
  EntryStatus,
  FunnelCounts,
  Payment,
  PaymentFilter,
  PaymentProvider,
  PaymentStatus,
} from '../../types.js';
import { PAYMENT_REQUEST_FORM_ID } from '../payment-constants.js';
import { escapeHtml } from '../templates.js';

/**
 * Builds a client-visible /forms-admin URL honoring the host's Astro
 * `trailingSlash` setting. Only `'always'` mutates the path — appends a
 * trailing slash unless the path already ends with one, or its final
 * segment looks like a file (contains a `.`, e.g. `export.csv`), in which
 * case the extension-style path is left slashless. A query string, if
 * present, is preserved and the slash is inserted before it.
 */
export function adminUrl(path: string, trailingSlash?: 'always' | 'never' | 'ignore'): string {
  if (trailingSlash !== 'always') return path;

  const queryIndex = path.indexOf('?');
  const pathname = queryIndex === -1 ? path : path.slice(0, queryIndex);
  const query = queryIndex === -1 ? '' : path.slice(queryIndex);

  if (pathname.endsWith('/')) return path;

  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
  if (lastSegment.includes('.')) return path;

  return `${pathname}/${query}`;
}

/** `trailingSlash` mode shared by every admin render helper below — pinned to adminUrl's own parameter type so the two can never drift apart. */
export type TrailingSlash = Parameters<typeof adminUrl>[1];

// ---------------------------------------------------------------------------
// parseEntryFilter — Astro.url.searchParams -> EntryFilter (ADMN-02)
// ---------------------------------------------------------------------------

const ENTRY_STATUSES: readonly EntryStatus[] = ['abandoned', 'submitted', 'converted', 'spam'];

/** Default page size for admin list views. */
export const DEFAULT_ENTRY_LIMIT = 25;
/** Hard ceiling on an admin-requested page size — a query-string value can never force an unbounded scan. */
export const MAX_ENTRY_LIMIT = 100;

function parsePositiveInt(value: string | null, fallback: number, max?: number): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return max !== undefined ? Math.min(n, max) : n;
}

/** Accepts a raw epoch-ms numeric string OR an ISO/RFC date string. Garbage resolves undefined — never throws. */
function parseTimestamp(value: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Maps `Astro.url.searchParams` into a valid `EntryFilter`: page -> offset
 * math, limit clamped to `MAX_ENTRY_LIMIT`, safe defaults throughout.
 * Unknown/garbage values (invalid status, non-numeric page/limit, malformed
 * dates) are silently ignored rather than thrown — every admin list view
 * calls this directly against untrusted query-string input.
 */
export function parseEntryFilter(searchParams: URLSearchParams): EntryFilter {
  const filter: EntryFilter = {};

  const status = searchParams.get('status');
  if (status && (ENTRY_STATUSES as readonly string[]).includes(status)) {
    filter.status = status as EntryStatus;
  }

  const formId = searchParams.get('formId');
  if (formId) filter.formId = formId;

  const search = searchParams.get('search');
  if (search) filter.search = search;

  const from = parseTimestamp(searchParams.get('from'));
  if (from !== undefined) filter.from = from;

  const to = parseTimestamp(searchParams.get('to'));
  if (to !== undefined) filter.to = to;

  const page = parsePositiveInt(searchParams.get('page'), 1);
  const limit = parsePositiveInt(searchParams.get('limit'), DEFAULT_ENTRY_LIMIT, MAX_ENTRY_LIMIT);
  filter.limit = limit;
  filter.offset = (page - 1) * limit;

  return filter;
}

// ---------------------------------------------------------------------------
// Admin page shell — nav tabs + noindex meta + mobile-responsive minimal CSS
// (D4: Entries[default]/Abandoned/Payments/Analytics). Shared by every P05
// admin view. No client framework (design spec §5.6) — plain HTML/CSS only.
// ---------------------------------------------------------------------------

export type AdminNavTab = 'entries' | 'abandoned' | 'payments' | 'analytics';

const NAV_LINKS: { tab: AdminNavTab; label: string; path: string }[] = [
  { tab: 'entries', label: 'Entries', path: '/forms-admin/entries' },
  { tab: 'abandoned', label: 'Abandoned', path: '/forms-admin/abandoned' },
  { tab: 'payments', label: 'Payments', path: '/forms-admin/payments' },
  { tab: 'analytics', label: 'Analytics', path: '/forms-admin/analytics' },
];

function renderNavHtml(active: AdminNavTab, trailingSlash: TrailingSlash | undefined): string {
  const items = NAV_LINKS.map((link) => {
    const href = adminUrl(link.path, trailingSlash);
    const current = link.tab === active;
    return `<li><a href="${escapeHtml(href)}"${current ? ' aria-current="page" class="active"' : ''}>${escapeHtml(link.label)}</a></li>`;
  }).join('');
  return `<nav aria-label="Admin navigation"><ul>${items}</ul></nav>`;
}

const ADMIN_STYLES = `
  :root { color-scheme: light dark; }
  body { margin: 0; font-family: system-ui, sans-serif; background: #f5f5f5; color: #1a1a1a; }
  nav[aria-label="Admin navigation"] ul { list-style: none; display: flex; flex-wrap: wrap; gap: 0.25rem; margin: 0; padding: 0.75rem 1rem; background: #1a1a1a; }
  nav[aria-label="Admin navigation"] a { display: inline-block; padding: 0.5rem 0.85rem; border-radius: 0.35rem; color: #f5f5f5; text-decoration: none; font-size: 0.95rem; }
  nav[aria-label="Admin navigation"] a:hover { background: #333; }
  nav[aria-label="Admin navigation"] a.active { background: #2563eb; font-weight: 600; }
  nav[aria-label="Admin navigation"] a:focus-visible { outline: 2px solid #93c5fd; outline-offset: 2px; }
  main { padding: 1rem; max-width: 72rem; margin: 0 auto; box-sizing: border-box; }
  h1 { font-size: 1.35rem; margin: 0 0 1rem; }
  h2 { font-size: 1.05rem; margin: 1.25rem 0 0.5rem; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
  form.filters { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: end; margin-bottom: 1rem; background: #fff; padding: 0.85rem; border-radius: 0.5rem; box-shadow: 0 1px 2px rgba(0,0,0,0.08); }
  form.filters label { display: block; font-size: 0.8rem; font-weight: 600; margin-bottom: 0.25rem; }
  form.filters input, form.filters select { padding: 0.4rem 0.5rem; border: 1px solid #ccc; border-radius: 0.3rem; font-size: 0.9rem; }
  form.filters button { padding: 0.45rem 0.9rem; border: none; border-radius: 0.3rem; background: #2563eb; color: #fff; font-weight: 600; cursor: pointer; }
  form.filters button:hover { background: #1d4ed8; }
  form.filters *:focus-visible { outline: 2px solid #2563eb; outline-offset: 1px; }
  .table-wrap { overflow-x: auto; background: #fff; border-radius: 0.5rem; box-shadow: 0 1px 2px rgba(0,0,0,0.08); }
  table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
  th, td { padding: 0.5rem 0.65rem; text-align: left; border-bottom: 1px solid #eee; white-space: nowrap; }
  th { background: #fafafa; font-weight: 600; }
  tr:hover td { background: #f8fafc; }
  a { color: #2563eb; }
  a:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }
  .flag-turnstile { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 999px; background: #fef2f2; color: #991b1b; font-size: 0.78rem; font-weight: 600; }
  .chip-toggle { display: inline-block; padding: 0.15rem 0.6rem; border-radius: 999px; background: #eef2ff; color: #1e3a8a; font-size: 0.78rem; font-weight: 600; text-decoration: none; }
  .chip-toggle:hover { background: #e0e7ff; }
  .state-empty, .state-error { padding: 1rem; background: #fff; border-radius: 0.5rem; box-shadow: 0 1px 2px rgba(0,0,0,0.08); }
  .state-error { color: #991b1b; }
  .admin-toolbar { margin: 0; padding: 0.5rem 1rem; text-align: right; font-size: 0.85rem; background: #eef2ff; }
  .export-link { margin: 0 0 0.75rem; font-size: 0.9rem; }
  nav[aria-label="Pagination"] { display: flex; gap: 1rem; align-items: center; padding: 0.75rem 0; font-size: 0.9rem; }
  section form { background: #fff; padding: 0.85rem; border-radius: 0.5rem; box-shadow: 0 1px 2px rgba(0,0,0,0.08); margin-bottom: 0.75rem; display: flex; flex-wrap: wrap; gap: 0.6rem; align-items: center; }
  @media (max-width: 40rem) {
    main { padding: 0.75rem; }
    form.filters { flex-direction: column; align-items: stretch; }
  }
`;

export interface AdminPageOptions {
  title: string;
  active: AdminNavTab;
  trailingSlash?: TrailingSlash;
  /** Pre-rendered, already-escaped HTML for the page's <main> content. */
  bodyHtml: string;
}

/**
 * "Download .db" link (ADMN-03) — present in every admin page shell, not
 * just the list views, since a full-database snapshot isn't scoped to any
 * one view's filter. Built via adminUrl (checker B1); export.db is an
 * extension-style path, so it stays slashless even under
 * trailingSlash:'always' (adminUrl's own extension-segment exemption).
 */
function renderAdminToolbarHtml(trailingSlash: TrailingSlash | undefined): string {
  const href = adminUrl('/forms-admin/export.db', trailingSlash);
  return `<p class="admin-toolbar"><a href="${escapeHtml(href)}">Download .db</a></p>`;
}

/**
 * Full HTML document shell (doctype/head/nav/main) shared by every P05
 * admin view. `noindex` meta mirrors login.astro's own convention; the
 * middleware also sets `X-Robots-Tag: noindex` on every authenticated admin
 * response (T-02-24) — belt and suspenders.
 */
export function renderAdminPageHtml(opts: AdminPageOptions): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<meta name="robots" content="noindex" />',
    `<title>${escapeHtml(opts.title)}</title>`,
    `<style>${ADMIN_STYLES}</style>`,
    '</head>',
    '<body>',
    renderNavHtml(opts.active, opts.trailingSlash),
    renderAdminToolbarHtml(opts.trailingSlash),
    `<main>${opts.bodyHtml}</main>`,
    '</body>',
    '</html>',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Entry table render helper — rows + columns + trailingSlash -> escaped HTML
// with EMPTY/ERROR states and adminUrl-built row/pagination links (D4;
// checker B1: every emitted href routes through adminUrl).
// ---------------------------------------------------------------------------

export interface EntryTableColumn {
  header: string;
  /** Must return already-safe HTML — escape any user-controlled value with escapeHtml before returning. */
  cell: (entry: Entry) => string;
}

/** Base columns every admin list view (Entries/Abandoned) starts from; Abandoned appends its own converted/turnstile-flag columns (D3/B2). */
export const DEFAULT_ENTRY_COLUMNS: EntryTableColumn[] = [
  { header: 'Created', cell: (entry) => escapeHtml(new Date(entry.createdAt).toISOString()) },
  { header: 'Form', cell: (entry) => escapeHtml(entry.formId) },
  { header: 'Status', cell: (entry) => escapeHtml(entry.status) },
  { header: 'Visitor', cell: (entry) => escapeHtml(entry.visitorUuid) },
];

function buildListQueryString(filter: EntryFilter, page: number, limit: number): string {
  const params = new URLSearchParams();
  if (filter.status) params.set('status', filter.status);
  if (filter.formId) params.set('formId', filter.formId);
  if (filter.search) params.set('search', filter.search);
  if (filter.from !== undefined) params.set('from', String(filter.from));
  if (filter.to !== undefined) params.set('to', String(filter.to));
  params.set('page', String(page));
  params.set('limit', String(limit));
  return params.toString();
}

function currentPageOf(filter: EntryFilter): number {
  const limit = filter.limit ?? DEFAULT_ENTRY_LIMIT;
  const offset = filter.offset ?? 0;
  return Math.floor(offset / limit) + 1;
}

/**
 * ADMN-03 — query string for the "Export CSV" link: status/formId/search/
 * from/to only. Deliberately excludes page/limit — CSV export always covers
 * the ENTIRE filtered dataset (threat model: "export routes -> full data
 * dump"), never just the currently-displayed page; export-csv.ts strips any
 * incoming limit/offset for the same reason (T-02-28).
 */
export function buildExportQueryString(filter: EntryFilter): string {
  const params = new URLSearchParams();
  if (filter.status) params.set('status', filter.status);
  if (filter.formId) params.set('formId', filter.formId);
  if (filter.search) params.set('search', filter.search);
  if (filter.from !== undefined) params.set('from', String(filter.from));
  if (filter.to !== undefined) params.set('to', String(filter.to));
  return params.toString();
}

/**
 * "Export CSV" link (ADMN-03) — carries the current view's filter criteria
 * (never page/limit, see buildExportQueryString) to /forms-admin/export.csv.
 * Built via adminUrl (checker B1); export.csv is an extension-style path, so
 * it stays slashless even under trailingSlash:'always'.
 */
function renderExportCsvLinkHtml(filter: EntryFilter, trailingSlash: TrailingSlash | undefined): string {
  const query = buildExportQueryString(filter);
  const href = adminUrl(`/forms-admin/export.csv${query ? `?${query}` : ''}`, trailingSlash);
  return `<p class="export-link"><a href="${escapeHtml(href)}">Export CSV</a></p>`;
}

function renderFilterFormHtml(
  basePath: string,
  filter: EntryFilter,
  trailingSlash: TrailingSlash | undefined,
  showStatusFilter: boolean,
): string {
  const action = adminUrl(basePath, trailingSlash);
  const statusField = showStatusFilter
    ? `<div><label for="status">Status</label><select id="status" name="status"><option value="">All</option>${ENTRY_STATUSES.map(
        (s) => `<option value="${s}"${filter.status === s ? ' selected' : ''}>${escapeHtml(s)}</option>`,
      ).join('')}</select></div>`
    : '';
  return [
    `<form method="get" action="${escapeHtml(action)}" class="filters">`,
    statusField,
    `<div><label for="formId">Form ID</label><input id="formId" name="formId" type="text" value="${escapeHtml(filter.formId ?? '')}" /></div>`,
    `<div><label for="search">Search</label><input id="search" name="search" type="search" value="${escapeHtml(filter.search ?? '')}" /></div>`,
    '<button type="submit">Filter</button>',
    '</form>',
  ].join('');
}

function renderPaginationHtml(
  basePath: string,
  filter: EntryFilter,
  rowCount: number,
  total: number,
  trailingSlash: TrailingSlash | undefined,
): string {
  const limit = filter.limit ?? DEFAULT_ENTRY_LIMIT;
  const offset = filter.offset ?? 0;
  const page = currentPageOf(filter);
  const hasPrev = offset > 0;
  const hasNext = offset + rowCount < total;

  const linkFor = (targetPage: number): string =>
    adminUrl(`${basePath}?${buildListQueryString(filter, targetPage, limit)}`, trailingSlash);

  const prev = hasPrev
    ? `<a href="${escapeHtml(linkFor(page - 1))}" rel="prev">Previous</a>`
    : '<span aria-disabled="true">Previous</span>';
  const next = hasNext
    ? `<a href="${escapeHtml(linkFor(page + 1))}" rel="next">Next</a>`
    : '<span aria-disabled="true">Next</span>';

  return `<nav aria-label="Pagination"><p>Page ${page} — ${total} total</p>${prev} ${next}</nav>`;
}

export interface RenderEntryTableOptions {
  /** `undefined` (never queried) renders the same as `[]` (EMPTY) — pass `error:true` to render the ERROR state instead. */
  entries: Entry[] | undefined;
  total: number;
  filter: EntryFilter;
  trailingSlash?: TrailingSlash;
  /** e.g. '/forms-admin/entries' — the filter-form action + pagination links are built from this; row-detail links always target '/forms-admin/entries/{id}' (the single detail route). */
  basePath: string;
  columns?: EntryTableColumn[];
  /** true when the underlying storage query threw — renders the ERROR state instead of an empty table. */
  error?: boolean;
  /** Entries=true (any status, filterable); Abandoned=false (status is pinned, not user-filterable). */
  showStatusFilter?: boolean;
}

/**
 * Renders a filter form + entries table + pagination as one HTML fragment.
 * EMPTY (no rows) / ERROR (query threw) / SUCCESS states are all handled
 * here; every row-detail link and pagination link is built via `adminUrl`
 * (checker B1). There is no separate client-observable LOADING state — these
 * are fully server-rendered pages with no client framework (design spec
 * §5.6); the browser's own navigation/loading UI covers that gap.
 */
export function renderEntryTableHtml(opts: RenderEntryTableOptions): string {
  const showStatusFilter = opts.showStatusFilter ?? true;
  const filterForm = renderFilterFormHtml(opts.basePath, opts.filter, opts.trailingSlash, showStatusFilter);
  const exportLink = renderExportCsvLinkHtml(opts.filter, opts.trailingSlash);

  if (opts.error) {
    return `${filterForm}${exportLink}<p role="alert" class="state-error">Unable to load entries right now — please try again.</p>`;
  }

  const entries = opts.entries ?? [];
  if (entries.length === 0) {
    return `${filterForm}${exportLink}<p class="state-empty">No entries found.</p>`;
  }

  const columns = opts.columns ?? DEFAULT_ENTRY_COLUMNS;
  const headCells = columns.map((c) => `<th scope="col">${escapeHtml(c.header)}</th>`).join('');
  const bodyRows = entries
    .map((entry) => {
      const detailHref = adminUrl(`/forms-admin/entries/${entry.id}`, opts.trailingSlash);
      const cells = columns.map((c) => `<td>${c.cell(entry)}</td>`).join('');
      return `<tr><td><a href="${escapeHtml(detailHref)}">View</a></td>${cells}</tr>`;
    })
    .join('');

  const table = [
    '<div class="table-wrap">',
    '<table>',
    '<caption class="sr-only">Entries</caption>',
    `<thead><tr><th scope="col">Detail</th>${headCells}</tr></thead>`,
    `<tbody>${bodyRows}</tbody>`,
    '</table>',
    '</div>',
  ].join('');

  const pagination = renderPaginationHtml(opts.basePath, opts.filter, entries.length, opts.total, opts.trailingSlash);

  return `${filterForm}${exportLink}${table}${pagination}`;
}

// ---------------------------------------------------------------------------
// Analytics panel render helper (ANLY-01 render, D4 tab). Deliberately a
// plain .ts function rather than inline analytics.astro frontmatter logic:
// @astrojs/compiler 2.x has a confirmed parser bug where a frontmatter
// script combining several ternary-with-nested-template-literal expressions
// (this panel's funnel/drop-off/health HTML) duplicates the frontmatter's
// `export const prerender` statement into the compiled component closure —
// a syntax error esbuild then rejects as "Unexpected export" at BUILD time
// (isolated + verified via a bisected repro against the compiler's
// transform() directly). Plain .ts modules are never run through that
// compiler, so hosting this logic here sidesteps the bug entirely; keeping
// analytics.astro's own frontmatter to data-fetching + one function call.
// ---------------------------------------------------------------------------

export interface AnalyticsHealthInfo {
  dbSizeBytes: number | undefined;
  oldestUnconvertedAt: number | undefined;
  lastNotifySuccessAt: number | undefined;
}

export interface RenderAnalyticsPanelOptions {
  funnel: FunnelCounts | undefined;
  dropOff: DropOffRow[];
  health: AnalyticsHealthInfo;
  /** true when the underlying storage query threw — renders the ERROR state instead. */
  error?: boolean;
}

function fmtBytes(bytes: number | undefined): string {
  if (bytes === undefined) return 'n/a';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function fmtTs(ts: number | undefined): string {
  if (ts === undefined) return 'n/a';
  return new Date(ts).toISOString();
}

/**
 * Renders the funnel table, abandonment rate, top-drop-off table, and
 * system-health line as one HTML fragment (excluding the page's <h1>, which
 * the .astro page itself renders). EMPTY (no funnel data yet, since client
 * capture ships in P07) / ERROR (query threw) / SUCCESS states are all
 * handled here. All values are escaped.
 */
export function renderAnalyticsPanelHtml(opts: RenderAnalyticsPanelOptions): string {
  if (opts.error) {
    return '<p role="alert" class="state-error">Unable to load analytics right now — please try again.</p>';
  }

  const started = opts.funnel?.started ?? 0;
  const abandoned = opts.funnel?.abandoned ?? 0;
  const submitted = opts.funnel?.submitted ?? 0;
  const converted = opts.funnel?.converted ?? 0;

  let abandonmentRate: string;
  if (started > 0) {
    const percent = (abandoned / started) * 100;
    abandonmentRate = `${percent.toFixed(1)}%`;
  } else {
    abandonmentRate = 'n/a (no form_starts recorded yet)';
  }

  let funnelHtml: string;
  if (started === 0 && abandoned === 0 && submitted === 0 && converted === 0) {
    funnelHtml =
      '<p class="state-empty">No funnel data yet — client capture starts recording form_starts once P07 ships.</p>';
  } else {
    const rateHtml = `<p>Abandonment rate: ${escapeHtml(abandonmentRate)}</p>`;
    funnelHtml =
      '<table><thead><tr><th scope="col">Started</th><th scope="col">Abandoned</th><th scope="col">Submitted</th><th scope="col">Converted</th></tr></thead>' +
      `<tbody><tr><td>${started}</td><td>${abandoned}</td><td>${submitted}</td><td>${converted}</td></tr></tbody></table>` +
      rateHtml;
  }

  let dropOffHtml: string;
  if (opts.dropOff.length === 0) {
    dropOffHtml = '<p class="state-empty">No drop-off data yet.</p>';
  } else {
    const rows = opts.dropOff
      .map((row) => `<tr><td>${escapeHtml(row.field)}</td><td>${row.count}</td></tr>`)
      .join('');
    dropOffHtml =
      '<table><thead><tr><th scope="col">Field</th><th scope="col">Count</th></tr></thead>' + `<tbody>${rows}</tbody></table>`;
  }

  const healthItems = [
    `DB size: ${escapeHtml(fmtBytes(opts.health.dbSizeBytes))}`,
    `Oldest unconverted abandoned entry: ${escapeHtml(fmtTs(opts.health.oldestUnconvertedAt))}`,
    `Last notify success: ${escapeHtml(fmtTs(opts.health.lastNotifySuccessAt))}`,
    'Reject counts: n/a (not persisted in this version)',
  ];
  const healthHtml = '<ul>' + healthItems.map((item) => `<li>${item}</li>`).join('') + '</ul>';

  return [
    `<section><h2>Funnel</h2>${funnelHtml}</section>`,
    `<section><h2>Top drop-off fields</h2>${dropOffHtml}</section>`,
    `<section><h2>System health</h2>${healthHtml}</section>`,
  ].join('');
}

// ---------------------------------------------------------------------------
// Entries default payment-request exclusion (checker B2) — synthetic
// `_payment_request` anchor rows (created by the /forms-pay standalone page,
// 03-05) must never masquerade as real form submissions in the Entries
// list. Hidden by default, with a visible chip/toggle to opt in. Deliberately
// plain .ts (not .astro frontmatter) per the @astrojs/compiler
// ternary/template-literal parser bug (see renderAnalyticsPanelHtml's own
// docstring above) — every non-trivial view-logic helper this admin surface
// needs lives here, never inline in a page's frontmatter script.
// ---------------------------------------------------------------------------

/**
 * Unless `?showPaymentRequests=1` is present, sets `filter.excludeFormId` to
 * the shared `PAYMENT_REQUEST_FORM_ID` constant (never a mirrored literal)
 * so `listEntries`/`countEntries` exclude synthetic payment-request rows by
 * default. Mutates and returns the same filter object (mirrors
 * `parseEntryFilter`'s own construction style).
 */
export function applyEntriesDefaultExclusion(filter: EntryFilter, searchParams: URLSearchParams): EntryFilter {
  if (searchParams.get('showPaymentRequests') !== '1') {
    filter.excludeFormId = PAYMENT_REQUEST_FORM_ID;
  }
  return filter;
}

/**
 * Renders the visible chip/toggle above the Entries table: "Payment
 * requests hidden — show" when hidden (the default), "Showing payment
 * requests — hide" when `showPaymentRequests=1` is present. Flips exactly
 * that one param while preserving the rest of the current query string
 * (status/formId/search/from/to/page/limit all carry through unchanged).
 * NOTE: this is deliberately Entries-only (hardcoded `/forms-admin/entries`,
 * matching this helper's fixed 2-arg signature) — the Abandoned view needs
 * no equivalent (its status is pinned to 'abandoned'; synthetic
 * payment-request rows are always created with status 'submitted', so they
 * can never appear there).
 */
export function renderPaymentRequestChipHtml(
  searchParams: URLSearchParams,
  trailingSlash: TrailingSlash | undefined,
): string {
  const showing = searchParams.get('showPaymentRequests') === '1';
  const params = new URLSearchParams(searchParams);
  if (showing) {
    params.delete('showPaymentRequests');
  } else {
    params.set('showPaymentRequests', '1');
  }
  const query = params.toString();
  const href = adminUrl(`/forms-admin/entries${query ? `?${query}` : ''}`, trailingSlash);
  const label = showing ? 'Showing payment requests — hide' : 'Payment requests hidden — show';
  return `<p><a href="${escapeHtml(href)}" class="chip-toggle">${escapeHtml(label)}</a></p>`;
}

// ---------------------------------------------------------------------------
// Payments admin list view (D5) — parsePaymentFilter + renderPaymentsTableHtml.
// Mirrors parseEntryFilter/renderEntryTableHtml's own EMPTY/ERROR/SUCCESS +
// adminUrl-built-link discipline (checker B1), not a shared generic — the
// two filter shapes (provider/status vs status/formId/search/from/to) are
// different enough that a forced abstraction would obscure more than it saves.
// ---------------------------------------------------------------------------

const PAYMENT_PROVIDERS: readonly PaymentProvider[] = ['stripe', 'paypal'];
const PAYMENT_STATUSES: readonly PaymentStatus[] = ['link_created', 'link_sent', 'paid', 'failed', 'refunded'];

/**
 * Maps `Astro.url.searchParams` into a valid `PaymentFilter`: provider/
 * status validated against their vocabularies (garbage silently ignored,
 * never thrown — same discipline as `parseEntryFilter`), page -> offset
 * math reusing the exact `parsePositiveInt`/`DEFAULT_ENTRY_LIMIT`/
 * `MAX_ENTRY_LIMIT` idioms so pagination behaves identically across every
 * admin list view.
 */
export function parsePaymentFilter(searchParams: URLSearchParams): PaymentFilter {
  const filter: PaymentFilter = {};

  const provider = searchParams.get('provider');
  if (provider && (PAYMENT_PROVIDERS as readonly string[]).includes(provider)) {
    filter.provider = provider as PaymentProvider;
  }

  const status = searchParams.get('status');
  if (status && (PAYMENT_STATUSES as readonly string[]).includes(status)) {
    filter.status = status as PaymentStatus;
  }

  const page = parsePositiveInt(searchParams.get('page'), 1);
  const limit = parsePositiveInt(searchParams.get('limit'), DEFAULT_ENTRY_LIMIT, MAX_ENTRY_LIMIT);
  filter.limit = limit;
  filter.offset = (page - 1) * limit;

  return filter;
}

function buildPaymentListQueryString(filter: PaymentFilter, page: number, limit: number): string {
  const params = new URLSearchParams();
  if (filter.provider) params.set('provider', filter.provider);
  if (filter.status) params.set('status', filter.status);
  params.set('page', String(page));
  params.set('limit', String(limit));
  return params.toString();
}

function currentPaymentPageOf(filter: PaymentFilter): number {
  const limit = filter.limit ?? DEFAULT_ENTRY_LIMIT;
  const offset = filter.offset ?? 0;
  return Math.floor(offset / limit) + 1;
}

function renderPaymentFilterFormHtml(
  basePath: string,
  filter: PaymentFilter,
  trailingSlash: TrailingSlash | undefined,
): string {
  const action = adminUrl(basePath, trailingSlash);
  const providerOptions = PAYMENT_PROVIDERS.map(
    (p) => `<option value="${p}"${filter.provider === p ? ' selected' : ''}>${escapeHtml(p)}</option>`,
  ).join('');
  const statusOptions = PAYMENT_STATUSES.map(
    (s) => `<option value="${s}"${filter.status === s ? ' selected' : ''}>${escapeHtml(s)}</option>`,
  ).join('');
  return [
    `<form method="get" action="${escapeHtml(action)}" class="filters">`,
    `<div><label for="payment-provider">Provider</label><select id="payment-provider" name="provider"><option value="">All</option>${providerOptions}</select></div>`,
    `<div><label for="payment-status">Status</label><select id="payment-status" name="status"><option value="">All</option>${statusOptions}</select></div>`,
    '<button type="submit">Filter</button>',
    '</form>',
  ].join('');
}

function renderPaymentPaginationHtml(
  basePath: string,
  filter: PaymentFilter,
  rowCount: number,
  total: number,
  trailingSlash: TrailingSlash | undefined,
): string {
  const limit = filter.limit ?? DEFAULT_ENTRY_LIMIT;
  const offset = filter.offset ?? 0;
  const page = currentPaymentPageOf(filter);
  const hasPrev = offset > 0;
  const hasNext = offset + rowCount < total;

  const linkFor = (targetPage: number): string =>
    adminUrl(`${basePath}?${buildPaymentListQueryString(filter, targetPage, limit)}`, trailingSlash);

  const prev = hasPrev
    ? `<a href="${escapeHtml(linkFor(page - 1))}" rel="prev">Previous</a>`
    : '<span aria-disabled="true">Previous</span>';
  const next = hasNext
    ? `<a href="${escapeHtml(linkFor(page + 1))}" rel="next">Next</a>`
    : '<span aria-disabled="true">Next</span>';

  return `<nav aria-label="Pagination"><p>Page ${page} — ${total} total</p>${prev} ${next}</nav>`;
}

export interface RenderPaymentsTableOptions {
  /** `undefined` (never queried) renders the same as `[]` (EMPTY) — pass `error:true` to render the ERROR state instead. */
  payments: Payment[] | undefined;
  total: number;
  filter: PaymentFilter;
  trailingSlash?: TrailingSlash;
  /** e.g. '/forms-admin/payments' — the filter-form action + pagination links are built from this. */
  basePath: string;
  /** true when the underlying storage query threw — renders the ERROR state instead of an empty table. */
  error?: boolean;
}

/**
 * Renders a provider/status filter form + payments table + pagination as
 * one HTML fragment. Columns: Created / Amount / Currency / Provider /
 * Status / Entry (links to `/forms-admin/entries/{entryId}`) / Pay link.
 * EMPTY/ERROR/SUCCESS states all handled here; every link is
 * `adminUrl`-built (checker B1). Amount/Currency are deliberately SEPARATE
 * columns (a raw dollars figure + an ISO code), not a combined
 * currency-formatted string — `formatMoney` (templates.ts) is for
 * human-readable prose contexts (emails, entry-detail rows), not a
 * multi-column data table.
 */
export function renderPaymentsTableHtml(opts: RenderPaymentsTableOptions): string {
  const filterForm = renderPaymentFilterFormHtml(opts.basePath, opts.filter, opts.trailingSlash);

  if (opts.error) {
    return `${filterForm}<p role="alert" class="state-error">Unable to load payments right now — please try again.</p>`;
  }

  const payments = opts.payments ?? [];
  if (payments.length === 0) {
    return `${filterForm}<p class="state-empty">No payments found.</p>`;
  }

  const rows = payments
    .map((payment) => {
      const created = escapeHtml(new Date(payment.createdAt).toISOString());
      const amount = payment.amountCents !== undefined ? escapeHtml((payment.amountCents / 100).toFixed(2)) : '';
      const currency = escapeHtml((payment.currency ?? '').toUpperCase());
      const provider = escapeHtml(payment.provider ?? '');
      const status = escapeHtml(payment.status ?? '');
      const entryHref = adminUrl(`/forms-admin/entries/${payment.entryId}`, opts.trailingSlash);
      const payLinkCell = payment.payLinkUrl
        ? `<a href="${escapeHtml(payment.payLinkUrl)}">Pay link</a>`
        : '';
      return `<tr><td>${created}</td><td>${amount}</td><td>${currency}</td><td>${provider}</td><td>${status}</td><td><a href="${escapeHtml(entryHref)}">${escapeHtml(payment.entryId)}</a></td><td>${payLinkCell}</td></tr>`;
    })
    .join('');

  const table = [
    '<div class="table-wrap">',
    '<table>',
    '<caption class="sr-only">Payments</caption>',
    '<thead><tr><th scope="col">Created</th><th scope="col">Amount</th><th scope="col">Currency</th><th scope="col">Provider</th><th scope="col">Status</th><th scope="col">Entry</th><th scope="col">Pay link</th></tr></thead>',
    `<tbody>${rows}</tbody>`,
    '</table>',
    '</div>',
  ].join('');

  const pagination = renderPaymentPaginationHtml(
    opts.basePath,
    opts.filter,
    payments.length,
    opts.total,
    opts.trailingSlash,
  );

  return `${filterForm}${table}${pagination}`;
}
