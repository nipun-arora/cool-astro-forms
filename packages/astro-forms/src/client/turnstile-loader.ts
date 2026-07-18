/// <reference types="vite/client" />
/**
 * Conditional Cloudflare Turnstile widget loader (D3/BOT-01).
 *
 * Injected by the integration ONLY when both TURNSTILE_SITE_KEY and
 * TURNSTILE_SECRET_KEY are configured (integration.ts). Fully inert (no
 * script tag, no widget, no network call) when `window.__cafConfig`'s
 * `turnstileSiteKey` is absent — that's what keeps a keys-absent site
 * byte-identical to Phase 1.
 *
 * Renders one explicit-mode widget per `[data-caf]` form (mirrors
 * capture.ts's own tagging convention) and forwards the minted token to
 * `capture.ts` via `setTurnstileToken()` — capture.ts attaches it to the
 * abandon payload's `_caf` envelope, and record-submission.ts's own
 * `_caf`-envelope parsing convention lets a host's submit endpoint read the
 * same token for a real-submission verifyTurnstile() call.
 *
 * Written fresh against Cloudflare's documented explicit-rendering API
 * (developers.cloudflare.com/turnstile) — clean-room, not derived from any
 * commercial form-plugin source.
 */
import { setTurnstileToken } from './capture.js';

interface TurnstileRenderOptions {
  sitekey: string;
  callback?: (token: string) => void;
  'error-callback'?: () => void;
}

declare global {
  interface Window {
    turnstile?: {
      render: (container: string | HTMLElement, options: TurnstileRenderOptions) => string;
    };
  }
}

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
const SCRIPT_MARKER_ATTR = 'data-caf-turnstile-script';
const WIDGET_MARKER_ATTR = 'data-caf-turnstile';
const ONLOAD_CALLBACK_NAME = '__cafTurnstileOnload';

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

    turnstile.render(container, {
      sitekey,
      callback: setTurnstileToken,
    });
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

/**
 * Inert (no script tag injected, no widget rendered) unless
 * `window.__cafConfig.turnstileSiteKey` is present — which the integration
 * only ever sets when BOTH TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY are
 * configured on the host (BOT-01). SSR-guarded.
 */
export function init(): void {
  if (typeof document === 'undefined') return;
  const siteKey = window.__cafConfig?.turnstileSiteKey;
  if (!siteKey) return;
  loadScript(siteKey);
}

init();
