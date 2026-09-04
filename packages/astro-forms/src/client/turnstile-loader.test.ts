// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { setTurnstileTokenMock, setTurnstileResetterMock } = vi.hoisted(() => ({
  setTurnstileTokenMock: vi.fn(),
  setTurnstileResetterMock: vi.fn(),
}));
vi.mock('./capture.js', () => ({
  setTurnstileToken: setTurnstileTokenMock,
  setTurnstileResetter: setTurnstileResetterMock,
}));

import { init, renderWidgets, resetWidgetRegistry, resetWidgets } from './turnstile-loader.js';

function buildTaggedForm(formId = 'demo'): HTMLFormElement {
  const form = document.createElement('form');
  form.setAttribute('data-caf', formId);
  document.body.appendChild(form);
  return form;
}

function cleanup(): void {
  document.body.innerHTML = '';
  document.head.querySelectorAll('script[data-caf-turnstile-script]').forEach((el) => el.remove());
  delete (window as unknown as { __cafConfig?: unknown }).__cafConfig;
  delete (window as unknown as { turnstile?: unknown }).turnstile;
  resetWidgetRegistry();
  setTurnstileResetterMock.mockClear();
}

describe('turnstile-loader — init() (inert without a configured siteKey)', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('injects no script tag when window.__cafConfig is entirely absent', () => {
    init();
    expect(document.querySelector('script[data-caf-turnstile-script]')).toBeNull();
  });

  it('injects no script tag when window.__cafConfig.turnstileSiteKey is absent', () => {
    window.__cafConfig = { siteId: 'site-1' };
    init();
    expect(document.querySelector('script[data-caf-turnstile-script]')).toBeNull();
  });

  it('injects the Cloudflare api.js explicit-render script tag when turnstileSiteKey is present', () => {
    window.__cafConfig = { siteId: 'site-1', turnstileSiteKey: '1x00000000000000000000AA' };
    init();
    const script = document.querySelector<HTMLScriptElement>('script[data-caf-turnstile-script]');
    expect(script).not.toBeNull();
    expect(script!.src).toContain('https://challenges.cloudflare.com/turnstile/v0/api.js');
    expect(script!.src).toContain('render=explicit');
  });

  it('does not inject a second script tag on repeated init() calls (idempotent)', () => {
    window.__cafConfig = { siteId: 'site-1', turnstileSiteKey: '1x00000000000000000000AA' };
    init();
    init();
    expect(document.querySelectorAll('script[data-caf-turnstile-script]').length).toBe(1);
  });
});

