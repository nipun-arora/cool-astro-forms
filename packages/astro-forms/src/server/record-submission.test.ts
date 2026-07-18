import { afterEach, describe, expect, it, vi } from 'vitest';
import { CAF_FIELD_NAME, type Entry } from '../types.js';
import { CONVERT_LOOKBACK_MS } from '../limits.js';
import type { StorageAdapter } from './storage/adapter.js';
import { recordSubmission } from './record-submission.js';

// ---------------------------------------------------------------------------
// 05-04 (ADPT-01, B1) — the CAF_STORAGE_KIND env bridge. recordSubmission has
// NO CoolFormsConfig parameter (pinned signature) so its production-default
// storage acquisition (`deps.storage ?? await getStorageAdapter()`) can ONLY
// see the backend selection via this env var. Mocked exactly like the
// package's own self-referencing bare specifier (05-03 exports subpath) so
// this proves the turso branch is genuinely reached without a built `dist/`.
// ---------------------------------------------------------------------------
const { FakeTursoStorage, fakeTursoConvertAndCreateSubmitted } = vi.hoisted(() => {
  const fakeTursoConvertAndCreateSubmitted = vi.fn(async () => ({
    converted: 0,
    entry: {
      id: 'turso-entry-1',
      siteId: 'demo-site',
      formId: 'contact-form',
      status: 'submitted' as const,
      fields: {},
      visitorUuid: 'visitor-1',
      createdAt: 1000,
      updatedAt: 1000,
    },
  }));
  class FakeTursoStorage {
    convertAndCreateSubmitted = fakeTursoConvertAndCreateSubmitted;
    listEntries = vi.fn(async () => []);
    purgeExpired = vi.fn(async () => 0);
  }
  return { FakeTursoStorage, fakeTursoConvertAndCreateSubmitted };
});
vi.mock('cool-astro-forms/server/storage/turso.js', () => ({ TursoStorage: FakeTursoStorage }));

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GEO_PROVIDER;
  delete process.env.CAF_GEO_PROVIDER;
  delete process.env.CAF_GEO_TIMEOUT_MS;
  delete process.env.CAF_GEO_ENABLED;
  delete process.env.CAF_DRIVE_LINK_ACCESS;
  delete process.env.CAF_DRIVE_ROOT_FOLDER;
  delete process.env.CAF_DRIVE_FALLBACK_MAX_BYTES;
  delete process.env.CAF_STORAGE_KIND;
  delete process.env.CAF_TURSO_DATABASE_URL;
  delete process.env.CAF_TURSO_AUTH_TOKEN;
  fakeTursoConvertAndCreateSubmitted.mockClear();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function notImplemented(name: string) {
  return vi.fn(async () => {
    throw new Error(`${name} not stubbed for this test`);
  });
}

/**
 * Matches storage.convertAndCreateSubmitted's first parameter shape — typed
 * explicitly on the spy fixtures below so `.mock.calls[0]![0]` infers a
 * usable type instead of vitest's parameterless-arrow-function `[]` tuple.
 */
type ConvertInput = Omit<Entry, 'id' | 'createdAt' | 'updatedAt' | 'status'>;

function makeEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: 'entry-1',
    siteId: 'demo-site',
    formId: 'contact-form',
    status: 'submitted',
    fields: { email: 'jane@example.com' },
    visitorUuid: 'visitor-1',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function makeFakeStorage(overrides: Partial<StorageAdapter> = {}): StorageAdapter {
  return {
    createEntry: notImplemented('createEntry'),
    updateEntry: notImplemented('updateEntry'),
    findAbandoned: vi.fn(async () => undefined),
    listEntries: vi.fn(async () => []),
    countEntries: vi.fn(async () => 0),
    attachPayment: vi.fn(async () => undefined),
    attachFiles: vi.fn(async () => undefined),
    exportCsv: vi.fn(async () => ''),
    upsertAbandoned: notImplemented('upsertAbandoned') as unknown as StorageAdapter['upsertAbandoned'],
    convertAndCreateSubmitted: vi.fn(async () => ({ converted: 0, entry: makeEntry() })),
    purgeVisitor: vi.fn(async () => 0),
    purgeExpired: vi.fn(async () => 0),
    recordFormStart: vi.fn(async () => undefined),
    getFunnel: vi.fn(async () => ({ started: 0, abandoned: 0, submitted: 0, converted: 0 })),
    getTopDropOff: vi.fn(async () => []),
    getEntryById: vi.fn(async () => undefined),
    deleteEntry: vi.fn(async () => false),
    getPaymentByProviderRef: vi.fn(async () => undefined),
    getPaymentsByEntry: vi.fn(async () => []),
    updatePayment: notImplemented('updatePayment') as unknown as StorageAdapter['updatePayment'],
    appendPaymentEventIfAbsent: notImplemented(
      'appendPaymentEventIfAbsent',
    ) as unknown as StorageAdapter['appendPaymentEventIfAbsent'],
    listPayments: vi.fn(async () => []),
    countPayments: vi.fn(async () => 0),
    getFilesByEntry: vi.fn(async () => []),
    findRecoverableEntries: vi.fn(async () => []),
    markConsent: vi.fn(async () => undefined),
    markRecoverySent: vi.fn(async () => true),
    suppressRecovery: vi.fn(async () => undefined),
    isRecoverySuppressed: vi.fn(async () => false),
    consumeRateLimitToken: vi.fn(async () => true),
    ...overrides,
  };
}

