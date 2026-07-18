/**
 * The per-form recovery resolution precedence (04-10 gap closure,
 * RCV-01/ROADMAP Phase 4 SC4 "per-form flag"). This is the ONE shared
 * implementation every consumer (handle-abandon.ts's consent gate,
 * sweep.ts's eligibility filter, integration.ts's public-config subset)
 * imports — pinned here as a 4-cell truth table so no consumer can drift.
 *
 * RED-first: written before resolve.ts exists.
 */
import { describe, expect, it } from 'vitest';
import type { CoolFormsConfig } from '../../config.js';
import { recoveryDisabledFormIds, recoveryEnabledForForm } from './resolve.js';

type ResolveConfig = Pick<CoolFormsConfig, 'recovery' | 'forms'>;

function makeConfig(overrides: Partial<ResolveConfig> = {}): ResolveConfig {
  return {
    recovery: { enabled: true, delayMins: 60, consentMode: 'auto' },
    forms: {},
    ...overrides,
  };
}

describe('recoveryEnabledForForm — 4-cell precedence', () => {
  it('site ON + form absent => true (inherit)', () => {
    const config = makeConfig({ recovery: { enabled: true, delayMins: 60, consentMode: 'auto' }, forms: {} });
    expect(recoveryEnabledForForm(config, 'contact-form')).toBe(true);
  });

  it('site ON + form {enabled:false} => false', () => {
    const config = makeConfig({
      recovery: { enabled: true, delayMins: 60, consentMode: 'auto' },
      forms: { 'contact-form': { abandonment: { require: 'email-or-phone', dedupeWindowMins: 60, notifyOnUpdate: false }, notifyTo: 'a@b.com', recovery: { enabled: false } } },
    });
    expect(recoveryEnabledForForm(config, 'contact-form')).toBe(false);
  });

  it('site ON + form {enabled:true} => true', () => {
    const config = makeConfig({
      recovery: { enabled: true, delayMins: 60, consentMode: 'auto' },
      forms: { 'contact-form': { abandonment: { require: 'email-or-phone', dedupeWindowMins: 60, notifyOnUpdate: false }, notifyTo: 'a@b.com', recovery: { enabled: true } } },
    });
    expect(recoveryEnabledForForm(config, 'contact-form')).toBe(true);
  });

  it('site OFF + form {enabled:true} => FALSE — the site switch is the hard gate, per-form true cannot override it', () => {
    const config = makeConfig({
      recovery: { enabled: false, delayMins: 60, consentMode: 'auto' },
      forms: { 'contact-form': { abandonment: { require: 'email-or-phone', dedupeWindowMins: 60, notifyOnUpdate: false }, notifyTo: 'a@b.com', recovery: { enabled: true } } },
    });
    expect(recoveryEnabledForForm(config, 'contact-form')).toBe(false);
  });

  it('site OFF + form absent => false', () => {
    const config = makeConfig({ recovery: { enabled: false, delayMins: 60, consentMode: 'auto' }, forms: {} });
    expect(recoveryEnabledForForm(config, 'contact-form')).toBe(false);
  });

  it('unknown formId (not present in config.forms) inherits the site value', () => {
    const onConfig = makeConfig({ recovery: { enabled: true, delayMins: 60, consentMode: 'auto' }, forms: {} });
    expect(recoveryEnabledForForm(onConfig, 'ghost-form')).toBe(true);

    const offConfig = makeConfig({ recovery: { enabled: false, delayMins: 60, consentMode: 'auto' }, forms: {} });
    expect(recoveryEnabledForForm(offConfig, 'ghost-form')).toBe(false);
  });
});

describe('recoveryDisabledFormIds', () => {
  it('returns exactly the ids whose per-form recovery.enabled === false', () => {
    const config = makeConfig({
      forms: {
        a: { abandonment: { require: 'email-or-phone', dedupeWindowMins: 60, notifyOnUpdate: false }, notifyTo: 'a@b.com' },
        b: {
          abandonment: { require: 'email-or-phone', dedupeWindowMins: 60, notifyOnUpdate: false },
          notifyTo: 'b@b.com',
          recovery: { enabled: false },
        },
        c: {
          abandonment: { require: 'email-or-phone', dedupeWindowMins: 60, notifyOnUpdate: false },
          notifyTo: 'c@b.com',
          recovery: { enabled: true },
        },
      },
    });
    expect(recoveryDisabledFormIds(config)).toEqual(['b']);
  });

  it('returns an empty array when no form has a per-form override', () => {
    const config = makeConfig({
      forms: {
        a: { abandonment: { require: 'email-or-phone', dedupeWindowMins: 60, notifyOnUpdate: false }, notifyTo: 'a@b.com' },
      },
    });
    expect(recoveryDisabledFormIds(config)).toEqual([]);
  });

  it('returns an empty array when config.forms is empty', () => {
    expect(recoveryDisabledFormIds(makeConfig({ forms: {} }))).toEqual([]);
  });
});
