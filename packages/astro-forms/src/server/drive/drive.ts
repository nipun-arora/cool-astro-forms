/**
 * Google Drive v3 REST module (DRV-01, DRV-02, D2, D5) — raw fetch, no SDK,
 * mirroring `paypal.ts` almost line-for-line: injectable `deps.fetch`,
 * env-seam base URLs, never-throws contract. OAuth refresh-token exchange
 * with an in-process access-token cache, list-then-create folder-hierarchy
 * idempotency, size-branched upload with retry-then-fallback, the D2
 * permission grant, and the `uploadFilesToDrive` orchestrator every
 * file-bearing submission calls.
 *
 * B3 timeout rule (mirrors deliver.ts:94-107): EVERY Drive fetch carries
 * `signal: AbortSignal.timeout(...)` — DRIVE_META_TIMEOUT_MS for
 * token/list/create/upload-init/permission, DRIVE_UPLOAD_TIMEOUT_MS for the
 * upload body POST/PUT. A stalled TCP connection never throws on its own,
 * so without the abort the never-throws catch can never fire, the retry
 * loop can never advance, and recordSubmission — AWAITED by the host's
 * submit endpoint — would block the visitor's own submit response
 * indefinitely. Timeout expiry MUST feed the same retry-then-{fallbackBuffer}
 * path as a thrown error (DRV-02).
 *
 * Clean-room: written fresh against developers.google.com Drive v3 REST
 * docs (04-RESEARCH.md Code Examples), not derived from any commercial form-plugin source.
 */
import type { DriveLinkAccess, FileInput } from '../../types.js';
import {
  ACCESS_TOKEN_TTL_MS,
  DRIVE_BACKOFF_MS,
  DRIVE_META_TIMEOUT_MS,
  DRIVE_UPLOAD_MAX_ATTEMPTS,
  DRIVE_UPLOAD_TIMEOUT_MS,
  FIVE_MIB,
} from '../drive-recovery-constants.js';
import { log, logError } from '../log.js';
import { buildFolderPath, escapeQueryValue, sanitizeName } from './folder-path.js';

export interface DriveDeps {
  fetch?: typeof fetch;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => void;
}

const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

/** `process.env.GOOGLE_DRIVE_API_BASE_URL` when set, else the real Drive host — the STRIPE_API_BASE_URL seam generalized (e2e mock route, unset/inert in every real deployment). */
export function driveApiBaseUrl(): string {
  return process.env.GOOGLE_DRIVE_API_BASE_URL ?? 'https://www.googleapis.com';
}

/** `process.env.GOOGLE_OAUTH_TOKEN_URL` when set, else Google's real token endpoint — same env-seam shape as `driveApiBaseUrl()`. */
export function oauthTokenUrl(): string {
  return process.env.GOOGLE_OAUTH_TOKEN_URL ?? 'https://oauth2.googleapis.com/token';
}

/** True only when all three GOOGLE_DRIVE_* env keys are set (mirrors paypalConfigured) — the module stays fully inert without them. */
export function driveConfigured(): boolean {
  return (
    Boolean(process.env.GOOGLE_DRIVE_CLIENT_ID) &&
    Boolean(process.env.GOOGLE_DRIVE_CLIENT_SECRET) &&
    Boolean(process.env.GOOGLE_DRIVE_REFRESH_TOKEN)
  );
}

// ---------------------------------------------------------------------------
// OAuth refresh-token exchange (module-level access-token + folder caches)
// ---------------------------------------------------------------------------

interface TokenCache {
  token: string;
  expiresAt: number;
}

let tokenCache: TokenCache | undefined;
let folderCache = new Map<string, string>();

/** Test-only reset for the module-level token + folder caches (mirrors resetWebhookTargets). */
export function resetDriveCaches(): void {
  tokenCache = undefined;
  folderCache = new Map();
}

interface DriveTokenResponseBody {
  access_token?: string;
}

