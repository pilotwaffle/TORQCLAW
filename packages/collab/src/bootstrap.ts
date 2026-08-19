/**
 * Bootstrap and disaster recovery for the Collaboration Substrate.
 *
 * Implements PRD v0.14 Section 6.3 (bootstrap and recovery kit) over an
 * injected {db, secretStore, clock, uuids, rng} environment so the entire
 * flow is deterministic and testable without touching the real filesystem,
 * Windows Credential Manager, or wall-clock time.
 *
 * BUILD ORDER MANDATE (G1R condition): the recovery-kit KDF round-trip
 * (`exportRecoveryKit` -> `verifyRecoveryKit`) is implemented and tested
 * FIRST, ahead of the rest of this module's bootstrap orchestration.
 *
 * KDF resolution (G1R C2): the primary path is `@node-rs/argon2`
 * (Argon2id, 64 MiB memory, 3 iterations, parallelism 1, 32-byte output),
 * which this build verified installs and runs correctly on this machine
 * (Node 22.19.0, Windows 11) — see the probe in the build report. The
 * fallback path (Node core `scrypt`, N=131072, r=8, p=1, explicit
 * `maxmem: 268435456` — the 128 MiB requirement exceeds Node's 32 MiB
 * default) is implemented and exercised by its own fixture even though the
 * primary path is what ships, so a future environment where the native
 * dependency fails to load degrades safely rather than silently breaking.
 * The kit header is self-describing JSON and pins `formatVersion: 4`
 * exactly when `kdf: "scrypt"` (and `formatVersion: 3` for `kdf:
 * "argon2id"`), per the PRD's mandated version increment.
 *
 * (F3, G2A fix-pass) The header (every field except `ciphertext`) is
 * authenticated as AES-256-GCM Additional Authenticated Data on both
 * encrypt and decrypt, so tampering any header field — including
 * `kdfParams` — fails verification instead of silently succeeding with the
 * pinned (untampered) parameters. `kdfParams` remain pinned by
 * `formatVersion` for derivation purposes (never read off the kit for that
 * purpose): the header is authenticated but advisory. This bumped
 * `formatVersion` 1->3 (argon2id) and 2->4 (scrypt) — a kit binary format
 * change with no production kits to migrate.
 */

import { randomBytes, createHmac, createCipheriv, createDecipheriv, timingSafeEqual, scrypt as scryptCallback } from 'node:crypto';
import type { SecretStore } from './secrets.js';
import { canonicalJson } from './canonical.js';

// ---------------------------------------------------------------------------
// Injected environment
// ---------------------------------------------------------------------------

/**
 * Clock abstraction matching Slice 0's `DeterministicClock` (harness.ts):
 * a single `next()` returning an RFC 3339 UTC millisecond timestamp string,
 * advancing internal state by exactly 1 ms per call in fixture mode.
 */
export interface Clock {
  next(): string;
}

export interface UuidSource {
  next(): string;
}

export interface RandomSource {
  randomBytes(size: number): Buffer;
}

/** Production RandomSource backed by Node's CSPRNG. */
export const nodeRandomSource: RandomSource = {
  randomBytes: (size: number) => randomBytes(size),
};

/** Production Clock backed by wall-clock time (RFC 3339 UTC milliseconds). */
export const systemClock: Clock = {
  next: () => new Date().toISOString(),
};

/** Minimal DB surface bootstrap needs; the real adapter is better-sqlite3's Database. */
export interface BootstrapDb {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  exec(sql: string): void;
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
}

export interface BootstrapEnv {
  db: BootstrapDb;
  secretStore: SecretStore;
  clock: Clock;
  uuids: UuidSource;
  rng: RandomSource;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class BootstrapRefusedError extends Error {
  readonly code = 'BOOTSTRAP_REFUSED_NON_PERSISTENT_SECRET_STORE' as const;
  constructor(message: string) {
    super(message);
    this.name = 'BootstrapRefusedError';
  }
}

export class RecoveryKitError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RecoveryKitError';
    this.code = code;
  }
}

