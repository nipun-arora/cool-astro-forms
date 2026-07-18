// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as capture from './capture.js';
import { init } from './recovery-widget.js';

function buildForm(html: string, formId = 'form-recovery'): HTMLFormElement {
  const form = document.createElement('form');
  form.setAttribute('data-caf', formId);
  form.innerHTML = html;
  document.body.appendChild(form);
  return form;
}

// ---------------------------------------------------------------------------
// Ordering note: recovery-widget.ts's `caf:recovery-saved` listener binds
// idempotently but NEVER unbinds — mirroring capture.ts's own
// globalTriggersBound pattern. The "inert" test therefore MUST run first,
// before any test flips `recovery.enabled: true`, or a later dispatch would
// still render a toast from the earlier binding.
// ---------------------------------------------------------------------------

describe('recovery-widget', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    delete (window as unknown as { __cafConfig?: unknown }).__cafConfig;
    vi.restoreAllMocks();
  });

  it('is inert (no DOM added, no listener bound) when recovery is absent or enabled:false', () => {
    window.__cafConfig = { siteId: 'site-1' }; // no `recovery` key at all
    init();
    document.dispatchEvent(new CustomEvent('caf:recovery-saved'));
    expect(document.querySelector('[data-caf-recovery-toast]')).toBeNull();

    window.__cafConfig = { siteId: 'site-1', recovery: { enabled: false } };
    init();
    document.dispatchEvent(new CustomEvent('caf:recovery-saved'));
    expect(document.querySelector('[data-caf-recovery-toast]')).toBeNull();
  });

  it('auto mode: renders a single "progress saved" toast on caf:recovery-saved, no checkbox', () => {
    buildForm(`<input name="email" />`);
    window.__cafConfig = { siteId: 'site-1', recovery: { enabled: true, consentMode: 'auto' } };
    init();

    expect(document.querySelector('[data-caf-recovery-checkbox]')).toBeNull();

    document.dispatchEvent(new CustomEvent('caf:recovery-saved'));

    const toast = document.querySelector('[data-caf-recovery-toast]');
    expect(toast).not.toBeNull();
    expect(toast!.textContent).toMatch(/progress is saved/i);
  });

  it('a second caf:recovery-saved does not stack a duplicate toast (idempotent)', () => {
    buildForm(`<input name="email" />`);
    window.__cafConfig = { siteId: 'site-1', recovery: { enabled: true, consentMode: 'auto' } };
    init();

    document.dispatchEvent(new CustomEvent('caf:recovery-saved'));
    document.dispatchEvent(new CustomEvent('caf:recovery-saved'));

    expect(document.querySelectorAll('[data-caf-recovery-toast]').length).toBe(1);
  });

  it('the toast is dismissible via its close control', () => {
    buildForm(`<input name="email" />`);
    window.__cafConfig = { siteId: 'site-1', recovery: { enabled: true, consentMode: 'auto' } };
    init();
    document.dispatchEvent(new CustomEvent('caf:recovery-saved'));

    const toast = document.querySelector('[data-caf-recovery-toast]');
    expect(toast).not.toBeNull();
    const dismiss = toast!.querySelector('button');
    expect(dismiss).not.toBeNull();
    dismiss!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(document.querySelector('[data-caf-recovery-toast]')).toBeNull();
  });

  it('checkbox mode: injects an opt-in checkbox on the [data-caf] form; change wires setRecoveryConsent(checked)', () => {
    buildForm(`<input name="email" /><button type="submit">Send</button>`);
    window.__cafConfig = { siteId: 'site-1', recovery: { enabled: true, consentMode: 'checkbox' } };

    const setSpy = vi.spyOn(capture, 'setRecoveryConsent');
    init();

    const checkbox = document.querySelector<HTMLInputElement>('[data-caf-recovery-checkbox] input[type="checkbox"]');
    expect(checkbox).not.toBeNull();

    checkbox!.checked = true;
    checkbox!.dispatchEvent(new Event('change', { bubbles: true }));
    expect(setSpy).toHaveBeenLastCalledWith(true);

    checkbox!.checked = false;
    checkbox!.dispatchEvent(new Event('change', { bubbles: true }));
    expect(setSpy).toHaveBeenLastCalledWith(false);
  });

  it('checkbox mode: the checkbox is excluded from stageFields capture (data-caf-ignore)', () => {
    buildForm(`<input name="email" />`);
    window.__cafConfig = { siteId: 'site-1', recovery: { enabled: true, consentMode: 'checkbox' } };
    init();

    const checkbox = document.querySelector('[data-caf-recovery-checkbox] input[type="checkbox"]');
    expect(checkbox?.hasAttribute('data-caf-ignore')).toBe(true);
  });

  it('checkbox mode is idempotent — calling init() twice does not inject a second checkbox', () => {
    buildForm(`<input name="email" />`);
    window.__cafConfig = { siteId: 'site-1', recovery: { enabled: true, consentMode: 'checkbox' } };
    init();
    init();

    expect(document.querySelectorAll('[data-caf-recovery-checkbox]').length).toBe(1);
  });

  it('auto mode never renders a checkbox even when a [data-caf] form is present', () => {
    buildForm(`<input name="email" />`);
    window.__cafConfig = { siteId: 'site-1', recovery: { enabled: true, consentMode: 'auto' } };
    init();
    expect(document.querySelector('[data-caf-recovery-checkbox]')).toBeNull();
  });

  // -------------------------------------------------------------------
  // Per-form scoping (04-10 gap closure — RCV-01/ROADMAP Phase 4 SC4
  // "per-form flag"). RED-first: written before init() iterates ALL
  // [data-caf] forms (it currently only ever touches the first one).
  // -------------------------------------------------------------------

  it('checkbox mode with disabledForms: injects the checkbox on the enabled form only, skips the disabled one', () => {
    buildForm(`<input name="email" /><button type="submit">Send</button>`, 'a');
    buildForm(`<input name="email" /><button type="submit">Send</button>`, 'b');
    window.__cafConfig = {
      siteId: 'site-1',
      recovery: { enabled: true, consentMode: 'checkbox', disabledForms: ['b'] },
    } as typeof window.__cafConfig;
    init();

    const formA = document.querySelector('[data-caf="a"]')!;
    const formB = document.querySelector('[data-caf="b"]')!;
    expect(formA.querySelector('[data-caf-recovery-checkbox]')).not.toBeNull();
    expect(formB.querySelector('[data-caf-recovery-checkbox]')).toBeNull();
  });

  it('checkbox mode with all forms disabled: no checkbox is injected anywhere', () => {
    buildForm(`<input name="email" />`, 'a');
    buildForm(`<input name="email" />`, 'b');
    window.__cafConfig = {
      siteId: 'site-1',
      recovery: { enabled: true, consentMode: 'checkbox', disabledForms: ['a', 'b'] },
    } as typeof window.__cafConfig;
    init();

    expect(document.querySelectorAll('[data-caf-recovery-checkbox]').length).toBe(0);
  });
});
