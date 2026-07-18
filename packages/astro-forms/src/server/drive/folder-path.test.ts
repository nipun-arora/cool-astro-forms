/**
 * folder-path.ts tests — buildFolderPath / escapeQueryValue / sanitizeName.
 * Every function under test is pure (zero I/O), so this suite needs zero
 * mocking (DRV-01).
 */
import { describe, expect, it } from 'vitest';
import { buildFolderPath, escapeQueryValue, sanitizeName } from './folder-path.js';

describe('buildFolderPath', () => {
  it('returns [root, siteId, YYYY-MM] with the month segment derived in UTC from a known epoch', () => {
    // 1700000000000 ms -> 2023-11-14T22:13:20.000Z
    expect(buildFolderPath('cool-astro-forms', 'site_1', 1_700_000_000_000)).toEqual([
      'cool-astro-forms',
      'site_1',
      '2023-11',
    ]);
  });

  it('appends the entryId as a 4th segment when provided', () => {
    expect(buildFolderPath('cool-astro-forms', 'site_1', 1_700_000_000_000, 'entry_9')).toEqual([
      'cool-astro-forms',
      'site_1',
      '2023-11',
      'entry_9',
    ]);
  });

  it('zero-pads a single-digit UTC month', () => {
    // 1_672_531_200_000 ms -> 2023-01-01T00:00:00.000Z
    expect(buildFolderPath('root', 'site_2', 1_672_531_200_000)).toEqual(['root', 'site_2', '2023-01']);
  });

  it('uses the UTC month even when it differs from the local calendar month at a year boundary', () => {
    // 1_703_980_799_000 ms -> 2023-12-31T23:59:59.000Z (UTC) — must stay '2023-12' regardless of host TZ.
    expect(buildFolderPath('root', 'site_3', 1_703_980_799_000)).toEqual(['root', 'site_3', '2023-12']);
  });
});

describe('escapeQueryValue', () => {
  it('backslash-escapes a single quote so a name cannot break out of a quoted q value', () => {
    expect(escapeQueryValue("O'Brien")).toBe("O\\'Brien");
  });

  it('escapes an existing backslash before escaping quotes', () => {
    expect(escapeQueryValue('back\\slash')).toBe('back\\\\slash');
  });

  it('leaves an already-clean name unchanged', () => {
    expect(escapeQueryValue('resume.pdf')).toBe('resume.pdf');
  });

  it('escapes multiple quotes in one name', () => {
    expect(escapeQueryValue("it's a 'test'")).toBe("it\\'s a \\'test\\'");
  });
});

describe('sanitizeName', () => {
  it('leaves an already-clean filename unchanged', () => {
    expect(sanitizeName('resume.pdf')).toBe('resume.pdf');
  });

  it('neutralizes a path-traversal-shaped filename (no leading/trailing slash, no ..)', () => {
    const result = sanitizeName('../../etc/passwd');
    expect(result).not.toContain('..');
    expect(result.startsWith('/')).toBe(false);
    expect(result.endsWith('/')).toBe(false);
  });

  it('strips control characters including NUL', () => {
    const result = sanitizeName('bad\u0000name\u001f.txt');
    expect(result).toBe('badname.txt');
  });

  it('falls back to "file" when the name is empty', () => {
    expect(sanitizeName('')).toBe('file');
  });

  it('falls back to "file" when the name is entirely stripped away', () => {
    expect(sanitizeName('....//')).toBe('file');
  });

  it('truncates an excessively long name to the length ceiling', () => {
    const longName = 'a'.repeat(500);
    const result = sanitizeName(longName);
    expect(result.length).toBeLessThanOrEqual(255);
  });
});
