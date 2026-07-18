// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FIELD_MAX_BYTES, MAX_PAYLOAD_BYTES } from '../limits.js';
import { CAF_FIELD_NAME } from '../types.js';
import type { JourneyStep } from '../types.js';
import {
  buildAbandonPayload,
  init,
  readHoneypot,
  setRecoveryConsent,
  setTurnstileToken,
  shouldSend,
  stageFields,
  SUBMIT_PAUSE_MS,
  THROTTLE_MS,
} from './capture.js';

function buildForm(html: string): HTMLFormElement {
  const form = document.createElement('form');
  form.innerHTML = html;
  document.body.appendChild(form);
  return form;
}

describe('stageFields', () => {
  it('excludes the honeypot field, the _caf envelope input, password inputs, and [data-caf-ignore] elements', () => {
    const form = buildForm(`
      <input name="email" value="visitor@example.com" />
      <input name="_caf_hp" value="bot-bait" />
      <input name="_caf" value="{}" />
      <input type="password" name="pw" value="secret" />
      <input name="internalNote" value="ignored" data-caf-ignore />
    `);

    expect(stageFields(form)).toEqual({ email: 'visitor@example.com' });
  });

  it('excludes denylist-matched names case-insensitively (csrf/token/card/cvv/ssn/password)', () => {
    const form = buildForm(`
      <input name="email" value="a@b.com" />
      <input name="CSRFToken" value="abc" />
      <input name="cardNumber" value="4111" />
      <input name="cvv" value="123" />
      <input name="ssnValue" value="000" />
      <input name="userPassword" value="hunter2" />
    `);

    expect(stageFields(form)).toEqual({ email: 'a@b.com' });
  });

  it('honors a custom opts.deny list', () => {
    const form = buildForm(`<input name="email" value="a@b.com" /><input name="secretCode" value="x" />`);
    expect(stageFields(form, { deny: ['secretCode'] })).toEqual({ email: 'a@b.com' });
  });

  it('when opts.allow is present, stages ONLY the listed names', () => {
    const form = buildForm(`
      <input name="email" value="a@b.com" />
      <input name="phone" value="555-1234" />
      <input name="notes" value="anything" />
    `);
    expect(stageFields(form, { allow: ['email'] })).toEqual({ email: 'a@b.com' });
  });

  it('truncates a value longer than FIELD_MAX_BYTES', () => {
    const longValue = 'x'.repeat(FIELD_MAX_BYTES + 500);
    const form = buildForm(`<input name="notes" value="${longValue}" />`);
    const staged = stageFields(form);
    expect(new TextEncoder().encode(staged.notes!).length).toBeLessThanOrEqual(FIELD_MAX_BYTES);
  });
});

describe('readHoneypot', () => {
  it('surfaces the honeypot input value', () => {
    const form = buildForm(`<input name="_caf_hp" value="bot-bait" />`);
    expect(readHoneypot(form)).toBe('bot-bait');
  });

  it('returns an empty string when the form has no honeypot input', () => {
    const form = buildForm(`<input name="email" value="a@b.com" />`);
    expect(readHoneypot(form)).toBe('');
  });
});

describe('buildAbandonPayload', () => {
  const baseInput = {
    siteId: 'site-1',
    formId: 'form-1',
    visitorUuid: 'uuid-1',
    fields: { email: 'a@b.com' },
  };

  it('drops oldest journey steps when the serialized payload exceeds MAX_PAYLOAD_BYTES', () => {
    const journey: JourneyStep[] = Array.from({ length: 400 }, (_, i) => ({
      url: `/page-${i}`,
      title: 'x'.repeat(200),
      ts: 1_000_000 + i,
    }));

    const oversized = buildAbandonPayload({ ...baseInput, journey });
    const bytes = new TextEncoder().encode(JSON.stringify(oversized)).length;

    expect(bytes).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect(oversized.journey!.length).toBeLessThan(journey.length);
  });

  it('carries the honeypot value through to the payload', () => {
    const payload = buildAbandonPayload({ ...baseInput, journey: [], honeypot: 'bot-bait' });
    expect(payload.honeypot).toBe('bot-bait');
  });

  it('falls back to a minimal contact-only payload when fields alone (journey already empty) exceed the cap', () => {
    const hugeValue = 'y'.repeat(MAX_PAYLOAD_BYTES + 5000);
    const payload = buildAbandonPayload({
      ...baseInput,
      fields: { email: 'a@b.com', notes: hugeValue },
      journey: [],
    });

    const bytes = new TextEncoder().encode(JSON.stringify(payload)).length;
    expect(bytes).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect(payload.fields).toEqual({ email: 'a@b.com' });
    expect(payload.journey).toBeUndefined();
  });
});

