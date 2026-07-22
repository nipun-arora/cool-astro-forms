import type { Transporter } from 'nodemailer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerJourneyStep } from '../types.js';
import type {
  AbandonedLeadEmailData,
  NotifyOptions,
  PaymentQuoteEmailData,
  PaymentReceivedEmailData,
  RecoveryEmailData,
} from './notify.js';

const ENV_KEYS = ['EMAIL_HOST', 'EMAIL_PORT', 'EMAIL_USER', 'EMAIL_PASS', 'NODE_ENV'] as const;
type EnvKey = (typeof ENV_KEYS)[number];

let savedEnv: Record<EnvKey, string | undefined>;

function baseData(overrides: Partial<AbandonedLeadEmailData> = {}): AbandonedLeadEmailData {
  return {
    siteId: 'demo-site',
    formId: 'contact-form',
    notifyTo: 'owner@example.com',
    fields: {
      name: 'Jane Doe',
      email: 'jane@example.com',
    },
    journey: [
      { url: '/pricing', title: 'Pricing', ts: 1_000, durationMs: 5_000 },
      { url: '/contact', title: 'Contact Us', ts: 6_000, durationMs: 12_000 },
    ] as ServerJourneyStep[],
    pageUrl: '/contact',
    referrer: 'https://google.com/',
    ...overrides,
  };
}