/**
 * Exchanges GOOGLE_DRIVE_REFRESH_TOKEN for an access token, caching it for
 * ACCESS_TOKEN_TTL_MS (kept under Google's 60-minute token life). Never
 * throws: an absent env key, a network error, a non-2xx response, or a
 * malformed body all resolve `undefined` — the paypal.ts `getAccessToken`
 * contract.
 */
export async function refreshAccessToken(deps: DriveDeps = {}): Promise<string | undefined> {
  const now = deps.now ? deps.now() : Date.now();
  if (tokenCache && now < tokenCache.expiresAt) return tokenCache.token;

  const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_DRIVE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return undefined;

  const doFetch = deps.fetch ?? fetch;
  try {
    const res = await doFetch(oauthTokenUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }).toString(),
      signal: AbortSignal.timeout(DRIVE_META_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as DriveTokenResponseBody;
    if (typeof data.access_token !== 'string') return undefined;
    tokenCache = { token: data.access_token, expiresAt: now + ACCESS_TOKEN_TTL_MS };
    return data.access_token;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Folder-hierarchy resolution (list-then-create idempotency)
// ---------------------------------------------------------------------------

interface DriveFilesListResult {
  files?: { id: string; name?: string }[];
}

/** Thin `files.list` wrapper — never throws, resolves `{}` on any failure. Carries AbortSignal.timeout(DRIVE_META_TIMEOUT_MS) (B3). */
async function driveFilesList(q: string, accessToken: string, deps: DriveDeps): Promise<DriveFilesListResult> {
  const doFetch = deps.fetch ?? fetch;
  try {
    const url = `${driveApiBaseUrl()}/drive/v3/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent('files(id,name)')}&spaces=drive`;
    const res = await doFetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(DRIVE_META_TIMEOUT_MS),
    });
    if (!res.ok) return {};
    return (await res.json()) as DriveFilesListResult;
  } catch {
    return {};
  }
}

interface DriveFilesCreateResult {
  id?: string;
}

interface DriveFilesCreateBody {
  name: string;
  mimeType: string;
  parents: string[];
}

/** Thin `files.create` wrapper — never throws, resolves `{}` on any failure. Carries AbortSignal.timeout(DRIVE_META_TIMEOUT_MS) (B3). */
async function driveFilesCreate(
  body: DriveFilesCreateBody,
  accessToken: string,
  deps: DriveDeps,
): Promise<DriveFilesCreateResult> {
  const doFetch = deps.fetch ?? fetch;
  try {
    const res = await doFetch(`${driveApiBaseUrl()}/drive/v3/files?fields=id`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DRIVE_META_TIMEOUT_MS),
    });
    if (!res.ok) return {};
    return (await res.json()) as DriveFilesCreateResult;
  } catch {
    return {};
  }
}

export interface ResolveFolderIdOptions {
  /**
   * When provided, the result is cached in-process under this key and
   * reused on subsequent calls (the root/siteId/month "stable levels",
   * RESEARCH Pattern 1). When omitted (the entryId level), resolution is
   * NEVER cached — the list-then-create call is itself the retry-after-
   * partial-failure guard.
   */
  cacheKey?: string;
}

/**
 * List-then-create idempotent folder resolution: an existing folder
 * (matched by escaped name + parent + folder mimeType + not-trashed) is
 * reused; a missing one is created once. Never throws — an exhausted
 * list-and-create failure resolves `undefined`.
 */
export async function resolveFolderId(
  name: string,
  parentId: string,
  accessToken: string,
  deps: DriveDeps = {},
  options: ResolveFolderIdOptions = {},
): Promise<string | undefined> {
  if (options.cacheKey && folderCache.has(options.cacheKey)) {
    return folderCache.get(options.cacheKey);
  }

  const q =
    `name='${escapeQueryValue(name)}' and '${parentId}' in parents ` +
    `and mimeType='${FOLDER_MIME_TYPE}' and trashed=false`;
  const listResult = await driveFilesList(q, accessToken, deps);
  const existingId = listResult.files?.[0]?.id;

  const folderId = existingId ?? (await driveFilesCreate({ name, mimeType: FOLDER_MIME_TYPE, parents: [parentId] }, accessToken, deps)).id;

  if (folderId && options.cacheKey) {
    folderCache.set(options.cacheKey, folderId);
  }
  return folderId;
}

