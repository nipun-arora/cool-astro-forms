/// <reference types="vite/client" />
/**
 * Client field-capture + abandon-payload transport (ABND-01).
 *
 * Written fresh against MDN Navigator.sendBeacon / Fetch keepalive / DOM
 * event specs — clean-room, not derived from WPForms source.
 *
 * This file's pure logic (stageFields, buildAbandonPayload, shouldSend) is
 * unit-tested directly in jsdom. The DOM wiring (four abandon triggers,
 * sendBeacon/keepalive transport, submit lifecycle, window.caf API) is
 * real-browser-event-dependent and is proven by the Playwright drill in
 * Plan 09 (jsdom cannot faithfully fire beforeunload/visibilitychange).
 */
import { FIELD_MAX_BYTES, MAX_PAYLOAD_BYTES } from '../limits.js';
import { CAF_FIELD_NAME, CLIENT_API_GLOBAL, HONEYPOT_FIELD_NAME } from '../types.js';
import type { AbandonPayload, CafClientApi, JourneyStep } from '../types.js';
import type { CafClientConfig } from './journey.js';
import { clearTrail, readTrail } from './journey.js';
import { getOrCreateVisitorUuid, grantConsent, isCaptureAllowed } from './visitor.js';

/** Max one send per this many ms (ABND-01). */
export const THROTTLE_MS = 10_000;
/** A plain DOM submit pauses capture for this long rather than clearing it (D4/SIG-01). */
export const SUBMIT_PAUSE_MS = 30_000;

const DEFAULT_DENY_PATTERN = /csrf|token|card|cvv|ssn|password/i;

// ---------------------------------------------------------------------------
// Turnstile token holder (D3/BOT-01) — set by turnstile-loader.ts's widget
// callback once a token is minted; read by attemptSend() below. Stays
// undefined on a keys-absent site (the loader never runs), which is what
// keeps abandon payloads byte-identical to Phase 1 in that case.
// ---------------------------------------------------------------------------

let currentTurnstileToken: string | undefined;

/** Called by turnstile-loader.ts's widget callback when a token is minted. */
export function setTurnstileToken(token: string): void {
  currentTurnstileToken = token || undefined;
}

// ---------------------------------------------------------------------------
// Recovery consent + fetch-reads-{saved} seam (RCV-01/D3, per-form 04-10
// gap closure) — mirrors the turnstile token holder above. `recoveryOptIn`
// is set by recovery-widget.ts's checkbox handler (consentMode:'checkbox'
// only) and rides an abandon payload ONLY for a form whose
// `state.recoveryActive` is true — a disabled form must never ship a
// stray opt-in the server would ignore anyway. `recoveryActive` is
// resolved PER FORM in bindForm() below from window.__cafConfig.recovery:
// active when the site-wide switch is on AND the form's id is not listed
// in `recovery.disabledForms`. An active form swaps attemptSend's
// transport from the sendBeacon-first transmit() to transmitReadingSaved()
// below, which is the ONLY path that satisfies the RCV-01 eng lock (the
// widget's "progress saved" toast must be driven by a REAL fetch response,
// never a fire-and-forget beacon that can't be read). A recovery-off
// site/form never activates, which is what keeps the sendBeacon path
// byte-identical to Phase 3.
// ---------------------------------------------------------------------------

let recoveryOptIn: boolean | undefined;

/** Called by recovery-widget.ts's checkbox handler in consentMode:'checkbox'. */
export function setRecoveryConsent(optIn: boolean): void {
  recoveryOptIn = optIn;
}

// ---------------------------------------------------------------------------
// Byte-safe helpers
// ---------------------------------------------------------------------------

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function truncateToBytes(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= maxBytes) return value;
  return new TextDecoder().decode(bytes.slice(0, maxBytes));
}