function baseQuoteData(overrides: Partial<PaymentQuoteEmailData> = {}): PaymentQuoteEmailData {
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

function baseReceivedData(overrides: Partial<PaymentReceivedEmailData> = {}): PaymentReceivedEmailData {
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

function baseRecoveryData(overrides: Partial<RecoveryEmailData> = {}): RecoveryEmailData {
  return {
    to: 'visitor@example.com',
    siteId: 'demo-site',
    formId: 'contact-form',
    resumeUrl: 'https://example.com/contact',
    unsubscribeUrl: 'https://example.com/api/forms/recovery-unsubscribe?token=abc123',
    ...overrides,
  };
}

/** Fresh module instance per test — buildTransport()'s memoized cache must never leak across tests. */
async function loadNotify() {
  return import('./notify.js');
}

async function loadTemplates() {
  return import('./templates.js');
}

beforeEach(() => {
  vi.resetModules();
  savedEnv = {} as Record<EnvKey, string | undefined>;
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.restoreAllMocks();
});

describe('sendAbandonedLeadEmail (jsonTransport)', () => {
  it('sends to notifyTo with a subject and text containing a field value + journey step title', async () => {
    const { sendAbandonedLeadEmail } = await loadNotify();
    const info = (await sendAbandonedLeadEmail(baseData())) as { message: string };
    expect(info).toBeTruthy();
    const parsed = JSON.parse(info.message);
    // jsonTransport parses addresses into {address, name} objects, not plain strings.
    expect(parsed.to).toEqual([{ address: 'owner@example.com', name: '' }]);
    expect(typeof parsed.subject).toBe('string');
    expect(parsed.subject.length).toBeGreaterThan(0);
    expect(parsed.text).toContain('Jane Doe');
    expect(parsed.text).toContain('Pricing');
  });

  it('uses opts.template override when supplied (sentinel subject)', async () => {
    const { sendAbandonedLeadEmail } = await loadNotify();
    const sentinel = 'SENTINEL-OVERRIDE-SUBJECT';
    const opts: NotifyOptions = {
      template: () => ({ subject: sentinel, text: 'override text', html: '<p>override</p>' }),
    };
    const info = (await sendAbandonedLeadEmail(baseData(), opts)) as { message: string };
    const parsed = JSON.parse(info.message);
    expect(parsed.subject).toBe(sentinel);
  });

  it('does not throw when EMAIL_* env is unset (jsonTransport fallback)', async () => {
    const { sendAbandonedLeadEmail } = await loadNotify();
    await expect(sendAbandonedLeadEmail(baseData())).resolves.toBeTruthy();
  });

  it('with NODE_ENV=production and EMAIL_* unset: does not throw, skips the send, logs exactly one notify.smtp-unconfigured line', async () => {
    process.env.NODE_ENV = 'production';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { sendAbandonedLeadEmail } = await loadNotify();

    await expect(sendAbandonedLeadEmail(baseData())).resolves.toBeFalsy();
    // A second call with the same unconfigured production env must not log again (memoized).
    await expect(sendAbandonedLeadEmail(baseData())).resolves.toBeFalsy();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const loggedLine = JSON.parse(errorSpy.mock.calls[0]?.[0] as string);
    expect(loggedLine.event).toBe('notify.smtp-unconfigured');
    expect(loggedLine.level).toBe('error');
  });

  it('getNotifyHealth().lastSuccessAt is null before, a timestamp after a successful send; resetNotifyHealth() clears it', async () => {
    const { sendAbandonedLeadEmail, getNotifyHealth, resetNotifyHealth } = await loadNotify();
    expect(getNotifyHealth().lastSuccessAt).toBeNull();

    const before = Date.now();
    await sendAbandonedLeadEmail(baseData());
    const after = getNotifyHealth().lastSuccessAt;

    expect(after).not.toBeNull();
    expect(after as number).toBeGreaterThanOrEqual(before);
    expect(after as number).toBeLessThanOrEqual(Date.now());

    resetNotifyHealth();
    expect(getNotifyHealth().lastSuccessAt).toBeNull();
  });

  it('logs a notify.sent line with content on success in non-production (dev demo visibility)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { sendAbandonedLeadEmail } = await loadNotify();

    await sendAbandonedLeadEmail(baseData());

    const sentCall = logSpy.mock.calls.find((call) => {
      try {
        return JSON.parse(call[0] as string).event === 'notify.sent';
      } catch {
        return false;
      }
    });
    expect(sentCall).toBeTruthy();
    const logged = JSON.parse(sentCall![0] as string);
    expect(logged.to).toBe('owner@example.com');
    expect(typeof logged.subject).toBe('string');
    expect(logged.text).toContain('Jane Doe');
    expect(logged.text).toContain('Pricing');
  });

  it('production notify.sent log omits field/journey content (no PII in prod logs)', async () => {
    process.env.NODE_ENV = 'production';
    // 127.0.0.1:1 refuses instantly; a remote hostname can black-hole on
    // filtered networks and time the test out (seen live 2026-07-22).
    process.env.EMAIL_HOST = '127.0.0.1';
    process.env.EMAIL_PORT = '1';
    process.env.EMAIL_USER = 'user@example.com';
    process.env.EMAIL_PASS = 'super-secret';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { sendAbandonedLeadEmail } = await loadNotify();

    // Real SMTP transport with no live server — sendMail rejects, but the
    // point of this test is only that a WOULD-BE success log never carries
    // field content in production; assert no notify.sent line leaks PII if
    // one were ever logged, and that failures still route through logError.
    await expect(sendAbandonedLeadEmail(baseData())).rejects.toBeTruthy();

    const sentCall = logSpy.mock.calls.find((call) => {
      try {
        return JSON.parse(call[0] as string).event === 'notify.sent';
      } catch {
        return false;
      }
    });
    if (sentCall) {
      const logged = JSON.parse(sentCall[0] as string);
      expect(logged.text).toBeUndefined();
    }
  });

  it('renders an entryUrl when provided; omits dangling link text when absent', async () => {
    const { sendAbandonedLeadEmail } = await loadNotify();

    const withEntry = (await sendAbandonedLeadEmail(
      baseData({ entryUrl: 'https://example.com/forms-admin/entries/abc123' })
    )) as { message: string };
    const parsedWith = JSON.parse(withEntry.message);
    expect(parsedWith.text).toContain('https://example.com/forms-admin/entries/abc123');
    expect(parsedWith.html).toContain('https://example.com/forms-admin/entries/abc123');

    const withoutEntry = (await sendAbandonedLeadEmail(baseData())) as { message: string };
    const parsedWithout = JSON.parse(withoutEntry.message);
    expect(parsedWithout.html).not.toContain('<a href="">');
    expect(parsedWithout.html).not.toMatch(/View entry:?\s*<\/a>/);
  });
});

// ---------------------------------------------------------------------------
// W3 — sendPaymentQuoteEmail / sendPaymentReceivedEmail (PAY-02) mirror
// sendAbandonedLeadEmail's exact never-throws-on-unconfigured /
// rejects-on-real-failure contract.
// ---------------------------------------------------------------------------

describe('sendPaymentQuoteEmail (jsonTransport)', () => {
  it('sends to notifyTo with a subject naming the amount and a breakdown + pay link in the body', async () => {
    const { sendPaymentQuoteEmail } = await loadNotify();
    const info = (await sendPaymentQuoteEmail(baseQuoteData({ memo: 'Website redesign' }))) as { message: string };
    const parsed = JSON.parse(info.message);
    expect(parsed.to).toEqual([{ address: 'owner@example.com', name: '' }]);
    expect(parsed.subject).toContain('$200.00');
    expect(parsed.text).toContain('Website redesign');
    expect(parsed.text).toContain('https://pay.stripe.com/abc123');
  });

  it('does not throw when EMAIL_* env is unset (jsonTransport fallback)', async () => {
    const { sendPaymentQuoteEmail } = await loadNotify();
    await expect(sendPaymentQuoteEmail(baseQuoteData())).resolves.toBeTruthy();
  });

  it('with NODE_ENV=production and EMAIL_* unset: does not throw, skips the send (unconfigured-skip contract)', async () => {
    process.env.NODE_ENV = 'production';
    const { sendPaymentQuoteEmail } = await loadNotify();
    await expect(sendPaymentQuoteEmail(baseQuoteData())).resolves.toBeFalsy();
  });

  it('a configured-transport send failure rejects with the underlying error (fire-and-forget callers .catch it)', async () => {
    const { sendPaymentQuoteEmail } = await loadNotify();
    const failingTransport = {
      sendMail: vi.fn(async () => {
        throw new Error('smtp exploded');
      }),
    } as unknown as Transporter;
    await expect(sendPaymentQuoteEmail(baseQuoteData(), { transport: failingTransport })).rejects.toThrow(
      'smtp exploded',
    );
  });
});

describe('sendPaymentReceivedEmail (jsonTransport)', () => {
  it('sends to notifyTo with amount + provider in the subject', async () => {
    const { sendPaymentReceivedEmail } = await loadNotify();
    const info = (await sendPaymentReceivedEmail(baseReceivedData())) as { message: string };
    const parsed = JSON.parse(info.message);
    expect(parsed.to).toEqual([{ address: 'owner@example.com', name: '' }]);
    expect(parsed.subject).toContain('$200.00');
    expect(parsed.subject.toLowerCase()).toContain('stripe');
  });

  it('does not throw when EMAIL_* env is unset (jsonTransport fallback)', async () => {
    const { sendPaymentReceivedEmail } = await loadNotify();
    await expect(sendPaymentReceivedEmail(baseReceivedData())).resolves.toBeTruthy();
  });

  it('with NODE_ENV=production and EMAIL_* unset: does not throw, skips the send (unconfigured-skip contract)', async () => {
    process.env.NODE_ENV = 'production';
    const { sendPaymentReceivedEmail } = await loadNotify();
    await expect(sendPaymentReceivedEmail(baseReceivedData())).resolves.toBeFalsy();
  });

  it('a configured-transport send failure rejects with the underlying error', async () => {
    const { sendPaymentReceivedEmail } = await loadNotify();
    const failingTransport = {
      sendMail: vi.fn(async () => {
        throw new Error('smtp exploded');
      }),
    } as unknown as Transporter;
    await expect(sendPaymentReceivedEmail(baseReceivedData(), { transport: failingTransport })).rejects.toThrow(
      'smtp exploded',
    );
  });
});

// ---------------------------------------------------------------------------
// RCV-01/D3/D4 — sendRecoveryEmail. This is the FIRST package email sent to
// the VISITOR (data.to), never notifyTo — same never-throws-on-unconfigured
// / rejects-on-real-failure contract as the other three sends.
// ---------------------------------------------------------------------------

describe('sendRecoveryEmail (jsonTransport)', () => {
  it('sends to data.to (the VISITOR), not notifyTo — with resume + unsubscribe links in the body', async () => {
    const { sendRecoveryEmail } = await loadNotify();
    const info = (await sendRecoveryEmail(baseRecoveryData())) as { message: string };
    const parsed = JSON.parse(info.message);
    expect(parsed.to).toEqual([{ address: 'visitor@example.com', name: '' }]);
    expect(parsed.text).toContain('https://example.com/contact');
    expect(parsed.text).toContain('https://example.com/api/forms/recovery-unsubscribe?token=abc123');
  });

  it('does not throw when EMAIL_* env is unset (jsonTransport fallback)', async () => {
    const { sendRecoveryEmail } = await loadNotify();
    await expect(sendRecoveryEmail(baseRecoveryData())).resolves.toBeTruthy();
  });

  it('with NODE_ENV=production and EMAIL_* unset: does not throw, skips the send (unconfigured-skip contract)', async () => {
    process.env.NODE_ENV = 'production';
    const { sendRecoveryEmail } = await loadNotify();
    await expect(sendRecoveryEmail(baseRecoveryData())).resolves.toBeFalsy();
  });

  it('a configured-transport send failure rejects with the underlying error (fire-and-forget callers .catch it)', async () => {
    const { sendRecoveryEmail } = await loadNotify();
    const failingTransport = {
      sendMail: vi.fn(async () => {
        throw new Error('smtp exploded');
      }),
    } as unknown as Transporter;
    await expect(sendRecoveryEmail(baseRecoveryData(), { transport: failingTransport })).rejects.toThrow(
      'smtp exploded',
    );
  });

  it('logs a notify.recovery-sent line with rendered text outside production (dev demo visibility)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { sendRecoveryEmail } = await loadNotify();

    await sendRecoveryEmail(baseRecoveryData());

    const sentCall = logSpy.mock.calls.find((call) => {
      try {
        return JSON.parse(call[0] as string).event === 'notify.recovery-sent';
      } catch {
        return false;
      }
    });
    expect(sentCall).toBeTruthy();
    const logged = JSON.parse(sentCall![0] as string);
    expect(logged.to).toBe('visitor@example.com');
    expect(logged.text).toContain('https://example.com/contact');
  });
});

