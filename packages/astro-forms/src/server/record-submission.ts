/**
 * recordSubmission({ siteId, formId, fields, files, request }) — the public
 * `cool-astro-forms/server` export the host site calls from its OWN submit
 * endpoint (ABND-04, PKG-03). Marks every matching abandoned row 'converted'
 * (kept, never deleted — funnel data preserved, the deliberate divergence
 * from the delete-on-convert behavior common in WordPress form plugins) and stitches the submission's journey onto a new
 * 'submitted' entry with server-recomputed durations (JRNY-02) — reusing
 * Plan 06's `recomputeJourney`, never re-derived here.
 *
 * NEVER throws into the host endpoint (S1-F1, T-01-39): the entire body runs
 * inside a catch-all that resolves `{ok:false, error}` and structured-logs
 * via `logError`. The host's business-critical submit flow can never be
 * broken by this package. Malformed/absent journey envelopes are tolerated.
 *
 * Clean-room: written fresh against the Plan 01/02/06 contracts, not derived
 * from any commercial form-plugin source.
 */
import { CONVERT_LOOKBACK_MS } from '../limits.js';
import {
  CAF_FIELD_NAME,
  type DriveLinkAccess,
  type FileInput,
  type FileUploadOutcome,
  type Geo,
  type JourneyStep,
  type WebhookEventType,
} from '../types.js';
import { DEFAULT_ATTACHMENT_FALLBACK_MAX_BYTES, DEFAULT_DRIVE_ROOT_FOLDER } from './drive-recovery-constants.js';
import { uploadFilesToDrive as uploadFilesToDriveImpl, type DriveFileOutcome, type UploadFilesToDriveArgs } from './drive/drive.js';
import { lookupGeo } from './geo/geo.js';
import { recomputeJourney } from './handlers/journey-server.js';
import { log, logError } from './log.js';
import type { StorageAdapter } from './storage/adapter.js';
import { getStorageAdapter } from './storage/index.js';
import { deliverWebhook as deliverWebhookImpl } from './webhooks/deliver.js';

export interface RecordSubmissionArgs {
  siteId: string;
  formId: string;
  fields: Record<string, unknown>;
  /** Real file bytes (DRV-01) — uploaded to Drive (or degraded to a fallback) inside recordSubmission itself. Omitted entirely = no upload, byte-identical to the pre-Phase-4 behavior. */
  files?: FileInput[];
  request: Request;
  /** Host-passed clientAddress (GEO-01) — the real-host adoption shape. Falls back to X-Forwarded-For's first hop when absent. */
  ip?: string;
}

/** Matches src/server/log.ts's `log()` signature — the only shape deps.log needs. */
export type Logger = (event: string, data?: Record<string, unknown>) => void;

export interface RecordSubmissionDeps {
  storage?: StorageAdapter;
  log?: Logger;
  now?: () => number;
  /** IP-geolocation enrichment (GEO-01) — overrides the production default (defaultGeo()) when injected. */
  geo?: (ip: string) => Promise<Geo | undefined>;
  /** Outbound entry.submitted webhook delivery (HOOK-01) — overrides the real deliverWebhook (test seam, network-free). */
  deliverWebhook?: (type: WebhookEventType, data: unknown) => void;
  /** Drive upload orchestrator (DRV-01/DRV-02) — overrides the real uploadFilesToDrive (test seam, no real Drive/network). */
  uploadFilesToDrive?: (files: FileInput[], args: UploadFilesToDriveArgs) => Promise<DriveFileOutcome[]>;
}

export type RecordSubmissionResult =
  | { ok: true; entryId: string; files?: FileUploadOutcome[] }
  | { ok: false; error: string };

/**
 * Matches config.ts's zod default for `retentionDays`. recordSubmission has
 * no `CoolFormsConfig` param to read the real per-site value from (pinned
 * signature: `{siteId, formId, fields, files, request}`) — Phase 1 scope.
 */
const DEFAULT_RETENTION_DAYS = 90;
const HOURLY_PURGE_INTERVAL_MS = 60 * 60 * 1000;

/** Module-level (per-process) gate: purgeExpired fires at most once per hour. */
let lastPurgeAtModule = 0;

/** Test-only reset hook for the module-level hourly purge gate. */
export function resetRecordSubmissionPurgeGate(): void {
  lastPurgeAtModule = 0;
}

