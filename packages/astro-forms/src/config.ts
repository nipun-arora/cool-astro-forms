/**
 * coolForms(config) shape — zod schema + parseConfig helper.
 *
 * Fail-fast by design: siteUrl is REQUIRED because the abandon handler's
 * same-origin check depends on it (an omitted siteUrl would silently 403
 * every request at runtime instead of failing loudly at config time).
 */
import { z } from 'zod';
import { DEFAULT_ALLOWED_CURRENCIES } from './limits.js';
import { DEFAULT_MIN_AMOUNT_CENTS, DEFAULT_MAX_AMOUNT_CENTS } from './server/payment-constants.js';
import {
  DEFAULT_ATTACHMENT_FALLBACK_MAX_BYTES,
  DEFAULT_DRIVE_ROOT_FOLDER,
  DEFAULT_RECOVERY_DELAY_MINS,
} from './server/drive-recovery-constants.js';

const abandonmentConfigSchema = z
  .object({
    require: z.enum(['email-or-phone', 'always']).default('email-or-phone'),
    dedupeWindowMins: z.number().int().positive().default(60),
    /** Dedupe-window updates re-notify only when true; CREATE always notifies. */
    notifyOnUpdate: z.boolean().default(false),
  })
  .default({ require: 'email-or-phone', dedupeWindowMins: 60, notifyOnUpdate: false });

const formConfigSchema = z.object({
  abandonment: abandonmentConfigSchema,
  notifyTo: z.email(),
  capture: z
    .object({
      allow: z.array(z.string()).optional(),
      deny: z.array(z.string()).optional(),
    })
    .optional(),
  /**
   * Per-form recovery override (ROADMAP Phase 4 SC4 "per-form flag").
   * ABSENT => inherit the site-wide `recovery.enabled`. `enabled:false` =>
   * recovery off for THIS form even when the site switch is on.
   * `enabled:true` does NOT activate recovery when the site-wide switch is
   * off — the site switch remains the master gate (it alone controls
   * unsubscribe-route + widget-script injection in integration.ts).
   */
  recovery: z
    .object({
      enabled: z.boolean().optional(),
    })
    .optional(),
});

/** IP-geolocation lookup config (D2). Default provider is ipwhois.io — free tier permits commercial use (ip-api.com's does not). */
const geoConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** `{ip}` template — swapped for the request IP at lookup time (P02). GEO_PROVIDER env var overrides at lookup time, not here. */
    providerUrl: z.string().default('https://ipwho.is/{ip}'),
    timeoutMs: z.number().int().positive().default(3000),
  })
  .default({ enabled: true, providerUrl: 'https://ipwho.is/{ip}', timeoutMs: 3000 });

/** Admin UI config (D4). */
const adminConfigSchema = z
  .object({
    /** Signed session cookie lifetime. */
    sessionTtlDays: z.number().int().positive().default(7),
  })
  .default({ sessionTtlDays: 7 });

/**
 * A single fee line (D3) — exactly one of `percent`/`flatCents` must be set.
 * Both-set or neither-set is a config-time error (fail loud, never a
 * silently-inert or silently-unbounded fee at runtime).
 */
const feeLineSchema = z
  .object({
    label: z.string().min(1),
    percent: z.number().nonnegative().optional(),
    flatCents: z.number().int().nonnegative().optional(),
  })
  .refine((line) => (line.percent !== undefined) !== (line.flatCents !== undefined), {
    message: 'FeeLine requires exactly one of percent or flatCents (not both, not neither)',
  });

/** payments.requestPage (D1/D2/D3/D4) — the /forms-pay page's server-enforced caps. */
const paymentsRequestPageSchema = z
  .object({
    minAmountCents: z.number().int().nonnegative().default(DEFAULT_MIN_AMOUNT_CENTS),
    maxAmountCents: z.number().int().positive().default(DEFAULT_MAX_AMOUNT_CENTS),
    allowedCurrencies: z
      .array(z.string().length(3))
      .default([...DEFAULT_ALLOWED_CURRENCIES]),
    feeLabel: z.string().optional(),
  })
  .default({
    minAmountCents: DEFAULT_MIN_AMOUNT_CENTS,
    maxAmountCents: DEFAULT_MAX_AMOUNT_CENTS,
    allowedCurrencies: [...DEFAULT_ALLOWED_CURRENCIES],
  });

/**
 * payments config (D3) — inert by default ([] fees). `feePresets` is the
 * named-config-key discretion container for the `?fee=<key>` per-link
 * override: a host can define e.g. `{ noFee: [] }` and a payment-request
 * link can select it by name instead of only toggling the default fees on/off.
 */
const paymentsConfigSchema = z
  .object({
    payLinkFees: z.array(feeLineSchema).default([]),
    feePresets: z.record(z.string(), z.array(feeLineSchema)).optional(),
    requestPage: paymentsRequestPageSchema,
  })
  .default({
    payLinkFees: [],
    requestPage: {
      minAmountCents: DEFAULT_MIN_AMOUNT_CENTS,
      maxAmountCents: DEFAULT_MAX_AMOUNT_CENTS,
      allowedCurrencies: [...DEFAULT_ALLOWED_CURRENCIES],
    },
  });

/** One outbound webhook target (HOOK-01). Secret is server-only — never surfaced via buildPublicConfig. */
const webhookTargetSchema = z.object({
  url: z.url(),
  secret: z.string().min(1),
  events: z.array(z.enum(['entry.submitted', 'entry.abandoned', 'payment.paid'])).optional(),
});

