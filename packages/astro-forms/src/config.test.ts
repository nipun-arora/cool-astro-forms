import { describe, it, expect } from 'vitest';
import { parseConfig } from './config.js';
import { DEFAULT_ALLOWED_CURRENCIES } from './limits.js';
import { DEFAULT_MIN_AMOUNT_CENTS, DEFAULT_MAX_AMOUNT_CENTS } from './server/payment-constants.js';
import {
  DEFAULT_ATTACHMENT_FALLBACK_MAX_BYTES,
  DEFAULT_DRIVE_ROOT_FOLDER,
  DEFAULT_RECOVERY_DELAY_MINS,
} from './server/drive-recovery-constants.js';

/**
 * Phase 3 (payments + webhooks) config validation. Existing fields
 * (siteId/siteUrl/forms/geo/admin/...) are exercised indirectly by every
 * other test suite that calls parseConfig; this file is scoped to the
 * `payments`/`webhooks` subtrees added in 03-01.
 */
function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    siteId: 'site-a',
    siteUrl: 'https://example.com',
    ...overrides,
  };
}

describe('parseConfig — payments subtree (Phase 3)', () => {
  it('accepts a valid payments config and echoes the values back', () => {
    const parsed = parseConfig(
      baseConfig({
        payments: {
          payLinkFees: [{ label: 'Card fee', percent: 0.05 }],
          requestPage: { minAmountCents: 100, maxAmountCents: 1_000_000, allowedCurrencies: ['usd'] },
        },
      }),
    );
    expect(parsed.payments.payLinkFees).toEqual([{ label: 'Card fee', percent: 0.05 }]);
    expect(parsed.payments.requestPage.minAmountCents).toBe(100);
    expect(parsed.payments.requestPage.maxAmountCents).toBe(1_000_000);
    expect(parsed.payments.requestPage.allowedCurrencies).toEqual(['usd']);
  });

  it('defaults to an inert payments config when omitted entirely', () => {
    const parsed = parseConfig(baseConfig());
    expect(parsed.payments.payLinkFees).toEqual([]);
    expect(parsed.payments.requestPage.minAmountCents).toBe(DEFAULT_MIN_AMOUNT_CENTS);
    expect(parsed.payments.requestPage.maxAmountCents).toBe(DEFAULT_MAX_AMOUNT_CENTS);
    expect(parsed.payments.requestPage.allowedCurrencies).toEqual([...DEFAULT_ALLOWED_CURRENCIES]);
  });

  it('rejects a FeeLine with BOTH percent and flatCents set', () => {
    expect(() =>
      parseConfig(baseConfig({ payments: { payLinkFees: [{ label: 'x', percent: 0.05, flatCents: 100 }] } })),
    ).toThrow();
  });

  it('rejects a FeeLine with NEITHER percent nor flatCents set', () => {
    expect(() => parseConfig(baseConfig({ payments: { payLinkFees: [{ label: 'x' }] } }))).toThrow();
  });

  it('accepts a FeeLine with exactly one of percent or flatCents', () => {
    expect(() =>
      parseConfig(baseConfig({ payments: { payLinkFees: [{ label: 'x', percent: 0.05 }] } })),
    ).not.toThrow();
    expect(() =>
      parseConfig(baseConfig({ payments: { payLinkFees: [{ label: 'y', flatCents: 100 }] } })),
    ).not.toThrow();
  });
});

describe('parseConfig — webhooks subtree (Phase 3)', () => {
  it('accepts a valid webhook target', () => {
    const parsed = parseConfig(
      baseConfig({ webhooks: [{ url: 'https://hooks.example/x', secret: 's', events: ['payment.paid'] }] }),
    );
    expect(parsed.webhooks).toEqual([{ url: 'https://hooks.example/x', secret: 's', events: ['payment.paid'] }]);
  });

  it('rejects a webhook with a non-URL url', () => {
    expect(() =>
      parseConfig(baseConfig({ webhooks: [{ url: 'not-a-url', secret: 's' }] })),
    ).toThrow();
  });

  it('rejects a webhook with an empty secret', () => {
    expect(() =>
      parseConfig(baseConfig({ webhooks: [{ url: 'https://hooks.example/x', secret: '' }] })),
    ).toThrow();
  });

  it('defaults to an empty array when omitted', () => {
    const parsed = parseConfig(baseConfig());
    expect(parsed.webhooks).toEqual([]);
  });
});