function getElementValue(el: Element): string | undefined {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    return el.value;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// stageFields — capture-safety rules (T-01-43)
// ---------------------------------------------------------------------------

export interface StageFieldsOptions {
  allow?: string[];
  deny?: string[];
}

/**
 * Collects named field values into a plain object. Never stages: the
 * honeypot input, the `_caf` envelope input, `input[type=password]`,
 * `[data-caf-ignore]` elements, or names matching the built-in denylist
 * (csrf/token/card/cvv/ssn/password) or `opts.deny`. When `opts.allow` is
 * present, ONLY listed names stage. Each value is truncated to
 * FIELD_MAX_BYTES.
 */
export function stageFields(form: HTMLFormElement, opts: StageFieldsOptions = {}): Record<string, string> {
  const staged: Record<string, string> = {};
  const elements = Array.from(form.elements) as Element[];

  for (const el of elements) {
    const name = el.getAttribute('name');
    if (!name) continue;
    if (name === HONEYPOT_FIELD_NAME || name === CAF_FIELD_NAME) continue;
    if (el instanceof HTMLInputElement && el.type === 'password') continue;
    if (el.hasAttribute('data-caf-ignore')) continue;

    if (opts.allow && opts.allow.length > 0) {
      if (!opts.allow.includes(name)) continue;
    } else {
      if (opts.deny?.includes(name)) continue;
      if (DEFAULT_DENY_PATTERN.test(name)) continue;
    }

    const value = getElementValue(el);
    if (value === undefined) continue;
    staged[name] = truncateToBytes(value, FIELD_MAX_BYTES);
  }

  return staged;
}

/** Reads the honeypot input's current value; empty string if the form has none. */
export function readHoneypot(form: HTMLFormElement): string {
  const el = form.elements.namedItem(HONEYPOT_FIELD_NAME);
  if (el instanceof HTMLInputElement) return el.value;
  return '';
}

// ---------------------------------------------------------------------------
// buildAbandonPayload — journey-drop-then-minimal-payload (Pitfall 4, T-01-18)
// ---------------------------------------------------------------------------

export interface BuildAbandonPayloadInput {
  siteId: string;
  formId: string;
  visitorUuid: string;
  fields: Record<string, unknown>;
  journey: JourneyStep[];
  pageUrl?: string;
  referrer?: string;
  honeypot?: string;
  /** Name of the last field the visitor edited (ANLY-01 D1) — never a honeypot/_caf/denylisted name. */
  lastField?: string;
  /**
   * Lead-recovery checkbox-mode opt-in (RCV-01/D3) — set via
   * setRecoveryConsent(). Rides EVERY payload shape (full + minimal) since
   * consent must never get dropped by size trimming; undefined omits the
   * key from the serialized JSON (byte-identical when unset).
   */
  recoveryOptIn?: boolean;
}

function payloadBytes(payload: AbandonPayload): number {
  return byteLength(JSON.stringify(payload));
}

function buildMinimalPayload(input: BuildAbandonPayloadInput): AbandonPayload {
  const minimalFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.fields)) {
    if (/email|phone|tel/i.test(key)) minimalFields[key] = value;
  }
  return {
    siteId: input.siteId,
    formId: input.formId,
    visitorUuid: input.visitorUuid,
    fields: minimalFields,
    honeypot: input.honeypot,
    lastField: input.lastField,
    recoveryOptIn: input.recoveryOptIn,
  };
}

/**
 * Builds the wire AbandonPayload. If the serialized payload would exceed
 * MAX_PAYLOAD_BYTES, drops oldest journey steps first; if STILL over margin
 * with the journey fully dropped, falls back to a minimal payload (ids +
 * visitor uuid + email/phone-only contact fields) — never
 * attempt-and-silently-fail against the browser's 64KB beacon ceiling.
 */
export function buildAbandonPayload(input: BuildAbandonPayloadInput): AbandonPayload {
  let journey = input.journey.slice();
  let payload: AbandonPayload = {
    siteId: input.siteId,
    formId: input.formId,
    visitorUuid: input.visitorUuid,
    fields: input.fields,
    journey,
    pageUrl: input.pageUrl,
    referrer: input.referrer,
    honeypot: input.honeypot,
    lastField: input.lastField,
    recoveryOptIn: input.recoveryOptIn,
  };

  while (journey.length > 0 && payloadBytes(payload) > MAX_PAYLOAD_BYTES) {
    journey = journey.slice(1);
    payload = { ...payload, journey };
  }

  if (payloadBytes(payload) > MAX_PAYLOAD_BYTES) {
    payload = buildMinimalPayload(input);
  }

  return payload;
}

// ---------------------------------------------------------------------------
// shouldSend — throttle + submit-pause gate (D4)
// ---------------------------------------------------------------------------

export interface ShouldSendState {
  lastSendAt: number;
  /** Timestamp the submit pause started, or null when none is active. */
  submitInFlightAt: number | null;
}

/**
 * False within THROTTLE_MS of the last send. False while a submit pause is
 * active — `submitInFlightAt` is a timestamp that auto-expires after
 * SUBMIT_PAUSE_MS so a failed AJAX submit leaves the visitor capturable
 * again (D4). True otherwise.
 */