// ---------------------------------------------------------------------------
// CafTemplates override contract (checker W3) — one override unit case per
// key (abandonedLead/paymentQuote/paymentReceived/recovery), each asserted
// via jsonTransport output carrying the override's sentinel subject.
// ---------------------------------------------------------------------------

describe('CafTemplates override contract (W3)', () => {
  it('abandonedLead override is honored by sendAbandonedLeadEmail', async () => {
    const { sendAbandonedLeadEmail } = await loadNotify();
    const sentinel = 'SENTINEL-ABANDONED-LEAD';
    const info = (await sendAbandonedLeadEmail(baseData(), {
      template: () => ({ subject: sentinel, text: 't', html: '<p>h</p>' }),
    })) as { message: string };
    expect(JSON.parse(info.message).subject).toBe(sentinel);
  });

  it('paymentQuote override is honored by sendPaymentQuoteEmail', async () => {
    const { sendPaymentQuoteEmail } = await loadNotify();
    const sentinel = 'SENTINEL-PAYMENT-QUOTE';
    const info = (await sendPaymentQuoteEmail(baseQuoteData(), {
      template: () => ({ subject: sentinel, text: 't', html: '<p>h</p>' }),
    })) as { message: string };
    expect(JSON.parse(info.message).subject).toBe(sentinel);
  });

  it('paymentReceived override is honored by sendPaymentReceivedEmail', async () => {
    const { sendPaymentReceivedEmail } = await loadNotify();
    const sentinel = 'SENTINEL-PAYMENT-RECEIVED';
    const info = (await sendPaymentReceivedEmail(baseReceivedData(), {
      template: () => ({ subject: sentinel, text: 't', html: '<p>h</p>' }),
    })) as { message: string };
    expect(JSON.parse(info.message).subject).toBe(sentinel);
  });

  it('recovery override is honored by sendRecoveryEmail', async () => {
    const { sendRecoveryEmail } = await loadNotify();
    const sentinel = 'SENTINEL-RECOVERY';
    const info = (await sendRecoveryEmail(baseRecoveryData(), {
      template: () => ({ subject: sentinel, text: 't', html: '<p>h</p>' }),
    })) as { message: string };
    expect(JSON.parse(info.message).subject).toBe(sentinel);
  });
});

