/**
 * Per-form recovery override resolution (04-10 gap closure — RCV-01/
 * ROADMAP Phase 4 SC4 "optional, per-form flag"). ONE shared implementation
 * of the precedence — consumed by handle-abandon.ts (consent-recording
 * gate), sweep.ts (per-row eligibility filter), and integration.ts
 * (build-time __cafConfig.recovery.disabledForms subset) — so the four
 * consumers this gap-closure plan targets cannot hand-roll (and drift on)
 * the same logic.
 *
 * Precedence (the full 4-cell truth table):
 *   site ON  + form absent         => true  (inherit the site-wide switch)
 *   site ON  + form {enabled:false} => false (per-form turns THIS form off)
 *   site ON  + form {enabled:true}  => true
 *   site OFF + form {enabled:true}  => FALSE — the site-wide switch is the
 *     hard gate; a per-form `true` can NEVER turn recovery on when the site
 *     switch is off. This is why integration.ts's route/script injection
 *     (gated on `config.recovery.enabled` alone) is deliberately left
 *     unchanged by this plan: the unsubscribe route only needs to exist
 *     when the site switch is on, regardless of any per-form value.
 *   site OFF + form absent          => false
 *
 * An unknown formId (not present in `config.forms`) inherits the site-wide
 * value. In practice this only occurs if a host deletes a form from config
 * after leads already exist for it (handle-abandon.ts rejects unknown
 * formIds at its own gate, so a live request can never reach this resolver
 * with an unconfigured form) — inheriting the site default is the safe
 * choice: it fails toward "the site switch still controls it," never
 * toward a silent per-form leak the host never configured.
 */
import type { CoolFormsConfig } from '../../config.js';

type ResolveConfig = Pick<CoolFormsConfig, 'recovery' | 'forms'>;

/** True only when the site-wide switch is on AND this form's override (if any) hasn't turned it off. */
export function recoveryEnabledForForm(config: ResolveConfig, formId: string): boolean {
  return config.recovery.enabled === true && config.forms[formId]?.recovery?.enabled !== false;
}

/** The ids of every configured form whose per-form `recovery.enabled === false` — empty array when none. */
export function recoveryDisabledFormIds(config: ResolveConfig): string[] {
  return Object.entries(config.forms)
    .filter(([, formConfig]) => formConfig.recovery?.enabled === false)
    .map(([formId]) => formId);
}