// ---------------------------------------------------------------------------
// Upload (multipart <=5MiB, single-shot resumable >5MiB) + retry-then-fallback
// ---------------------------------------------------------------------------

interface DriveUploadResult {
  id?: string;
  webViewLink?: string;
}

const MULTIPART_BOUNDARY = 'caf-drive-boundary';

/** Builds a `multipart/related` body: a JSON metadata part + the raw media bytes, per Drive's documented multipart-upload framing. */
function buildMultipartBody(metadata: Record<string, unknown>, mimeType: string, buffer: Buffer): Buffer {
  const metadataPart =
    `--${MULTIPART_BOUNDARY}\r\n` + `Content-Type: application/json; charset=UTF-8\r\n\r\n` + `${JSON.stringify(metadata)}\r\n`;
  const mediaHeader = `--${MULTIPART_BOUNDARY}\r\nContent-Type: ${mimeType}\r\n\r\n`;
  const closing = `\r\n--${MULTIPART_BOUNDARY}--`;
  return Buffer.concat([Buffer.from(metadataPart, 'utf8'), Buffer.from(mediaHeader, 'utf8'), buffer, Buffer.from(closing, 'utf8')]);
}

/**
 * Single-request multipart upload (<=5MiB, RESEARCH Pitfall 3). Never
 * throws — resolves `undefined` on any failure. Carries
 * AbortSignal.timeout(DRIVE_UPLOAD_TIMEOUT_MS) (B3, upload body).
 */
async function multipartUpload(
  file: FileInput,
  folderId: string,
  accessToken: string,
  deps: DriveDeps,
): Promise<DriveUploadResult | undefined> {
  const doFetch = deps.fetch ?? fetch;
  const mimeType = file.mimeType ?? 'application/octet-stream';
  const metadata = { name: sanitizeName(file.filename), parents: [folderId] };
  const body = buildMultipartBody(metadata, mimeType, file.buffer);
  try {
    const res = await doFetch(`${driveApiBaseUrl()}/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${MULTIPART_BOUNDARY}`,
      },
      // Buffer satisfies BodyInit's BufferSource member at runtime (Node fetch/undici
      // accepts it directly); cast needed because TS's overload resolution across the
      // merged DOM + Node fetch typings picks the URLSearchParams branch first here.
      body: body as unknown as BodyInit,
      signal: AbortSignal.timeout(DRIVE_UPLOAD_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    return (await res.json()) as DriveUploadResult;
  } catch {
    return undefined;
  }
}

/**
 * Single-shot resumable upload (>5MiB): an init request obtains a session
 * URI, then the WHOLE buffer is PUT in one request — no chunked resume
 * (RESEARCH Pattern 2, out of scope for v1). Never throws. The init request
 * carries AbortSignal.timeout(DRIVE_META_TIMEOUT_MS); the body PUT carries
 * AbortSignal.timeout(DRIVE_UPLOAD_TIMEOUT_MS) (B3).
 */
async function resumableUpload(
  file: FileInput,
  folderId: string,
  accessToken: string,
  deps: DriveDeps,
): Promise<DriveUploadResult | undefined> {
  const doFetch = deps.fetch ?? fetch;
  const mimeType = file.mimeType ?? 'application/octet-stream';
  try {
    const initRes = await doFetch(`${driveApiBaseUrl()}/upload/drive/v3/files?uploadType=resumable&fields=id,webViewLink`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType,
      },
      body: JSON.stringify({ name: sanitizeName(file.filename), parents: [folderId] }),
      signal: AbortSignal.timeout(DRIVE_META_TIMEOUT_MS),
    });
    if (!initRes.ok) return undefined;
    const sessionUrl = initRes.headers.get('Location') ?? initRes.headers.get('location');
    if (!sessionUrl) return undefined;

    const putRes = await doFetch(sessionUrl, {
      method: 'PUT',
      headers: { 'Content-Type': mimeType },
      body: file.buffer as unknown as BodyInit,
      signal: AbortSignal.timeout(DRIVE_UPLOAD_TIMEOUT_MS),
    });
    if (!putRes.ok) return undefined;
    return (await putRes.json()) as DriveUploadResult;
  } catch {
    return undefined;
  }
}

