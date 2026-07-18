/**
 * Pure folder-path + name-escaping helpers for the Drive module (DRV-01).
 * Zero I/O — every function here is total and side-effect-free so
 * folder-path.test.ts needs zero mocking.
 *
 * Query-syntax source: developers.google.com/workspace/drive/api/guides/search-files
 * (RESEARCH Pattern 1) — Drive's `q` mini-language requires backslash-escaping
 * a literal `\` and `'` inside a single-quoted string value.
 *
 * Clean-room: written fresh against the cited Drive docs, not derived from
 * any WPForms source.
 */

const MAX_NAME_LENGTH = 255;

/**
 * Builds the ordered Drive folder-path segments: `[root, siteId, 'YYYY-MM']`,
 * plus a trailing `entryId` segment when provided. The month segment is
 * derived from `entryCreatedAt` in UTC (never the host's local timezone) so
 * the folder layout is stable regardless of server locale.
 */
export function buildFolderPath(
  rootFolderName: string,
  siteId: string,
  entryCreatedAt: number,
  entryId?: string,
): string[] {
  const date = new Date(entryCreatedAt);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const segments = [rootFolderName, siteId, `${year}-${month}`];
  if (entryId) segments.push(entryId);
  return segments;
}

/**
 * Backslash-escapes `\` then `'` per Drive's `q` mini-language grammar so a
 * name value can never break out of its single-quoted string in a
 * `files.list` query (the one Drive-specific injection surface, RESEARCH
 * Security Domain).
 */
export function escapeQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Strips path-traversal shapes and control characters from a filename
 * before it is used as a Drive folder/file `name`. An already-clean name is
 * unchanged; an empty/all-stripped result falls back to `'file'`.
 */
export function sanitizeName(name: string): string {
  let cleaned = name.replace(/[\u0000-\u001f\u007f]/g, '');

  // Repeatedly strip ".." until none remain — a single non-overlapping pass
  // can leave a fresh ".." pair behind (e.g. "....") that a second pass must
  // still catch.
  let previous: string;
  do {
    previous = cleaned;
    cleaned = cleaned.replace(/\.\./g, '');
  } while (cleaned !== previous);

  cleaned = cleaned.replace(/^[/\\]+/, '').replace(/[/\\]+$/, '').trim();

  if (cleaned.length === 0) return 'file';
  return cleaned.slice(0, MAX_NAME_LENGTH);
}
