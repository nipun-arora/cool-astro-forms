import { describe, expect, it } from 'vitest';
import type { AbandonedLeadEmailData, PaymentQuoteEmailData, PaymentReceivedEmailData, RecoveryEmailData } from './notify.js';
import {
  defaultAbandonedLeadTemplate,
  escapeHtml,
  formatMoney,
  renderFieldsHtml,
  renderGeoLine,
  renderJourneyTimelineHtml,
  renderPaymentQuoteTemplate,
  renderPaymentReceivedTemplate,
  renderRecoveryEmailTemplate,
} from './templates.js';

function makeData(overrides: Partial<AbandonedLeadEmailData> = {}): AbandonedLeadEmailData {
  return {
    siteId: 'demo-site',
    formId: 'contact-form',
    notifyTo: 'owner@example.com',
    fields: { email: 'jane@example.com' },
    ...overrides,
  };
}

function makeQuoteData(overrides: Partial<PaymentQuoteEmailData> = {}): PaymentQuoteEmailData {
  return {
    siteId: 'demo-site',
    formId: 'contact-form',
    notifyTo: 'owner@example.com',
    amountCents: 20000,
    currency: 'usd',
    payLinkUrl: 'https://pay.stripe.com/abc123',
    ...overrides,
  };
}

function makeReceivedData(overrides: Partial<PaymentReceivedEmailData> = {}): PaymentReceivedEmailData {
  return {
    siteId: 'demo-site',
    formId: 'contact-form',
    notifyTo: 'owner@example.com',
    amountCents: 20000,
    currency: 'usd',
    provider: 'stripe',
    ...overrides,
  };
}