/**
 * Parses a `Cookie` header for a single named cookie value. A small,
 * module-scoped parser (not shared) — mirrors handle-abandon.ts's identical
 * local helper; both are header-only parsers scoped to their own module,
 * not a re-declared shared constant.
 */
function parseCookieValue(cookieHeader: string | null, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key === name) {
      const value = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }
  return undefined;
}

function isJourneyStepArray(value: unknown): value is JourneyStep[] {
  return Array.isArray(value);
}

/**
 * Reads the `_caf` machine-data envelope (a JSON string or an already-parsed
 * object). Malformed JSON, a wrong-shape object, or an absent key are all
 * TOLERATED — never throws, always resolves an (empty when tolerated)
 * journey array. Malformed/wrong-shape cases log one structured warn line
 * via the injected logger; a plain absent envelope (no client capture wired)
 * is the normal case for a host that hasn't tagged its form and stays quiet.
 */
function parseCafEnvelope(raw: unknown, logFn: Logger): JourneyStep[] {
  if (raw === undefined || raw === null) {
    return [];
  }

  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      logFn('record-submission.envelope-invalid', { reason: 'malformed-json' });
      return [];
    }
  }

  if (typeof parsed !== 'object' || parsed === null || !isJourneyStepArray((parsed as { journey?: unknown }).journey)) {
    logFn('record-submission.envelope-invalid', { reason: 'wrong-shape' });
    return [];
  }

  return (parsed as { journey: JourneyStep[] }).journey;
}

/**
 * Resolves the visitor IP for geo enrichment: `args.ip` (host-passed
 * clientAddress) takes precedence. Falls back to the FIRST hop of an
 * X-Forwarded-For header on the request — best-effort/spoofable, ONLY a
 * fallback for hosts that don't pass clientAddress (same T-01-35 accepted
 * proxy-trust posture as the rate limiter; worst case is wrong geo on the
 * owner's own admin display, no auth/security decision rides on it).
 * Absent both, geo lookup is skipped entirely (undefined).
 */
function resolveIp(args: RecordSubmissionArgs): string | undefined {
  if (args.ip) return args.ip;
  const xff = args.request.headers.get('x-forwarded-for');
  if (!xff) return undefined;
  const first = xff.split(',')[0]?.trim();
  return first || undefined;
}

/**
 * Builds the PRODUCTION DEFAULT geo lookup for REAL (non-injected)
 * recordSubmission callers — a real host calling recordSubmission(args) with
 * no deps.geo still gets geo enrichment. Reads the runtime-config env
 * contract P03's registerRuntimeConfig writes (mirrors CAF_DB_PATH); the
 * bare GEO_PROVIDER env var overrides both this and the abandon route's
 * config value. Until a host's middleware runs, these hardcoded defaults
 * apply — identical to config.ts's zod defaults. Returns undefined (no
 * lookup at all) when CAF_GEO_ENABLED is explicitly 'false'.
 */
function defaultGeo(): ((ip: string) => Promise<Geo | undefined>) | undefined {
  if (process.env.CAF_GEO_ENABLED === 'false') return undefined;
  return (ip: string) =>
    lookupGeo(ip, {
      providerUrl: process.env.GEO_PROVIDER ?? process.env.CAF_GEO_PROVIDER ?? 'https://ipwho.is/{ip}',
      timeoutMs: Number(process.env.CAF_GEO_TIMEOUT_MS ?? 3000),
    });
}

/**
 * Builds the PRODUCTION DEFAULT Drive config for REAL (non-injected)
 * recordSubmission callers — mirrors defaultGeo()'s env-seam mechanism.
 * record-submission has NO `CoolFormsConfig` param (pinned signature), so
 * this reads the runtime env vars 04-06's middleware bridge publishes
 * (W1 — verbatim contract, do not invent variants):
 * `CAF_DRIVE_LINK_ACCESS` ('anyone'|'private', default 'private'),
 * `CAF_DRIVE_ROOT_FOLDER` (default DEFAULT_DRIVE_ROOT_FOLDER),
 * `CAF_DRIVE_FALLBACK_MAX_BYTES` (numeric string, default
 * DEFAULT_ATTACHMENT_FALLBACK_MAX_BYTES). driveConfigured() (drive.ts) is
 * the actual on/off gate — this function only supplies the safe-by-default
 * VALUE knobs, identical in spirit to config.ts's driveConfigSchema.
 */
