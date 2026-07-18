/**
 * DEV-ONLY demo-data seeder (05-06, ROLL-01 living-docs SC2). Mirrors
 * `debug-entries.ts`/`debug-recovery.ts`'s gating posture (`import.meta.env.DEV`
 * + localhost-only, dead-code-eliminated from production builds). NEVER
 * shipped as part of the package — playground-only tooling.
 *
 * `/forms-admin` is genuinely empty on a fresh checkout (nobody has typed
 * into the demo form yet), which makes a first-time visitor's admin tour a
 * tour of empty tables. `?action=seed` populates a handful of REALISTIC
 * entries by driving the package's own real routes exactly like a browser
 * would — one real fetch POST per abandoned entry to `/api/forms/abandon`
 * (the same endpoint capture.ts calls on a real exit-intent/tab-close), and
 * one real fetch POST to this playground's own `/api/upload` (the PKG-03
 * adoption-reference endpoint) for a converted entry — never a raw SQLite
 * write. Reuse the EXISTING `/api/debug-entries?action=reset` to clear.
 */
import type { APIRoute } from 'astro';

export const prerender = false;

function isLocalhost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

interface SeedAbandon {
  visitorUuid: string;
  fields: Record<string, string>;
  lastField: string;
  journey: Array<{ url: string; title: string; ts: number }>;
}

/** Three representative abandoned visitors — one email-gated, one phone-gated (ABND-02's `email-or-phone`), one mid-fill. */
function seedAbandons(now: number): SeedAbandon[] {
  return [
    {
      visitorUuid: crypto.randomUUID(),
      fields: { name: 'Sarah Chen', email: 'sarah.chen@example.com', details: 'Need a quote for a 3-page site redesign' },
      lastField: 'details',
      journey: [
        { url: '/', title: 'cool-astro-forms playground', ts: now - 45_000 },
        { url: '/two', title: 'Page two', ts: now - 20_000 },
      ],
    },
    {
      visitorUuid: crypto.randomUUID(),
      fields: { name: 'Marcus Webb', phone: '+1-555-0134' },
      lastField: 'phone',
      journey: [{ url: '/', title: 'cool-astro-forms playground', ts: now - 15_000 }],
    },
    {
      visitorUuid: crypto.randomUUID(),
      fields: { name: 'Priya Nair', email: 'priya.nair@example.com' },
      lastField: 'email',
      journey: [
        { url: '/', title: 'cool-astro-forms playground', ts: now - 90_000 },
        { url: '/plain', title: 'cool-astro-forms playground — plain', ts: now - 60_000 },
        { url: '/', title: 'cool-astro-forms playground', ts: now - 30_000 },
      ],
    },
  ];
}

export const GET: APIRoute = async ({ url }) => {
  if (!import.meta.env.DEV) return new Response(null, { status: 404 });
  if (!isLocalhost(url.hostname)) return new Response(null, { status: 404 });

  if (url.searchParams.get('action') !== 'seed') {
    return json(400, { error: 'unknown action — use ?action=seed (reset via /api/debug-entries?action=reset)' });
  }

  const origin = url.origin;
  const now = Date.now();
  const created: Array<{ kind: 'abandoned' | 'converted'; status: number; body: unknown }> = [];

  // Real abandon POSTs — same endpoint/Origin/shape capture.ts sends, so
  // this exercises the actual gate/dedupe/journey/notify pipeline, not a
  // synthetic DB row.
  for (const entry of seedAbandons(now)) {
    const res = await fetch(`${origin}/api/forms/abandon`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({
        siteId: 'playground',
        formId: 'demo',
        visitorUuid: entry.visitorUuid,
        fields: entry.fields,
        lastField: entry.lastField,
        journey: entry.journey,
      }),
    });
    created.push({ kind: 'abandoned', status: res.status, body: await res.json().catch(() => null) });
  }

  // One converted entry — a real POST to THIS playground's own /api/upload
  // (the PKG-03 host-adoption reference endpoint), the same call a browser
  // submit fires.
  const convertRes = await fetch(`${origin}/api/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: {
        name: 'James Okafor',
        email: 'james.okafor@example.com',
        phone: '+1-555-0198',
        details: 'Ready to move forward — please send the contract.',
        confirmed: 'yes',
      },
    }),
  });
  created.push({ kind: 'converted', status: convertRes.status, body: await convertRes.json().catch(() => null) });

  return json(200, { seeded: created.length, results: created });
};