function makeRecoveryData(overrides: Partial<RecoveryEmailData> = {}): RecoveryEmailData {
  return {
    to: 'visitor@example.com',
    siteId: 'demo-site',
    formId: 'contact-form',
    resumeUrl: 'https://example.com/contact',
    unsubscribeUrl: 'https://example.com/api/forms/recovery-unsubscribe?token=abc123',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// GEO-02 (email half) — populated geo lights up the Location line
// ---------------------------------------------------------------------------

describe('defaultAbandonedLeadTemplate — geo line (GEO-02)', () => {
  it('emits "Location: City, Region, Country" in both text and html when geo is populated', () => {
    const result = defaultAbandonedLeadTemplate(
      makeData({ geo: { city: 'Metropolis', region: 'NY', country: 'US' } }),
    );
    expect(result.text).toContain('Location: Metropolis, NY, US');
    expect(result.html).toContain('Location: Metropolis, NY, US');
  });

  it('omits the Location line entirely when geo is absent (Phase 1 behavior preserved)', () => {
    const result = defaultAbandonedLeadTemplate(makeData());
    expect(result.text).not.toContain('Location:');
    expect(result.html).not.toContain('Location:');
  });

  it('omits the Location line when geo has no usable city/region/country parts', () => {
    const result = defaultAbandonedLeadTemplate(makeData({ geo: { lat: 1, lon: 2 } }));
    expect(result.text).not.toContain('Location:');
  });
});

// ---------------------------------------------------------------------------
// W1 — render helpers exported for P05 admin reuse (no behavior change)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// W3 — payment email templates + shared money formatter
// ---------------------------------------------------------------------------

describe('formatMoney', () => {
  it('formats whole and fractional cents as a currency string', () => {
    expect(formatMoney(20000, 'usd')).toBe('$200.00');
    expect(formatMoney(19950, 'usd')).toBe('$199.50');
  });

  it('never throws for a malformed currency code (falls back to a plain string, no crash)', () => {
    expect(() => formatMoney(20000, '')).not.toThrow();
  });
});

describe('renderPaymentQuoteTemplate (PAY-02, W3)', () => {
  it('subject names the amount and includes the site id', () => {
    const result = renderPaymentQuoteTemplate(makeQuoteData());
    expect(result.subject).toContain('$200.00');
    expect(result.subject).toContain('demo-site');
  });

  it('renders the memo when provided, omits a Memo line when absent', () => {
    const withMemo = renderPaymentQuoteTemplate(makeQuoteData({ memo: 'Website redesign' }));
    expect(withMemo.text).toContain('Website redesign');
    expect(withMemo.html).toContain('Website redesign');

    const withoutMemo = renderPaymentQuoteTemplate(makeQuoteData());
    expect(withoutMemo.text).not.toContain('Memo:');
  });

  it('renders a Subtotal/fee-line/Total breakdown when breakdown is supplied', () => {
    const result = renderPaymentQuoteTemplate(
      makeQuoteData({
        amountCents: 20000,
        breakdown: {
          subtotalCents: 20000,
          lines: [{ label: 'Processing fee', amountCents: 600 }],
          totalCents: 20600,
        },
      }),
    );
    expect(result.text).toContain('Subtotal: $200.00');
    expect(result.text).toContain('Processing fee: $6.00');
    expect(result.text).toContain('Total due: $206.00');
    expect(result.html).toContain('Processing fee');
  });

  it('defaults to a trivial subtotal-only breakdown (no fee lines) when breakdown is omitted', () => {
    const result = renderPaymentQuoteTemplate(makeQuoteData({ amountCents: 20000 }));
    expect(result.text).toContain('Subtotal: $200.00');
    expect(result.text).toContain('Total due: $200.00');
  });

  it('renders the pay link as an escaped anchor in html and a plain copy-URL in text', () => {
    const result = renderPaymentQuoteTemplate(makeQuoteData({ payLinkUrl: 'https://pay.stripe.com/abc123?x=1&y=2' }));
    expect(result.text).toContain('https://pay.stripe.com/abc123?x=1&y=2');
    expect(result.html).toContain('<a href="https://pay.stripe.com/abc123?x=1&amp;y=2">');
  });

  it('HTML-escapes a malicious memo — no raw <script> substring in html output', () => {
    const result = renderPaymentQuoteTemplate(makeQuoteData({ memo: '<script>alert(1)</script>' }));
    expect(result.html).not.toContain('<script>alert(1)</script>');
    expect(result.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

describe('renderPaymentReceivedTemplate (W3)', () => {
  it('subject/text include the formatted amount and provider', () => {
    const result = renderPaymentReceivedTemplate(makeReceivedData({ provider: 'paypal' }));
    expect(result.subject).toContain('$200.00');
    expect(result.subject.toLowerCase()).toContain('paypal');
    expect(result.text).toContain('$200.00');
    expect(result.text.toLowerCase()).toContain('paypal');
  });

  it('renders an entryUrl link when provided, omits "View entry" text when absent', () => {
    const withEntry = renderPaymentReceivedTemplate(
      makeReceivedData({ entryUrl: 'https://example.com/forms-admin/entries/e1' }),
    );
    expect(withEntry.html).toContain('https://example.com/forms-admin/entries/e1');

    const withoutEntry = renderPaymentReceivedTemplate(makeReceivedData());
    expect(withoutEntry.text).not.toContain('View entry');
  });

  it('never emits the literal string "undefined"', () => {
    const result = renderPaymentReceivedTemplate(makeReceivedData());
    expect(result.text).not.toContain('undefined');
    expect(result.html ?? '').not.toContain('undefined');
  });
});

describe('renderRecoveryEmailTemplate (RCV-01, D3/D4)', () => {
  it('subject is a plain non-empty nudge string', () => {
    const result = renderRecoveryEmailTemplate(makeRecoveryData());
    expect(typeof result.subject).toBe('string');
    expect(result.subject.length).toBeGreaterThan(0);
  });

  it('text and html both carry the resume link and the unsubscribe link', () => {
    const result = renderRecoveryEmailTemplate(makeRecoveryData());
    expect(result.text).toContain('https://example.com/contact');
    expect(result.text).toContain('https://example.com/api/forms/recovery-unsubscribe?token=abc123');
    expect(result.html).toContain('https://example.com/contact');
    expect(result.html).toContain('https://example.com/api/forms/recovery-unsubscribe?token=abc123');
  });

  it('HTML-escapes a malicious resumeUrl — no raw breakout substring in html output', () => {
    const malicious = 'https://example.com/"><script>alert(1)</script>';
    const result = renderRecoveryEmailTemplate(makeRecoveryData({ resumeUrl: malicious }));
    expect(result.html).not.toContain('"><script>alert(1)</script>');
    expect(result.html).toContain('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('HTML-escapes a malicious unsubscribeUrl the same way', () => {
    const malicious = 'https://example.com/u?token="><script>alert(2)</script>';
    const result = renderRecoveryEmailTemplate(makeRecoveryData({ unsubscribeUrl: malicious }));
    expect(result.html).not.toContain('"><script>alert(2)</script>');
  });

  it('never emits the literal string "undefined"', () => {
    const result = renderRecoveryEmailTemplate(makeRecoveryData());
    expect(result.text).not.toContain('undefined');
    expect(result.html ?? '').not.toContain('undefined');
  });
});

describe('templates.ts — exported render helpers (P05 admin reuse, W1)', () => {
  it('exports renderJourneyTimelineHtml, renderFieldsHtml, renderGeoLine alongside the already-exported escapeHtml', () => {
    expect(typeof renderJourneyTimelineHtml).toBe('function');
    expect(typeof renderFieldsHtml).toBe('function');
    expect(typeof renderGeoLine).toBe('function');
    expect(typeof escapeHtml).toBe('function');
  });

  it('renderFieldsHtml escapes field values into a table row', () => {
    const html = renderFieldsHtml({ name: '<script>' });
    expect(html).toContain('&lt;script&gt;');
  });

  it('renderJourneyTimelineHtml renders "(no journey recorded)" for an empty/undefined journey', () => {
    expect(renderJourneyTimelineHtml(undefined)).toContain('(no journey recorded)');
  });

  it('renderGeoLine renders "Location: City, Region, Country" for a populated geo, empty string otherwise', () => {
    expect(renderGeoLine({ city: 'A', region: 'B', country: 'C' })).toBe('Location: A, B, C');
    expect(renderGeoLine(undefined)).toBe('');
  });
});
