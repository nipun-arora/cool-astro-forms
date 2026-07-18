/**
 * admin-secret.ts tests — HMAC signing key resolution for admin sessions:
 * env-first, else generate + persist beside dbPath (db.ts's data/ persistence
 * convention — S9 backup precedent), never regenerated once persisted.
 *
 * D2 fix #2 (05-01): CAF_REQUIRE_EXPLICIT_SECRETS truthiness boundary +
 * fail-loud-instead-of-generate coverage for resolveAdminSecret.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { explicitSecretsRequired, resolveAdminSecret } from './admin-secret.js';

const ORIGINAL_SECRET = process.env.FORMS_ADMIN_SECRET;
const ORIGINAL_REQUIRE_EXPLICIT = process.env.CAF_REQUIRE_EXPLICIT_SECRETS;

describe('resolveAdminSecret', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caf-admin-secret-'));
    dbPath = path.join(tmpDir, 'forms.db');
    delete process.env.FORMS_ADMIN_SECRET;
    delete process.env.CAF_REQUIRE_EXPLICIT_SECRETS;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (ORIGINAL_SECRET === undefined) delete process.env.FORMS_ADMIN_SECRET;
    else process.env.FORMS_ADMIN_SECRET = ORIGINAL_SECRET;
    if (ORIGINAL_REQUIRE_EXPLICIT === undefined) delete process.env.CAF_REQUIRE_EXPLICIT_SECRETS;
    else process.env.CAF_REQUIRE_EXPLICIT_SECRETS = ORIGINAL_REQUIRE_EXPLICIT;
  });

  it('returns FORMS_ADMIN_SECRET when set, without persisting a secret file', () => {
    process.env.FORMS_ADMIN_SECRET = 'env-provided-secret';
    expect(resolveAdminSecret(dbPath)).toBe('env-provided-secret');
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
  });

  it('generates and persists a secret beside dbPath when unset', () => {
    const secret = resolveAdminSecret(dbPath);
    expect(secret.length).toBeGreaterThan(0);

    const filesInDir = fs.readdirSync(tmpDir);
    expect(filesInDir.length).toBeGreaterThan(0);
  });

  it('persists the secret file with mode 0o600 (owner read/write only, CWE-732)', () => {
    resolveAdminSecret(dbPath);
    const secretPath = path.join(tmpDir, '.forms-admin-secret');
    const mode = fs.statSync(secretPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('returns the same persisted secret on a subsequent call (never regenerates)', () => {
    const first = resolveAdminSecret(dbPath);
    const second = resolveAdminSecret(dbPath);
    expect(second).toBe(first);
  });

  it('persists a secret at least 32 bytes of entropy (base64url of randomBytes(32))', () => {
    const secret = resolveAdminSecret(dbPath);
    // base64url of 32 random bytes is 43 chars (no padding).
    expect(secret.length).toBeGreaterThanOrEqual(40);
  });

  describe('CAF_REQUIRE_EXPLICIT_SECRETS unset (legacy default)', () => {
    it('still generates and persists beside dbPath — byte-identical to pre-05-01 behavior', () => {
      delete process.env.CAF_REQUIRE_EXPLICIT_SECRETS;
      const secret = resolveAdminSecret(dbPath);
      expect(secret.length).toBeGreaterThan(0);
      expect(fs.readdirSync(tmpDir).length).toBeGreaterThan(0);
    });
  });

  describe('CAF_REQUIRE_EXPLICIT_SECRETS truthy + FORMS_ADMIN_SECRET set', () => {
    it('returns the env secret and never touches disk', () => {
      process.env.CAF_REQUIRE_EXPLICIT_SECRETS = '1';
      process.env.FORMS_ADMIN_SECRET = 'explicit-secret-present';
      expect(resolveAdminSecret(dbPath)).toBe('explicit-secret-present');
      expect(fs.readdirSync(tmpDir)).toHaveLength(0);
    });
  });

  describe('CAF_REQUIRE_EXPLICIT_SECRETS truthy + FORMS_ADMIN_SECRET absent', () => {
    it('throws naming FORMS_ADMIN_SECRET and the ephemeral-FS rationale, without writing a secret file', () => {
      process.env.CAF_REQUIRE_EXPLICIT_SECRETS = '1';
      delete process.env.FORMS_ADMIN_SECRET;
      expect(() => resolveAdminSecret(dbPath)).toThrow(/FORMS_ADMIN_SECRET/);
      expect(() => resolveAdminSecret(dbPath)).toThrow(/cold start/i);
      expect(fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : []).toHaveLength(0);
    });
  });
});

describe('explicitSecretsRequired', () => {
  afterEach(() => {
    if (ORIGINAL_REQUIRE_EXPLICIT === undefined) delete process.env.CAF_REQUIRE_EXPLICIT_SECRETS;
    else process.env.CAF_REQUIRE_EXPLICIT_SECRETS = ORIGINAL_REQUIRE_EXPLICIT;
  });

  it.each(['1', 'true', 'TRUE', 'True'])('is on for %j', (value) => {
    process.env.CAF_REQUIRE_EXPLICIT_SECRETS = value;
    expect(explicitSecretsRequired()).toBe(true);
  });

  it.each([undefined, '', '0', 'false', 'FALSE', 'yes', '2'])('is off for %j', (value) => {
    if (value === undefined) delete process.env.CAF_REQUIRE_EXPLICIT_SECRETS;
    else process.env.CAF_REQUIRE_EXPLICIT_SECRETS = value;
    expect(explicitSecretsRequired()).toBe(false);
  });
});