function makeRequest(cookie?: string): Request {
  const headers = new Headers();
  if (cookie) headers.set('cookie', cookie);
  return new Request('https://example.com/api/upload', { method: 'POST', headers });
}

// ---------------------------------------------------------------------------
// Storage backend selection (05-04, ADPT-01/B1) — the CAF_STORAGE_KIND env
// bridge. No deps.storage is injected in these tests: recordSubmission must
// resolve its OWN production-default storage via getStorageAdapter(), which
// has no CoolFormsConfig to read and so relies entirely on the env bridge
// registerRuntimeConfig (middleware.ts) publishes from cfg.storage.kind.
// ---------------------------------------------------------------------------

describe('recordSubmission — storage backend selection (05-04 env bridge, ADPT-01)', () => {
  it('honors CAF_STORAGE_KIND=turso with NO deps.storage override — routes through the SAME backend the routes/middleware use, never a silent sqlite fallback', async () => {
    process.env.CAF_STORAGE_KIND = 'turso';
    process.env.CAF_TURSO_DATABASE_URL = 'libsql://example.turso.io';
    process.env.CAF_TURSO_AUTH_TOKEN = 'env-bridge-token';

    const result = await recordSubmission({
      siteId: 'demo-site',
      formId: 'contact-form',
      fields: { email: 'jane@example.com' },
      request: makeRequest('_caf_uid=visitor-1'),
    });

    expect(result).toEqual({ ok: true, entryId: 'turso-entry-1' });
    expect(fakeTursoConvertAndCreateSubmitted).toHaveBeenCalledTimes(1);
  });

  it('defaults to the sqlite backend when CAF_STORAGE_KIND is unset (byte-identical pre-05-04 behavior) — the turso adapter is never touched', async () => {
    delete process.env.CAF_STORAGE_KIND;

    // A real, config-less recordSubmission call with no deps.storage falls
    // through to getStorageAdapter()'s sqlite branch, which opens a REAL
    // better-sqlite3 connection (CAF_DB_PATH fallback) rather than throwing
    // — proving the default path stays untouched by the 05-04 factory.
    process.env.CAF_DB_PATH = ':memory:';
    const result = await recordSubmission({
      siteId: 'demo-site',
      formId: 'contact-form',
      fields: { email: 'jane@example.com' },
      request: makeRequest('_caf_uid=visitor-1'),
    });

    expect(result.ok).toBe(true);
    expect(fakeTursoConvertAndCreateSubmitted).not.toHaveBeenCalled();
    delete process.env.CAF_DB_PATH;
  });
});

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

describe('recordSubmission — conversion', () => {
  it('makes ONE convertAndCreateSubmitted call with CONVERT_LOOKBACK_MS when abandoned rows match', async () => {
    const convertAndCreateSubmitted = vi.fn(async () => ({
      converted: 2,
      entry: makeEntry({ id: 'entry-new' }),
    }));

    const result = await recordSubmission(
      {
        siteId: 'demo-site',
        formId: 'contact-form',
        fields: { email: 'jane@example.com' },
        request: makeRequest('_caf_uid=visitor-1'),
      },
      { storage: makeFakeStorage({ convertAndCreateSubmitted }), now: () => 5000 },
    );

    expect(result).toEqual({ ok: true, entryId: 'entry-new' });
    expect(convertAndCreateSubmitted).toHaveBeenCalledTimes(1);
    expect(convertAndCreateSubmitted).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: 'demo-site', formId: 'contact-form', visitorUuid: 'visitor-1' }),
      CONVERT_LOOKBACK_MS,
    );
  });

  it('with no matching abandoned row, creates only the submitted entry (converted: 0) and does not log a repeat', async () => {
    const convertAndCreateSubmitted = vi.fn(async () => ({ converted: 0, entry: makeEntry({ id: 'entry-only' }) }));
    const log = vi.fn();

    const result = await recordSubmission(
      {
        siteId: 'demo-site',
        formId: 'contact-form',
        fields: { email: 'jane@example.com' },
        request: makeRequest('_caf_uid=visitor-1'),
      },
      { storage: makeFakeStorage({ convertAndCreateSubmitted, listEntries: vi.fn(async () => []) }), log, now: () => 5000 },
    );

    expect(result).toEqual({ ok: true, entryId: 'entry-only' });
    expect(log).not.toHaveBeenCalledWith('record-submission.repeat', expect.anything());
  });
});

// ---------------------------------------------------------------------------
// Double submit
// ---------------------------------------------------------------------------