export function shouldSend(state: ShouldSendState, now: number): boolean {
  if (state.submitInFlightAt !== null && now - state.submitInFlightAt < SUBMIT_PAUSE_MS) {
    return false;
  }
  if (now - state.lastSendAt < THROTTLE_MS) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// DOM wiring — four abandon triggers + sendBeacon/keepalive transport +
// submit lifecycle + window.caf API. Real-browser-event-dependent; proven by
// the Plan 09 Playwright drill (jsdom cannot faithfully fire beforeunload /
// visibilitychange — RESEARCH Pitfall 5).
// ---------------------------------------------------------------------------

/** Slashless fallback for playground/back-compat use when window.__cafConfig
 * hasn't been injected (or predates abandonEndpoint) — matches the
 * integration's own trailingSlash:'never'/'ignore' default. */
const DEFAULT_ABANDON_ENDPOINT = '/api/forms/abandon';

/**
 * The integration computes this from the host's `trailingSlash` config and
 * injects it via `window.__cafConfig.abandonEndpoint` — required for hosts
 * with `trailingSlash: 'always'`, where a slashless POST never
 * reaches the injected route handler.
 */
function getAbandonEndpoint(): string {
  return (typeof window !== 'undefined' && window.__cafConfig?.abandonEndpoint) || DEFAULT_ABANDON_ENDPOINT;
}

/**
 * Present only once the integration ships `startedEndpoint` (P07/ANLY-01) —
 * unlike abandonEndpoint there is no slashless fallback: an absent
 * startedEndpoint means the host hasn't shipped this yet, and the ping
 * simply stays dormant (never a guessed default URL).
 */
function getStartedEndpoint(): string | undefined {
  return typeof window !== 'undefined' ? window.__cafConfig?.startedEndpoint : undefined;
}

interface FormCaptureState {
  form: HTMLFormElement;
  formId: string;
  siteId: string;
  fields: Record<string, string>;
  /** Name of the most recently edited staged field (ANLY-01 D1) — never a honeypot/_caf/denylisted name. */
  lastField?: string;
  /** Once true, sendFormStarted() never attempts another ping for this bound form (ANLY-01 D1). */
  startedSent: boolean;
  lastSendAt: number;
  submitInFlightAt: number | null;
  allow?: string[];
  deny?: string[];
  /** Per-form recovery gate (RCV-01/D3, 04-10) — resolved once in bindForm() from __cafConfig.recovery. */
  recoveryActive: boolean;
  unbindFns: Array<() => void>;
}

// ---------------------------------------------------------------------------
// form_started ping (ANLY-01 D1) — sendBeacon to startedEndpoint on the first
// qualifying input into a tagged form, once per visitor+form (an in-memory
// per-form flag for the current page load + a localStorage guard so a
// reload doesn't double-count). Idempotent server-side too
// (recordFormStart is INSERT OR IGNORE), so a missed/duplicate guard write
// is never a correctness bug, only a redundant no-op ping.
// ---------------------------------------------------------------------------

function formStartedGuardKey(siteId: string, formId: string): string {
  return `_caf_started_${siteId}_${formId}`;
}

function sendFormStarted(state: FormCaptureState): void {
  if (state.startedSent) return;
  state.startedSent = true;

  const endpoint = getStartedEndpoint();
  if (!endpoint) return;

  const guardKey = formStartedGuardKey(state.siteId, state.formId);
  try {
    if (typeof localStorage !== 'undefined') {
      if (localStorage.getItem(guardKey) === '1') return;
      localStorage.setItem(guardKey, '1');
    }
  } catch {
    // best-effort guard only — worst case one redundant idempotent ping
  }

  const body = JSON.stringify({ siteId: state.siteId, formId: state.formId, visitorUuid: getOrCreateVisitorUuid() });
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon(endpoint, new Blob([body], { type: 'application/json' }));
      return;
    }
  } catch {
    // fall through to fetch
  }
  try {
    fetch(endpoint, { method: 'POST', body, keepalive: true, headers: { 'Content-Type': 'application/json' } }).catch(
      () => undefined,
    );
  } catch {
    // best-effort, never throws
  }
}

const formStates = new Map<string, FormCaptureState>();

let globalTriggersBound = false;
let configRetryRegistered = false;
let pageLoadListenerRegistered = false;

function transmit(payload: AbandonPayload): void {
  const endpoint = getAbandonEndpoint();
  const body = JSON.stringify(payload);
  let queued = false;

  try {
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const blob = new Blob([body], { type: 'application/json' });
      queued = navigator.sendBeacon(endpoint, blob);
    }
  } catch {
    queued = false;
  }

  if (queued) return;

  const warnBothFailed = (): void => {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.warn('[cool-astro-forms] abandon payload failed to send (sendBeacon + fetch keepalive both failed)');
    }
  };

  try {
    fetch(endpoint, {
      method: 'POST',
      body,
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
    }).catch(warnBothFailed);
  } catch {
    warnBothFailed();
  }
}