describe('shouldSend', () => {
  const NOW = 1_000_000;

  it('respects the 10s throttle', () => {
    expect(shouldSend({ lastSendAt: NOW - THROTTLE_MS + 1, submitInFlightAt: null }, NOW)).toBe(false);
    expect(shouldSend({ lastSendAt: NOW - THROTTLE_MS - 1, submitInFlightAt: null }, NOW)).toBe(true);
  });

  it('blocks sends while submitInFlight is active and auto-expires after SUBMIT_PAUSE_MS', () => {
    const active = NOW - SUBMIT_PAUSE_MS + 1;
    expect(shouldSend({ lastSendAt: 0, submitInFlightAt: active }, NOW)).toBe(false);

    const expired = NOW - SUBMIT_PAUSE_MS - 1;
    expect(shouldSend({ lastSendAt: 0, submitInFlightAt: expired }, NOW)).toBe(true);
  });
});

describe('DOM wiring: init/bind/consent/submitted (Task 3)', () => {
  afterEach(() => {
    window.caf?.submitted();
    document.body.innerHTML = '';
    delete (window as unknown as { __cafConfig?: unknown }).__cafConfig;
  });

  it('no-ops when no [data-caf] element is present', () => {
    expect(() => init()).not.toThrow();
  });

  it('no-ops without throwing when window.__cafConfig is absent (form present)', () => {
    const form = buildForm(`<input name="email" />`);
    form.setAttribute('data-caf', 'form-noconfig');
    delete (window as unknown as { __cafConfig?: unknown }).__cafConfig;

    expect(() => init()).not.toThrow();
  });

  it('binds a [data-caf] form once config is present and exposes window.caf', () => {
    const form = buildForm(`<input name="email" value="a@b.com" />`);
    form.setAttribute('data-caf', 'form-a');
    window.__cafConfig = { siteId: 'site-1' };

    init();

    expect(typeof window.caf?.submitted).toBe('function');
    expect(typeof window.caf?.consentGranted).toBe('function');
  });

  it("window.caf.submitted(formId) clears only that form's bindings; other forms stay active", () => {
    const formA = buildForm(`<input name="email" value="a@example.com" />`);
    formA.setAttribute('data-caf', 'form-a');
    const formB = buildForm(`<input name="email" value="b@example.com" />`);
    formB.setAttribute('data-caf', 'form-b');
    window.__cafConfig = { siteId: 'site-1' };
    init();

    let callCount = 0;
    Object.defineProperty(navigator, 'sendBeacon', {
      value: () => {
        callCount += 1;
        return true;
      },
      configurable: true,
    });

    window.caf!.submitted('form-a');

    document.dispatchEvent(new MouseEvent('mouseleave', { clientY: 0 }));

    expect(callCount).toBe(1); // only form-b sent; form-a was unbound
  });

  it('sends the abandon payload to the fallback /api/forms/abandon endpoint when window.__cafConfig has no abandonEndpoint', () => {
    const form = buildForm(`<input name="email" value="a@example.com" />`);
    form.setAttribute('data-caf', 'form-fallback');
    window.__cafConfig = { siteId: 'site-1' };
    init();

    let sentUrl: string | undefined;
    Object.defineProperty(navigator, 'sendBeacon', {
      value: (url: string) => {
        sentUrl = url;
        return true;
      },
      configurable: true,
    });

    document.dispatchEvent(new MouseEvent('mouseleave', { clientY: 0 }));

    expect(sentUrl).toBe('/api/forms/abandon');
  });

  it("sends the abandon payload to the configured abandonEndpoint (trailing-slash variant) when window.__cafConfig sets one", () => {
    const form = buildForm(`<input name="email" value="a@example.com" />`);
    form.setAttribute('data-caf', 'form-configured');
    window.__cafConfig = { siteId: 'site-1', abandonEndpoint: '/api/forms/abandon/' };
    init();

    let sentUrl: string | undefined;
    Object.defineProperty(navigator, 'sendBeacon', {
      value: (url: string) => {
        sentUrl = url;
        return true;
      },
      configurable: true,
    });

    document.dispatchEvent(new MouseEvent('mouseleave', { clientY: 0 }));

    expect(sentUrl).toBe('/api/forms/abandon/');
  });

  it('requireConsent:true stays dormant until consentGranted(); a second call does not double-bind', () => {
    const form = buildForm(`<input name="email" value="a@example.com" />`);
    form.setAttribute('data-caf', 'form-consent');
    window.__cafConfig = { siteId: 'site-1', requireConsent: true };

    let callCount = 0;
    Object.defineProperty(navigator, 'sendBeacon', {
      value: () => {
        callCount += 1;
        return true;
      },
      configurable: true,
    });

    init();
    document.dispatchEvent(new MouseEvent('mouseleave', { clientY: 0 }));
    expect(callCount).toBe(0); // dormant — form never bound without consent

    window.caf!.consentGranted();
    window.caf!.consentGranted(); // idempotent — must not double-bind

    document.dispatchEvent(new MouseEvent('mouseleave', { clientY: 0 }));
    expect(callCount).toBe(1); // exactly one send, not two, from the single dispatch
  });
});

