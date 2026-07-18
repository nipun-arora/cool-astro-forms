/**
 * unsubscribe-token.ts tests — the D4 one-click HMAC unsubscribe token.
 * Reuses the ONE HMAC convention in this package (sign.ts's
 * `createHmac('sha256')` + `tokensMatch` constant-time compare — RESEARCH
 * Don't Hand-Roll), so these cases mirror sign.test.ts's shape
 * (round-trip / wrong-key / tamper / malformed-never-throws).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveRecoverySecret, signUnsubscribeToken, verifyUnsubscribeToken } from './unsubscribe-token.js';

const SECRET = 'recovery_secret_do_not_use_in_prod';
const VISITOR_UUID = 'visitor-abc-123';

describe('signUnsubscribeToken / verifyUnsubscribeToken — round trip', () => {
  it('verifies a freshly signed token back to the same visitorUuid', () => {
    const token = signUnsubscribeToken(VISITOR_UUID, SECRET);
    expect(verifyUnsubscribeToken(token, SECRET)).toBe(VISITOR_UUID);
  });

  it('produces a `${visitorUuid}.${hex}` shaped token', () => {
    const token = signUnsubscribeToken(VISITOR_UUID, SECRET);
    const match = token.match(/^(.+)\.([0-9a-f]{64})$/);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe(VISITOR_UUID);
  });

  it('produces a different signature for a different secret (same visitorUuid)', () => {
    const a = signUnsubscribeToken(VISITOR_UUID, SECRET);
    const b = signUnsubscribeToken(VISITOR_UUID, 'a-different-secret');
    expect(a).not.toBe(b);
  });
});

describe('verifyUnsubscribeToken — wrong key / tamper / malformed', () => {
  it('resolves undefined when verified with the wrong secret', () => {
    const token = signUnsubscribeToken(VISITOR_UUID, SECRET);
    expect(verifyUnsubscribeToken(token, 'a-different-secret')).toBeUndefined();
  });

  it('resolves undefined for a tampered signature (flipped hex char)', () => {
    const token = signUnsubscribeToken(VISITOR_UUID, SECRET);
    const dotIndex = token.lastIndexOf('.');
    const uuidPart = token.slice(0, dotIndex);
    const sigPart = token.slice(dotIndex + 1);
    const flippedChar = sigPart[0] === 'a' ? 'b' : 'a';
    const tampered = `${uuidPart}.${flippedChar}${sigPart.slice(1)}`;
    expect(verifyUnsubscribeToken(tampered, SECRET)).toBeUndefined();
  });

  it('resolves undefined for a swapped visitorUuid keeping the original signature', () => {
    const token = signUnsubscribeToken(VISITOR_UUID, SECRET);
    const sigPart = token.slice(token.lastIndexOf('.') + 1);
    const swapped = `some-other-visitor-uuid.${sigPart}`;
    expect(verifyUnsubscribeToken(swapped, SECRET)).toBeUndefined();
  });

  it('resolves undefined for a token with no dot', () => {
    expect(verifyUnsubscribeToken('not-a-valid-token', SECRET)).toBeUndefined();
  });

  it('resolves undefined for an empty string', () => {
    expect(verifyUnsubscribeToken('', SECRET)).toBeUndefined();
  });

  it('resolves undefined for null/undefined input', () => {
    expect(verifyUnsubscribeToken(null, SECRET)).toBeUndefined();
    expect(verifyUnsubscribeToken(undefined, SECRET)).toBeUndefined();
  });

  it('resolves undefined for a token missing its signature (trailing dot, nothing after)', () => {
    expect(verifyUnsubscribeToken(`${VISITOR_UUID}.`, SECRET)).toBeUndefined();
  });

  it('resolves undefined for a token that is only a dot', () => {
    expect(verifyUnsubscribeToken('.', SECRET)).toBeUndefined();
  });

  it('never throws for any malformed token shape', () => {
    expect(() => verifyUnsubscribeToken('garbage', SECRET)).not.toThrow();
    expect(() => verifyUnsubscribeToken('.', SECRET)).not.toThrow();
    expect(() => verifyUnsubscribeToken('a.b.c', SECRET)).not.toThrow();
    expect(() => verifyUnsubscribeToken(null, SECRET)).not.toThrow();
  });

  it('splits on the LAST dot (defensive, even though visitor UUIDs contain no dot)', () => {
    // A visitorUuid containing a dot must still round-trip via the last-dot split.
    const weirdUuid = 'visitor.with.dots';
    const token = signUnsubscribeToken(weirdUuid, SECRET);
    expect(verifyUnsubscribeToken(token, SECRET)).toBe(weirdUuid);
  });
});

describe('resolveRecoverySecret', () => {
  const ORIGINAL_RECOVERY_SECRET = process.env.CAF_RECOVERY_SECRET;
  const ORIGINAL_ADMIN_SECRET = process.env.FORMS_ADMIN_SECRET;
  const ORIGINAL_REQUIRE_EXPLICIT = process.env.CAF_REQUIRE_EXPLICIT_SECRETS;
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caf-recovery-secret-'));
    dbPath = path.join(tmpDir, 'forms.db');
    delete process.env.CAF_RECOVERY_SECRET;
    delete process.env.FORMS_ADMIN_SECRET;
    delete process.env.CAF_REQUIRE_EXPLICIT_SECRETS;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (ORIGINAL_RECOVERY_SECRET === undefined) delete process.env.CAF_RECOVERY_SECRET;
    else process.env.CAF_RECOVERY_SECRET = ORIGINAL_RECOVERY_SECRET;
    if (ORIGINAL_ADMIN_SECRET === undefined) delete process.env.FORMS_ADMIN_SECRET;
    else process.env.FORMS_ADMIN_SECRET = ORIGINAL_ADMIN_SECRET;
    if (ORIGINAL_REQUIRE_EXPLICIT === undefined) delete process.env.CAF_REQUIRE_EXPLICIT_SECRETS;
    else process.env.CAF_REQUIRE_EXPLICIT_SECRETS = ORIGINAL_REQUIRE_EXPLICIT;
  });

  it('prefers CAF_RECOVERY_SECRET when set, without touching the admin-secret file', () => {
    process.env.CAF_RECOVERY_SECRET = 'env-recovery-secret';
    expect(resolveRecoverySecret(dbPath)).toBe('env-recovery-secret');
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
  });

  it('falls back to resolveAdminSecret(dbPath) when CAF_RECOVERY_SECRET is unset', () => {
    const secret = resolveRecoverySecret(dbPath);
    expect(secret.length).toBeGreaterThan(0);
    // resolveAdminSecret persists a file beside dbPath when it generates one.
    expect(fs.readdirSync(tmpDir).length).toBeGreaterThan(0);
  });

  it('the fallback secret matches resolveAdminSecret(dbPath) directly (same underlying resolver)', async () => {
    const { resolveAdminSecret } = await import('../security/admin-secret.js');
    const viaRecovery = resolveRecoverySecret(dbPath);
    const viaAdmin = resolveAdminSecret(dbPath);
    expect(viaRecovery).toBe(viaAdmin);
  });

  describe('CAF_REQUIRE_EXPLICIT_SECRETS unset (legacy default)', () => {
    it('still falls back to resolveAdminSecret(dbPath) — byte-identical to pre-05-01 behavior', () => {
      delete process.env.CAF_REQUIRE_EXPLICIT_SECRETS;
      const secret = resolveRecoverySecret(dbPath);
      expect(secret.length).toBeGreaterThan(0);
      expect(fs.readdirSync(tmpDir).length).toBeGreaterThan(0);
    });
  });

  describe('CAF_REQUIRE_EXPLICIT_SECRETS truthy + CAF_RECOVERY_SECRET set', () => {
    it('returns the env secret and never touches disk', () => {
      process.env.CAF_REQUIRE_EXPLICIT_SECRETS = '1';
      process.env.CAF_RECOVERY_SECRET = 'explicit-recovery-secret';
      expect(resolveRecoverySecret(dbPath)).toBe('explicit-recovery-secret');
      expect(fs.readdirSync(tmpDir)).toHaveLength(0);
    });
  });

  describe('CAF_REQUIRE_EXPLICIT_SECRETS truthy + CAF_RECOVERY_SECRET absent', () => {
    it('throws naming CAF_RECOVERY_SECRET and the ephemeral-FS rationale, WITHOUT falling back to resolveAdminSecret', () => {
      process.env.CAF_REQUIRE_EXPLICIT_SECRETS = '1';
      delete process.env.CAF_RECOVERY_SECRET;
      // Set FORMS_ADMIN_SECRET so a fallback-to-admin-secret bug would NOT
      // also throw for FORMS_ADMIN_SECRET reasons — isolates the assertion
      // to "did it throw for the recovery secret specifically".
      process.env.FORMS_ADMIN_SECRET = 'admin-secret-present';
      expect(() => resolveRecoverySecret(dbPath)).toThrow(/CAF_RECOVERY_SECRET/);
      expect(() => resolveRecoverySecret(dbPath)).toThrow(/cold start/i);
      expect(fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : []).toHaveLength(0);
    });
  });
});