describe('turnstile-loader — renderWidgets()', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('no-ops (does not throw, renders nothing) when window.turnstile has not loaded yet', () => {
    buildTaggedForm();
    expect(() => renderWidgets('1x00000000000000000000AA')).not.toThrow();
    expect(document.querySelector('[data-caf-turnstile]')).toBeNull();
  });

  it('renders one widget per [data-caf] form and wires its callback to setTurnstileToken', () => {
    const form = buildTaggedForm();
    const renderMock = vi.fn((_container: unknown, opts: { sitekey: string; callback?: (t: string) => void }) => {
      opts.callback?.('minted-token');
      return 'widget-id-1';
    });
    window.turnstile = { render: renderMock };

    renderWidgets('1x00000000000000000000AA');

    expect(renderMock).toHaveBeenCalledTimes(1);
    const [container, opts] = renderMock.mock.calls[0]!;
    expect(container).toBe(form.querySelector('[data-caf-turnstile]'));
    expect(opts.sitekey).toBe('1x00000000000000000000AA');
    expect(setTurnstileTokenMock).toHaveBeenCalledWith('minted-token');
  });

  it('does not render a second widget into a form that already has one', () => {
    buildTaggedForm();
    const renderMock = vi.fn(() => 'widget-id-1');
    window.turnstile = { render: renderMock };

    renderWidgets('1x00000000000000000000AA');
    renderWidgets('1x00000000000000000000AA');

    expect(renderMock).toHaveBeenCalledTimes(1);
  });

  it('renders a widget per form across multiple [data-caf] forms', () => {
    buildTaggedForm('form-a');
    buildTaggedForm('form-b');
    const renderMock = vi.fn(() => 'widget-id');
    window.turnstile = { render: renderMock };

    renderWidgets('1x00000000000000000000AA');

    expect(renderMock).toHaveBeenCalledTimes(2);
  });

  // Placement contract (owner report 2026-07-17): the challenge must sit
  // ABOVE the form's submit control — a widget below the button reads as
  // page furniture and visitors submit before solving it.
  it('inserts the widget before a <button type="submit">, not after it', () => {
    const form = buildTaggedForm();
    form.innerHTML = '<input name="email" type="email"><button type="submit">Submit</button>';
    window.turnstile = { render: vi.fn(() => 'widget-id') };

    renderWidgets('1x00000000000000000000AA');

    const widget = form.querySelector('[data-caf-turnstile]')!;
    const submit = form.querySelector('button[type="submit"]')!;
    expect(widget.compareDocumentPosition(submit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('inserts the widget before an <input type="submit">', () => {
    const form = buildTaggedForm();
    form.innerHTML = '<input name="email" type="email"><input type="submit" value="Send">';
    window.turnstile = { render: vi.fn(() => 'widget-id') };

    renderWidgets('1x00000000000000000000AA');

    const widget = form.querySelector('[data-caf-turnstile]')!;
    const submit = form.querySelector('input[type="submit"]')!;
    expect(widget.compareDocumentPosition(submit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('inserts the widget before a typeless <button> (implicit submit)', () => {
    const form = buildTaggedForm();
    form.innerHTML = '<input name="email" type="email"><button>Submit</button>';
    window.turnstile = { render: vi.fn(() => 'widget-id') };

    renderWidgets('1x00000000000000000000AA');

    const widget = form.querySelector('[data-caf-turnstile]')!;
    const submit = form.querySelector('button')!;
    expect(widget.compareDocumentPosition(submit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('appends the widget at the end of a form with no submit control', () => {
    const form = buildTaggedForm();
    form.innerHTML = '<input name="email" type="email">';
    window.turnstile = { render: vi.fn(() => 'widget-id') };

    renderWidgets('1x00000000000000000000AA');

    expect(form.lastElementChild).toBe(form.querySelector('[data-caf-turnstile]'));
  });
});

// ---------------------------------------------------------------------------
// resetWidgets(). A Turnstile token is single-use, and the abandonment
// capture spends it: without a re-arm, a visitor who moused out and came back
// submits with a dead token and gets refused as a replay. The loader owns the
// widget ids, so it owns the re-arm; capture.ts reaches it only through the
// resetter registered at render time.
// ---------------------------------------------------------------------------

describe('turnstile-loader — resetWidgets() re-arms spent widgets', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('hands capture.ts a resetter once a widget has actually rendered', () => {
    buildTaggedForm();
    window.turnstile = { render: vi.fn(() => 'widget-id-1'), reset: vi.fn() };

    renderWidgets('1x00000000000000000000AA');

    expect(setTurnstileResetterMock).toHaveBeenCalledTimes(1);
    expect(setTurnstileResetterMock.mock.calls[0]![0]).toBe(resetWidgets);
  });

  it('registers no resetter when nothing rendered — a page with no widget must leave capture.ts with nothing to call', () => {
    buildTaggedForm();
    // window.turnstile absent: api.js has not loaded, so renderWidgets bails.
    renderWidgets('1x00000000000000000000AA');

    expect(setTurnstileResetterMock).not.toHaveBeenCalled();
  });

  it('resets EVERY rendered widget by id — reset() with no argument only touches the first widget on the page, which would leave a second form holding a dead token', () => {
    buildTaggedForm('form-a');
    buildTaggedForm('form-b');
    const ids = ['widget-a', 'widget-b'];
    let next = 0;
    const resetMock = vi.fn();
    window.turnstile = { render: vi.fn(() => ids[next++]!), reset: resetMock };

    renderWidgets('1x00000000000000000000AA');
    resetWidgets();

    expect(resetMock.mock.calls.map((c) => c[0])).toEqual(['widget-a', 'widget-b']);
  });

  it('is a no-op when the Turnstile script exposes no reset() — an older api.js must not break the abandon send that calls this', () => {
    buildTaggedForm();
    window.turnstile = { render: vi.fn(() => 'widget-id-1') };

    renderWidgets('1x00000000000000000000AA');

    expect(() => resetWidgets()).not.toThrow();
  });

  it('keeps re-arming the remaining widgets when one of them throws', () => {
    buildTaggedForm('form-a');
    buildTaggedForm('form-b');
    const ids = ['widget-a', 'widget-b'];
    let next = 0;
    const resetMock = vi.fn((id?: string | HTMLElement) => {
      if (id === 'widget-a') throw new Error('widget removed from the DOM');
    });
    window.turnstile = { render: vi.fn(() => ids[next++]!), reset: resetMock };

    renderWidgets('1x00000000000000000000AA');

    expect(() => resetWidgets()).not.toThrow();
    expect(resetMock).toHaveBeenCalledWith('widget-b');
  });
});