describe('last-edited-field tracking (ANLY-01 D1)', () => {
  afterEach(() => {
    window.caf?.submitted();
    document.body.innerHTML = '';
    delete (window as unknown as { __cafConfig?: unknown }).__cafConfig;
  });

  function captureSentBody(): { getBody: () => Promise<string | undefined> } {
    let sentBody: Blob | string | undefined;
    Object.defineProperty(navigator, 'sendBeacon', {
      value: (_url: string, body: Blob | string) => {
        sentBody = body;
        return true;
      },
      configurable: true,
    });
    return {
      getBody: async () => {
        if (sentBody === undefined) return undefined;
        return typeof sentBody === 'string' ? sentBody : await sentBody.text();
      },
    };
  }

  it('the abandon payload carries lastField as the most recently edited staged field name', async () => {
    const form = buildForm(`<input name="name" value="" /><input name="email" value="" />`);
    form.setAttribute('data-caf', 'form-lastfield');
    window.__cafConfig = { siteId: 'site-1' };
    init();

    form.querySelector('input[name="name"]')!.setAttribute('value', 'Ada');
    form.querySelector('input[name="name"]')!.dispatchEvent(new Event('input', { bubbles: true }));
    (form.querySelector('input[name="email"]') as HTMLInputElement).value = 'ada@example.com';
    form.querySelector('input[name="email"]')!.dispatchEvent(new Event('input', { bubbles: true }));

    const { getBody } = captureSentBody();
    document.dispatchEvent(new MouseEvent('mouseleave', { clientY: 0 }));

    const body = await getBody();
    const payload = JSON.parse(body!) as { lastField?: string };
    expect(payload.lastField).toBe('email');
  });

  it('never sets lastField from the honeypot, _caf envelope, or a denylisted field', async () => {
    const form = buildForm(
      `<input name="email" value="a@b.com" /><input name="_caf_hp" value="" /><input name="cardNumber" value="" />`,
    );
    form.setAttribute('data-caf', 'form-lastfield-excluded');
    window.__cafConfig = { siteId: 'site-1' };
    init();

    form.querySelector('input[name="email"]')!.dispatchEvent(new Event('input', { bubbles: true }));
    (form.querySelector('input[name="_caf_hp"]') as HTMLInputElement).value = 'bot-bait';
    form.querySelector('input[name="_caf_hp"]')!.dispatchEvent(new Event('input', { bubbles: true }));
    (form.querySelector('input[name="cardNumber"]') as HTMLInputElement).value = '4111';
    form.querySelector('input[name="cardNumber"]')!.dispatchEvent(new Event('input', { bubbles: true }));

    const { getBody } = captureSentBody();
    document.dispatchEvent(new MouseEvent('mouseleave', { clientY: 0 }));

    const body = await getBody();
    const payload = JSON.parse(body!) as { lastField?: string };
    expect(payload.lastField).toBe('email');
  });
});