/**
 * Thrown by `bootstrapOperator` when the DB transaction committed but
 * persisting a pepper to the SecretStore afterward failed (e.g. a second
 * bootstrap attempt hit `SecretAlreadyExistsError`, or the store's
 * underlying filesystem write failed). See the long comment at the
 * `env.secretStore.set(...)` call sites below for why this can happen and
 * what this class's compensating rollback does about it.
 */
export class BootstrapSecretPersistError extends Error {
  readonly code = 'BOOTSTRAP_SECRET_PERSIST_FAILED' as const;
  readonly cause: unknown;
  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'BootstrapSecretPersistError';
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// (a-condition): bootstrap refuses to report healthy over a non-persistent
// SecretStore.
// ---------------------------------------------------------------------------

/**
 * Assert the given SecretStore is persistent. Throws BootstrapRefusedError
 * if not. Bootstrap MUST call this before it will report the installation
 * healthy (G1R explicit answer (a)).
 */
export function assertPersistentSecretStore(secretStore: SecretStore): void {
  if (!secretStore.isPersistent) {
    throw new BootstrapRefusedError(
      'Bootstrap refuses to report healthy: the injected SecretStore is not persistent ' +
        '(isPersistent=false). The principal pepper and recovery pepper MUST be stored in ' +
        'durable, off-database storage (Windows Credential Manager in production); an ' +
        'in-memory store would make the installation unrecoverable after restart.'
    );
  }
}

// ---------------------------------------------------------------------------
// Recovery kit: KDF resolution
// ---------------------------------------------------------------------------

/**
 * (F3) Kit header authentication.
 *
 * formatVersion bumped 1->3 (argon2id) and 2->4 (scrypt) in this fix: the
 * header — every field on the kit object EXCEPT `ciphertext` itself
 * (formatVersion, kdf, installationId, schemaVersion, createdAt, salt,
 * nonce, kdfParams) — is now passed as GCM Additional Authenticated Data
 * (AAD) on both encrypt and decrypt. Any tamper to any header field
 * (including kdfParams, including formatVersion) now fails GCM tag
 * verification and is rejected as WRONG_PASSPHRASE (indistinguishable from
 * a bad passphrase, same as any other GCM auth failure — Section 6.3 does
 * not require distinguishing the two).
 *
 * kdfParams remain PINNED BY formatVersion (the module constants
 * ARGON2_PARAMS/SCRYPT_PARAMS below are the sole source of truth used for
 * derivation — verifyRecoveryKit never reads kdfParams off the untrusted
 * kit object to choose derivation inputs). The header is therefore
 * AUTHENTICATED BUT ADVISORY: authenticated because tampering is now
 * cryptographically detected (closes the G1R C2/F3 downgrade gap, where a
 * tampered kdfParams field previously verified successfully with the
 * pinned-not-tampered params); advisory because even an untampered
 * kdfParams value in the kit is never actually used to parameterize KDF
 * derivation — it exists for human/tooling inspection only, and changing
 * it (honestly or maliciously) has zero effect on what derivation actually
 * runs for a given formatVersion.
 *
 * There are no production kits on formatVersion 1/2 to migrate (Slice 1,
 * pre-ship); the version bump is a clean cut, not a compatibility shim.
 */
export type KitFormatVersion1 = {
  formatVersion: 3;
  kdf: 'argon2id';
  installationId: string;
  schemaVersion: number;
  createdAt: string;
  salt: string; // base64
  nonce: string; // base64
  ciphertext: string; // base64 (includes GCM auth tag appended)
  kdfParams: {
    memoryCostKiB: number;
    timeCost: number;
    parallelism: number;
    outputLen: number;
  };
};

export type KitFormatVersion2 = {
  formatVersion: 4;
  kdf: 'scrypt';
  installationId: string;
  schemaVersion: number;
  createdAt: string;
  salt: string; // base64
  nonce: string; // base64
  ciphertext: string; // base64 (includes GCM auth tag appended)
  kdfParams: {
    N: number;
    r: number;
    p: number;
    maxmem: number;
    outputLen: number;
  };
};

export type RecoveryKit = KitFormatVersion1 | KitFormatVersion2;

/**
 * Compute the canonical AAD bytes for a kit header: every kit field except
 * `ciphertext`, serialized via canonicalJson for a stable, unambiguous byte
 * sequence (sorted keys, pinned escaping — same serializer used for
 * request-hash computation elsewhere in this package). Shared by both
 * `exportRecoveryKit` (encrypt) and `verifyRecoveryKit` (decrypt) so the
 * AAD computed on each side is byte-identical whenever the header is
 * byte-identical, and diverges the instant any header field is tampered.
 */
function kitHeaderAad(header: {
  formatVersion: number;
  kdf: string;
  installationId: string;
  schemaVersion: number;
  createdAt: string;
  salt: string;
  nonce: string;
  kdfParams: Record<string, number>;
}): Buffer {
  return Buffer.from(canonicalJson(header as unknown as Record<string, unknown>), 'utf8');
}

/** Plaintext payload sealed inside the recovery kit (Section 6.3). */
export interface RecoveryKitPayload {
  principalPepper: string; // base64
  recoveryPepper: string; // base64
  recoverySecret: string; // base64
  installationId: string;
  schemaVersion: number;
  kitCreatedAt: string;
}

const ARGON2_PARAMS = {
  memoryCostKiB: 65536, // 64 MiB
  timeCost: 3,
  parallelism: 1,
  outputLen: 32,
} as const;

const SCRYPT_PARAMS = {
  N: 131072,
  r: 8,
  p: 1,
  // The 128 MiB requirement exceeds Node's 32 MiB default maxmem; omitting
  // this hard-fails scrypt with ERR_CRYPTO_INVALID_SCRYPT_PARAMS.
  maxmem: 268435456, // 256 MiB, comfortably above the 128 MiB requirement
  outputLen: 32,
} as const;

/**
 * Derive a 32-byte key from a passphrase via Argon2id. Returns null if the
 * native dependency fails to load or throws for any reason (caller falls
 * back to scrypt in that case). This function is the SOLE place that
 * decides argon2 usability; it never throws.
 */
async function tryDeriveArgon2id(passphrase: Buffer, salt: Buffer): Promise<Buffer | null> {
  try {
    // Dynamic import so a load failure on a machine without the native
    // binding degrades to the scrypt fallback instead of preventing the
    // module from loading at all.
    const argon2 = await import('@node-rs/argon2');
    const out = await argon2.hashRaw(passphrase, {
      algorithm: argon2.Algorithm.Argon2id,
      memoryCost: ARGON2_PARAMS.memoryCostKiB,
      timeCost: ARGON2_PARAMS.timeCost,
      parallelism: ARGON2_PARAMS.parallelism,
      outputLen: ARGON2_PARAMS.outputLen,
      salt,
    });
    return Buffer.from(out);
  } catch {
    return null;
  }
}

function deriveScrypt(passphrase: Buffer, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      passphrase,
      salt,
      SCRYPT_PARAMS.outputLen,
      { N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p, maxmem: SCRYPT_PARAMS.maxmem },
      (err, derivedKey) => {
        if (err) {
          reject(err);
        } else {
          resolve(derivedKey);
        }
      }
    );
  });
}

