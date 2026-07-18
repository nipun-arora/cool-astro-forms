/**
 * secrets-preflight.ts tests — D2 fix #2 (05-01, ADPT-01) boot preflight.
 * `assertExplicitSecrets(config)` is the per-request middleware guard: a
 * no-op when `CAF_REQUIRE_EXPLICIT_SECRETS` is off, and a var-named,
 * ephemeral-FS-rationale-bearing throw when the flag is on and a required
 * secret (FORMS_ADMIN_SECRET always; CAF_RECOVERY_SECRET when
 * `recovery.enabled`) is absent.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CoolFormsConfig } from '../../config.js';
import { assertExplicitSecrets } from './secrets-preflight.js';

const ORIGINAL_REQUIRE_EXPLICIT = process.env.CAF_REQUIRE_EXPLICIT_SECRETS;
const ORIGINAL_ADMIN_SECRET = process.env.FORMS_ADMIN_SECRET;
const ORIGINAL_RECOVERY_SECRET = process.env.CAF_RECOVERY_SECRET;

function makeConfig(recoveryEnabled: boolean): CoolFormsConfig {
  return { recovery: { enabled: recoveryEnabled, delayMins: 60, consentMode: 'auto' } } as CoolFormsConfig;
}

describe('assertExplicitSecrets', () => {
  beforeEach(() => {
    delete process.env.CAF_REQUIRE_EXPLICIT_SECRETS;
    delete process.env.FORMS_ADMIN_SECRET;
    delete process.env.CAF_RECOVERY_SECRET;
  });

  afterEach(() => {
    if (ORIGINAL_REQUIRE_EXPLICIT === undefined) delete process.env.CAF_REQUIRE_EXPLICIT_SECRETS;
    else process.env.CAF_REQUIRE_EXPLICIT_SECRETS = ORIGINAL_REQUIRE_EXPLICIT;
    if (ORIGINAL_ADMIN_SECRET === undefined) delete process.env.FORMS_ADMIN_SECRET;
    else process.env.FORMS_ADMIN_SECRET = ORIGINAL_ADMIN_SECRET;
    if (ORIGINAL_RECOVERY_SECRET === undefined) delete process.env.CAF_RECOVERY_SECRET;
    else process.env.CAF_RECOVERY_SECRET = ORIGINAL_RECOVERY_SECRET;
  });

  describe('flag off (CAF_REQUIRE_EXPLICIT_SECRETS unset)', () => {
    it('is a no-op even with every secret absent and recovery enabled', () => {
      expect(() => assertExplicitSecrets(makeConfig(true))).not.toThrow();
    });

    it('is a no-op with recovery disabled and both secrets absent', () => {
      expect(() => assertExplicitSecrets(makeConfig(false))).not.toThrow();
    });
  });

  describe('flag on (CAF_REQUIRE_EXPLICIT_SECRETS=1)', () => {
    beforeEach(() => {
      process.env.CAF_REQUIRE_EXPLICIT_SECRETS = '1';
    });

    it('throws naming FORMS_ADMIN_SECRET when it is absent, recovery disabled', () => {
      expect(() => assertExplicitSecrets(makeConfig(false))).toThrow(/FORMS_ADMIN_SECRET/);
      expect(() => assertExplicitSecrets(makeConfig(false))).toThrow(/cold start/i);
    });

    it('throws naming FORMS_ADMIN_SECRET when it is absent, even with recovery enabled and CAF_RECOVERY_SECRET present', () => {
      process.env.CAF_RECOVERY_SECRET = 'recovery-secret-present';
      expect(() => assertExplicitSecrets(makeConfig(true))).toThrow(/FORMS_ADMIN_SECRET/);
    });

    it('returns cleanly when FORMS_ADMIN_SECRET is present and recovery is disabled', () => {
      process.env.FORMS_ADMIN_SECRET = 'admin-secret-present';
      expect(() => assertExplicitSecrets(makeConfig(false))).not.toThrow();
    });

    it('throws naming CAF_RECOVERY_SECRET when recovery is enabled, FORMS_ADMIN_SECRET present, CAF_RECOVERY_SECRET absent', () => {
      process.env.FORMS_ADMIN_SECRET = 'admin-secret-present';
      expect(() => assertExplicitSecrets(makeConfig(true))).toThrow(/CAF_RECOVERY_SECRET/);
      expect(() => assertExplicitSecrets(makeConfig(true))).toThrow(/cold start/i);
    });

    it('does NOT check CAF_RECOVERY_SECRET when recovery is disabled', () => {
      process.env.FORMS_ADMIN_SECRET = 'admin-secret-present';
      expect(() => assertExplicitSecrets(makeConfig(false))).not.toThrow();
    });

    it('returns cleanly when both required secrets are present and recovery is enabled', () => {
      process.env.FORMS_ADMIN_SECRET = 'admin-secret-present';
      process.env.CAF_RECOVERY_SECRET = 'recovery-secret-present';
      expect(() => assertExplicitSecrets(makeConfig(true))).not.toThrow();
    });
  });

  describe('idempotency', () => {
    it('is safe to call repeatedly with no side effects (pure env/config check)', () => {
      process.env.CAF_REQUIRE_EXPLICIT_SECRETS = '1';
      process.env.FORMS_ADMIN_SECRET = 'admin-secret-present';
      const config = makeConfig(false);
      expect(() => {
        assertExplicitSecrets(config);
        assertExplicitSecrets(config);
        assertExplicitSecrets(config);
      }).not.toThrow();
    });
  });
});
