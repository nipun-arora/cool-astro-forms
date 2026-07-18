/**
 * Visitor identity + consent gate (ABND-06).
 *
 * Written fresh against MDN document.cookie/Web Storage/Web Crypto specs —
 * clean-room, not derived from commercial form-plugin source.
 *
 * The `_caf_uid` cookie is the server-authoritative identity signal (the
 * abandon route reads it from the request). The localStorage mirror exists
 * purely to survive a cleared cookie (e.g. a user manually clears cookies but
 * not site data) — when the cookie is missing but the mirror has a value,
 * the cookie gets REWRITTEN from the mirror rather than minting a new uuid,
 * keeping the server's view of "one visitor" stable.
 */

const COOKIE_NAME = '_caf_uid';
const MIRROR_STORAGE_KEY = '_caf_uid';
const CONSENT_STORAGE_KEY = '_caf_consent';
const COOKIE_MAX_AGE_SECONDS = 31_536_000; // 1 year

declare global {
  interface Window {
    /** Alternate consent signal a host page can set directly (see hasConsent). */
    __cafConsent?: boolean;
  }
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const escaped = name.replace(/([.$?*|{}()[\]\\/+^])/g, '\\$1');
  const match = document.cookie.match(new RegExp(`(?:^|; )${escaped}=([^;]*)`));
  return match ? decodeURIComponent(match[1]!) : null;
}

function writeCookie(name: string, value: string, maxAgeSeconds: number): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${name}=${encodeURIComponent(value)}; Max-Age=${maxAgeSeconds}; Path=/; SameSite=Lax`;
}

// ---------------------------------------------------------------------------
// localStorage mirror (best-effort; cookie remains authoritative)
// ---------------------------------------------------------------------------

function safeLocalStorageGet(key: string): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function safeLocalStorageSet(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
  } catch {
    // best-effort mirror only; the cookie is the source of truth
  }
}

function generateUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback RFC4122-v4-shaped generator for environments without crypto.randomUUID.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Reads the `_caf_uid` cookie; if absent but the localStorage mirror has a
 * value, rewrites the cookie from the mirror (keeps the server
 * cookie-authoritative) and returns it. Otherwise mints a new uuid, writes
 * both the cookie and the mirror, and returns it.
 */
export function getOrCreateVisitorUuid(): string {
  const cookieValue = readCookie(COOKIE_NAME);
  if (cookieValue) return cookieValue;

  const mirrored = safeLocalStorageGet(MIRROR_STORAGE_KEY);
  if (mirrored) {
    writeCookie(COOKIE_NAME, mirrored, COOKIE_MAX_AGE_SECONDS);
    return mirrored;
  }

  const uuid = generateUuid();
  writeCookie(COOKIE_NAME, uuid, COOKIE_MAX_AGE_SECONDS);
  safeLocalStorageSet(MIRROR_STORAGE_KEY, uuid);
  return uuid;
}

// ---------------------------------------------------------------------------
// Consent gate (requireConsent)
// ---------------------------------------------------------------------------

let consentGrantedFlag = false;

/**
 * Idempotently marks consent as granted: in-module flag, `window.__cafConsent`,
 * and a localStorage flag so a later page load in the same browser stays
 * granted without the host having to re-signal every navigation.
 */
export function grantConsent(): void {
  consentGrantedFlag = true;
  if (typeof window !== 'undefined') window.__cafConsent = true;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(CONSENT_STORAGE_KEY, '1');
  } catch {
    // best-effort persistence only
  }
}

export interface ConsentOptions {
  requireConsent: boolean;
}

/**
 * `requireConsent: false` → always true (no gate). `requireConsent: true` →
 * true only once a consent signal is present: `grantConsent()` having been
 * called, `window.__cafConsent === true` set directly by the host, or a
 * previously persisted localStorage flag.
 */
export function hasConsent(opts: ConsentOptions): boolean {
  if (!opts.requireConsent) return true;
  if (consentGrantedFlag) return true;
  if (typeof window !== 'undefined' && window.__cafConsent === true) return true;
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem(CONSENT_STORAGE_KEY) === '1') {
      consentGrantedFlag = true;
      return true;
    }
  } catch {
    // treat as no consent signal available
  }
  return false;
}

/** Gates capture on consent. Same semantics as hasConsent — kept as a named
 * entrypoint for capture.ts so the intent at each call site reads clearly. */
export function isCaptureAllowed(opts: ConsentOptions): boolean {
  return hasConsent(opts);
}