describe('form_started ping (ANLY-01 D1)', () => {
  afterEach(() => {
    window.caf?.submitted();
    document.body.innerHTML = '';
    delete (window as unknown as { __cafConfig?: unknown }).__cafConfig;
    localStorage.clear();
  });

  function spySendBeacon(): { getCalls: () => Promise<Array<{ url: string; body: string }>> } {
    const raw: Array<{ url: string; body: Blob | string }> = [];
    Object.defineProperty(navigator, 'sendBeacon', {
      value: (url: string, body: Blob | string) => {
        raw.push({ url, body });
        return true;
      },
      configurable: true,
    });
    return {
      getCalls: async () =>
        Promise.all(
          raw.map(async (c) => ({ url: c.url, body: typeof c.body === 'string' ? c.body : await c.body.text() })),
        ),
    };
  }

  it('fires exactly once, on the first qualifying input, to window.__cafConfig.startedEndpoint', async () => {
    const form = buildForm(`<input name="email" value="" />`);
    form.setAttribute('data-caf', 'form-started-once');
    window.__cafConfig = { siteId: 'site-1', startedEndpoint: '/api/forms/started' };
    init();

    const { getCalls } = spySendBeacon();
    const input = form.querySelector('input[name="email"]')!;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));

    const calls = await getCalls();
    const startedCalls = calls.filter((c) => c.url === '/api/forms/started');
    expect(startedCalls.length).toBe(1);
    const body = JSON.parse(startedCalls[0]!.body) as { siteId: string; formId: string; visitorUuid: string };
    expect(body.siteId).toBe('site-1');
    expect(body.formId).toBe('form-started-once');
    expect(body.visitorUuid).toBeTruthy();
  });

  it('skips the ping entirely when window.__cafConfig has no startedEndpoint', async () => {
    const form = buildForm(`<input name="email" value="" />`);
    form.setAttribute('data-caf', 'form-started-noendpoint');
    window.__cafConfig = { siteId: 'site-1' };
    init();

    const { getCalls } = spySendBeacon();
    form.querySelector('input[name="email"]')!.dispatchEvent(new Event('input', { bubbles: true }));

    expect((await getCalls()).length).toBe(0);
  });

  it('does not re-fire on a later page load in the same browser (localStorage guard survives a fresh bind)', async () => {
    localStorage.setItem('_caf_started_site-1_form-started-guarded', '1');

    const form = buildForm(`<input name="email" value="" />`);
    form.setAttribute('data-caf', 'form-started-guarded');
    window.__cafConfig = { siteId: 'site-1', startedEndpoint: '/api/forms/started' };
    init();

    const { getCalls } = spySendBeacon();
    form.querySelector('input[name="email"]')!.dispatchEvent(new Event('input', { bubbles: true }));

    expect((await getCalls()).filter((c) => c.url === '/api/forms/started').length).toBe(0);
  });
});

describe('setTurnstileToken() — abandon payload _caf envelope attach (D3/BOT-01)', () => {
  afterEach(() => {
    window.caf?.submitted();
    document.body.innerHTML = '';
    delete (window as unknown as { __cafConfig?: unknown }).__cafConfig;
    setTurnstileToken(''); // reset the module-scoped holder between tests
  });

  function captureSentBody(): { getBody: () => Promise<string | undefined> } {
    let sentBody: Blob | string | undefined;
    Object.defineProperty(navigator, 'sendBeacon', {
      value: (_url: string, body: Blob | string) => {
        sentBody = body;
        return true;
      },
      configurable: true,
    });
    return {
      getBody: async () => {
        if (sentBody === undefined) return undefined;
        return typeof sentBody === 'string' ? sentBody : await sentBody.text();
      },
    };
  }

  it('when no token has been minted, the abandon payload has no _caf key (byte-identical to Phase 1)', async () => {
    const form = buildForm(`<input name="email" value="no-token@example.com" />`);
    form.setAttribute('data-caf', 'form-no-token');
    window.__cafConfig = { siteId: 'site-1' };
    init();

    const { getBody } = captureSentBody();
    document.dispatchEvent(new MouseEvent('mouseleave', { clientY: 0 }));

    const body = await getBody();
    expect(body).toBeDefined();
    const payload = JSON.parse(body!) as { fields: Record<string, unknown> };
    expect(payload.fields[CAF_FIELD_NAME]).toBeUndefined();
  });

  it('when a token has been minted (setTurnstileToken), the abandon payload carries it in fields._caf as {turnstileToken}', async () => {
    const form = buildForm(`<input name="email" value="with-token@example.com" />`);
    form.setAttribute('data-caf', 'form-with-token');
    window.__cafConfig = { siteId: 'site-1' };
    init();
    form.querySelector('input[name="email"]')!.dispatchEvent(new Event('input', { bubbles: true }));
    setTurnstileToken('minted-abc123');

    const { getBody } = captureSentBody();
    document.dispatchEvent(new MouseEvent('mouseleave', { clientY: 0 }));

    const body = await getBody();
    const payload = JSON.parse(body!) as { fields: Record<string, unknown> };
    expect(JSON.parse(payload.fields[CAF_FIELD_NAME] as string)).toEqual({ turnstileToken: 'minted-abc123' });
    // stageFields-collected fields are untouched — only the _caf key is added.
    expect(payload.fields.email).toBe('with-token@example.com');
  });
});

