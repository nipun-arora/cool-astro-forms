/**
 * Explicit same-origin check for the /api/forms/abandon route.
 *
 * RESEARCH.md Pitfall 1: Astro's built-in `security.checkOrigin` only
 * inspects requests whose Content-Type is application/x-www-form-urlencoded,
 * multipart/form-data, or text/plain. This route receives application/json,
 * so Astro's check never runs against it — this is the ONLY origin
 * protection the route gets and it must be hand-implemented (SEC-01 / T-01-08).
 *
 * Clean-room: written fresh against Fetch/URL spec semantics, not derived
 * from any commercial form-plugin source.
 */

/** Parses a header value into its normalized URL.origin, or null if unusable. */
function toOrigin(headerValue: string | null): string | null {
  if (!headerValue) return null;
  try {
    return new URL(headerValue).origin;
  } catch {
    return null;
  }
}

/**
 * Compares the FULL origin (scheme + host + port) of the request against
 * `allowedOrigin`, via the Origin header primarily, falling back to Referer
 * only when Origin is absent or the browser sent the opaque literal "null".
 * A present-and-parseable-but-mismatched Origin is a hard rejection — it
 * never falls back to the spoofable Referer header. Never fails open:
 * malformed/missing input on both headers resolves to `false`.
 */
export function isSameOrigin(headers: Headers, allowedOrigin: string): boolean {
  const allowed = toOrigin(allowedOrigin);
  if (!allowed) return false;

  const rawOrigin = headers.get('Origin');
  if (rawOrigin && rawOrigin !== 'null') {
    const origin = toOrigin(rawOrigin);
    return origin !== null && origin === allowed;
  }

  // Origin is absent, OR the browser sent the opaque literal "null" —
  // both cases fall back to a Referer confirmation per SEC-01.
  const referer = toOrigin(headers.get('Referer'));
  return referer !== null && referer === allowed;
}
