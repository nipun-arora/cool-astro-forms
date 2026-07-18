/**
 * lookupGeo(ip, opts) — pure, NEVER-throws IP-geolocation enrichment step
 * (GEO-01). Private/local IPs are skipped with no network call. Every
 * failure mode (timeout, network error, non-2xx response, malformed body,
 * provider `success:false`) resolves `undefined` — the save this feeds must
 * never block or fail because a third-party lookup misbehaved (Research
 * Pattern 1; T-02-06 DoS mitigation via the hard AbortSignal.timeout cap).
 */
import type { Geo } from '../../types.js';
import { buildIpwhoisUrl, mapIpwhoisResponse } from './providers/ipwhois.js';

export interface LookupGeoOptions {
  /** `{ip}` template — swapped for the request IP at lookup time. */
  providerUrl: string;
  timeoutMs: number;
}

/**
 * Hand-rolled private/local IP range check (mirrors the Phase 1 hand-roll
 * precedent — no new dependency). Ranges per IANA special-purpose address
 * registries: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8,
 * 0.0.0.0, ::1, ::, fc00::/7 (unique local), fe80::/10 (link-local).
 */
export function isPrivateOrLocal(ip: string): boolean {
  if (!ip) return true;

  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 127) return true; // 127.0.0.0/8
    if (a === 0) return true; // 0.0.0.0/8 (incl. 0.0.0.0 itself)
    return false;
  }

  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true; // loopback / unspecified
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 unique local
  if (
    lower.startsWith('fe8') ||
    lower.startsWith('fe9') ||
    lower.startsWith('fea') ||
    lower.startsWith('feb')
  ) {
    return true; // fe80::/10 link-local
  }

  return false;
}

/**
 * Looks up geo for a public IP. Returns `undefined` immediately (no fetch)
 * for an empty or private/local IP. `process.env.GEO_PROVIDER` overrides
 * `opts.providerUrl` when set (runtime env contract, mirrors CAF_DB_PATH).
 */
export async function lookupGeo(ip: string, opts: LookupGeoOptions): Promise<Geo | undefined> {
  if (!ip || isPrivateOrLocal(ip)) return undefined;

  try {
    const providerUrl = process.env.GEO_PROVIDER ?? opts.providerUrl;
    const url = buildIpwhoisUrl(providerUrl, ip);
    const res = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs) });
    if (!res.ok) return undefined;
    const data: unknown = await res.json();
    return mapIpwhoisResponse(data);
  } catch {
    return undefined;
  }
}
