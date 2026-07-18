/**
 * Server-only value constants for Google Drive uploads + lead recovery
 * (Phase 4).
 *
 * Moved out of the shared `types.ts`/`limits.ts` modules (which client
 * entries capture.ts/journey.ts import) for the same reason as
 * payment-constants.ts: a real `export const` emits bytes into every
 * importer's bundle, unlike a type-only export. Left in a shared module
 * these values would inflate the client bundle's local chunk closure past
 * the codified gzip budget even though no client code ever reads a
 * Drive/recovery value knob. Every consumer here is already server-only, so
 * this module is safe to import directly without touching the client graph.
 */

/** Drive upload strategy threshold (RESEARCH Pitfall 3): <=5MiB uses the multipart upload; larger files use the resumable upload. */
export const FIVE_MIB = 5_242_880;

/** Drive upload retry ceiling — mirrors deliver.ts's webhook-delivery retry count exactly (RESEARCH Don't Hand-Roll). */
export const DRIVE_UPLOAD_MAX_ATTEMPTS = 3;

/** Drive upload retry backoff schedule (ms) — mirrors deliver.ts exactly. */
export const DRIVE_BACKOFF_MS: readonly number[] = [1000, 2000];

/**
 * Short metadata-call timeout (token refresh, files.list, folder create,
 * permission grant) — 10s. Deliberately NOT deliver.ts's 5s webhook value.
 * EVERY Drive fetch MUST carry `AbortSignal.timeout` (checker B3): a
 * stalled TCP connection never throws on its own, so without an explicit
 * abort the never-throws catch can never fire, the retry loop can never
 * start its next attempt, and recordSubmission — AWAITED by the host's
 * submit endpoint — would block the visitor's own submit response
 * indefinitely.
 */
export const DRIVE_META_TIMEOUT_MS = 10_000;

/** Upload-body timeout (init + PUT) — sized larger than DRIVE_META_TIMEOUT_MS for multi-MB payloads. Same AbortSignal.timeout rationale as above. */
export const DRIVE_UPLOAD_TIMEOUT_MS = 120_000;

/** Default attachment-fallback size ceiling (~10MB) when a Drive upload fails — a conservative SMTP cap (RESEARCH A4), owner-overridable via `drive.attachmentFallbackMaxBytes`. */
export const DEFAULT_ATTACHMENT_FALLBACK_MAX_BYTES = 10_485_760;

/** Default recovery-email delay (minutes) after last abandon activity (D3) — documented arbitrary default, owner-overridable via `recovery.delayMins`. */
export const DEFAULT_RECOVERY_DELAY_MINS = 60;

/** Per-process lazy-sweep gate interval (ms) — mirrors HOURLY_PURGE_INTERVAL_MS's module-gate shape (no setTimeout; RESEARCH Anti-Patterns — Passenger recycles idle workers). */
export const RECOVERY_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/** Max rows a single lazy-sweep pass claims + emails — bounds a traffic-driven sweep's per-request work, mirroring the batching caution of the other retry/backoff constants above. */
export const BATCH_LIMIT = 25;

/** Drive access-token cache lifetime (ms) — kept under Google's 60min token life. */
export const ACCESS_TOKEN_TTL_MS = 50 * 60 * 1000;

/** Default Drive root folder name (the `/<root>` path level) — owner-overridable via `drive.rootFolderName`. */
export const DEFAULT_DRIVE_ROOT_FOLDER = 'cool-astro-forms';