/**
 * RCV-01 eng lock: the recovery widget's "progress saved" toast must be
 * driven by a REAL server response, never a fire-and-forget beacon that
 * can't be read — so this is used ONLY when recoveryActive, in place of
 * transmit()'s sendBeacon-first path. Posts via fetch (keepalive) and, on a
 * JSON `{saved:true}` response body, dispatches `caf:recovery-saved` for
 * recovery-widget.ts to render the toast. Never throws; a network failure,
 * a rejected save, or a non-JSON response simply renders no toast.
 */
function transmitReadingSaved(payload: AbandonPayload): void {
  const endpoint = getAbandonEndpoint();
  const body = JSON.stringify(payload);

  try {
    fetch(endpoint, {
      method: 'POST',
      body,
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
    })
      .then((res) => res.json())
      .then((data: unknown) => {
        const saved = typeof data === 'object' && data !== null && (data as { saved?: unknown }).saved === true;
        if (saved) document.dispatchEvent(new CustomEvent('caf:recovery-saved'));
      })
      .catch(() => undefined);
  } catch {
    // best-effort — a thrown fetch() call simply means no toast renders
  }
}

function attemptSend(state: FormCaptureState, now: number): void {
  if (!shouldSend({ lastSendAt: state.lastSendAt, submitInFlightAt: state.submitInFlightAt }, now)) return;

  // D3/BOT-01: attach the minted Turnstile token into the payload's _caf
  // envelope ONLY when one exists — a keys-absent site never calls
  // setTurnstileToken(), so `fields` here stays byte-identical to `state.fields`.
  const fields = currentTurnstileToken
    ? { ...state.fields, [CAF_FIELD_NAME]: JSON.stringify({ turnstileToken: currentTurnstileToken }) }
    : state.fields;

  const payload = buildAbandonPayload({
    siteId: state.siteId,
    formId: state.formId,
    visitorUuid: getOrCreateVisitorUuid(),
    fields,
    journey: readTrail(),
    pageUrl: location.href,
    referrer: document.referrer,
    honeypot: readHoneypot(state.form),
    lastField: state.lastField,
    recoveryOptIn: state.recoveryActive ? recoveryOptIn : undefined,
  });

  // Setting lastSendAt BEFORE transmit, shared by every trigger, is what
  // keeps visibilitychange + beforeunload from double-sending when both
  // fire in quick succession during a single abandon (mobile backgrounding
  // followed immediately by tab close, for example).
  state.lastSendAt = now;
  if (state.recoveryActive) {
    transmitReadingSaved(payload);
  } else {
    transmit(payload);
  }
}

function sendAllForms(): void {
  const now = Date.now();
  for (const state of formStates.values()) {
    attemptSend(state, now);
  }
}

function isLeavingLinkClick(event: MouseEvent): boolean {
  const target = event.target;
  if (!(target instanceof Element)) return false;
  const anchor = target.closest('a[href]');
  if (!anchor) return false;
  const href = anchor.getAttribute('href');
  if (!href || href.startsWith('#') || href.startsWith('javascript:')) return false;
  return true;
}

function handleExitIntent(event: MouseEvent): void {
  if (event.clientY > 0) return;
  sendAllForms();
}

function handleLinkClick(event: MouseEvent): void {
  if (!isLeavingLinkClick(event)) return;
  sendAllForms();
}

function handleBeforeUnload(): void {
  sendAllForms();
}

function handleVisibilityChange(): void {
  if (document.visibilityState === 'hidden') sendAllForms();
}

function bindGlobalTriggersOnce(): void {
  if (globalTriggersBound) return;
  globalTriggersBound = true;
  document.addEventListener('mouseleave', handleExitIntent);
  document.addEventListener('click', handleLinkClick, true);
  window.addEventListener('beforeunload', handleBeforeUnload);
  document.addEventListener('visibilitychange', handleVisibilityChange);
}

function ensureEnvelopeInput(form: HTMLFormElement): HTMLInputElement {
  const existing = form.elements.namedItem(CAF_FIELD_NAME);
  if (existing instanceof HTMLInputElement) return existing;
  const input = document.createElement('input');
  input.type = 'hidden';
  input.name = CAF_FIELD_NAME;
  form.appendChild(input);
  return input;
}