/**
 * Drive file-upload config (DRV-01/D2/D5). The Drive module itself stays
 * optional/inert until the GOOGLE_DRIVE_* env keys exist (integration.ts
 * gating, mirroring Stripe/PayPal/Turnstile) — this schema only carries the
 * safe-by-default VALUE knobs. No Drive secret/token field is representable
 * here: GOOGLE_DRIVE_* are env-only (V2 authentication, treated like
 * STRIPE_SECRET_KEY — never config-file material).
 */
const driveConfigSchema = z
  .object({
    /** 'anyone' opens notification-email links without a Google login (D2, owner explicit); 'private' is the safe OSS-consumer default. */
    linkAccess: z.enum(['anyone', 'private']).default('private'),
    /** Attachment-fallback ceiling (bytes) when a Drive upload fails (DRV-02) — a conservative SMTP cap by default. */
    attachmentFallbackMaxBytes: z.number().int().positive().default(DEFAULT_ATTACHMENT_FALLBACK_MAX_BYTES),
    /** The `/<root>` folder level under which `<siteId>/<YYYY-MM>/<entryId>/` is created. */
    rootFolderName: z.string().min(1).default(DEFAULT_DRIVE_ROOT_FOLDER),
  })
  .default({
    linkAccess: 'private',
    attachmentFallbackMaxBytes: DEFAULT_ATTACHMENT_FALLBACK_MAX_BYTES,
    rootFolderName: DEFAULT_DRIVE_ROOT_FOLDER,
  });

/** Lead recovery config (RCV-01/D3). Inert (enabled:false) by default — no follow-up email is ever sent until an owner opts in. */
const recoveryConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Minutes after last abandon activity before the lazy sweep becomes eligible to send this row. */
    delayMins: z.number().int().positive().default(DEFAULT_RECOVERY_DELAY_MINS),
    /** 'auto' records consent on a captured valid email with no checkbox (owner default, D3); 'checkbox' is reserved for a future opt-in mode. */
    consentMode: z.enum(['auto', 'checkbox']).default('auto'),
  })
  .default({ enabled: false, delayMins: DEFAULT_RECOVERY_DELAY_MINS, consentMode: 'auto' });

/**
 * Rate-limit backend selection (D2 fix #1, ADPT-01). 'memory' (default) is
 * today's in-process token bucket (rate-limit.ts) — byte-identical
 * behavior for every host that never sets this key. 'storage' opts into
 * the adapter-backed StorageBackedRateLimiter (rate-limit-store.ts), which
 * persists bucket state so limits survive a serverless cold start.
 */
const rateLimitConfigSchema = z
  .object({
    store: z.enum(['memory', 'storage']).default('memory'),
  })
  .default({ store: 'memory' });

/**
 * Storage backend selection (05-04, ADPT-01). 'sqlite' (default) is
 * byte-identical to every pre-Phase-5 config — `dbPath` (top-level, below)
 * keeps carrying the sqlite file path. 'turso' selects the libSQL adapter;
 * its connection details (`CAF_TURSO_DATABASE_URL`/`CAF_TURSO_AUTH_TOKEN`)
 * are ALWAYS env-only, never representable here — the same server-secret
 * boundary as Stripe/PayPal/Drive credentials.
 */
const storageConfigSchema = z
  .object({
    kind: z.enum(['sqlite', 'turso']).default('sqlite'),
  })
  .default({ kind: 'sqlite' });

export const coolFormsConfigSchema = z.object({
  siteId: z.string().min(1),
  /** REQUIRED — same-origin check depends on it; omission would 403 every request. */
  siteUrl: z.url(),
  forms: z.record(z.string(), formConfigSchema).default({}),
  /** Capture stays dormant until the host signals consent when true. */
  requireConsent: z.boolean().default(false),
  /** Journey step params dropped by default for privacy (D5). */
  journeyParams: z.boolean().default(false),
  /** Abandoned-row retention window in days. */
  retentionDays: z.number().int().positive().default(90),
  dbPath: z.string().default('data/forms.db'),
  /** Storage backend selection (05-04). 'sqlite' (default) reads `dbPath` above; 'turso' reads CAF_TURSO_* env vars (never here — server-secret boundary). */
  storage: storageConfigSchema,
  /**
   * Host-relative module path default-exporting `CafTemplates`
   * (server/notify.ts) — `{ abandonedLead?, paymentQuote?, paymentReceived? }`,
   * each `(data) => {subject, text, html?}`. Every key is optional; an
   * omitted key falls back to this package's own default template for that
   * email (W3).
   */
  templatesModule: z.string().optional(),
  geo: geoConfigSchema,
  admin: adminConfigSchema,
  /**
   * Fee lines, per-link overrides, and payment-request caps (D1-D4). Server-
   * only: fees are always computed server-side and never surfaced via
   * buildPublicConfig (integration.ts) — nothing to bridge to the client here.
   */
  payments: paymentsConfigSchema,
  /** Outbound webhook targets (HOOK-01). Secrets stay server-only — asserted never-in-buildPublicConfig in 03-08. */
  webhooks: z.array(webhookTargetSchema).default([]),
  /** Drive file-upload config (DRV-01). Inert until GOOGLE_DRIVE_* env keys exist. */
  drive: driveConfigSchema,
  /** Lead recovery config (RCV-01). Inert (enabled:false) by default. */
  recovery: recoveryConfigSchema,
  /** Rate-limit backend selection (D2 fix #1). 'memory' (default) is byte-identical to pre-Phase-5 behavior; 'storage' opts into the adapter-backed persistent limiter. */
  rateLimit: rateLimitConfigSchema,
});

export type CoolFormsConfig = z.infer<typeof coolFormsConfigSchema>;

/** Parses and validates a coolForms(config) input, throwing on invalid shape. */
export function parseConfig(input: unknown): CoolFormsConfig {
  return coolFormsConfigSchema.parse(input);
}
