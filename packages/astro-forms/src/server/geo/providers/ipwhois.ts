/**
 * ipwho.is (`https://ipwho.is/{ip}`) response mapping — the commercial-use-safe
 * default geo provider (D2; corrects the design spec's non-commercial
 * ip-api.com). Mapping stays simple/1:1 per D2 — no derived fields.
 *
 * Success shape: { success: true, city, region, country, latitude, longitude,
 * postal, connection: { isp } } — note isp is NESTED under `connection`, not
 * top-level.
 * Failure shape: { success: false, message }
 */
import type { Geo } from '../../../types.js';

/** Substitutes the ONLY `{ip}` slot in a provider URL template (T-02-05: encodeURIComponent'd, never raw request data). */
export function buildIpwhoisUrl(providerUrl: string, ip: string): string {
  return providerUrl.replace('{ip}', encodeURIComponent(ip));
}

/**
 * Maps an ipwho.is JSON body to `Geo`. Returns `undefined` when the provider
 * reports `success: false` or the body isn't a usable object — callers
 * (lookupGeo) treat `undefined` as "no geo", never as an error to surface.
 */
export function mapIpwhoisResponse(data: unknown): Geo | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const body = data as Record<string, unknown>;
  if (body.success === false) return undefined;

  const connection =
    body.connection && typeof body.connection === 'object' ? (body.connection as Record<string, unknown>) : undefined;

  return {
    city: typeof body.city === 'string' ? body.city : undefined,
    region: typeof body.region === 'string' ? body.region : undefined,
    country: typeof body.country === 'string' ? body.country : undefined,
    lat: typeof body.latitude === 'number' ? body.latitude : undefined,
    lon: typeof body.longitude === 'number' ? body.longitude : undefined,
    postal: typeof body.postal === 'string' ? body.postal : undefined,
    isp: connection && typeof connection.isp === 'string' ? (connection.isp as string) : undefined,
  };
}
