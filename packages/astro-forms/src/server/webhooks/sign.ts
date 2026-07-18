/**
 * Outbound webhook signature scheme (HOOK-01): `t=<unixSec>,v1=<hex hmac>`.
 * Mirrors admin-session.ts's `createHmac('sha256', secret)` + tokensMatch()
 * constant-time-compare convention — one HMAC convention in this package,
 * not two (RESEARCH.md Don't Hand-Roll).
 *
 * This module doubles as the RECEIVER-side helper: `verifyWebhookSignature`
 * is re-exported from `cool-astro-forms/server` so a host's own n8n/Astro
 * receiver can authenticate our outbound POSTs the same way we sign them.
 *
 * Clean-room: written fresh against the documented HMAC-timestamp pattern
 * (Stripe-style `t=,v1=` scheme), not derived from any commercial form-plugin source.
 */
import { createHmac } from 'node:crypto';
import { WEBHOOK_SIGNATURE_TOLERANCE_SEC } from '../payment-constants.js';
import { tokensMatch } from '../security/constant-time-compare.js';

function hmacHex(message: string, secret: string): string {
  return createHmac('sha256', secret).update(message).digest('hex');
}

/** Signs `payload` (the raw JSON string about to be POSTed) -> the `X-Caf-Signature` header value. */
export function signWebhookPayload(payload: string, secret: string, now: number = Date.now()): string {
  const ts = Math.floor(now / 1000);
  return `t=${ts},v1=${hmacHex(`${ts}.${payload}`, secret)}`;
}

/**
 * Parses a `t=<ts>,v1=<hex>` header into its named parts. Unrecognized
 * segments (no `=`, unknown key) are ignored; missing keys resolve
 * `undefined` — mirrors handle-abandon.ts's parseCookieValue tolerance.
 */
function parseSignatureHeader(header: string): { t?: string; v1?: string } {
  const result: { t?: string; v1?: string } = {};
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') result.t = value;
    else if (key === 'v1') result.v1 = value;
  }
  return result;
}

/**
 * Verifies an `X-Caf-Signature` header against `payload` + `secret`. Never
 * throws — a null/malformed header, a tampered payload, the wrong secret,
 * or a timestamp outside `toleranceSec` of `now` all resolve `false`.
 */
export function verifyWebhookSignature(
  payload: string,
  header: string | null | undefined,
  secret: string,
  now: number = Date.now(),
  toleranceSec: number = WEBHOOK_SIGNATURE_TOLERANCE_SEC,
): boolean {
  if (!header) return false;

  const { t: tStr, v1 } = parseSignatureHeader(header);
  if (!tStr || !v1) return false;

  const ts = Number(tStr);
  if (!Number.isFinite(ts)) return false;

  if (!tokensMatch(v1, hmacHex(`${tStr}.${payload}`, secret))) return false;

  const nowSec = Math.floor(now / 1000);
  return Math.abs(nowSec - ts) <= toleranceSec;
}
