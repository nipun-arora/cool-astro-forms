/**
 * CSV cell encoding for `StorageAdapter.exportCsv` (T-01-33). The ONE
 * implementation every backend imports, so the export's bytes, and its
 * injection guard, never depend on which adapter produced them.
 *
 * Nearly every exported cell is visitor-controlled (field values and field
 * NAMES from the abandon payload, plus the userAgent/referrer request
 * headers), and the owner opens the file in a spreadsheet. Two rules,
 * following the OWASP CSV Injection guidance:
 *
 * 1. Formula guard: a cell that starts with `=` `+` `-` `@`, TAB, CR or LF
 *    gets a leading `'`, so the spreadsheet reads it as text. TAB/CR/LF are
 *    on the list because importers strip or split on them and the next
 *    character then leads the cell.
 * 2. Quoting (RFC 4180): a cell containing `,` `"` CR or LF is wrapped in
 *    double quotes with inner quotes doubled. A bare CR must be quoted too:
 *    spreadsheets treat it as a row break, so an unquoted `Thanks\r=1+1`
 *    would start a new row with a live formula.
 */
export function csvCell(value: unknown): string {
  let s = value === undefined || value === null ? '' : String(value);
  if (/^[=+\-@\t\r\n]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}