function createSubmitHandler(state: FormCaptureState): (event: Event) => void {
  return () => {
    // Machine-data envelope rides inside the host's own submit payload,
    // reaching recordSubmission() as fields._caf (pinned wire format).
    const envelope = ensureEnvelopeInput(state.form);
    envelope.value = JSON.stringify({ journey: readTrail() });

    // A plain DOM submit only PAUSES capture (~30s) — it does NOT clear
    // staged data or the journey trail. That happens only via the explicit
    // window.caf.submitted() success signal (SIG-01/D4), so a failed AJAX
    // submit leaves the visitor capturable again.
    state.submitInFlightAt = Date.now();
  };
}

function unbindForm(state: FormCaptureState): void {
  for (const unbind of state.unbindFns) unbind();
  state.unbindFns = [];
}

function bindForm(form: HTMLFormElement, formId: string, config: CafClientConfig): void {
  const formCaptureConfig = config.forms?.[formId]?.capture;

  const state: FormCaptureState = {
    form,
    formId,
    siteId: config.siteId ?? '',
    fields: {},
    startedSent: false,
    lastSendAt: 0,
    submitInFlightAt: null,
    allow: formCaptureConfig?.allow,
    deny: formCaptureConfig?.deny,
    recoveryActive: config.recovery?.enabled === true && !config.recovery.disabledForms?.includes(formId),
    unbindFns: [],
  };

  const handleFieldEvent = (event: Event): void => {
    state.fields = stageFields(form, { allow: state.allow, deny: state.deny });
    const name = event.target instanceof Element ? event.target.getAttribute('name') : null;
    if (name && name in state.fields) state.lastField = name;
    sendFormStarted(state);
  };
  form.addEventListener('input', handleFieldEvent);
  form.addEventListener('change', handleFieldEvent);
  state.unbindFns.push(() => form.removeEventListener('input', handleFieldEvent));
  state.unbindFns.push(() => form.removeEventListener('change', handleFieldEvent));

  const submitHandler = createSubmitHandler(state);
  // Capture-phase, bound as early as init() runs (module load), so it fires
  // ahead of the host's own bubble-phase submit handler wherever possible.
  form.addEventListener('submit', submitHandler, true);
  state.unbindFns.push(() => form.removeEventListener('submit', submitHandler, true));

  formStates.set(formId, state);
}

/**
 * Idempotent bootstrap: no-ops when no `[data-caf]` form is present (this is
 * what makes injectScript('page') safe sitewide). Defensively no-ops and
 * retries on DOMContentLoaded when `window.__cafConfig` hasn't run yet
 * rather than throwing. Skips forms already bound (safe to call repeatedly,
 * e.g. from `window.caf.consentGranted()` or the astro:page-load rebind).
 */
export function init(): void {
  if (typeof document === 'undefined') return;

  const forms = document.querySelectorAll<HTMLFormElement>('[data-caf]');
  if (forms.length === 0) return;

  const config = window.__cafConfig;
  if (!config) {
    if (!configRetryRegistered) {
      configRetryRegistered = true;
      document.addEventListener('DOMContentLoaded', init, { once: true });
    }
    return;
  }

  bindGlobalTriggersOnce();

  forms.forEach((form) => {
    const formId = form.getAttribute('data-caf');
    if (!formId) return;
    if (formStates.has(formId)) return; // already bound — idempotent

    const requireConsent = config.requireConsent === true;
    if (!isCaptureAllowed({ requireConsent })) return;

    bindForm(form, formId, config);
  });
}

function clearFormState(state: FormCaptureState): void {
  unbindForm(state);
  formStates.delete(state.formId);
}

/**
 * The `window.caf` client API (CLIENT_API_GLOBAL). `submitted(formId?)` is
 * the ONLY thing that clears staged capture data + the journey trail
 * (SIG-01/D4) — with a formId argument only that form's staged data and
 * bindings clear (multi-form pages); no-arg clears all.
 * `consentGranted()` idempotently (re-)runs init() once the host's consent
 * banner fires, for `requireConsent: true` sites that started dormant.
 */
const cafApi: CafClientApi = {
  submitted(formId?: string): void {
    if (formId) {
      const state = formStates.get(formId);
      if (state) clearFormState(state);
    } else {
      for (const state of formStates.values()) clearFormState(state);
    }
    clearTrail();
  },
  consentGranted(): void {
    grantConsent();
    init();
  },
};

function registerPageLoadListener(): void {
  if (pageLoadListenerRegistered) return;
  pageLoadListenerRegistered = true;
  document.addEventListener('astro:page-load', init);
}

if (typeof window !== 'undefined') {
  window[CLIENT_API_GLOBAL] = cafApi;
}

// Primary path: astro:page-load NEVER fires on sites without ClientRouter
// (any trailingSlash-strict host included), so init() must run unconditionally at module load —
// AND rebind on every View Transitions client-side navigation.
init();
registerPageLoadListener();
