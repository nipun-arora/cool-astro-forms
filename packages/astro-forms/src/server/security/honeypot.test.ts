/**
 * honeypot.ts tests — anti-automation honeypot field detection (SEC-01,
 * T-01-11). Clean-room, written fresh.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HONEYPOT_FIELD_NAME } from '../../types.js';
import { isHoneypotTripped } from './honeypot.js';

describe('isHoneypotTripped', () => {
  it('returns true when an explicit honeypotValue is non-empty', () => {
    expect(isHoneypotTripped({}, 'bot-filled')).toBe(true);
  });

  it('returns false when an explicit honeypotValue is an empty string', () => {
    expect(isHoneypotTripped({}, '')).toBe(false);
  });

  it('returns false when honeypotValue is undefined and no honeypot field is present', () => {
    expect(isHoneypotTripped({})).toBe(false);
  });

  it('returns true when the reserved honeypot field is present and filled in fields', () => {
    expect(isHoneypotTripped({ [HONEYPOT_FIELD_NAME]: 'i-am-a-bot' })).toBe(true);
  });

  it('returns false when the reserved honeypot field is present but empty', () => {
    expect(isHoneypotTripped({ [HONEYPOT_FIELD_NAME]: '' })).toBe(false);
  });

  it('returns false when the reserved honeypot field value is not a string', () => {
    expect(isHoneypotTripped({ [HONEYPOT_FIELD_NAME]: 123 })).toBe(false);
  });
});

describe('HONEYPOT_FIELD_NAME stays autofill-proof', () => {
  // 2026-09-04 fleet incident: a sibling site's honeypot was named `company`,
  // Chrome's autofill classified it as an organisation field and filled it
  // during the owner's own test, and the server's silent bot-discard dropped
  // a real message. Any name browser autofill recognises reproduces this.
  const AUTOFILL_VOCABULARY = [
    'company',
    'organization',
    'org',
    'website',
    'url',
    'address',
    'street',
    'city',
    'zip',
    'postal',
    'country',
    'phone',
    'tel',
    'mobile',
    'fax',
    'name',
    'email',
    'username',
  ];

  it('contains none of the autofill vocabulary tokens', () => {
    const lower = HONEYPOT_FIELD_NAME.toLowerCase();
    for (const token of AUTOFILL_VOCABULARY) {
      expect(lower.includes(token)).toBe(false);
    }
  });

  const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../');
  const PLAYGROUND_PAGES = [
    path.join(REPO_ROOT, 'apps/playground/src/pages/index.astro'),
    path.join(REPO_ROOT, 'apps/playground/src/pages/plain.astro'),
  ];

  it.each(PLAYGROUND_PAGES)('%s wires the honeypot input as autofill-proof reference markup', (pagePath) => {
    const source = fs.readFileSync(pagePath, 'utf8');

    const inputMatches = [...source.matchAll(/<input\b[^>]*>/g)].filter((match) => {
      const nameMatch = /\bname=["']([^"']+)["']/.exec(match[0]);
      return nameMatch?.[1] === HONEYPOT_FIELD_NAME;
    });
    expect(inputMatches.length).toBe(1);

    const honeypotInput = inputMatches[0]![0];
    expect(honeypotInput).toContain('autocomplete="off"');
    expect(honeypotInput).toContain('tabindex="-1"');

    const idMatch = /\bid=["']([^"']+)["']/.exec(honeypotInput);
    expect(idMatch?.[1]).toBe(HONEYPOT_FIELD_NAME);

    const labelRe = new RegExp(`<label\\s+for=["']${HONEYPOT_FIELD_NAME}["']>([^<]*)</label>`);
    const labelMatch = labelRe.exec(source);
    expect(labelMatch?.[1]).toBe('Leave this field empty');
  });
});