function waitFor(scheduleFn: (fn: () => void, ms: number) => void, ms: number): Promise<void> {
  return new Promise((resolve) => scheduleFn(resolve, ms));
}

const defaultSchedule = (fn: () => void, ms: number): void => {
  setTimeout(fn, ms);
};

export interface UploadFileResult {
  ok: boolean;
  driveFileId?: string;
  webViewLink?: string;
}

/**
 * Uploads one file, branching on `file.buffer.length` BEFORE the request
 * (<=FIVE_MIB multipart, >FIVE_MIB resumable — RESEARCH Pitfall 3). Retries
 * up to DRIVE_UPLOAD_MAX_ATTEMPTS times with DRIVE_BACKOFF_MS backoff
 * (mirrors deliver.ts's attemptOnce/deliverToTarget shape exactly). Never
 * throws: exhausted attempts resolve `{ ok: false }` (DRV-02 — the caller
 * degrades to the fallback buffer, never a lost file).
 */
export async function uploadFile(
  file: FileInput,
  folderId: string,
  accessToken: string,
  deps: DriveDeps = {},
): Promise<UploadFileResult> {
  const scheduleFn = deps.schedule ?? defaultSchedule;
  for (let attempt = 1; attempt <= DRIVE_UPLOAD_MAX_ATTEMPTS; attempt++) {
    const result =
      file.buffer.length <= FIVE_MIB
        ? await multipartUpload(file, folderId, accessToken, deps)
        : await resumableUpload(file, folderId, accessToken, deps);
    if (result?.id) {
      return { ok: true, driveFileId: result.id, webViewLink: result.webViewLink };
    }
    if (attempt < DRIVE_UPLOAD_MAX_ATTEMPTS) {
      await waitFor(scheduleFn, DRIVE_BACKOFF_MS[attempt - 1] ?? 0);
    }
  }
  return { ok: false };
}

// ---------------------------------------------------------------------------
// Permission grant (D2 — 'anyone'-reader so webViewLink opens without login)
// ---------------------------------------------------------------------------

/**
 * Grants `role:'reader', type:'anyone'` on `fileId` so its `webViewLink`
 * opens without a Google login (D2). Never throws: a failure is logged but
 * does not fail the (already-succeeded) upload — the file stays on Drive,
 * only the link may show "Request access" (RESEARCH Pitfall 4).
 */