function defaultDriveConfig(): UploadFilesToDriveArgs['config'] {
  const linkAccess: DriveLinkAccess = process.env.CAF_DRIVE_LINK_ACCESS === 'anyone' ? 'anyone' : 'private';
  return {
    drive: {
      linkAccess,
      rootFolderName: process.env.CAF_DRIVE_ROOT_FOLDER ?? DEFAULT_DRIVE_ROOT_FOLDER,
      attachmentFallbackMaxBytes: Number(process.env.CAF_DRIVE_FALLBACK_MAX_BYTES ?? DEFAULT_ATTACHMENT_FALLBACK_MAX_BYTES),
    },
  };
}

/**
 * Maps one orchestrator-internal DriveFileOutcome (drive.ts) to the
 * host-facing FileUploadOutcome (D1) — a Drive success carries only
 * `{filename, driveLink}` (never the driveFileId/mime/sizeBytes internals),
 * a Drive failure/disabled host carries `{filename, fallbackBuffer}`, and an
 * over-ceiling fallback carries `{filename, fallbackTooLarge:true}` — never
 * more than one of the three is set.
 */
function toFileUploadOutcome(outcome: DriveFileOutcome): FileUploadOutcome {
  if (outcome.storage === 'drive' && outcome.driveLink) {
    return { filename: outcome.filename, driveLink: outcome.driveLink };
  }
  if (outcome.fallbackTooLarge) {
    return { filename: outcome.filename, fallbackTooLarge: true };
  }
  return { filename: outcome.filename, fallbackBuffer: outcome.fallbackBuffer };
}

/**
 * Defensive degrade path (DRV-02) for when the upload orchestrator itself
 * throws — the real drive.ts `uploadFilesToDrive` already never throws, but
 * an injected/host-overridden `deps.uploadFilesToDrive` might. Applies the
 * SAME attachmentFallbackMaxBytes ceiling the real orchestrator uses so the
 * degrade behavior stays consistent regardless of which path produced it.
 */
function buildFallbackOutcomes(files: FileInput[], fallbackMaxBytes: number): DriveFileOutcome[] {
  return files.map((file) => {
    const sizeBytes = file.buffer.length;
    const base = { filename: file.filename, sizeBytes, mime: file.mimeType, storage: 'email-only' as const };
    return sizeBytes > fallbackMaxBytes ? { ...base, fallbackTooLarge: true } : { ...base, fallbackBuffer: file.buffer };
  });
}

/** Fire-and-forget, at most once per hour per process — mirrors handle-abandon.ts's maybePurgeExpired. */
function maybePurgeExpired(storage: StorageAdapter, now: number): void {
  if (now - lastPurgeAtModule < HOURLY_PURGE_INTERVAL_MS) return;
  lastPurgeAtModule = now;
  try {
    storage.purgeExpired(DEFAULT_RETENTION_DAYS).catch((err: unknown) => {
      logError('storage.purge-failed', err);
    });
  } catch (err) {
    logError('storage.purge-failed', err);
  }
}

