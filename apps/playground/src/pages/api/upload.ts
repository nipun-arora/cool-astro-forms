/**
 * The playground's OWN submit endpoint (PKG-03 adoption contract) — this is
 * the one-attribute-plus-recordSubmission-call shape a real host site
 * implements. The package never owns this route; it just records what the
 * host tells it via `recordSubmission()`.
 */
import type { APIRoute } from 'astro';
import { recordSubmission } from 'cool-astro-forms/server';

export const prerender = false;

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const raw: unknown = await request.json().catch(() => null);
  if (!raw || typeof raw !== 'object') {
    return new Response(JSON.stringify({ ok: false, error: 'invalid body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const fields = (raw as { fields?: Record<string, unknown> }).fields ?? {};

  const result = await recordSubmission({
    siteId: 'playground',
    formId: 'demo',
    fields,
    files: [],
    request,
    // GEO-01 host-adoption reference shape — a real host passes its own
    // APIRoute's clientAddress the same way.
    ip: clientAddress,
  });

  if (!result.ok) {
    return new Response(JSON.stringify({ ok: false }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ ok: true, entryId: result.entryId }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