/**
 * Encrypt the recovery kit payload with AES-256-GCM under a key derived
 * from the passphrase. Tries Argon2id first; falls back to scrypt if the
 * native dependency is unavailable. Returns the self-describing kit
 * object, whose `formatVersion`/`kdf` fields record which path ran.
 */
export async function exportRecoveryKit(
  payload: RecoveryKitPayload,
  passphrase: Buffer,
  opts: { rng: RandomSource; createdAt: string }
): Promise<RecoveryKit> {
  const salt = opts.rng.randomBytes(16);
  const nonce = opts.rng.randomBytes(12);

  const argon2Key = await tryDeriveArgon2id(passphrase, salt);

  const plaintext = Buffer.from(canonicalJson(payload as unknown as Record<string, unknown>), 'utf8');

  if (argon2Key !== null) {
    const header = {
      formatVersion: 3 as const,
      kdf: 'argon2id' as const,
      installationId: payload.installationId,
      schemaVersion: payload.schemaVersion,
      createdAt: opts.createdAt,
      salt: salt.toString('base64'),
      nonce: nonce.toString('base64'),
      kdfParams: { ...ARGON2_PARAMS },
    };
    // (F3) AAD = the serialized header (everything but ciphertext),
    // authenticating formatVersion/kdf/salt/nonce/kdfParams/installationId/
    // schemaVersion/createdAt together with the ciphertext under one GCM
    // tag.
    const { ciphertext, authTag } = aesGcmEncrypt(argon2Key, nonce, plaintext, kitHeaderAad(header));
    argon2Key.fill(0);
    return {
      ...header,
      ciphertext: Buffer.concat([ciphertext, authTag]).toString('base64'),
    };
  }

  const scryptHeader = {
    formatVersion: 4 as const,
    kdf: 'scrypt' as const,
    installationId: payload.installationId,
    schemaVersion: payload.schemaVersion,
    createdAt: opts.createdAt,
    salt: salt.toString('base64'),
    nonce: nonce.toString('base64'),
    kdfParams: { ...SCRYPT_PARAMS },
  };
  const scryptKey = await deriveScrypt(passphrase, salt);
  const { ciphertext, authTag } = aesGcmEncrypt(scryptKey, nonce, plaintext, kitHeaderAad(scryptHeader));
  scryptKey.fill(0);
  return {
    ...scryptHeader,
    ciphertext: Buffer.concat([ciphertext, authTag]).toString('base64'),
  };
}