export async function recordSubmission(
  args: RecordSubmissionArgs,
  deps: RecordSubmissionDeps = {},
): Promise<RecordSubmissionResult> {
  try {
    const now = deps.now ? deps.now() : Date.now();
    const storage = deps.storage ?? (await getStorageAdapter());
    const logFn = deps.log ?? log;

    // Visitor identity — the request's _caf_uid cookie is AUTHORITATIVE; a
    // fields-supplied uuid is only a fallback. Headers only — the request
    // body has already been consumed by the host endpoint and is NEVER
    // re-read here.
    const cookieUuid = parseCookieValue(args.request.headers.get('cookie'), '_caf_uid');
    const fieldsUuid = typeof args.fields?.['visitorUuid'] === 'string' ? (args.fields['visitorUuid'] as string) : undefined;
    const visitorUuid = cookieUuid ?? fieldsUuid ?? '';

    // Machine-data envelope — parsed defensively, then stripped from the
    // fields blob persisted on the entry.
    const fieldsCopy: Record<string, unknown> = { ...args.fields };
    const rawEnvelope = fieldsCopy[CAF_FIELD_NAME];
    delete fieldsCopy[CAF_FIELD_NAME];
    const envelopeJourney = parseCafEnvelope(rawEnvelope, logFn);
    const recomputed = recomputeJourney(envelopeJourney, now);

    // Geo enrichment (GEO-01) — real hosts get this via the ip arg + XFF
    // fallback + env-driven production default; an injected deps.geo always
    // wins (test seam). A rejecting geo dep never fails the submission —
    // lookupGeo's own contract never throws, but this defensive catch
    // guards against a buggy injected geo dep (never-throws contract, S1-F1).
    const ip = resolveIp(args);
    const geoFn = deps.geo ?? defaultGeo();
    let geo: Geo | undefined;
    if (ip && geoFn) {
      try {
        geo = await geoFn(ip);
      } catch {
        geo = undefined;
      }
    }

    // Repeat-submit detection — checked BEFORE the atomic call so a genuine
    // "nothing ever abandoned, first-ever submission" case is never
    // mislabeled as a repeat (both scenarios return converted:0).
    const priorSubmitted = await storage.listEntries({
      siteId: args.siteId,
      formId: args.formId,
      visitorUuid,
      status: 'submitted',
      limit: 1,
    });

    // ONE atomic call — converts ALL matching abandoned rows (kept, never
    // deleted) and creates the submitted entry in a single transaction
    // (Plan 02). Idempotent on double-submit: converts 0, creates a second
    // submitted row.
    const result = await storage.convertAndCreateSubmitted(
      {
        siteId: args.siteId,
        formId: args.formId,
        fields: fieldsCopy,
        visitorUuid,
        journey: recomputed.steps,
        geo,
        ip,
      },
      CONVERT_LOOKBACK_MS,
    );

    if (result.converted === 0 && priorSubmitted.length > 0) {
      logFn('record-submission.repeat', { siteId: args.siteId, formId: args.formId, visitorUuid });
    }

    // Real file bytes -> Drive upload -> per-file outcome the HOST's own
    // email code branches on (D1 — no new package-owned submission email).
    // DRV-02 is HARD here: no Drive failure may throw out of
    // recordSubmission or lose a file — every degrade path below still
    // returns {ok:true} with the (already-created) entry saved.
    let fileOutcomes: FileUploadOutcome[] | undefined;
    if (args.files && args.files.length > 0) {
      const driveConfig = defaultDriveConfig();
      const uploadFn = deps.uploadFilesToDrive ?? uploadFilesToDriveImpl;

      let driveOutcomes: DriveFileOutcome[];
      try {
        driveOutcomes = await uploadFn(args.files, {
          siteId: args.siteId,
          entryId: result.entry.id,
          entryCreatedAt: result.entry.createdAt,
          config: driveConfig,
        });
      } catch (err) {
        // The real orchestrator (drive.ts) never throws on its own; this
        // guards an injected/host-overridden uploadFilesToDrive dep so a
        // thrown error still degrades every file to fallback rather than
        // failing the whole submission.
        logError('record-submission.drive-upload-failed', err, { siteId: args.siteId, formId: args.formId });
        driveOutcomes = buildFallbackOutcomes(args.files, driveConfig.drive.attachmentFallbackMaxBytes);
      }

      try {
        await storage.attachFiles(
          result.entry.id,
          driveOutcomes.map((o) => ({
            filename: o.filename,
            sizeBytes: o.sizeBytes,
            mime: o.mime,
            storage: o.storage,
            driveFileId: o.driveFileId,
            driveLink: o.driveLink,
          })),
        );
      } catch (err) {
        logError('record-submission.attach-files-failed', err, { siteId: args.siteId, formId: args.formId });
      }

      fileOutcomes = driveOutcomes.map(toFileUploadOutcome);
    }

    // Fire-and-forget entry.submitted webhook (HOOK-01) — this point is only
    // ever reached on a genuinely successful submit; never awaited, never
    // able to affect the {ok:true} result below (deliverWebhook's own
    // contract never throws).
    const deliverWebhookFn = deps.deliverWebhook ?? deliverWebhookImpl;
    deliverWebhookFn('entry.submitted', {
      id: result.entry.id,
      siteId: args.siteId,
      formId: args.formId,
      fields: fieldsCopy,
      geo,
    });

    maybePurgeExpired(storage, now);

    return fileOutcomes ? { ok: true, entryId: result.entry.id, files: fileOutcomes } : { ok: true, entryId: result.entry.id };
  } catch (err) {
    logError('record-submission.failed', err, { siteId: args.siteId, formId: args.formId });
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