describe('parseConfig — payments and webhooks both omitted', () => {
  it('still parses to inert defaults ([] fees, [] webhooks)', () => {
    const parsed = parseConfig(baseConfig());
    expect(parsed.payments.payLinkFees).toEqual([]);
    expect(parsed.webhooks).toEqual([]);
  });
});

/**
 * Phase 4 (Drive files + lead recovery) config validation — the `drive`/
 * `recovery` subtrees added in 04-01. RED-first: written before
 * driveConfigSchema/recoveryConfigSchema exist on coolFormsConfigSchema.
 */
describe('parseConfig — drive subtree (Phase 4)', () => {
  it('accepts a valid drive config and echoes the values back', () => {
    const parsed = parseConfig(
      baseConfig({
        drive: { linkAccess: 'anyone', attachmentFallbackMaxBytes: 5000000, rootFolderName: 'my-forms' },
      }),
    );
    expect(parsed.drive.linkAccess).toBe('anyone');
    expect(parsed.drive.attachmentFallbackMaxBytes).toBe(5000000);
    expect(parsed.drive.rootFolderName).toBe('my-forms');
  });

  it('defaults to the safe drive config when omitted (private links, package defaults)', () => {
    const parsed = parseConfig(baseConfig());
    expect(parsed.drive.linkAccess).toBe('private');
    expect(parsed.drive.attachmentFallbackMaxBytes).toBe(DEFAULT_ATTACHMENT_FALLBACK_MAX_BYTES);
    expect(parsed.drive.rootFolderName).toBe(DEFAULT_DRIVE_ROOT_FOLDER);
  });

  it('rejects a drive.linkAccess value other than anyone|private', () => {
    expect(() => parseConfig(baseConfig({ drive: { linkAccess: 'public' } }))).toThrow();
  });
});

describe('parseConfig — recovery subtree (Phase 4)', () => {
  it('accepts a valid recovery config and echoes the values back', () => {
    const parsed = parseConfig(
      baseConfig({ recovery: { enabled: true, delayMins: 30, consentMode: 'checkbox' } }),
    );
    expect(parsed.recovery.enabled).toBe(true);
    expect(parsed.recovery.delayMins).toBe(30);
    expect(parsed.recovery.consentMode).toBe('checkbox');
  });

  it('defaults to the inert recovery config when omitted (disabled, 60min, auto)', () => {
    const parsed = parseConfig(baseConfig());
    expect(parsed.recovery.enabled).toBe(false);
    expect(parsed.recovery.delayMins).toBe(DEFAULT_RECOVERY_DELAY_MINS);
    expect(parsed.recovery.consentMode).toBe('auto');
  });

  it('rejects a recovery.consentMode value other than auto|checkbox', () => {
    expect(() => parseConfig(baseConfig({ recovery: { consentMode: 'bogus' } }))).toThrow();
  });

  it('rejects a non-positive recovery.delayMins', () => {
    expect(() => parseConfig(baseConfig({ recovery: { delayMins: 0 } }))).toThrow();
    expect(() => parseConfig(baseConfig({ recovery: { delayMins: -5 } }))).toThrow();
  });
});

describe('parseConfig — drive and recovery both omitted', () => {
  it('still parses to inert defaults (private/unset drive, disabled recovery)', () => {
    const parsed = parseConfig(baseConfig());
    expect(parsed.drive.linkAccess).toBe('private');
    expect(parsed.recovery.enabled).toBe(false);
  });
});

/**
 * Per-form recovery override (04-10 gap closure, RCV-01/ROADMAP Phase 4
 * SC4 "per-form flag"). RED-first: written before formConfigSchema carries
 * a `recovery` key. The site-wide recoveryConfigSchema (above) is
 * untouched — this is a SEPARATE per-form subtree on formConfigSchema.
 */
