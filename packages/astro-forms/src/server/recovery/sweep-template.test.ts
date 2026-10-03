/**
 * The `templates.recovery` override (CafTemplates) reaches the recovery
 * email. Up to 0.1.14 the key was typed and documented but never read: the
 * middleware runs the sweep with no `send`, the sweep fell back to
 * `sendRecoveryEmail` with no template, and a host's branded recovery
 * template was silently ignored while its other three overrides worked.
 * notify.ts is mocked here so the test sees exactly what the sweep passes.
 */
import { describe, expect, it, vi } from 'vitest';

const { sendRecoveryEmailMock } = vi.hoisted(() => ({
  sendRecoveryEmailMock: vi.fn(async (_data: unknown, _opts?: unknown) => ({})),
}));
vi.mock('../notify.js', () => ({ sendRecoveryEmail: sendRecoveryEmailMock }));

import type { CoolFormsConfig } from '../../config.js';
import type { Entry } from '../../types.js';
import type { StorageAdapter } from '../storage/adapter.js';
import { runRecoverySweep } from './sweep.js';

function makeConfig(templates?: unknown): CoolFormsConfig {
  return {
    siteId: 'demo-site',
    siteUrl: 'https://example.com',
    forms: {},
    requireConsent: false,
    journeyParams: false,
    retentionDays: 90,
    dbPath: 'data/forms.db',
    geo: { enabled: true, providerUrl: 'https://ipwho.is/{ip}', timeoutMs: 3000 },
    admin: { sessionTtlDays: 7 },
    payments: {
      payLinkFees: [],
      feeOverrides: 'off',
      requestPage: { minAmountCents: 100, maxAmountCents: 1_000_000, allowedCurrencies: ['usd'] },
    },
    webhooks: [],
    drive: { linkAccess: 'private', attachmentFallbackMaxBytes: 10_485_760, rootFolderName: 'cool-astro-forms' },
    recovery: { enabled: true, delayMins: 60, consentMode: 'auto' },
    rateLimit: { store: 'memory' },
    storage: { kind: 'sqlite' },
    ...(templates ? { templates } : {}),
  } as unknown as CoolFormsConfig;
}

function makeStorage(): StorageAdapter {
  const entry: Entry = {
    id: 'entry-1',
    siteId: 'demo-site',
    formId: 'contact',
    status: 'abandoned',
    fields: { email: 'visitor@example.com' },
    visitorUuid: 'visitor-1',
    createdAt: 1000,
    updatedAt: 1000,
  };
  return {
    findRecoverableEntries: vi.fn(async () => [entry]),
    markRecoverySent: vi.fn(async () => true),
  } as unknown as StorageAdapter;
}

describe('runRecoverySweep — templates.recovery override', () => {
  it("passes the host's recovery template to sendRecoveryEmail when no send dep is injected (the middleware's path)", async () => {
    sendRecoveryEmailMock.mockClear();
    const recovery = () => ({ subject: 'Branded recovery', text: 't' });

    await runRecoverySweep({
      storage: makeStorage(),
      config: makeConfig({ recovery }),
      resolveSecret: () => 'secret',
      now: () => 10_000_000,
    });

    expect(sendRecoveryEmailMock).toHaveBeenCalledTimes(1);
    const [data, opts] = sendRecoveryEmailMock.mock.calls[0]!;
    expect(data).toMatchObject({ to: 'visitor@example.com' });
    expect((opts as { template?: unknown }).template).toBe(recovery);
  });

  it('passes no template (the package default) when the host has no templatesModule', async () => {
    sendRecoveryEmailMock.mockClear();

    await runRecoverySweep({
      storage: makeStorage(),
      config: makeConfig(),
      resolveSecret: () => 'secret',
      now: () => 10_000_000,
    });

    expect(sendRecoveryEmailMock).toHaveBeenCalledTimes(1);
    const [, opts] = sendRecoveryEmailMock.mock.calls[0]!;
    expect((opts as { template?: unknown } | undefined)?.template).toBeUndefined();
  });
});
