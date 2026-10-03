/// <reference types="vite/client" />
/**
 * Conditional Cloudflare Turnstile widget loader (D3/BOT-01).
 *
 * Injected by the integration ONLY when both TURNSTILE_SITE_KEY and
 * TURNSTILE_SECRET_KEY are configured (integration.ts). Fully inert (no
 * script tag, no widget, no network call) when `window.__cafConfig`'s
 * `turnstileSiteKey` is absent — that's what keeps a keys-absent site
 * byte-identical to Phase 1 — and, from 0.1.15, on any page that has no
 * `[data-caf]` form. A form that appears later (a client:only island, a form
 * a script inserts, a ClientRouter navigation) loads the script then.
 *
 * Renders one explicit-mode widget per `[data-caf]` form (mirrors
 * capture.ts's own tagging convention) and forwards the minted token to
 * `capture.ts` via `setTurnstileToken()` — capture.ts attaches it to the
 * abandon payload's `_caf` envelope, and record-submission.ts's own
 * `_caf`-envelope parsing convention lets a host's submit endpoint read the
 * same token for a real-submission verifyTurnstile() call.
 *
 * Each rendered widget's id is retained so `resetWidgets()` can re-arm them
 * after capture.ts has spent a token on an abandon send (a Turnstile token
 * is single-use). That function is handed to capture.ts through
 * `setTurnstileResetter()`; capture.ts never imports this module, so the
 * dependency direction stays one-way.
 *
 * Written fresh against Cloudflare's documented explicit-rendering API
 * (developers.cloudflare.com/turnstile) — clean-room, not derived from any
 * commercial form-plugin source.
 */
import { setTurnstileResetter, setTurnstileToken } from './capture.js';

interface TurnstileRenderOptions {
  sitekey: string;
  callback?: (token: string) => void;
  'error-callback'?: () => void;
  'refresh-expired'?: 'auto' | 'manual' | 'never';
}

declare global {
  interface Window {
    turnstile?: {
      render: (container: string | HTMLElement, options: TurnstileRenderOptions) => string;
      /** Re-arms a widget so it issues a fresh token. Added to the global by api.js. */
      reset?: (widget?: string | HTMLElement) => void;
    };
  }
}

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
const SCRIPT_MARKER_ATTR = 'data-caf-turnstile-script';
const WIDGET_MARKER_ATTR = 'data-caf-turnstile';
const ONLOAD_CALLBACK_NAME = '__cafTurnstileOnload';

/**
 * Ids of the widgets this module rendered, in render order. Cloudflare's
 * `reset()` takes a widget id and, with no argument, only touches the first
 * widget on the page — a site with a widget per form needs every id.
 */
const widgetIds: string[] = [];

/**
 * Re-arms every widget this module rendered, so each issues a fresh token
 * after capture.ts spent the last one on an abandon send. Safe to call on a
 * page whose widgets have not loaded (or an api.js build without `reset`):
 * it simply does nothing. Individual failures are swallowed so one broken
 * widget cannot stop the rest from re-arming.
 *
 * Exported for tests and for a host that wants to re-arm by hand; the normal
 * caller is capture.ts via the resetter registered below.
 */
export function resetWidgets(): void {
  const reset = window.turnstile?.reset;
  if (!reset) return;
  for (const id of widgetIds) {
    try {
      reset(id);
    } catch {
      // one uncooperative widget must not strand the others
    }
  }
}

/** Test-only: forgets the rendered widgets so cases do not inherit each other's. */
export function resetWidgetRegistry(): void {
  widgetIds.length = 0;
}

/**
 * Renders one Turnstile widget per `[data-caf]` form that doesn't already
 * have one. No-ops (does not throw) when `window.turnstile` hasn't finished
 * loading yet — the script's own onload callback re-invokes this once ready.
 */
export function renderWidgets(sitekey: string): void {
  const turnstile = window.turnstile;
  if (!turnstile) return;

  const forms = document.querySelectorAll<HTMLFormElement>('[data-caf]');
  forms.forEach((form) => {
    if (form.querySelector(`[${WIDGET_MARKER_ATTR}]`)) return; // already rendered — idempotent

    const container = document.createElement('div');
    container.setAttribute(WIDGET_MARKER_ATTR, '');
    // The challenge must sit ABOVE the submit control — below it, visitors
    // hit Submit before ever seeing the widget. A typeless <button> inside a
    // form is an implicit submit, so it counts too.
    const submit = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
    if (submit) {
      submit.parentNode?.insertBefore(container, submit);
    } else {
      form.appendChild(container);
    }

    const widgetId = turnstile.render(container, {
      sitekey,
      callback: setTurnstileToken,
      // Pinned (documented default): re-arm in place when the ~300s token
      // dies, and re-fire callback so the staged token stays fresh. Orthogonal
      // to the explicit reset() below — that one handles a token this page
      // SPENT, not one that timed out.
      'refresh-expired': 'auto',
    });

    // Registering only after a real render is what keeps a keys-absent or
    // form-less page from ever handing capture.ts a resetter to call.
    if (typeof widgetId === 'string' && widgetId !== '') widgetIds.push(widgetId);
    setTurnstileResetter(resetWidgets);
  });
}

function loadScript(sitekey: string): void {
  if (document.querySelector(`script[${SCRIPT_MARKER_ATTR}]`)) return; // already injected — idempotent

  (window as unknown as Record<string, () => void>)[ONLOAD_CALLBACK_NAME] = () => renderWidgets(sitekey);

  const script = document.createElement('script');
  script.src = `${SCRIPT_SRC}?onload=${ONLOAD_CALLBACK_NAME}&render=explicit`;
  script.async = true;
  script.defer = true;
  script.setAttribute(SCRIPT_MARKER_ATTR, '');
  document.head.appendChild(script);
}

/** Set while a form-less page waits for its first `[data-caf]` form. */
let formWatch: MutationObserver | undefined;

/** Test-only: stops waiting for a form so cases do not inherit each other's observer. */
export function stopFormWatch(): void {
  formWatch?.disconnect();
  formWatch = undefined;
}

/**
 * Inert (no script tag injected, no widget rendered) unless
 * `window.__cafConfig.turnstileSiteKey` is present — which the integration
 * only ever sets when BOTH TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY are
 * configured on the host (BOT-01) — AND the page has a `[data-caf]` form
 * (0.1.15: the script used to load on every page of the site).
 *
 * With no form yet, it watches the DOM and loads the script when the first
 * `[data-caf]` form appears, then stops watching. api.js's onload pass
 * renders a widget into every form present by then, so a client-rendered
 * form still gets one, as it did when the script loaded on every page.
 * SSR-guarded.
 */
export function init(): void {
  if (typeof document === 'undefined') return;
  const siteKey = window.__cafConfig?.turnstileSiteKey;
  if (!siteKey) return;
  if (document.querySelector('[data-caf]')) {
    loadScript(siteKey);
    return;
  }
  if (formWatch || typeof MutationObserver === 'undefined') return;
  formWatch = new MutationObserver(() => {
    if (!document.querySelector('[data-caf]')) return;
    stopFormWatch();
    loadScript(siteKey);
  });
  formWatch.observe(document.documentElement, { childList: true, subtree: true });
}

init();
