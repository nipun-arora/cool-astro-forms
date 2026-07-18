/**
 * D2 fix #2 boot preflight (05-01, ADPT-01): called on every request
 * (middleware.ts, pre-order) so a misconfigured serverless deploy fails
 * LOUD on request #1 instead of silently falling back to a disk-persisted
 * secret that regenerates on every cold start (05-RESEARCH.md Pitfall 2 —
 * an ephemeral filesystem breaks HMAC continuity for both admin sessions
 * and unsubscribe links). Reuses admin-secret.ts's
 * `explicitSecretsRequired()` reader so this preflight, `resolveAdminSecret`,
 * and `resolveRecoverySecret` all read the exact same on/off boundary.
 *
 * Idempotent and cheap: two env reads plus one config-field read, no disk
 * I/O, no allocation beyond the checks — safe to call unconditionally on
 * every request.
 */
import type { CoolFormsConfig } from '../../config.js';
import { explicitSecretMissingMessage, explicitSecretsRequired } from './admin-secret.js';

/**
 * Throws when `CAF_REQUIRE_EXPLICIT_SECRETS` is on and a required secret is
 * absent: `FORMS_ADMIN_SECRET` always; `CAF_RECOVERY_SECRET` additionally
 * when `config.recovery.enabled`. No-op when the flag is off, or when every
 * required secret is present.
 */
export function assertExplicitSecrets(config: CoolFormsConfig): void {
  if (!explicitSecretsRequired()) return;

  if (!process.env.FORMS_ADMIN_SECRET) {
    throw new Error(explicitSecretMissingMessage('FORMS_ADMIN_SECRET'));
  }

  if (config.recovery.enabled && !process.env.CAF_RECOVERY_SECRET) {
    throw new Error(explicitSecretMissingMessage('CAF_RECOVERY_SECRET'));
  }
}
