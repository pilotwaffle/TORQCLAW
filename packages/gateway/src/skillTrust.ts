import {
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { dirname } from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

/**
 * The trust protocol deliberately uses a small JSON subset.  Its canonical
 * form is UTF-8 JSON with lexicographically sorted object keys, preserved
 * array order, and JSON.stringify's ES number representation.  Unsupported
 * values are rejected instead of being silently dropped by JSON.stringify.
 */
export function canonicalizeSignedPayload(value: unknown): string {
  return canonicalizeValue(value, '$');
}

const MAX_CANONICAL_DEPTH = 64;

function canonicalizeValue(value: unknown, path: string, depth = 0): string {
  if (depth > MAX_CANONICAL_DEPTH) throw new Error(`payload nesting exceeds ${MAX_CANONICAL_DEPTH} at ${path}`);
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number': {
      if (!Number.isFinite(value)) throw new Error(`non-finite number at ${path}`);
      return Object.is(value, -0) ? '0' : JSON.stringify(value);
    }
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item, index) => canonicalizeValue(item, `${path}[${index}]`, depth + 1)).join(',')}]`;
      }

      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(`non-plain object at ${path}`);
      }

      const record = value as Record<string, unknown>;
      const fields = Object.keys(record).sort();
      return `{${fields.map((key) => {
        const field = record[key];
        if (field === undefined) throw new Error(`undefined value at ${path}.${key}`);
        return `${JSON.stringify(key)}:${canonicalizeValue(field, `${path}.${key}`, depth + 1)}`;
      }).join(',')}}`;
    }
    default:
      throw new Error(`unsupported value at ${path}`);
  }
}

export function signCanonicalPayload(payload: unknown, privateKey: KeyObject): string {
  return sign(null, Buffer.from(canonicalizeSignedPayload(payload), 'utf8'), privateKey).toString('base64url');
}

export function verifyCanonicalSignature(
  payload: unknown,
  encodedSignature: string,
  publicKey: KeyObject,
): boolean {
  try {
    const signature = decodeBase64Url(encodedSignature);
    return signature.length === 64 && verify(
      null,
      Buffer.from(canonicalizeSignedPayload(payload), 'utf8'),
      publicKey,
      signature,
    );
  } catch {
    return false;
  }
}

export interface OriginScopedEd25519Key {
  readonly origin: string;
  readonly keyId: string;
  /** DER SubjectPublicKeyInfo, encoded as unpadded base64url. */
  readonly publicKey: string;
}

export type Revocation =
  | {
      readonly kind: 'key';
      readonly keyId: string;
      readonly revokedAt: string;
      readonly reason?: string;
    }
  | {
      readonly kind: 'skill';
      readonly skillId: string;
      /** Omit to revoke every digest for the skill. */
      readonly digest?: string;
      readonly revokedAt: string;
      readonly reason?: string;
    };

export interface TrustBundlePayload {
  readonly version: 1;
  readonly origin: string;
  readonly sequence: number;
  readonly issuedAt: string;
  readonly nextUpdate: string;
  readonly trustedKeys: readonly OriginScopedEd25519Key[];
  readonly revocations: readonly Revocation[];
}

export interface SignedTrustBundle extends TrustBundlePayload {
  readonly signingKeyId: string;
  readonly signature: string;
}

export interface SignedSkillArtifact<T = unknown> {
  readonly origin: string;
  readonly skillId: string;
  readonly keyId: string;
  /** A caller-supplied content digest. It is signed and is the revocation binding. */
  readonly digest: string;
  readonly payload: T;
  readonly signature: string;
}

export interface TrustStoreOptions {
  /** Static roots used to authenticate trust bundles. */
  readonly trustedAuthorities: readonly OriginScopedEd25519Key[];
  readonly now?: () => number;
  readonly maxFreshnessMs?: number;
  readonly maxFutureSkewMs?: number;
  readonly maxClockRollbackMs?: number;
  readonly maxCanonicalPayloadBytes?: number;
  readonly maxTrustedKeys?: number;
  readonly maxRevocations?: number;
  /** Optional atomic JSON persistence for accepted signed bundles and clock state. */
  readonly persistPath?: string;
}

export type TrustQuarantineReason =
  | 'clock-unavailable'
  | 'clock-rollback'
  | 'invalid-schema'
  | 'payload-too-large'
  | 'origin-mismatch'
  | 'unknown-authority-key'
  | 'signature-invalid'
  | 'invalid-freshness'
  | 'future-issued'
  | 'stale'
  | 'sequence-not-monotonic'
  | 'issued-at-not-monotonic'
  | 'unknown-origin'
  | 'untrusted-key'
  | 'invalid-key'
  | 'revoked-key'
  | 'revoked-skill'
  | 'trust-not-yet-valid';

export interface TrustUpdateAccepted {
  readonly accepted: true;
  readonly decision: 'accepted';
  readonly origin: string;
  readonly sequence: number;
}

export interface TrustUpdateQuarantined {
  readonly accepted: false;
  readonly decision: 'quarantine';
  readonly reason: TrustQuarantineReason;
}

export type TrustUpdateResult = TrustUpdateAccepted | TrustUpdateQuarantined;

export interface SkillAllowed {
  readonly decision: 'allow';
  readonly origin: string;
  readonly skillId: string;
  readonly keyId: string;
}

export interface SkillQuarantined {
  readonly decision: 'quarantine';
  readonly reason: TrustQuarantineReason;
}

export type SkillTrustDecision = SkillAllowed | SkillQuarantined;

interface TrustState {
  readonly payload: TrustBundlePayload;
  readonly keys: ReadonlyMap<string, KeyObject>;
  readonly revokedKeyIds: ReadonlySet<string>;
}

const DEFAULT_MAX_FRESHNESS_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_FUTURE_SKEW_MS = 2 * 60 * 1000;
const DEFAULT_MAX_CANONICAL_PAYLOAD_BYTES = 256 * 1024;
const DEFAULT_MAX_TRUSTED_KEYS = 256;
const DEFAULT_MAX_REVOCATIONS = 2048;

export function exportEd25519PublicKey(publicKey: KeyObject): string {
  const key = publicKey.type === 'private' ? createPublicKey(publicKey) : publicKey;
  assertEd25519PublicKey(key);
  return key.export({ type: 'spki', format: 'der' }).toString('base64url');
}

export function importEd25519PublicKey(encodedPublicKey: string): KeyObject {
  const key = createPublicKey({
    key: Buffer.from(decodeBase64Url(encodedPublicKey)),
    format: 'der',
    type: 'spki',
  });
  assertEd25519PublicKey(key);
  return key;
}

export function signTrustBundle(
  payload: TrustBundlePayload,
  signingKeyId: string,
  privateKey: KeyObject,
): SignedTrustBundle {
  const unsigned = { ...payload, signingKeyId };
  return { ...unsigned, signature: signCanonicalPayload(unsigned, privateKey) };
}

export function signSkillArtifact<T>(
  artifact: Omit<SignedSkillArtifact<T>, 'signature'>,
  privateKey: KeyObject,
): SignedSkillArtifact<T> {
  return { ...artifact, signature: signCanonicalPayload(artifact, privateKey) };
}

export class SkillTrustStore {
  private readonly authorities = new Map<string, Map<string, KeyObject>>();
  private readonly states = new Map<string, TrustState>();
  private readonly now: () => number;
  private readonly maxFreshnessMs: number;
  private readonly maxFutureSkewMs: number;
  private readonly maxClockRollbackMs: number;
  private readonly maxCanonicalPayloadBytes: number;
  private readonly maxTrustedKeys: number;
  private readonly maxRevocations: number;
  private readonly persistPath?: string;
  private readonly acceptedBundles = new Map<string, SignedTrustBundle>();
  private lastObservedNowMs: number | null = null;
  private clockRollbackDetected = false;

  public constructor(options: TrustStoreOptions) {
    this.now = options.now ?? (() => Date.now());
    this.maxFreshnessMs = positiveLimit(options.maxFreshnessMs ?? DEFAULT_MAX_FRESHNESS_MS, 'maxFreshnessMs');
    this.maxFutureSkewMs = nonNegativeLimit(options.maxFutureSkewMs ?? DEFAULT_MAX_FUTURE_SKEW_MS, 'maxFutureSkewMs');
    this.maxClockRollbackMs = nonNegativeLimit(options.maxClockRollbackMs ?? 0, 'maxClockRollbackMs');
    this.maxCanonicalPayloadBytes = positiveLimit(
      options.maxCanonicalPayloadBytes ?? DEFAULT_MAX_CANONICAL_PAYLOAD_BYTES,
      'maxCanonicalPayloadBytes',
    );
    this.maxTrustedKeys = positiveLimit(options.maxTrustedKeys ?? DEFAULT_MAX_TRUSTED_KEYS, 'maxTrustedKeys');
    this.maxRevocations = positiveLimit(options.maxRevocations ?? DEFAULT_MAX_REVOCATIONS, 'maxRevocations');
    this.persistPath = options.persistPath;

    for (const authority of options.trustedAuthorities) {
      const key = importScopedKey(authority);
      let originKeys = this.authorities.get(authority.origin);
      if (!originKeys) {
        originKeys = new Map();
        this.authorities.set(authority.origin, originKeys);
      }
      if (originKeys.has(authority.keyId)) throw new Error(`duplicate authority key: ${authority.origin}/${authority.keyId}`);
      originKeys.set(authority.keyId, key);
    }
    this.restorePersistedState();
  }

  public get isClockRollbackDetected(): boolean {
    return this.clockRollbackDetected;
  }

  /**
   * Recovery is intentionally explicit. A higher clock reading alone never
   * clears the fail-closed state after rollback was observed.
   */
  public resetAfterClockRepair(repairedNowMs?: number): boolean {
    // A clock repair is not cryptographic evidence. A newer signed trust
    // bundle must clear quarantine through applyTrustBundle instead.
    void repairedNowMs;
    return false;
  }

  public applyTrustBundle(bundle: unknown, expectedOrigin?: string): TrustUpdateResult {
    const now = this.observeClock();
    if (now === null) return quarantineUpdate('clock-unavailable');
    // A detected rollback is recoverable only through a newly signed bundle;
    // monotonic sequence and issuedAt checks below reject replay.

    let parsed: ParsedBundle;
    try {
      parsed = parseBundle(bundle, this.maxTrustedKeys, this.maxRevocations);
    } catch (error) {
      if (error instanceof OriginMismatchError) return quarantineUpdate('origin-mismatch');
      return quarantineUpdate('invalid-schema');
    }

    if (expectedOrigin !== undefined && parsed.payload.origin !== expectedOrigin) {
      return quarantineUpdate('origin-mismatch');
    }

    let canonicalBytes: number;
    try {
      canonicalBytes = Buffer.byteLength(canonicalizeSignedPayload(parsed.unsigned), 'utf8');
    } catch {
      return quarantineUpdate('invalid-schema');
    }
    if (canonicalBytes > this.maxCanonicalPayloadBytes) return quarantineUpdate('payload-too-large');

    const authority = this.authorities.get(parsed.payload.origin)?.get(parsed.signingKeyId);
    if (!authority) {
      if (this.authorityExistsUnderAnotherOrigin(parsed.signingKeyId, parsed.payload.origin)) {
        return quarantineUpdate('origin-mismatch');
      }
      return quarantineUpdate('unknown-authority-key');
    }
    if (!verifyCanonicalSignature(parsed.unsigned, parsed.signature, authority)) {
      return quarantineUpdate('signature-invalid');
    }

    const freshness = checkFreshness(parsed.payload, now, this.maxFreshnessMs, this.maxFutureSkewMs);
    if (freshness) return quarantineUpdate(freshness);

    const previous = this.states.get(parsed.payload.origin);
    if (previous) {
      if (parsed.payload.sequence <= previous.payload.sequence) return quarantineUpdate('sequence-not-monotonic');
      if (Date.parse(parsed.payload.issuedAt) <= Date.parse(previous.payload.issuedAt)) {
        return quarantineUpdate('issued-at-not-monotonic');
      }
    }

    try {
      const keys = new Map<string, KeyObject>();
      for (const trustedKey of parsed.payload.trustedKeys) keys.set(trustedKey.keyId, importScopedKey(trustedKey));

      const revokedKeyIds = new Set<string>();
      for (const revocation of parsed.payload.revocations) {
        if (revocation.kind === 'key') revokedKeyIds.add(revocation.keyId);
      }

      this.states.set(parsed.payload.origin, { payload: parsed.payload, keys, revokedKeyIds });
      this.acceptedBundles.set(parsed.payload.origin, {
        ...parsed.payload,
        signingKeyId: parsed.signingKeyId,
        signature: parsed.signature,
      });
      this.clockRollbackDetected = false;
      this.persistState();
      return { accepted: true, decision: 'accepted', origin: parsed.payload.origin, sequence: parsed.payload.sequence };
    } catch {
      return quarantineUpdate('invalid-key');
    }
  }

  public evaluateSkill<T>(artifact: unknown, expectedOrigin?: string): SkillTrustDecision {
    const now = this.observeClock();
    if (now === null) return quarantineSkill('clock-unavailable');
    if (this.clockRollbackDetected) return quarantineSkill('clock-rollback');

    let parsed: SignedSkillArtifact<T>;
    try {
      parsed = parseSkillArtifact(artifact);
    } catch {
      return quarantineSkill('invalid-schema');
    }

    if (expectedOrigin !== undefined && parsed.origin !== expectedOrigin) return quarantineSkill('origin-mismatch');

    let canonicalBytes: number;
    try {
      canonicalBytes = Buffer.byteLength(canonicalizeSignedPayload(skillPayload(parsed)), 'utf8');
    } catch {
      return quarantineSkill('invalid-schema');
    }
    if (canonicalBytes > this.maxCanonicalPayloadBytes) return quarantineSkill('payload-too-large');

    const state = this.states.get(parsed.origin);
    if (!state) return quarantineSkill('unknown-origin');
    const freshness = checkFreshness(state.payload, now, this.maxFreshnessMs, this.maxFutureSkewMs);
    if (freshness) return quarantineSkill(freshness);

    const key = state.keys.get(parsed.keyId);
    if (!key) {
      if (this.keyExistsUnderAnotherOrigin(parsed.keyId, parsed.origin)) return quarantineSkill('origin-mismatch');
      return quarantineSkill('untrusted-key');
    }
    if (state.revokedKeyIds.has(parsed.keyId)) return quarantineSkill('revoked-key');
    if (!verifyCanonicalSignature(skillPayload(parsed), parsed.signature, key)) {
      return quarantineSkill('signature-invalid');
    }

    for (const revocation of state.payload.revocations) {
      if (revocation.kind === 'key') continue;
      if (revocation.skillId !== parsed.skillId) continue;
      if (revocation.digest === undefined || revocation.digest === parsed.digest) {
        return quarantineSkill('revoked-skill');
      }
    }

    return { decision: 'allow', origin: parsed.origin, skillId: parsed.skillId, keyId: parsed.keyId };
  }

  public getTrustSnapshot(origin: string): TrustBundlePayload | null {
    const payload = this.states.get(origin)?.payload;
    if (!payload) return null;
    return {
      ...payload,
      trustedKeys: payload.trustedKeys.map((key) => ({ ...key })),
      revocations: payload.revocations.map((revocation) => ({ ...revocation })),
    };
  }

  private observeClock(): number | null {
    const current = this.readRawNow();
    if (current === null) return null;
    if (this.lastObservedNowMs !== null && current < this.lastObservedNowMs - this.maxClockRollbackMs) {
      this.clockRollbackDetected = true;
      this.persistState();
      return current;
    }
    if (this.lastObservedNowMs === null || current > this.lastObservedNowMs) this.lastObservedNowMs = current;
    return current;
  }

  private readRawNow(): number | null {
    try {
      const current = this.now();
      return Number.isFinite(current) ? current : null;
    } catch {
      return null;
    }
  }

  private restorePersistedState(): void {
    if (!this.persistPath) return;
    if (!existsSync(this.persistPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.persistPath, 'utf8')) as {
        schemaVersion?: unknown;
        bundles?: unknown;
        lastObservedNowMs?: unknown;
        clockRollbackDetected?: unknown;
      };
      if (raw.schemaVersion !== 1 || !Array.isArray(raw.bundles) || raw.bundles.length > this.maxTrustedKeys) {
        throw new Error('invalid persisted trust state');
      }
      for (const bundle of raw.bundles) this.applyTrustBundle(bundle);
      if (typeof raw.lastObservedNowMs === 'number' && Number.isFinite(raw.lastObservedNowMs)) {
        this.lastObservedNowMs = raw.lastObservedNowMs;
      }
      if (raw.clockRollbackDetected === true) this.clockRollbackDetected = true;
    } catch {
      // Corrupt or unverifiable trust state is fail-closed. Static authorities
      // remain available so a strictly newer signed bundle can recover trust.
      this.clockRollbackDetected = true;
    }
  }

  private persistState(): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      const tempPath = `${this.persistPath}.${process.pid}.tmp`;
      writeFileSync(tempPath, JSON.stringify({
        schemaVersion: 1,
        bundles: [...this.acceptedBundles.values()],
        lastObservedNowMs: this.lastObservedNowMs,
        clockRollbackDetected: this.clockRollbackDetected,
      }), { encoding: 'utf8', flag: 'w' });
      renameSync(tempPath, this.persistPath);
    } catch {
      // Persistence failure must never turn a verified request into an
      // unverified success; the next process will fail closed if state is absent.
      this.clockRollbackDetected = true;
    }
  }

  private authorityExistsUnderAnotherOrigin(keyId: string, origin: string): boolean {
    return [...this.authorities.entries()].some(([candidateOrigin, keys]) => candidateOrigin !== origin && keys.has(keyId));
  }

  private keyExistsUnderAnotherOrigin(keyId: string, origin: string): boolean {
    return [...this.states.entries()].some(([candidateOrigin, state]) => candidateOrigin !== origin && state.keys.has(keyId));
  }
}

interface ParsedBundle {
  readonly payload: TrustBundlePayload;
  readonly unsigned: Omit<SignedTrustBundle, 'signature'>;
  readonly signingKeyId: string;
  readonly signature: string;
}

function parseBundle(value: unknown, maxTrustedKeys: number, maxRevocations: number): ParsedBundle {
  const record = asRecord(value);
  requireExactKeys(record, ['issuedAt', 'nextUpdate', 'origin', 'revocations', 'sequence', 'signature', 'signingKeyId', 'trustedKeys', 'version']);
  if (record.version !== 1 || !isBoundedString(record.origin, 512) || !isBoundedString(record.signingKeyId, 128)) throw new Error('invalid bundle identity');
  if (!Number.isSafeInteger(record.sequence) || (record.sequence as number) < 0) throw new Error('invalid sequence');
  if (!isStrictIsoInstant(record.issuedAt) || !isStrictIsoInstant(record.nextUpdate)) throw new Error('invalid timestamp');
  if (!isBoundedString(record.signature, 128)) throw new Error('invalid signature');
  if (!Array.isArray(record.trustedKeys) || record.trustedKeys.length > maxTrustedKeys) throw new Error('invalid trusted keys');
  if (!Array.isArray(record.revocations) || record.revocations.length > maxRevocations) throw new Error('invalid revocations');

  const trustedKeys = record.trustedKeys.map((key) => parseScopedKey(key, record.origin as string));
  const revocations = record.revocations.map(parseRevocation);
  if (new Set(trustedKeys.map((key) => key.keyId)).size !== trustedKeys.length) throw new Error('duplicate trusted key');
  const payload: TrustBundlePayload = {
    version: 1,
    origin: record.origin as string,
    sequence: record.sequence as number,
    issuedAt: record.issuedAt as string,
    nextUpdate: record.nextUpdate as string,
    trustedKeys,
    revocations,
  };
  const signingKeyId = record.signingKeyId as string;
  const unsigned = { ...payload, signingKeyId };
  return { payload, unsigned, signingKeyId, signature: record.signature as string };
}

function parseSkillArtifact<T>(value: unknown): SignedSkillArtifact<T> {
  const record = asRecord(value);
  requireExactKeys(record, ['digest', 'keyId', 'origin', 'payload', 'signature', 'skillId']);
  for (const field of ['origin', 'skillId', 'keyId', 'digest', 'signature']) {
    if (!isBoundedString(record[field], field === 'origin' ? 512 : field === 'signature' ? 128 : 512)) throw new Error(`invalid ${field}`);
  }
  return {
    origin: record.origin as string,
    skillId: record.skillId as string,
    keyId: record.keyId as string,
    digest: record.digest as string,
    payload: record.payload as T,
    signature: record.signature as string,
  };
}

function parseScopedKey(value: unknown, bundleOrigin: string): OriginScopedEd25519Key {
  const record = asRecord(value);
  requireExactKeys(record, ['keyId', 'origin', 'publicKey']);
  if (!isBoundedString(record.origin, 512) || record.origin !== bundleOrigin) throw new OriginMismatchError();
  if (!isBoundedString(record.keyId, 128) || !isBoundedString(record.publicKey, 256)) throw new Error('invalid key');
  decodeBase64Url(record.publicKey);
  return { origin: record.origin, keyId: record.keyId, publicKey: record.publicKey };
}

function parseRevocation(value: unknown): Revocation {
  const record = asRecord(value);
  if (record?.kind === 'key') {
    requireExactKeys(record, ['keyId', 'kind', 'revokedAt'], ['reason']);
    if (!isBoundedString(record.keyId, 128) || !isStrictIsoInstant(record.revokedAt)) throw new Error('invalid key revocation');
    if (record.reason !== undefined && !isBoundedString(record.reason, 256)) throw new Error('invalid revocation reason');
    return { kind: 'key', keyId: record.keyId, revokedAt: record.revokedAt, ...(record.reason === undefined ? {} : { reason: record.reason }) };
  }
  if (record?.kind === 'skill') {
    requireExactKeys(record, ['kind', 'revokedAt', 'skillId'], ['digest', 'reason']);
    if (!isBoundedString(record.skillId, 512) || !isStrictIsoInstant(record.revokedAt)) throw new Error('invalid skill revocation');
    if (record.digest !== undefined && !isBoundedString(record.digest, 512)) throw new Error('invalid revocation digest');
    if (record.reason !== undefined && !isBoundedString(record.reason, 256)) throw new Error('invalid revocation reason');
    return {
      kind: 'skill',
      skillId: record.skillId,
      revokedAt: record.revokedAt,
      ...(record.digest === undefined ? {} : { digest: record.digest }),
      ...(record.reason === undefined ? {} : { reason: record.reason }),
    };
  }
  throw new Error('invalid revocation');
}

function importScopedKey(key: OriginScopedEd25519Key): KeyObject {
  if (!isBoundedString(key.origin, 512) || !isBoundedString(key.keyId, 128) || !isBoundedString(key.publicKey, 256)) {
    throw new Error('invalid scoped key');
  }
  return importEd25519PublicKey(key.publicKey);
}

function skillPayload<T>(artifact: SignedSkillArtifact<T>): Omit<SignedSkillArtifact<T>, 'signature'> {
  return {
    origin: artifact.origin,
    skillId: artifact.skillId,
    keyId: artifact.keyId,
    digest: artifact.digest,
    payload: artifact.payload,
  };
}

function checkFreshness(
  payload: TrustBundlePayload,
  now: number,
  maxFreshnessMs: number,
  maxFutureSkewMs: number,
): TrustQuarantineReason | null {
  const issuedAt = Date.parse(payload.issuedAt);
  const nextUpdate = Date.parse(payload.nextUpdate);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(nextUpdate) || nextUpdate <= issuedAt || nextUpdate - issuedAt > maxFreshnessMs) {
    return 'invalid-freshness';
  }
  if (issuedAt > now + maxFutureSkewMs) return 'future-issued';
  if (now > nextUpdate) return 'stale';
  if (now < issuedAt - maxFutureSkewMs) return 'trust-not-yet-valid';
  return null;
}

function assertEd25519PublicKey(key: KeyObject): void {
  if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') throw new Error('expected Ed25519 public key');
}

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid base64url');
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length === 0 || decoded.toString('base64url') !== value) throw new Error('non-canonical base64url');
  return decoded;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected object');
  return value as Record<string, unknown>;
}

function requireExactKeys(record: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !(key in record)) || Object.keys(record).some((key) => !allowed.has(key))) throw new Error('unexpected fields');
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isStrictIsoInstant(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

function nonNegativeLimit(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be non-negative`);
  return value;
}

function quarantineUpdate(reason: TrustQuarantineReason): TrustUpdateQuarantined {
  return { accepted: false, decision: 'quarantine', reason };
}

function quarantineSkill(reason: TrustQuarantineReason): SkillQuarantined {
  return { decision: 'quarantine', reason };
}

class OriginMismatchError extends Error {}