describe('recordSubmission — double submit', () => {
  it('logs record-submission.repeat when converted:0 and a prior submitted entry already exists', async () => {
    const convertAndCreateSubmitted = vi.fn(async () => ({ converted: 0, entry: makeEntry({ id: 'entry-second' }) }));
    const listEntries = vi.fn(async () => [makeEntry({ id: 'entry-first' })]);
    const log = vi.fn();

    const result = await recordSubmission(
      {
        siteId: 'demo-site',
        formId: 'contact-form',
        fields: { email: 'jane@example.com' },
        request: makeRequest('_caf_uid=visitor-1'),
      },
      { storage: makeFakeStorage({ convertAndCreateSubmitted, listEntries }), log, now: () => 5000 },
    );

    expect(result).toEqual({ ok: true, entryId: 'entry-second' });
    expect(listEntries).toHaveBeenCalledWith(
      expect.objectContaining({
        siteId: 'demo-site',
        formId: 'contact-form',
        visitorUuid: 'visitor-1',
        status: 'submitted',
      }),
    );
    expect(log).toHaveBeenCalledWith('record-submission.repeat', expect.objectContaining({ visitorUuid: 'visitor-1' }));
  });
});

// ---------------------------------------------------------------------------
// Visitor identity
// ---------------------------------------------------------------------------

describe('recordSubmission — visitor identity', () => {
  it('reads visitorUuid from the _caf_uid cookie on the request (headers only)', async () => {
    const convertAndCreateSubmitted = vi.fn(async (_input: ConvertInput) => ({ converted: 0, entry: makeEntry() }));

    await recordSubmission(
      {
        siteId: 'demo-site',
        formId: 'contact-form',
        fields: {},
        request: makeRequest('other=1; _caf_uid=visitor-xyz; another=2'),
      },
      { storage: makeFakeStorage({ convertAndCreateSubmitted }), now: () => 5000 },
    );

    expect(convertAndCreateSubmitted).toHaveBeenCalledWith(
      expect.objectContaining({ visitorUuid: 'visitor-xyz' }),
      CONVERT_LOOKBACK_MS,
    );
  });
});

// ---------------------------------------------------------------------------
// Journey envelope
// ---------------------------------------------------------------------------

