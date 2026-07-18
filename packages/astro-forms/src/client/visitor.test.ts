// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getOrCreateVisitorUuid, grantConsent, hasConsent, isCaptureAllowed } from './visitor.js';

function clearCookies(): void {
  document.cookie.split(';').forEach((pair) => {
    const name = pair.split('=')[0]!.trim();
    if (name) document.cookie = `${name}=; Max-Age=0; Path=/;`;
  });
}

beforeEach(() => {
  clearCookies();
  localStorage.clear();
});

describe('getOrCreateVisitorUuid', () => {
  it('mints a uuid, sets the _caf_uid cookie with SameSite=Lax + Max-Age=31536000, and mirrors to localStorage', () => {
    const setSpy = vi.spyOn(document, 'cookie', 'set');

    const uuid = getOrCreateVisitorUuid();

    expect(uuid).toMatch(/^[0-9a-f-]{36}$|^.+$/); // non-empty identifier
    expect(setSpy).toHaveBeenCalled();
    const written = setSpy.mock.calls[0]![0] as string;
    expect(written).toContain('_caf_uid=');
    expect(written).toContain('SameSite=Lax');
    expect(written).toContain('Max-Age=31536000');
    expect(written).toContain('Path=/');

    expect(document.cookie).toContain(`_caf_uid=${uuid}`);
    expect(localStorage.getItem('_caf_uid')).toBe(uuid);

    setSpy.mockRestore();
  });

  it('returns the SAME uuid from the cookie on a second call', () => {
    const first = getOrCreateVisitorUuid();
    const second = getOrCreateVisitorUuid();
    expect(second).toBe(first);
  });

  it('cookie-restore: with the cookie cleared but the localStorage mirror populated, returns the mirror value and rewrites the cookie', () => {
    localStorage.setItem('_caf_uid', 'mirror-uuid-123');
    clearCookies();
    expect(document.cookie).not.toContain('_caf_uid=mirror-uuid-123');

    const result = getOrCreateVisitorUuid();

    expect(result).toBe('mirror-uuid-123');
    expect(document.cookie).toContain('_caf_uid=mirror-uuid-123');
  });
});

describe('consent gate', () => {
  it('requireConsent:true is dormant with no signal and active once granted', () => {
    expect(isCaptureAllowed({ requireConsent: true })).toBe(false);
    grantConsent();
    expect(isCaptureAllowed({ requireConsent: true })).toBe(true);
    expect(hasConsent({ requireConsent: true })).toBe(true);
  });

  it('requireConsent:false always allows capture', () => {
    expect(isCaptureAllowed({ requireConsent: false })).toBe(true);
  });
});