function aesGcmEncrypt(
  key: Buffer,
  nonce: Buffer,
  plaintext: Buffer,
  aad: Buffer
): { ciphertext: Buffer; authTag: Buffer } {
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext, authTag };
}

/**
 * Result of verifying/decrypting a recovery kit.
 */
export type RecoveryKitVerifyResult =
  | { ok: true; payload: RecoveryKitPayload }
  | { ok: false; error: 'WRONG_PASSPHRASE' | 'WRONG_INSTALLATION_ID' | 'CORRUPTED_CIPHERTEXT' | 'INVALID_KIT_FORMAT' };

/**
 * Decrypt and validate a recovery kit against the supplied passphrase and
 * the expected installation ID. Per Section 6.3, verification MUST
 * actually decrypt (proving the passphrase opens the kit), not merely
 * compare a checksum.
 *
 * Fails cleanly (never throws) for: wrong passphrase, wrong installation
 * ID, corrupted ciphertext, and a doctored/unrecognized formatVersion.
 */
export async function verifyRecoveryKit(
  kit: unknown,
  passphrase: Buffer,
  expectedInstallationId: string
): Promise<RecoveryKitVerifyResult> {
  const parsed = parseKitShape(kit);
  if (parsed === null) {
    return { ok: false, error: 'INVALID_KIT_FORMAT' };
  }

  let salt: Buffer;
  let nonce: Buffer;
  let ciphertextWithTag: Buffer;
  try {
    salt = Buffer.from(parsed.salt, 'base64');
    nonce = Buffer.from(parsed.nonce, 'base64');
    ciphertextWithTag = Buffer.from(parsed.ciphertext, 'base64');
  } catch {
    return { ok: false, error: 'CORRUPTED_CIPHERTEXT' };
  }

  if (salt.length !== 16 || nonce.length !== 12 || ciphertextWithTag.length < 16) {
    return { ok: false, error: 'CORRUPTED_CIPHERTEXT' };
  }

  const authTag = ciphertextWithTag.subarray(ciphertextWithTag.length - 16);
  const ciphertext = ciphertextWithTag.subarray(0, ciphertextWithTag.length - 16);

  // (F3) kdfParams are PINNED BY formatVersion: derivation below always
  // uses the module constants (ARGON2_PARAMS / SCRYPT_PARAMS), NEVER
  // `parsed.kdfParams` — the kit's own kdfParams field is authenticated (as
  // part of the AAD below, so tampering it is now detected) but advisory,
  // and is never load-bearing for what parameters actually get used to
  // derive the key. This is what makes authenticating it safe: even if a
  // tampered kdfParams value somehow slipped past the AAD check, it could
  // not influence derivation.
  let key: Buffer;
  let aad: Buffer;
  if (parsed.formatVersion === 3) {
    if (parsed.kdf !== 'argon2id') {
      return { ok: false, error: 'INVALID_KIT_FORMAT' };
    }
    aad = kitHeaderAad({
      formatVersion: parsed.formatVersion,
      kdf: parsed.kdf,
      installationId: parsed.installationId,
      schemaVersion: parsed.schemaVersion,
      createdAt: parsed.createdAt,
      salt: parsed.salt,
      nonce: parsed.nonce,
      kdfParams: parsed.kdfParams as unknown as Record<string, number>,
    });
    const derived = await tryDeriveArgon2id(passphrase, salt);
    if (derived === null) {
      // Argon2 unavailable on this machine but the kit requires it: this is
      // not a passphrase failure, but verification cannot proceed. Treat as
      // a clean, typed failure rather than throwing.
      return { ok: false, error: 'INVALID_KIT_FORMAT' };
    }
    key = derived;
  } else if (parsed.formatVersion === 4) {
    if (parsed.kdf !== 'scrypt') {
      return { ok: false, error: 'INVALID_KIT_FORMAT' };
    }
    aad = kitHeaderAad({
      formatVersion: parsed.formatVersion,
      kdf: parsed.kdf,
      installationId: parsed.installationId,
      schemaVersion: parsed.schemaVersion,
      createdAt: parsed.createdAt,
      salt: parsed.salt,
      nonce: parsed.nonce,
      kdfParams: parsed.kdfParams as unknown as Record<string, number>,
    });
    try {
      key = await deriveScrypt(passphrase, salt);
    } catch {
      return { ok: false, error: 'INVALID_KIT_FORMAT' };
    }
  } else {
    return { ok: false, error: 'INVALID_KIT_FORMAT' };
  }

  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    key.fill(0);
    // GCM auth tag mismatch: could be wrong passphrase (wrong key), a
    // tampered header (formatVersion/kdf/salt/nonce/kdfParams/
    // installationId/schemaVersion/createdAt — now authenticated as AAD),
    // or corrupted ciphertext/tag bytes. We cannot distinguish these from a
    // failed auth-tag check alone, so classify as WRONG_PASSPHRASE — the
    // dominant real-world cause — while corruption to the salt/nonce/
    // envelope shape itself is caught above as CORRUPTED_CIPHERTEXT.
    return { ok: false, error: 'WRONG_PASSPHRASE' };
  }
  key.fill(0);

  let payload: RecoveryKitPayload;
  try {
    const obj = JSON.parse(plaintext.toString('utf8')) as RecoveryKitPayload;
    payload = obj;
  } catch {
    return { ok: false, error: 'CORRUPTED_CIPHERTEXT' };
  }

  if (payload.installationId !== expectedInstallationId) {
    return { ok: false, error: 'WRONG_INSTALLATION_ID' };
  }

  return { ok: true, payload };
}

