/// <reference types="vite/client" />
/**
 * Standalone lead-recovery widget (RCV-01/D3).
 *
 * Injected by the integration ONLY when `config.recovery.enabled` is true
 * (04-08) — a SEPARATE entry/chunk from capture.js + journey.js, mirroring
 * turnstile-loader.ts's pattern, so its bytes never count against the
 * capture+journey gzip budget. Fully inert (no DOM added, no listener
 * bound) when `window.__cafConfig.recovery.enabled` is absent/false.
 *
 * Two responsibilities, gated by `window.__cafConfig.recovery`:
 *  1. Always (when enabled): bind a `caf:recovery-saved` listener and render
 *     a "progress saved" toast when it fires. capture.ts's own
 *     transmitReadingSaved() dispatches that event ONLY after reading a real
 *     `{saved:true}` fetch response (the RCV-01 eng lock) — the toast never
 *     claims a save the server didn't confirm. This listener stays SITE-LEVEL
 *     (not per-form): `caf:recovery-saved` can only ever originate from a
 *     recovery-active form's fetch path (capture.ts gates that per-form via
 *     04-10's `recoveryActive`), so there is nothing for the toast itself to
 *     re-gate per form.
 *  2. Only in `consentMode:'checkbox'`: inject an opt-in checkbox on EVERY
 *     `[data-caf]` form whose id is NOT listed in `recovery.disabledForms`
 *     (04-10 gap closure — RCV-01/ROADMAP Phase 4 SC4 "per-form flag"),
 *     wiring its `change` event to `capture.ts`'s `setRecoveryConsent()`.
 *
 * Written fresh against MDN CustomEvent/DOM specs — clean-room, not derived
 * from any WPForms source (no WPForms precedent exists for recovery).
 */
import * as capture from './capture.js';

const TOAST_MARKER_ATTR = 'data-caf-recovery-toast';
const TOAST_MESSAGE = "Your progress is saved — we'll email you a link to finish.";
const CHECKBOX_MARKER_ATTR = 'data-caf-recovery-checkbox';
const CHECKBOX_LABEL_TEXT = "Email me a link to finish this form if I don't complete it now.";
const SAVED_EVENT = 'caf:recovery-saved';

/**
 * Renders the "progress saved" toast — idempotent (a query for the marker
 * attribute skips re-render if one is already visible, so a second
 * caf:recovery-saved dispatch never stacks a duplicate). Zero-dependency
 * vanilla DOM; dismissible via a close button.
 */
function renderToast(): void {
  if (document.querySelector(`[${TOAST_MARKER_ATTR}]`)) return;

  const toast = document.createElement('div');
  toast.setAttribute(TOAST_MARKER_ATTR, '');
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');

  const message = document.createElement('span');
  message.textContent = TOAST_MESSAGE;
  toast.appendChild(message);

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.setAttribute('aria-label', 'Dismiss');
  dismiss.textContent = '×';
  dismiss.addEventListener('click', () => toast.remove());
  toast.appendChild(dismiss);

  document.body.appendChild(toast);
}

let toastListenerRegistered = false;

/** Idempotent — a second call is a no-op (mirrors capture.ts's bindGlobalTriggersOnce). */
function bindToastListenerOnce(): void {
  if (toastListenerRegistered) return;
  toastListenerRegistered = true;
  document.addEventListener(SAVED_EVENT, renderToast);
}

/**
 * Injects a labeled opt-in checkbox on `form`, wired to
 * `capture.ts`'s setRecoveryConsent(). Idempotent (a query for the marker
 * attribute skips re-injection on a repeat init() call, e.g. the
 * astro:page-load rebind). `data-caf-ignore` keeps stageFields() from ever
 * staging this control as a regular submitted field — consent rides the
 * dedicated `recoveryOptIn` payload key instead.
 */
function injectCheckbox(form: HTMLFormElement): void {
  if (form.querySelector(`[${CHECKBOX_MARKER_ATTR}]`)) return;

  const wrapper = document.createElement('label');
  wrapper.setAttribute(CHECKBOX_MARKER_ATTR, '');

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.setAttribute('data-caf-ignore', '');
  checkbox.addEventListener('change', () => capture.setRecoveryConsent(checkbox.checked));

  const text = document.createElement('span');
  text.textContent = CHECKBOX_LABEL_TEXT;

  wrapper.appendChild(checkbox);
  wrapper.appendChild(text);

  // Mirrors turnstile-loader.ts's placement convention: above the submit
  // control, so a visitor sees the opt-in before ever reaching Submit.
  const submit = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
  if (submit) {
    submit.parentNode?.insertBefore(wrapper, submit);
  } else {
    form.appendChild(wrapper);
  }
}

/**
 * Inert (no DOM added, no listener bound) unless
 * `window.__cafConfig.recovery.enabled` is true — which the integration only
 * ever sets when the host configures `recovery.enabled` (RCV-01/D3). In
 * `consentMode:'checkbox'`, also injects the opt-in checkbox on every
 * `[data-caf]` form NOT listed in `recovery.disabledForms` (04-10 per-form
 * gap closure). SSR-guarded. Idempotent — safe to call repeatedly (e.g.
 * from the astro:page-load rebind below).
 */
export function init(): void {
  if (typeof document === 'undefined') return;

  const recovery = window.__cafConfig?.recovery;
  if (!recovery?.enabled) return;

  bindToastListenerOnce();

  if (recovery.consentMode === 'checkbox') {
    const forms = document.querySelectorAll<HTMLFormElement>('[data-caf]');
    forms.forEach((form) => {
      const formId = form.getAttribute('data-caf');
      if (formId && recovery.disabledForms?.includes(formId)) return;
      injectCheckbox(form);
    });
  }
}

let pageLoadListenerRegistered = false;

function registerPageLoadListener(): void {
  if (pageLoadListenerRegistered) return;
  pageLoadListenerRegistered = true;
  document.addEventListener('astro:page-load', init);
}

init();
registerPageLoadListener();