describe('parseConfig — per-form recovery override (04-10)', () => {
  function baseConfigWithForm(formRecovery?: Record<string, unknown>): Record<string, unknown> {
    return baseConfig({
      forms: {
        'contact-form': {
          notifyTo: 'owner@example.com',
          ...(formRecovery !== undefined ? { recovery: formRecovery } : {}),
        },
      },
    });
  }

  it('accepts an optional per-form recovery.enabled:false override and echoes it back', () => {
    const parsed = parseConfig(baseConfigWithForm({ enabled: false }));
    expect(parsed.forms['contact-form']!.recovery?.enabled).toBe(false);
  });

  it('accepts an optional per-form recovery.enabled:true override and echoes it back', () => {
    const parsed = parseConfig(baseConfigWithForm({ enabled: true }));
    expect(parsed.forms['contact-form']!.recovery?.enabled).toBe(true);
  });

  it('a form without the recovery key still parses — undefined (inherit the site-wide default)', () => {
    const parsed = parseConfig(baseConfigWithForm());
    expect(parsed.forms['contact-form']!.recovery).toBeUndefined();
  });

  it('rejects a non-boolean per-form recovery.enabled', () => {
    expect(() => parseConfig(baseConfigWithForm({ enabled: 'yes' }))).toThrow();
  });

  it('rejects an unknown-shape (non-object) per-form recovery value', () => {
    expect(() =>
      parseConfig({
        ...baseConfig(),
        forms: { 'contact-form': { notifyTo: 'owner@example.com', recovery: 'bogus' } },
      }),
    ).toThrow();
  });

  it('leaves the site-wide recovery subtree unaffected by a per-form override', () => {
    const parsed = parseConfig({
      ...baseConfigWithForm({ enabled: false }),
      recovery: { enabled: true, delayMins: 90, consentMode: 'checkbox' },
    });
    expect(parsed.recovery.enabled).toBe(true);
    expect(parsed.recovery.delayMins).toBe(90);
    expect(parsed.recovery.consentMode).toBe('checkbox');
    expect(parsed.forms['contact-form']!.recovery?.enabled).toBe(false);
  });
});

/**
 * Phase 5, Plan 02 (D2 fix #1, ADPT-01): the rateLimit.store opt-in.
 * 'memory' (default) must stay byte-identical to pre-Phase-5 configs that
 * never mention rateLimit at all.
 */
describe('parseConfig — rateLimit subtree (Phase 5, D2 fix #1)', () => {
  it('defaults to store: "memory" when the rateLimit key is omitted entirely', () => {
    const parsed = parseConfig(baseConfig());
    expect(parsed.rateLimit.store).toBe('memory');
  });

  it('accepts an explicit store: "memory" and echoes it back', () => {
    const parsed = parseConfig(baseConfig({ rateLimit: { store: 'memory' } }));
    expect(parsed.rateLimit.store).toBe('memory');
  });

  it('accepts an explicit store: "storage" opt-in', () => {
    const parsed = parseConfig(baseConfig({ rateLimit: { store: 'storage' } }));
    expect(parsed.rateLimit.store).toBe('storage');
  });

  it('rejects an unknown rateLimit.store value', () => {
    expect(() => parseConfig(baseConfig({ rateLimit: { store: 'redis' } }))).toThrow();
  });
});

/**
 * Phase 5, Plan 04 (ADPT-01): the storage.kind backend selector. 'sqlite'
 * (default) must stay byte-identical to pre-Phase-5 configs that never
 * mention storage at all — `dbPath` stays top-level and independent.
 */
describe('parseConfig — storage subtree (Phase 5, ADPT-01)', () => {
  it('defaults to kind: "sqlite" when the storage key is omitted entirely (existing configs parse unchanged)', () => {
    const parsed = parseConfig(baseConfig());
    expect(parsed.storage.kind).toBe('sqlite');
  });

  it('accepts an explicit kind: "sqlite" and echoes it back', () => {
    const parsed = parseConfig(baseConfig({ storage: { kind: 'sqlite' } }));
    expect(parsed.storage.kind).toBe('sqlite');
  });

  it('accepts an explicit kind: "turso" opt-in', () => {
    const parsed = parseConfig(baseConfig({ storage: { kind: 'turso' } }));
    expect(parsed.storage.kind).toBe('turso');
  });

  it('rejects an unknown storage.kind value', () => {
    expect(() => parseConfig(baseConfig({ storage: { kind: 'postgres' } }))).toThrow();
  });

  it('keeps dbPath top-level and independent of storage.kind (backward compatible)', () => {
    const parsed = parseConfig(baseConfig({ dbPath: 'custom/path.db', storage: { kind: 'turso' } }));
    expect(parsed.dbPath).toBe('custom/path.db');
    expect(parsed.storage.kind).toBe('turso');
  });
});