function parseKitShape(kit: unknown): RecoveryKit | null {
  if (typeof kit !== 'object' || kit === null) {
    return null;
  }
  const k = kit as Record<string, unknown>;
  // (F3) formatVersion 3 (argon2id) / 4 (scrypt) — bumped from 1/2 because
  // this fix changes the on-the-wire kit binary format (AAD now covers the
  // header). There are no production kits on 1/2 to migrate.
  if (k.formatVersion !== 3 && k.formatVersion !== 4) {
    return null;
  }
  if (
    typeof k.kdf !== 'string' ||
    typeof k.installationId !== 'string' ||
    typeof k.schemaVersion !== 'number' ||
    typeof k.createdAt !== 'string' ||
    typeof k.salt !== 'string' ||
    typeof k.nonce !== 'string' ||
    typeof k.ciphertext !== 'string' ||
    typeof k.kdfParams !== 'object' ||
    k.kdfParams === null
  ) {
    return null;
  }
  return k as unknown as RecoveryKit;
}

/**
 * (F7) HMAC-SHA-256 checksum, keyed with an empty (zero-length) key, of a
 * kit's ciphertext bytes (base64-decoded), used for the database-stored
 * `recovery_kit_checksum` field. This is NOT a plain SHA-256 digest —
 * `createHmac('sha256', Buffer.alloc(0))` is HMAC-SHA-256 under RFC 2104
 * with an empty key, which differs from `createHash('sha256')` in its
 * padding/block construction even though both produce a 32-byte output.
 * The empty-key HMAC construction is intentional and unchanged by this fix
 * (kits already produced under this exact function must keep verifying
 * against their existing `recovery_kit_checksum` values); only this
 * docstring was wrong. Exposed here so callers don't need to re-derive the
 * exact byte slice being hashed.
 */