describe('recordSubmission — journey envelope', () => {
  it('stitches server-recomputed durations from the fields._caf JSON-string envelope and strips _caf from persisted fields', async () => {
    const convertAndCreateSubmitted = vi.fn(async (_input: ConvertInput) => ({ converted: 0, entry: makeEntry() }));
    const envelope = JSON.stringify({
      journey: [
        { url: '/a', title: 'A', ts: 1000, duration: 999999 }, // forged client duration must be ignored
        { url: '/b', title: 'B', ts: 4000 },
      ],
    });

    await recordSubmission(
      {
        siteId: 'demo-site',
        formId: 'contact-form',
        fields: { email: 'jane@example.com', [CAF_FIELD_NAME]: envelope },
        request: makeRequest('_caf_uid=visitor-1'),
      },
      { storage: makeFakeStorage({ convertAndCreateSubmitted }), now: () => 5000 },
    );

    const callArgs = convertAndCreateSubmitted.mock.calls[0]![0] as {
      fields: Record<string, unknown>;
      journey: Array<{ url: string; durationMs: number }>;
    };
    expect(callArgs.fields).not.toHaveProperty(CAF_FIELD_NAME);
    expect(callArgs.fields.email).toBe('jane@example.com');
    expect(callArgs.journey).toEqual([
      expect.objectContaining({ url: '/a', durationMs: 3000 }),
      expect.objectContaining({ url: '/b', durationMs: 1000 }),
    ]);
    expect(callArgs.journey[0]).not.toHaveProperty('duration');
  });

  it('accepts an already-parsed _caf object (not a JSON string)', async () => {
    const convertAndCreateSubmitted = vi.fn(async (_input: ConvertInput) => ({ converted: 0, entry: makeEntry() }));

    await recordSubmission(
      {
        siteId: 'demo-site',
        formId: 'contact-form',
        fields: { [CAF_FIELD_NAME]: { journey: [{ url: '/a', title: 'A', ts: 1000 }] } },
        request: makeRequest('_caf_uid=visitor-1'),
      },
      { storage: makeFakeStorage({ convertAndCreateSubmitted }), now: () => 5000 },
    );

    const callArgs = convertAndCreateSubmitted.mock.calls[0]![0] as { journey: unknown[] };
    expect(callArgs.journey).toHaveLength(1);
  });

  it('tolerates an absent _caf envelope — records with an empty journey, never throws', async () => {
    const convertAndCreateSubmitted = vi.fn(async (_input: ConvertInput) => ({ converted: 0, entry: makeEntry() }));

    const result = await recordSubmission(
      {
        siteId: 'demo-site',
        formId: 'contact-form',
        fields: { email: 'jane@example.com' },
        request: makeRequest('_caf_uid=visitor-1'),
      },
      { storage: makeFakeStorage({ convertAndCreateSubmitted }), now: () => 5000 },
    );

    expect(result.ok).toBe(true);
    const callArgs = convertAndCreateSubmitted.mock.calls[0]![0] as { journey: unknown[] };
    expect(callArgs.journey).toEqual([]);
  });

  it('tolerates malformed _caf JSON — records with an empty journey, never throws', async () => {
    const convertAndCreateSubmitted = vi.fn(async (_input: ConvertInput) => ({ converted: 0, entry: makeEntry() }));

    const result = await recordSubmission(
      {
        siteId: 'demo-site',
        formId: 'contact-form',
        fields: { [CAF_FIELD_NAME]: '{not valid json' },
        request: makeRequest('_caf_uid=visitor-1'),
      },
      { storage: makeFakeStorage({ convertAndCreateSubmitted }), now: () => 5000 },
    );

    expect(result.ok).toBe(true);
    const callArgs = convertAndCreateSubmitted.mock.calls[0]![0] as { journey: unknown[] };
    expect(callArgs.journey).toEqual([]);
  });

  it('tolerates a wrong-shape _caf envelope — records with an empty journey, never throws', async () => {
    const convertAndCreateSubmitted = vi.fn(async (_input: ConvertInput) => ({ converted: 0, entry: makeEntry() }));

    const result = await recordSubmission(
      {
        siteId: 'demo-site',
        formId: 'contact-form',
        fields: { [CAF_FIELD_NAME]: { unexpected: true } },
        request: makeRequest('_caf_uid=visitor-1'),
      },
      { storage: makeFakeStorage({ convertAndCreateSubmitted }), now: () => 5000 },
    );

    expect(result.ok).toBe(true);
    const callArgs = convertAndCreateSubmitted.mock.calls[0]![0] as { journey: unknown[] };
    expect(callArgs.journey).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Files (DRV-01, DRV-02) — FileInput[] -> uploadFilesToDrive (injected) ->
// attachFiles metadata-only + FileUploadOutcome[] host-facing return.
// ---------------------------------------------------------------------------

describe('recordSubmission — files', () => {
  function makeFileInput(overrides: Partial<{ filename: string; buffer: Buffer; mimeType?: string }> = {}) {
    return {
      filename: 'a.pdf',
      buffer: Buffer.from('file bytes'),
      mimeType: 'application/pdf',
      ...overrides,
    };
  }

  it('W2 (migrated): a Drive success uploads via the injected orchestrator, attaches METADATA ONLY (never a buffer), and returns {filename, driveLink}', async () => {
    const convertAndCreateSubmitted = vi.fn(async () => ({ converted: 0, entry: makeEntry({ id: 'entry-1', createdAt: 5000 }) }));
    const attachFiles = vi.fn(async (_entryId: string, _files: Record<string, unknown>[]) => undefined);
    const file = makeFileInput();
    const uploadFilesToDrive = vi.fn(async () => [
      {
        filename: 'a.pdf',
        sizeBytes: file.buffer.length,
        mime: 'application/pdf',
        storage: 'drive' as const,
        driveFileId: 'drive-file-1',
        driveLink: 'https://drive.google.com/file/d/drive-file-1/view',
      },
    ]);

    const result = await recordSubmission(
      {
        siteId: 'demo-site',
        formId: 'contact-form',
        fields: {},
        files: [file],
        request: makeRequest('_caf_uid=visitor-1'),
      },
      { storage: makeFakeStorage({ convertAndCreateSubmitted, attachFiles }), uploadFilesToDrive, now: () => 5000 },
    );

    expect(uploadFilesToDrive).toHaveBeenCalledWith(
      [file],
      expect.objectContaining({ siteId: 'demo-site', entryId: 'entry-1', entryCreatedAt: 5000 }),
    );
    expect(attachFiles).toHaveBeenCalledWith('entry-1', [
      {
        filename: 'a.pdf',
        sizeBytes: file.buffer.length,
        mime: 'application/pdf',
        storage: 'drive',
        driveFileId: 'drive-file-1',
        driveLink: 'https://drive.google.com/file/d/drive-file-1/view',
      },
    ]);
    // NEVER a buffer field reaches storage.attachFiles (T-04-19).
    const attachedRow = attachFiles.mock.calls[0]![1][0]!;
    expect(attachedRow).not.toHaveProperty('buffer');
    expect(attachedRow).not.toHaveProperty('fallbackBuffer');
    expect(result).toEqual({
      ok: true,
      entryId: 'entry-1',
      files: [{ filename: 'a.pdf', driveLink: 'https://drive.google.com/file/d/drive-file-1/view' }],
    });
  });

  it('a Drive failure (email-only outcome) attaches an email-only file record, returns {filename, fallbackBuffer}, and the submission entry STILL exists (DRV-02: never lost)', async () => {
    const convertAndCreateSubmitted = vi.fn(async () => ({ converted: 0, entry: makeEntry({ id: 'entry-2', createdAt: 5000 }) }));
    const attachFiles = vi.fn(async () => undefined);
    const file = makeFileInput({ filename: 'b.pdf' });
    const uploadFilesToDrive = vi.fn(async () => [
      {
        filename: 'b.pdf',
        sizeBytes: file.buffer.length,
        mime: 'application/pdf',
        storage: 'email-only' as const,
        fallbackBuffer: file.buffer,
      },
    ]);

    const result = await recordSubmission(
      {
        siteId: 'demo-site',
        formId: 'contact-form',
        fields: {},
        files: [file],
        request: makeRequest('_caf_uid=visitor-1'),
      },
      { storage: makeFakeStorage({ convertAndCreateSubmitted, attachFiles }), uploadFilesToDrive, now: () => 5000 },
    );

    expect(attachFiles).toHaveBeenCalledWith('entry-2', [
      { filename: 'b.pdf', sizeBytes: file.buffer.length, mime: 'application/pdf', storage: 'email-only', driveFileId: undefined, driveLink: undefined },
    ]);
    expect(result).toEqual({ ok: true, entryId: 'entry-2', files: [{ filename: 'b.pdf', fallbackBuffer: file.buffer }] });
  });

  it('a fallback buffer over attachmentFallbackMaxBytes returns {filename, fallbackTooLarge:true} (no buffer) but still {ok:true} with the entry saved', async () => {
    const convertAndCreateSubmitted = vi.fn(async () => ({ converted: 0, entry: makeEntry({ id: 'entry-3', createdAt: 5000 }) }));
    const attachFiles = vi.fn(async () => undefined);
    const file = makeFileInput({ filename: 'huge.zip' });
    const uploadFilesToDrive = vi.fn(async () => [
      {
        filename: 'huge.zip',
        sizeBytes: file.buffer.length,
        mime: 'application/pdf',
        storage: 'email-only' as const,
        fallbackTooLarge: true,
      },
    ]);

    const result = await recordSubmission(
      {
        siteId: 'demo-site',
        formId: 'contact-form',
        fields: {},
        files: [file],
        request: makeRequest('_caf_uid=visitor-1'),
      },
      { storage: makeFakeStorage({ convertAndCreateSubmitted, attachFiles }), uploadFilesToDrive, now: () => 5000 },
    );

    expect(result).toEqual({ ok: true, entryId: 'entry-3', files: [{ filename: 'huge.zip', fallbackTooLarge: true }] });
    expect(attachFiles).toHaveBeenCalledTimes(1);
  });

  it('skips the upload entirely and returns {ok:true, entryId} with NO files key when no files are provided (additive-safety when no files are sent)', async () => {
    const convertAndCreateSubmitted = vi.fn(async () => ({ converted: 0, entry: makeEntry({ id: 'entry-4' }) }));
    const attachFiles = vi.fn(async () => undefined);
    const uploadFilesToDrive = vi.fn(async () => []);

    const result = await recordSubmission(
      {
        siteId: 'demo-site',
        formId: 'contact-form',
        fields: {},
        request: makeRequest('_caf_uid=visitor-1'),
      },
      { storage: makeFakeStorage({ convertAndCreateSubmitted, attachFiles }), uploadFilesToDrive, now: () => 5000 },
    );

    expect(attachFiles).not.toHaveBeenCalled();
    expect(uploadFilesToDrive).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, entryId: 'entry-4' });
    expect(result).not.toHaveProperty('files');
  });

  it('a thrown error inside the upload path never escapes — the host still sees {ok:true} (entry saved) with the affected files degraded to fallback', async () => {
    const convertAndCreateSubmitted = vi.fn(async () => ({ converted: 0, entry: makeEntry({ id: 'entry-5', createdAt: 5000 }) }));
    const attachFiles = vi.fn(async () => undefined);
    const file = makeFileInput({ filename: 'c.pdf' });
    const uploadFilesToDrive = vi.fn(async () => {
      throw new Error('drive orchestrator exploded');
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await recordSubmission(
      {
        siteId: 'demo-site',
        formId: 'contact-form',
        fields: {},
        files: [file],
        request: makeRequest('_caf_uid=visitor-1'),
      },
      { storage: makeFakeStorage({ convertAndCreateSubmitted, attachFiles }), uploadFilesToDrive, now: () => 5000 },
    );

    expect(result).toEqual({ ok: true, entryId: 'entry-5', files: [{ filename: 'c.pdf', fallbackBuffer: file.buffer }] });
    expect(attachFiles).toHaveBeenCalledWith('entry-5', [
      { filename: 'c.pdf', sizeBytes: file.buffer.length, mime: 'application/pdf', storage: 'email-only', driveFileId: undefined, driveLink: undefined },
    ]);
    consoleError.mockRestore();
  });

  it('a storage.attachFiles persistence hiccup still returns the outcomes + {ok:true} (attach failure is logged, not fatal)', async () => {
    const convertAndCreateSubmitted = vi.fn(async () => ({ converted: 0, entry: makeEntry({ id: 'entry-6', createdAt: 5000 }) }));
    const attachFiles = vi.fn(async () => {
      throw new Error('disk full');
    });
    const file = makeFileInput({ filename: 'd.pdf' });
    const uploadFilesToDrive = vi.fn(async () => [
      {
        filename: 'd.pdf',
        sizeBytes: file.buffer.length,
        mime: 'application/pdf',
        storage: 'drive' as const,
        driveFileId: 'drive-file-6',
        driveLink: 'https://drive.google.com/file/d/drive-file-6/view',
      },
    ]);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await recordSubmission(
      {
        siteId: 'demo-site',
        formId: 'contact-form',
        fields: {},
        files: [file],
        request: makeRequest('_caf_uid=visitor-1'),
      },
      { storage: makeFakeStorage({ convertAndCreateSubmitted, attachFiles }), uploadFilesToDrive, now: () => 5000 },
    );

    expect(result).toEqual({
      ok: true,
      entryId: 'entry-6',
      files: [{ filename: 'd.pdf', driveLink: 'https://drive.google.com/file/d/drive-file-6/view' }],
    });
    consoleError.mockRestore();
  });

  it('the non-injected PRODUCTION DEFAULT reads CAF_DRIVE_LINK_ACCESS / CAF_DRIVE_ROOT_FOLDER / CAF_DRIVE_FALLBACK_MAX_BYTES verbatim into the config passed to the real uploadFilesToDrive seam', async () => {
    process.env.CAF_DRIVE_LINK_ACCESS = 'anyone';
    process.env.CAF_DRIVE_ROOT_FOLDER = 'custom-root';
    process.env.CAF_DRIVE_FALLBACK_MAX_BYTES = '2048';

    // No GOOGLE_DRIVE_* keys set -> the real drive.ts orchestrator is fully
    // inert (driveConfigured() false) and degrades every file to fallback
    // without any network call — safe to exercise the real (non-injected)
    // uploadFilesToDrive here.
    const convertAndCreateSubmitted = vi.fn(async () => ({ converted: 0, entry: makeEntry({ id: 'entry-7', createdAt: 5000 }) }));
    const attachFiles = vi.fn(async () => undefined);
    const file = makeFileInput({ filename: 'e.pdf', buffer: Buffer.from('small') });

    const result = await recordSubmission(
      {
        siteId: 'demo-site',
        formId: 'contact-form',
        fields: {},
        files: [file],
        request: makeRequest('_caf_uid=visitor-1'),
      },
      // NOTE: no deps.uploadFilesToDrive — proves the non-injected default path.
      { storage: makeFakeStorage({ convertAndCreateSubmitted, attachFiles }), now: () => 5000 },
    );

    expect(result).toEqual({ ok: true, entryId: 'entry-7', files: [{ filename: 'e.pdf', fallbackBuffer: file.buffer }] });

    delete process.env.CAF_DRIVE_LINK_ACCESS;
    delete process.env.CAF_DRIVE_ROOT_FOLDER;
    delete process.env.CAF_DRIVE_FALLBACK_MAX_BYTES;
  });

  it('CAF_DRIVE_FALLBACK_MAX_BYTES governs the non-injected default fallback ceiling — a file over the configured max degrades to fallbackTooLarge', async () => {
    process.env.CAF_DRIVE_FALLBACK_MAX_BYTES = '4';

    const convertAndCreateSubmitted = vi.fn(async () => ({ converted: 0, entry: makeEntry({ id: 'entry-8', createdAt: 5000 }) }));
    const attachFiles = vi.fn(async () => undefined);
    const file = makeFileInput({ filename: 'f.pdf', buffer: Buffer.from('this buffer is definitely over 4 bytes') });

    const result = await recordSubmission(
      {
        siteId: 'demo-site',
        formId: 'contact-form',
        fields: {},
        files: [file],
        request: makeRequest('_caf_uid=visitor-1'),
      },
      { storage: makeFakeStorage({ convertAndCreateSubmitted, attachFiles }), now: () => 5000 },
    );

    expect(result).toEqual({ ok: true, entryId: 'entry-8', files: [{ filename: 'f.pdf', fallbackTooLarge: true }] });

    delete process.env.CAF_DRIVE_FALLBACK_MAX_BYTES;
  });
});

// ---------------------------------------------------------------------------
// Error isolation (S1-F1, T-01-39) — recordSubmission NEVER throws
// ---------------------------------------------------------------------------

describe('recordSubmission — error isolation', () => {
  it('resolves {ok:false, error} and never throws when the storage entry-creation call rejects', async () => {
    const convertAndCreateSubmitted = vi.fn(async () => {
      throw new Error('disk full');
    });

    const result = await recordSubmission(
      {
        siteId: 'demo-site',
        formId: 'contact-form',
        fields: {},
        request: makeRequest('_caf_uid=visitor-1'),
      },
      { storage: makeFakeStorage({ convertAndCreateSubmitted }), now: () => 5000 },
    );

    expect(result).toEqual({ ok: false, error: 'disk full' });
  });

  it('logs record-submission.failed via the structured logger when a storage call throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const convertAndCreateSubmitted = vi.fn(async (_input: ConvertInput) => {
      throw new Error('disk full');
    });

    await recordSubmission(
      {
        siteId: 'demo-site',
        formId: 'contact-form',
        fields: {},
        request: makeRequest('_caf_uid=visitor-1'),
      },
      { storage: makeFakeStorage({ convertAndCreateSubmitted }), now: () => 5000 },
    );

    expect(consoleError).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(consoleError.mock.calls[0]![0] as string) as { event: string; level: string };
    expect(logged.event).toBe('record-submission.failed');
    expect(logged.level).toBe('error');
    consoleError.mockRestore();
  });

  it('resolves {ok:false} without throwing when storage.listEntries rejects', async () => {
    const listEntries = vi.fn(async () => {
      throw new Error('busy');
    });

    await expect(
      recordSubmission(
        {
          siteId: 'demo-site',
          formId: 'contact-form',
          fields: {},
          request: makeRequest('_caf_uid=visitor-1'),
        },
        { storage: makeFakeStorage({ listEntries }), now: () => 5000 },
      ),
    ).resolves.toEqual({ ok: false, error: 'busy' });
  });

  it('never throws even with no cookie at all on the request', async () => {
    const convertAndCreateSubmitted = vi.fn(async (_input: ConvertInput) => ({ converted: 0, entry: makeEntry() }));

    await expect(
      recordSubmission(
        { siteId: 'demo-site', formId: 'contact-form', fields: {}, request: makeRequest() },
        { storage: makeFakeStorage({ convertAndCreateSubmitted }), now: () => 5000 },
      ),
    ).resolves.toEqual(expect.objectContaining({ ok: true }));
  });
});

// ---------------------------------------------------------------------------
// Geo enrichment (GEO-01, real non-injected callers)
// ---------------------------------------------------------------------------

describe('recordSubmission — geo enrichment', () => {
  it('args.ip takes precedence over X-Forwarded-For for geo resolution', async () => {
    const geo = vi.fn(async () => ({ city: 'X' }));
    const convertAndCreateSubmitted = vi.fn(async (_input: ConvertInput) => ({ converted: 0, entry: makeEntry() }));
    const request = makeRequest('_caf_uid=visitor-1');
    request.headers.set('x-forwarded-for', '9.9.9.9, 8.8.8.8');

    await recordSubmission(
      { siteId: 'demo-site', formId: 'contact-form', fields: {}, request, ip: '203.0.113.5' },
      { storage: makeFakeStorage({ convertAndCreateSubmitted }), geo, now: () => 5000 },
    );

    expect(geo).toHaveBeenCalledWith('203.0.113.5');
  });

  it('falls back to the first X-Forwarded-For hop (trimmed) when args.ip is absent', async () => {
    const geo = vi.fn(async () => ({ city: 'X' }));
    const convertAndCreateSubmitted = vi.fn(async (_input: ConvertInput) => ({ converted: 0, entry: makeEntry() }));
    const request = makeRequest('_caf_uid=visitor-1');
    request.headers.set('x-forwarded-for', '9.9.9.9, 8.8.8.8');

    await recordSubmission(
      { siteId: 'demo-site', formId: 'contact-form', fields: {}, request },
      { storage: makeFakeStorage({ convertAndCreateSubmitted }), geo, now: () => 5000 },
    );

    expect(geo).toHaveBeenCalledWith('9.9.9.9');
  });

  it('no args.ip and no X-Forwarded-For — geo is not invoked, geo stays undefined on the entry', async () => {
    const geo = vi.fn(async () => ({ city: 'X' }));
    const convertAndCreateSubmitted = vi.fn(async (_input: ConvertInput) => ({ converted: 0, entry: makeEntry() }));

    await recordSubmission(
      { siteId: 'demo-site', formId: 'contact-form', fields: {}, request: makeRequest('_caf_uid=visitor-1') },
      { storage: makeFakeStorage({ convertAndCreateSubmitted }), geo, now: () => 5000 },
    );

    expect(geo).not.toHaveBeenCalled();
    const callArgs = convertAndCreateSubmitted.mock.calls[0]![0] as { geo?: unknown };
    expect(callArgs.geo).toBeUndefined();
  });

  it('an injected deps.geo wins over the production default and is forwarded to convertAndCreateSubmitted', async () => {
    const geoValue = { city: 'Injected City' };
    const geo = vi.fn(async () => geoValue);
    const convertAndCreateSubmitted = vi.fn(async (_input: ConvertInput) => ({ converted: 0, entry: makeEntry() }));

    await recordSubmission(
      {
        siteId: 'demo-site',
        formId: 'contact-form',
        fields: {},
        request: makeRequest('_caf_uid=visitor-1'),
        ip: '203.0.113.5',
      },
      { storage: makeFakeStorage({ convertAndCreateSubmitted }), geo, now: () => 5000 },
    );

    const callArgs = convertAndCreateSubmitted.mock.calls[0]![0] as { geo?: unknown };
    expect(callArgs.geo).toEqual(geoValue);
  });

  it('a rejecting injected geo dep never fails the submission — result stays {ok:true} with geo undefined', async () => {
    const geo = vi.fn(async () => {
      throw new Error('geo lookup exploded');
    });
    const convertAndCreateSubmitted = vi.fn(async (_input: ConvertInput) => ({ converted: 0, entry: makeEntry() }));

    const result = await recordSubmission(
      {
        siteId: 'demo-site',
        formId: 'contact-form',
        fields: {},
        request: makeRequest('_caf_uid=visitor-1'),
        ip: '203.0.113.5',
      },
      { storage: makeFakeStorage({ convertAndCreateSubmitted }), geo, now: () => 5000 },
    );

    expect(result.ok).toBe(true);
    const callArgs = convertAndCreateSubmitted.mock.calls[0]![0] as { geo?: unknown };
    expect(callArgs.geo).toBeUndefined();
  });

  it('the non-injected PRODUCTION DEFAULT builds a real lookupGeo (mocked fetch) and enriches the submission', async () => {
    const fetchMock = vi.fn(async (_url: string) => ({
      ok: true,
      json: async () => ({
        success: true,
        city: 'Mountain View',
        region: 'California',
        country: 'United States',
        latitude: 37.4056,
        longitude: -122.0775,
        postal: '94043',
        connection: { isp: 'Google LLC' },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const convertAndCreateSubmitted = vi.fn(async (_input: ConvertInput) => ({ converted: 0, entry: makeEntry() }));

    await recordSubmission(
      {
        siteId: 'demo-site',
        formId: 'contact-form',
        fields: {},
        request: makeRequest('_caf_uid=visitor-1'),
        ip: '203.0.113.5',
      },
      // NOTE: no deps.geo — proves the non-injected default path.
      { storage: makeFakeStorage({ convertAndCreateSubmitted }), now: () => 5000 },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://ipwho.is/203.0.113.5');
    const callArgs = convertAndCreateSubmitted.mock.calls[0]![0] as { geo?: unknown };
    expect(callArgs.geo).toEqual({
      city: 'Mountain View',
      region: 'California',
      country: 'United States',
      lat: 37.4056,
      lon: -122.0775,
      postal: '94043',
      isp: 'Google LLC',
    });
  });

  it('CAF_GEO_ENABLED="false" disables the production default — no fetch call, geo undefined', async () => {
    process.env.CAF_GEO_ENABLED = 'false';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const convertAndCreateSubmitted = vi.fn(async (_input: ConvertInput) => ({ converted: 0, entry: makeEntry() }));

    await recordSubmission(
      {
        siteId: 'demo-site',
        formId: 'contact-form',
        fields: {},
        request: makeRequest('_caf_uid=visitor-1'),
        ip: '203.0.113.5',
      },
      { storage: makeFakeStorage({ convertAndCreateSubmitted }), now: () => 5000 },
    );

    expect(fetchMock).not.toHaveBeenCalled();
    const callArgs = convertAndCreateSubmitted.mock.calls[0]![0] as { geo?: unknown };
    expect(callArgs.geo).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Outbound entry.submitted webhook (HOOK-01)
// ---------------------------------------------------------------------------

describe('recordSubmission — deliverWebhook wiring (HOOK-01)', () => {
  it('fires entry.submitted via deps.deliverWebhook exactly once on success, with the new entryId', async () => {
    const deliverWebhook = vi.fn();
    const convertAndCreateSubmitted = vi.fn(async () => ({ converted: 0, entry: makeEntry({ id: 'entry-9' }) }));

    const result = await recordSubmission(
      {
        siteId: 'demo-site',
        formId: 'contact-form',
        fields: { email: 'jane@example.com' },
        request: makeRequest('_caf_uid=visitor-1'),
      },
      { storage: makeFakeStorage({ convertAndCreateSubmitted }), deliverWebhook, now: () => 5000 },
    );

    expect(result).toEqual({ ok: true, entryId: 'entry-9' });
    expect(deliverWebhook).toHaveBeenCalledTimes(1);
    expect(deliverWebhook).toHaveBeenCalledWith(
      'entry.submitted',
      expect.objectContaining({ id: 'entry-9', siteId: 'demo-site', formId: 'contact-form' }),
    );
  });

  it('does NOT fire deliverWebhook when the submission fails (storage throw) — swallowed on the failure path', async () => {
    const deliverWebhook = vi.fn();
    const convertAndCreateSubmitted = vi.fn(async () => {
      throw new Error('disk full');
    });

    const result = await recordSubmission(
      { siteId: 'demo-site', formId: 'contact-form', fields: {}, request: makeRequest('_caf_uid=visitor-1') },
      { storage: makeFakeStorage({ convertAndCreateSubmitted }), deliverWebhook, now: () => 5000 },
    );

    expect(result.ok).toBe(false);
    expect(deliverWebhook).not.toHaveBeenCalled();
  });

  it('no deliverWebhook dep injected — no-op, submission proceeds normally', async () => {
    const convertAndCreateSubmitted = vi.fn(async () => ({ converted: 0, entry: makeEntry({ id: 'entry-only' }) }));

    const result = await recordSubmission(
      { siteId: 'demo-site', formId: 'contact-form', fields: {}, request: makeRequest('_caf_uid=visitor-1') },
      { storage: makeFakeStorage({ convertAndCreateSubmitted }), now: () => 5000 },
    );

    expect(result).toEqual({ ok: true, entryId: 'entry-only' });
  });
});

// ---------------------------------------------------------------------------
// Source assertions
// ---------------------------------------------------------------------------

describe('recordSubmission — source assertions', () => {
  it('contains no request.text( or request.json( call — headers only', async () => {
    const fs = await import('node:fs');
    const source = fs.readFileSync(new URL('./record-submission.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/request\.text\(/);
    expect(source).not.toMatch(/request\.json\(/);
  });

  it('the fire-and-forget purge call site carries .catch( — no bare rejection', async () => {
    const fs = await import('node:fs');
    const source = fs.readFileSync(new URL('./record-submission.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/purgeExpired\([^)]*\)\.catch\(/);
  });
});