export async function grantPermission(fileId: string, accessToken: string, deps: DriveDeps = {}): Promise<void> {
  const doFetch = deps.fetch ?? fetch;
  try {
    const res = await doFetch(`${driveApiBaseUrl()}/drive/v3/files/${fileId}/permissions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'reader', type: 'anyone' }),
      signal: AbortSignal.timeout(DRIVE_META_TIMEOUT_MS),
    });
    if (!res.ok) {
      log('drive.permission-grant-failed', { fileId, status: res.status });
    }
  } catch (err) {
    logError('drive.permission-grant-failed', err, { fileId });
  }
}

// ---------------------------------------------------------------------------
// uploadFilesToDrive orchestrator — the one entrypoint every file-bearing
// submission calls (DRV-01, DRV-02)
// ---------------------------------------------------------------------------

/** Per-file result: the rich internal shape record-submission.ts (04-05) threads into both `storage.attachFiles` and the host-facing outcome. */
export interface DriveFileOutcome {
  filename: string;
  sizeBytes: number;
  mime?: string;
  storage: 'drive' | 'email-only';
  driveFileId?: string;
  driveLink?: string;
  /** Present when Drive failed/disabled AND the file fits under attachmentFallbackMaxBytes — the host should attach this buffer itself (DRV-02). */
  fallbackBuffer?: Buffer;
  /** Present when Drive failed/disabled AND the file exceeds attachmentFallbackMaxBytes — neither linkable nor attachable; the submission entry itself is still saved. */
  fallbackTooLarge?: boolean;
}

export interface UploadFilesToDriveArgs {
  siteId: string;
  entryId: string;
  entryCreatedAt: number;
  config: {
    drive: {
      linkAccess: DriveLinkAccess;
      attachmentFallbackMaxBytes: number;
      rootFolderName: string;
    };
  };
  deps?: DriveDeps;
}

function toFallbackOutcome(file: FileInput, fallbackMaxBytes: number): DriveFileOutcome {
  const sizeBytes = file.buffer.length;
  const base = { filename: file.filename, sizeBytes, mime: file.mimeType, storage: 'email-only' as const };
  if (sizeBytes > fallbackMaxBytes) {
    return { ...base, fallbackTooLarge: true };
  }
  return { ...base, fallbackBuffer: file.buffer };
}

/**
 * Uploads every file to `/<rootFolderName>/<siteId>/<YYYY-MM>/<entryId>/`,
 * returning one `DriveFileOutcome` per file. Fully inert (zero network
 * calls, every file `storage:'email-only'` with the buffer kept) when
 * `driveConfigured()` is false. Never throws — the whole orchestrator is
 * wrapped so ANY failure (auth, folder resolution, upload) degrades the
 * affected files to the fallback path rather than propagating (DRV-02,
 * record-submission's never-throws contract).
 */
export async function uploadFilesToDrive(files: FileInput[], args: UploadFilesToDriveArgs): Promise<DriveFileOutcome[]> {
  if (files.length === 0) return [];

  const deps = args.deps ?? {};
  const fallbackMaxBytes = args.config.drive.attachmentFallbackMaxBytes;
  const toFallback = (file: FileInput): DriveFileOutcome => toFallbackOutcome(file, fallbackMaxBytes);

  try {
    if (!driveConfigured()) {
      return files.map(toFallback);
    }

    const accessToken = await refreshAccessToken(deps);
    if (!accessToken) {
      return files.map(toFallback);
    }

    const stableSegments = buildFolderPath(args.config.drive.rootFolderName, args.siteId, args.entryCreatedAt);
    let parentId = 'root';
    const cacheKeyParts: string[] = [];
    for (const segment of stableSegments) {
      cacheKeyParts.push(segment);
      const folderId = await resolveFolderId(segment, parentId, accessToken, deps, { cacheKey: cacheKeyParts.join(':') });
      if (!folderId) return files.map(toFallback);
      parentId = folderId;
    }

    // entryId level — always fresh, never cached (retry-after-partial-failure guard).
    const entryFolderId = await resolveFolderId(args.entryId, parentId, accessToken, deps);
    if (!entryFolderId) return files.map(toFallback);

    const results: DriveFileOutcome[] = [];
    for (const file of files) {
      const uploadResult = await uploadFile(file, entryFolderId, accessToken, deps);
      if (uploadResult.ok && uploadResult.driveFileId) {
        if (args.config.drive.linkAccess === 'anyone') {
          await grantPermission(uploadResult.driveFileId, accessToken, deps);
        }
        results.push({
          filename: file.filename,
          sizeBytes: file.buffer.length,
          mime: file.mimeType,
          storage: 'drive',
          driveFileId: uploadResult.driveFileId,
          driveLink: uploadResult.webViewLink,
        });
      } else {
        results.push(toFallback(file));
      }
    }
    return results;
  } catch (err) {
    logError('drive.upload-orchestrator-failed', err, { entryId: args.entryId });
    return files.map(toFallback);
  }
}