// ---------------------------------------------------------------------------
// Recovery seam (RCV-01/D3). `recoveryActive` is resolved PER FORM in
// bindForm() (04-10 gap closure) — there is no cross-test module-level flag
// to worry about; each test binds its own distinctly-`data-caf`-id'd
// form(s), so these cases (and the per-form-scoping describe block further
// below) are order-independent.
// ---------------------------------------------------------------------------

describe('recovery seam: setRecoveryConsent + recoveryActive fetch-reads-{saved} (RCV-01/D3)', () => {
  afterEach(() => {
    window.caf?.submitted();
    document.body.innerHTML = '';
    delete (window as unknown as { __cafConfig?: unknown }).__cafConfig;
    vi.unstubAllGlobals();
  });

  it('sendBeacon path is byte-identical when recovery is absent — fetch is never called', () => {
    const form = buildForm(`<input name="email" value="a@example.com" />`);
    form.setAttribute('data-caf', 'form-recovery-off');
    window.__cafConfig = { siteId: 'site-1' }; // no `recovery` key at all
    init();

    let sendBeaconCalls = 0;
    Object.defineProperty(navigator, 'sendBeacon', {
      value: () => {
        sendBeaconCalls += 1;
        return true;
      },
      configurable: true,
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    document.dispatchEvent(new MouseEvent('mouseleave', { clientY: 0 }));

    expect(sendBeaconCalls).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sendBeacon path is byte-identical when recovery.enabled is explicitly false — fetch is never called', () => {
    const form = buildForm(`<input name="email" value="a@example.com" />`);
    form.setAttribute('data-caf', 'form-recovery-explicit-off');
    window.__cafConfig = { siteId: 'site-1', recovery: { enabled: false } };
    init();

    let sendBeaconCalls = 0;
    Object.defineProperty(navigator, 'sendBeacon', {
      value: () => {
        sendBeaconCalls += 1;
        return true;
      },
      configurable: true,
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    document.dispatchEvent(new MouseEvent('mouseleave', { clientY: 0 }));

    expect(sendBeaconCalls).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('setRecoveryConsent(optIn) rides recoveryOptIn on an active form\'s abandon payload (04-10: only active forms carry it)', async () => {
    const form = buildForm(`<input name="email" value="a@example.com" />`);
    form.setAttribute('data-caf', 'form-recovery-optin');
    window.__cafConfig = { siteId: 'site-1', recovery: { enabled: true, consentMode: 'checkbox' } };
    init();
    setRecoveryConsent(true);

    let sentBody: string | undefined;
    const fetchMock = vi.fn(async (_url: string, requestInit?: RequestInit) => {
      sentBody = requestInit?.body as string;
      return { json: async () => ({ saved: true }) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    document.dispatchEvent(new MouseEvent('mouseleave', { clientY: 0 }));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const payload = JSON.parse(sentBody!) as { recoveryOptIn?: boolean };
    expect(payload.recoveryOptIn).toBe(true);
  });

  it('recoveryActive: attemptSend transports via fetch (never sendBeacon) and dispatches caf:recovery-saved on a {saved:true} JSON response', async () => {
    const form = buildForm(`<input name="email" value="a@example.com" />`);
    form.setAttribute('data-caf', 'form-recovery-active-saved');
    window.__cafConfig = { siteId: 'site-1', recovery: { enabled: true, consentMode: 'auto' } };
    init();

    let sendBeaconCalls = 0;
    Object.defineProperty(navigator, 'sendBeacon', {
      value: () => {
        sendBeaconCalls += 1;
        return true;
      },
      configurable: true,
    });

    let fetchCalls = 0;
    const fetchMock = vi.fn(async () => {
      fetchCalls += 1;
      return { json: async () => ({ saved: true }) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    let eventFired = false;
    document.addEventListener('caf:recovery-saved', () => {
      eventFired = true;
    });

    document.dispatchEvent(new MouseEvent('mouseleave', { clientY: 0 }));

    await vi.waitFor(() => {
      expect(eventFired).toBe(true);
    });

    expect(fetchCalls).toBe(1);
    expect(sendBeaconCalls).toBe(0);
  });

  it('recoveryActive: does NOT dispatch caf:recovery-saved when the response is not {saved:true} (T-04-26)', async () => {
    const form = buildForm(`<input name="email" value="a@example.com" />`);
    form.setAttribute('data-caf', 'form-recovery-active-notsaved');
    window.__cafConfig = { siteId: 'site-1', recovery: { enabled: true, consentMode: 'auto' } };
    init();

    const fetchMock = vi.fn(async () => ({ json: async () => ({ saved: false }) }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    let eventFired = false;
    document.addEventListener('caf:recovery-saved', () => {
      eventFired = true;
    });

    document.dispatchEvent(new MouseEvent('mouseleave', { clientY: 0 }));

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    // Give the .then chain a chance to settle before asserting the negative.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(eventFired).toBe(false);
  });
});

/**
 * Per-form recovery scoping (04-10 gap closure — RCV-01/ROADMAP Phase 4
 * SC4 "per-form flag"). `recoveryActive` moves from a module-level flag to
 * per-form state resolved in bindForm() — a disabled form's transport must
 * stay on the sendBeacon path (never fetch-reads-{saved}) and must never
 * carry a stray `recoveryOptIn`. RED-first: written before capture.ts
 * resolves `recoveryActive` per form.
 */
describe('recovery seam: per-form scoping via __cafConfig.recovery.disabledForms (04-10)', () => {
  afterEach(() => {
    window.caf?.submitted();
    document.body.innerHTML = '';
    delete (window as unknown as { __cafConfig?: unknown }).__cafConfig;
    vi.unstubAllGlobals();
  });

  it('form "a" (enabled) uses the fetch-reads-{saved} path while form "b" (in disabledForms) uses the beacon path — same page, same config', async () => {
    const formA = buildForm(`<input name="email" value="a@example.com" />`);
    formA.setAttribute('data-caf', 'a');
    const formB = buildForm(`<input name="email" value="b@example.com" />`);
    formB.setAttribute('data-caf', 'b');
    window.__cafConfig = {
      siteId: 'site-1',
      recovery: { enabled: true, consentMode: 'auto', disabledForms: ['b'] },
    } as typeof window.__cafConfig;
    init();

    let sendBeaconCalls = 0;
    Object.defineProperty(navigator, 'sendBeacon', {
      value: () => {
        sendBeaconCalls += 1;
        return true;
      },
      configurable: true,
    });
    const fetchMock = vi.fn(async () => ({ json: async () => ({ saved: true }) }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    let eventFired = false;
    document.addEventListener('caf:recovery-saved', () => {
      eventFired = true;
    });

    document.dispatchEvent(new MouseEvent('mouseleave', { clientY: 0 }));

    await vi.waitFor(() => {
      expect(eventFired).toBe(true);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1); // form 'a' only
    expect(sendBeaconCalls).toBe(1); // form 'b' only
  });

  it('a disabled form never dispatches caf:recovery-saved and never calls fetch, even with recovery site-wide ON', async () => {
    const formB = buildForm(`<input name="email" value="b@example.com" />`);
    formB.setAttribute('data-caf', 'b-only');
    window.__cafConfig = {
      siteId: 'site-1',
      recovery: { enabled: true, consentMode: 'auto', disabledForms: ['b-only'] },
    } as typeof window.__cafConfig;
    init();

    Object.defineProperty(navigator, 'sendBeacon', {
      value: () => true,
      configurable: true,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    let eventFired = false;
    document.addEventListener('caf:recovery-saved', () => {
      eventFired = true;
    });

    document.dispatchEvent(new MouseEvent('mouseleave', { clientY: 0 }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(eventFired).toBe(false);
  });

  it('a disabled form carries NO recoveryOptIn even after setRecoveryConsent(true)', async () => {
    const formB = buildForm(`<input name="email" value="b@example.com" />`);
    formB.setAttribute('data-caf', 'b-optin');
    window.__cafConfig = {
      siteId: 'site-1',
      recovery: { enabled: true, consentMode: 'checkbox', disabledForms: ['b-optin'] },
    } as typeof window.__cafConfig;
    init();
    setRecoveryConsent(true);

    let sentBody: Blob | string | undefined;
    Object.defineProperty(navigator, 'sendBeacon', {
      value: (_url: string, body: Blob | string) => {
        sentBody = body;
        return true;
      },
      configurable: true,
    });

    document.dispatchEvent(new MouseEvent('mouseleave', { clientY: 0 }));

    const text = typeof sentBody === 'string' ? sentBody : await sentBody!.text();
    const payload = JSON.parse(text) as { recoveryOptIn?: boolean };
    expect(payload.recoveryOptIn).toBeUndefined();
  });
});