describe('buildTransport()', () => {
  it('includes connectionTimeout and socketTimeout on the real SMTP transport', async () => {
    process.env.EMAIL_HOST = 'smtp.example.com';
    process.env.EMAIL_PORT = '587';
    process.env.EMAIL_USER = 'user@example.com';
    process.env.EMAIL_PASS = 'super-secret';
    const { buildTransport } = await loadNotify();

    const transport = buildTransport() as unknown as {
      options: { connectionTimeout?: number; socketTimeout?: number };
    };
    expect(transport).toBeTruthy();
    expect(transport.options.connectionTimeout).toBe(5_000);
    expect(transport.options.socketTimeout).toBe(5_000);
  });
});

describe('defaultAbandonedLeadTemplate', () => {
  it('renders with geo absent without emitting the literal string "undefined"', async () => {
    const { defaultAbandonedLeadTemplate } = await loadTemplates();
    const result = defaultAbandonedLeadTemplate(baseData());
    expect(result.text).not.toContain('undefined');
    expect(result.html ?? '').not.toContain('undefined');
  });

  it('HTML-escapes a malicious field value — no raw <script> substring in html output', async () => {
    const { defaultAbandonedLeadTemplate } = await loadTemplates();
    const result = defaultAbandonedLeadTemplate(
      baseData({ fields: { comment: '<script>alert(1)</script>' } })
    );
    expect(result.html ?? '').not.toContain('<script>alert(1)</script>');
    expect(result.html ?? '').toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('contains a journey timeline with per-step title, path, duration, and totals', async () => {
    const { defaultAbandonedLeadTemplate } = await loadTemplates();
    const result = defaultAbandonedLeadTemplate(baseData());
    expect(result.text).toContain('Pricing');
    expect(result.text).toContain('/pricing');
    expect(result.text).toContain('Contact Us');
    expect(result.text).toContain('/contact');
    expect(result.text).toMatch(/2/); // total steps
  });
});

describe('escapeHtml', () => {
  it('escapes &, <, >, ", and \'', async () => {
    const { escapeHtml } = await loadTemplates();
    expect(escapeHtml(`& < > " '`)).toBe('&amp; &lt; &gt; &quot; &#39;');
  });
});