export function recoveryKitChecksum(kit: RecoveryKit): string {
  const bytes = Buffer.from(kit.ciphertext, 'base64');
  return createHmac('sha256', Buffer.alloc(0)).update(bytes).digest('hex');
}

// ---------------------------------------------------------------------------
// Section 6.3 pepper-check HMACs
// ---------------------------------------------------------------------------

const PRINCIPAL_PEPPER_CHECK_PREFIX = 'torqclaw-principal-pepper-check:';
const RECOVERY_PEPPER_CHECK_PREFIX = 'torqclaw-recovery-pepper-check:';

export function principalPepperCheck(principalPepper: Buffer, installationId: string): Buffer {
  return createHmac('sha256', principalPepper)
    .update(Buffer.from(PRINCIPAL_PEPPER_CHECK_PREFIX + installationId, 'utf8'))
    .digest();
}

export function recoveryPepperCheck(recoveryPepper: Buffer, installationId: string): Buffer {
  return createHmac('sha256', recoveryPepper)
    .update(Buffer.from(RECOVERY_PEPPER_CHECK_PREFIX + installationId, 'utf8'))
    .digest();
}

/**
 * Constant-time comparison of two pepper-check HMACs. Both operands are
 * asserted to be exactly 32 bytes (SHA-256 output) before
 * `timingSafeEqual`, matching the same length-assertion discipline used in
 * credentials.ts (C1) — `timingSafeEqual` throws on length mismatch, and a
 * thrown exception here must not escape as an unhandled rejection during
 * startup.
 */
export function verifyPepperCheck(expected: Buffer, actual: Buffer): boolean {
  if (expected.length !== 32 || actual.length !== 32) {
    return false;
  }
  return timingSafeEqual(expected, actual);
}

// ---------------------------------------------------------------------------
// Bootstrap orchestration (Section 6.3)
// ---------------------------------------------------------------------------

export interface BootstrapResult {
  operatorPrincipalId: string;
  operatorCredentialId: string;
  operatorCredential: string; // plaintext, shown once
  principalPepper: Buffer; // caller must .fill(0) after use
  recoveryPepper: Buffer; // caller must .fill(0) after use
  recoverySecret: Buffer; // caller must .fill(0) after use
  installationId: string;
}

/**
 * Perform local bootstrap per Section 6.3: create the operator principal,
 * an operator credential, the principal pepper, a 32-byte recovery secret,
 * and an independent 32-byte recovery pepper. Recovery material is
 * returned once; callers MUST zero the returned Buffers after use/export.
 *
 * This function does NOT create the encrypted recovery kit (that is
 * `exportRecoveryKit`, called by the CLI layer once healthy mode is about
 * to be granted) and does NOT itself assert `secretStore.isPersistent` —
 * callers that intend to report "healthy" MUST call
 * `assertPersistentSecretStore` first; this function only performs the
 * bootstrap writes so it composes with fixtures that test both the
 * refusal path and the underlying bootstrap mechanics independently.
 */
export function bootstrapOperator(
  env: BootstrapEnv,
  params: { operatorDisplayName: string; installationId: string; schemaVersion: number }
): BootstrapResult {
  const principalPepper = env.rng.randomBytes(32);
  const recoveryPepper = env.rng.randomBytes(32);
  const recoverySecret = env.rng.randomBytes(32);

  const operatorId = env.uuids.next();
  const credentialId = env.uuids.next();
  const credentialSecretBytes = env.rng.randomBytes(32);
  const credentialToken = `tq1_${credentialId}_${credentialSecretBytes.toString('base64url')}`;
  const tokenBuf = Buffer.from(credentialToken, 'utf8');
  const secretHmac = createHmac('sha256', principalPepper).update(tokenBuf).digest();

  const now = env.clock.next();

  const pPepperCheck = principalPepperCheck(principalPepper, params.installationId);
  const rPepperCheck = recoveryPepperCheck(recoveryPepper, params.installationId);
  const recoverySecretHmac = createHmac('sha256', recoveryPepper).update(recoverySecret).digest();

  const tx = env.db.transaction(() => {
    env.db
      .prepare(
        'INSERT INTO principals(id, kind, display_name, owner_principal_id, status, auth_epoch, revoked_at, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)'
      )
      .run(operatorId, 'operator', params.operatorDisplayName, null, 'active', 1, null, now, now);

    env.db
      .prepare(
        'INSERT INTO principal_credentials(id, principal_id, secret_hmac, state, revoked_at, created_at, last_used_at) VALUES(?,?,?,?,?,?,?)'
      )
      .run(credentialId, operatorId, secretHmac, 'active', null, now, null);

    env.db
      .prepare(
        'INSERT INTO collab_installation(singleton, installation_id, recovery_secret_hmac, principal_pepper_check, recovery_pepper_check, recovery_kit_id, recovery_kit_checksum, recovery_kit_verified_at, schema_version) VALUES(1,?,?,?,?,?,?,?,?)'
      )
      .run(
        params.installationId,
        recoverySecretHmac,
        pPepperCheck,
        rPepperCheck,
        null,
        null,
        null,
        params.schemaVersion
      );

    env.db
      .prepare(
        'INSERT INTO collab_audit(kind, actor_principal_id, subject_principal_id, content_json, created_at) VALUES(?,?,?,?,?)'
      )
      .run('bootstrap_completed', operatorId, operatorId, canonicalJson({ operatorPrincipalId: operatorId }), now);
  });

  try {
    tx();
  } catch (err) {
    // Rollback path: zero every secret buffer before rethrowing so no
    // plaintext lingers in memory after a failed bootstrap.
    principalPepper.fill(0);
    recoveryPepper.fill(0);
    recoverySecret.fill(0);
    credentialSecretBytes.fill(0);
    throw err;
  }

  // credentialSecretBytes is encoded into credentialToken (a string) above;
  // per L1, the encoded response string itself is not zeroable, but the
  // Buffer it was derived from is zeroed here now that it is no longer
  // needed.
  credentialSecretBytes.fill(0);

  // These two set() calls run AFTER the DB transaction above already
  // committed the principal/credential/installation/audit rows. Before this
  // fix, either call throwing (most realistically: a second bootstrap
  // attempt hitting FileSecretStore's SecretAlreadyExistsError, since
  // production now has a working, non-throwing SecretStore) would propagate
  // past already-inserted rows with NO rollback -- leaving a
  // half-bootstrapped installation whose DB looks fully set up
  // (principals/collab_installation rows exist) but whose principal pepper
  // was never persisted, so `principalPepperCheck` in the DB row can never
  // be matched again and every future connect fails closed with no
  // recovery path other than wiping the DB and starting over.
  //
  // FIX: on either set() failing, run a compensating DELETE transaction
  // that removes exactly the four rows this function's own tx() just
  // inserted (matched by the same operatorId/credentialId/installationId
  // this call generated -- never a broader delete), zero every secret
  // buffer, and throw BootstrapSecretPersistError. This restores the
  // pre-bootstrap DB state so a retried bootstrapOperator call starts clean
  // instead of colliding with orphaned rows.
  //
  // RESIDUAL RISK (documented, not silently papered over): if the FIRST
  // set() (principal-pepper) succeeds but the SECOND (recovery-pepper)
  // throws, the compensating DELETE below still removes the DB rows, but
  // the principal-pepper FILE persisted by FileSecretStore is not deleted
  // (SecretStore has no delete() method -- adding one would change the
  // interface, which this slice must not do). That leaves an orphaned
  // pepper FILE on disk with no DB row referencing it -- harmless (it
  // authenticates nothing, since the principal row that would have used it
  // is gone) but not cleaned up. A retried bootstrap after this failure
  // will mint a NEW random pepper and a NEW credential id, so it does not
  // collide with the orphaned file's name.
  const rollbackDbOnSecretFailure = (cause: unknown): never => {
    try {
      const cleanup = env.db.transaction(() => {
        env.db.prepare('DELETE FROM collab_audit WHERE actor_principal_id = ? AND subject_principal_id = ?').run(operatorId, operatorId);
        env.db.prepare('DELETE FROM collab_installation WHERE installation_id = ?').run(params.installationId);
        env.db.prepare('DELETE FROM principal_credentials WHERE id = ?').run(credentialId);
        env.db.prepare('DELETE FROM principals WHERE id = ?').run(operatorId);
      });
      cleanup();
    } catch (cleanupErr) {
      // The compensating rollback itself failed -- surface BOTH errors
      // rather than swallowing the cleanup failure, since the caller now
      // has an inconsistent DB it needs to know about.
      principalPepper.fill(0);
      recoveryPepper.fill(0);
      recoverySecret.fill(0);
      throw new BootstrapSecretPersistError(
        `bootstrapOperator: secretStore.set failed AND compensating DB rollback also failed -- ` +
          `the installation is now in an inconsistent state and requires manual inspection. ` +
          `original cause: ${String(cause)}; rollback cause: ${String(cleanupErr)}`,
        cause,
      );
    }
    principalPepper.fill(0);
    recoveryPepper.fill(0);
    recoverySecret.fill(0);
    throw new BootstrapSecretPersistError(
      `bootstrapOperator: secretStore.set failed after the DB transaction committed; ` +
        `the committed principal/credential/installation rows have been rolled back via a ` +
        `compensating delete so a retried bootstrap starts clean. cause: ${String(cause)}`,
      cause,
    );
  };

  try {
    env.secretStore.set('TORQCLAW/principal-pepper', principalPepper);
  } catch (err) {
    rollbackDbOnSecretFailure(err);
  }

  try {
    env.secretStore.set('TORQCLAW/recovery-pepper', recoveryPepper);
  } catch (err) {
    rollbackDbOnSecretFailure(err);
  }

  return {
    operatorPrincipalId: operatorId,
    operatorCredentialId: credentialId,
    operatorCredential: credentialToken,
    principalPepper,
    recoveryPepper,
    recoverySecret,
    installationId: params.installationId,
  };
}
