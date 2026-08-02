import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  SkillTrustStore,
  canonicalizeSignedPayload,
  exportEd25519PublicKey,
  signSkillArtifact,
  signTrustBundle,
  type OriginScopedEd25519Key,
  type SignedSkillArtifact,
  type TrustBundlePayload,
} from '../packages/gateway/src/skillTrust.js';

const ORIGIN = 'https://skills.example.test';
const OTHER_ORIGIN = 'https://other.example.test';
const ISSUED_AT = Date.parse('2026-08-02T00:00:00.000Z');

function keyPair() {
  return generateKeyPairSync('ed25519');
}

function scopedKey(origin: string, keyId: string, publicKey: ReturnType<typeof keyPair>['publicKey']): OriginScopedEd25519Key {
  return { origin, keyId, publicKey: exportEd25519PublicKey(publicKey) };
}

function bundlePayload(
  signer: OriginScopedEd25519Key,
  trustedKeys: readonly OriginScopedEd25519Key[],
  overrides: Partial<TrustBundlePayload> = {},
): TrustBundlePayload {
  return {
    version: 1,
    origin: signer.origin,
    sequence: 1,
    issuedAt: new Date(ISSUED_AT).toISOString(),
    nextUpdate: new Date(ISSUED_AT + 60 * 60 * 1000).toISOString(),
    trustedKeys,
    revocations: [],
    ...overrides,
  };
}

function makeStore(now: () => number, authority: OriginScopedEd25519Key, options: Record<string, unknown> = {}) {
  return new SkillTrustStore({
    trustedAuthorities: [authority],
    now,
    ...options,
  });
}

function applyValidBundle(store: SkillTrustStore, authority: OriginScopedEd25519Key, authorityPrivateKey: ReturnType<typeof keyPair>['privateKey'], trustedKeys: readonly OriginScopedEd25519Key[], overrides: Partial<TrustBundlePayload> = {}) {
  const payload = bundlePayload(authority, trustedKeys, overrides);
  return { payload, result: store.applyTrustBundle(signTrustBundle(payload, authority.keyId, authorityPrivateKey)) };
}

describe('bounded signed skill trust primitive', () => {
  it('canonicalizes signed payloads independently of object insertion order', () => {
    expect(canonicalizeSignedPayload({ z: 1, a: { b: 2, a: [true, null] } })).toBe(
      '{"a":{"a":[true,null],"b":2},"z":1}',
    );

    const root = keyPair();
    const authority = scopedKey(ORIGIN, 'root-1', root.publicKey);
    const payload = bundlePayload(authority, []);
    const signed = signTrustBundle(payload, authority.keyId, root.privateKey);
    const reordered = {
      signature: signed.signature,
      trustedKeys: signed.trustedKeys,
      revocations: signed.revocations,
      nextUpdate: signed.nextUpdate,
      issuedAt: signed.issuedAt,
      sequence: signed.sequence,
      origin: signed.origin,
      signingKeyId: signed.signingKeyId,
      version: signed.version,
    };
    const store = makeStore(() => ISSUED_AT + 10_000, authority);
    expect(store.applyTrustBundle(reordered)).toMatchObject({ accepted: true, sequence: 1 });

    const tampered = { ...signed, sequence: 2 };
    expect(store.applyTrustBundle(tampered)).toMatchObject({ decision: 'quarantine', reason: 'signature-invalid' });
  });

  it('accepts Ed25519 trust bundles and scopes authorities and trusted keys to origin', () => {
    const root = keyPair();
    const skill = keyPair();
    const authority = scopedKey(ORIGIN, 'root-1', root.publicKey);
    const trustedSkill = scopedKey(ORIGIN, 'skill-1', skill.publicKey);
    const store = makeStore(() => ISSUED_AT + 10_000, authority);

    expect(applyValidBundle(store, authority, root.privateKey, [trustedSkill]).result).toMatchObject({ accepted: true });

    const otherRoot = keyPair();
    const otherAuthority = scopedKey(OTHER_ORIGIN, 'root-1', otherRoot.publicKey);
    const otherPayload = bundlePayload(otherAuthority, [], { origin: OTHER_ORIGIN });
    expect(store.applyTrustBundle(signTrustBundle(otherPayload, otherAuthority.keyId, otherRoot.privateKey))).toMatchObject({
      decision: 'quarantine',
      reason: 'origin-mismatch',
    });

    const wrongScopedKey = scopedKey(OTHER_ORIGIN, 'skill-2', skill.publicKey);
    const invalidPayload = bundlePayload(authority, [wrongScopedKey]);
    expect(store.applyTrustBundle(signTrustBundle(invalidPayload, authority.keyId, root.privateKey))).toMatchObject({
      decision: 'quarantine',
      reason: 'origin-mismatch',
    });
  });

  it('enforces bounded freshness, nextUpdate, and future-issued limits', () => {
    const root = keyPair();
    const authority = scopedKey(ORIGIN, 'root-1', root.publicKey);
    const store = makeStore(() => ISSUED_AT, authority, { maxFreshnessMs: 60 * 60 * 1000, maxFutureSkewMs: 0 });

    const tooLong = bundlePayload(authority, [], {
      nextUpdate: new Date(ISSUED_AT + 2 * 60 * 60 * 1000).toISOString(),
    });
    expect(store.applyTrustBundle(signTrustBundle(tooLong, authority.keyId, root.privateKey))).toMatchObject({ reason: 'invalid-freshness' });

    const stale = bundlePayload(authority, [], {
      issuedAt: new Date(ISSUED_AT - 2 * 60 * 60 * 1000).toISOString(),
      nextUpdate: new Date(ISSUED_AT - 60 * 60 * 1000).toISOString(),
    });
    expect(store.applyTrustBundle(signTrustBundle(stale, authority.keyId, root.privateKey))).toMatchObject({ reason: 'stale' });

    const future = bundlePayload(authority, [], {
      issuedAt: new Date(ISSUED_AT + 1).toISOString(),
      nextUpdate: new Date(ISSUED_AT + 60 * 60 * 1000).toISOString(),
    });
    expect(store.applyTrustBundle(signTrustBundle(future, authority.keyId, root.privateKey))).toMatchObject({ reason: 'future-issued' });
  });

  it('requires strictly increasing sequence and issuedAt per origin', () => {
    const root = keyPair();
    const authority = scopedKey(ORIGIN, 'root-1', root.publicKey);
    let now = ISSUED_AT + 10_000;
    const store = makeStore(() => now, authority);
    expect(applyValidBundle(store, authority, root.privateKey, []).result).toMatchObject({ accepted: true });

    const replay = bundlePayload(authority, [], { sequence: 1 });
    expect(store.applyTrustBundle(signTrustBundle(replay, authority.keyId, root.privateKey))).toMatchObject({ reason: 'sequence-not-monotonic' });

    now += 10_000;
    const sameIssuedAt = bundlePayload(authority, [], { sequence: 2 });
    expect(store.applyTrustBundle(signTrustBundle(sameIssuedAt, authority.keyId, root.privateKey))).toMatchObject({ reason: 'issued-at-not-monotonic' });

    const next = bundlePayload(authority, [], {
      sequence: 2,
      issuedAt: new Date(ISSUED_AT + 20_000).toISOString(),
      nextUpdate: new Date(ISSUED_AT + 60 * 60 * 1000).toISOString(),
    });
    expect(store.applyTrustBundle(signTrustBundle(next, authority.keyId, root.privateKey))).toMatchObject({ accepted: true, sequence: 2 });
  });

  it('enters persistent fail-closed state on clock rollback', () => {
    const root = keyPair();
    const skill = keyPair();
    const authority = scopedKey(ORIGIN, 'root-1', root.publicKey);
    const trustedSkill = scopedKey(ORIGIN, 'skill-1', skill.publicKey);
    let now = ISSUED_AT + 10_000;
    const store = makeStore(() => now, authority);
    const valid = applyValidBundle(store, authority, root.privateKey, [trustedSkill]);
    expect(valid.result).toMatchObject({ accepted: true });

    const artifact = signSkillArtifact({ origin: ORIGIN, skillId: 'demo', keyId: 'skill-1', digest: 'sha256:1', payload: { ok: true } }, skill.privateKey);
    now = ISSUED_AT - 10_000;
    expect(store.evaluateSkill(artifact)).toMatchObject({ decision: 'quarantine', reason: 'clock-rollback' });
    now = ISSUED_AT + 20_000;
    expect(store.evaluateSkill(artifact)).toMatchObject({ decision: 'quarantine', reason: 'clock-rollback' });
    expect(store.isClockRollbackDetected).toBe(true);
    expect(store.resetAfterClockRepair(now)).toBe(false);
    const recovery = bundlePayload(authority, [trustedSkill], {
      sequence: 2,
      issuedAt: new Date(ISSUED_AT + 20_000).toISOString(),
      nextUpdate: new Date(ISSUED_AT + 60 * 60 * 1000).toISOString(),
    });
    expect(store.applyTrustBundle(signTrustBundle(recovery, authority.keyId, root.privateKey))).toMatchObject({ accepted: true, sequence: 2 });
    expect(store.evaluateSkill(artifact)).toMatchObject({ decision: 'allow' });
  });

  it('restores accepted signed bundles across process restarts', () => {
    const root = keyPair();
    const skill = keyPair();
    const authority = scopedKey(ORIGIN, 'root-1', root.publicKey);
    const trustedSkill = scopedKey(ORIGIN, 'skill-1', skill.publicKey);
    const temp = mkdtempSync(join(tmpdir(), 'torqclaw-trust-'));
    const persistPath = join(temp, 'trust-state.json');
    try {
      const artifact = signSkillArtifact({ origin: ORIGIN, skillId: 'demo', keyId: 'skill-1', digest: 'sha256:1', payload: { ok: true } }, skill.privateKey);
      const first = makeStore(() => ISSUED_AT + 10_000, authority, { persistPath });
      expect(applyValidBundle(first, authority, root.privateKey, [trustedSkill]).result).toMatchObject({ accepted: true });
      expect(JSON.parse(readFileSync(persistPath, 'utf8')).schemaVersion).toBe(1);
      const restarted = makeStore(() => ISSUED_AT + 20_000, authority, { persistPath });
      expect(restarted.evaluateSkill(artifact)).toMatchObject({ decision: 'allow' });
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('quarantines signature, key, and origin mismatches, and allows a valid skill', () => {
    const root = keyPair();
    const skill = keyPair();
    const wrongSkill = keyPair();
    const authority = scopedKey(ORIGIN, 'root-1', root.publicKey);
    const trustedSkill = scopedKey(ORIGIN, 'skill-1', skill.publicKey);
    const store = makeStore(() => ISSUED_AT + 10_000, authority);
    applyValidBundle(store, authority, root.privateKey, [trustedSkill]);

    const valid = signSkillArtifact({ origin: ORIGIN, skillId: 'demo', keyId: 'skill-1', digest: 'sha256:1', payload: { value: 1 } }, skill.privateKey);
    expect(store.evaluateSkill(valid)).toMatchObject({ decision: 'allow', skillId: 'demo' });
    const tamperedSignature = Buffer.from(valid.signature, 'base64url');
    tamperedSignature[0] ^= 1;
    expect(store.evaluateSkill({ ...valid, signature: tamperedSignature.toString('base64url') })).toMatchObject({ reason: 'signature-invalid' });

    const unknownKey = signSkillArtifact({ ...valid, keyId: 'not-trusted' }, skill.privateKey);
    expect(store.evaluateSkill(unknownKey)).toMatchObject({ reason: 'untrusted-key' });

    const wrongSignatureKey = signSkillArtifact({ ...valid }, wrongSkill.privateKey);
    expect(store.evaluateSkill(wrongSignatureKey)).toMatchObject({ reason: 'signature-invalid' });
    expect(store.evaluateSkill({ ...valid, origin: OTHER_ORIGIN }, ORIGIN)).toMatchObject({ reason: 'origin-mismatch' });
  });

  it('quarantines revoked keys and skill digests', () => {
    const root = keyPair();
    const skill = keyPair();
    const authority = scopedKey(ORIGIN, 'root-1', root.publicKey);
    const trustedSkill = scopedKey(ORIGIN, 'skill-1', skill.publicKey);
    const store = makeStore(() => ISSUED_AT + 10_000, authority);
    const revocationTime = new Date(ISSUED_AT + 1_000).toISOString();

    const revokedSkillBundle = bundlePayload(authority, [trustedSkill], {
      revocations: [{ kind: 'skill', skillId: 'revoked', digest: 'sha256:bad', revokedAt: revocationTime }],
    });
    expect(store.applyTrustBundle(signTrustBundle(revokedSkillBundle, authority.keyId, root.privateKey))).toMatchObject({ accepted: true });
    const revokedSkill = signSkillArtifact({ origin: ORIGIN, skillId: 'revoked', keyId: 'skill-1', digest: 'sha256:bad', payload: {} }, skill.privateKey);
    expect(store.evaluateSkill(revokedSkill)).toMatchObject({ decision: 'quarantine', reason: 'revoked-skill' });

    const revokedKeyBundle = bundlePayload(authority, [trustedSkill], {
      sequence: 2,
      issuedAt: new Date(ISSUED_AT + 20_000).toISOString(),
      revocations: [{ kind: 'key', keyId: 'skill-1', revokedAt: revocationTime }],
    });
    expect(store.applyTrustBundle(signTrustBundle(revokedKeyBundle, authority.keyId, root.privateKey))).toMatchObject({ accepted: true });
    const validShape = signSkillArtifact({ origin: ORIGIN, skillId: 'not-revoked', keyId: 'skill-1', digest: 'sha256:ok', payload: {} }, skill.privateKey);
    expect(store.evaluateSkill(validShape)).toMatchObject({ decision: 'quarantine', reason: 'revoked-key' });
  });

  it('bounds canonical signed payloads before accepting trust or skills', () => {
    const root = keyPair();
    const skill = keyPair();
    const authority = scopedKey(ORIGIN, 'root-1', root.publicKey);
    const trustedSkill = scopedKey(ORIGIN, 'skill-1', skill.publicKey);
    const store = makeStore(() => ISSUED_AT + 10_000, authority, { maxCanonicalPayloadBytes: 200 });
    const oversized = bundlePayload(authority, [trustedSkill]);
    expect(store.applyTrustBundle(signTrustBundle(oversized, authority.keyId, root.privateKey))).toMatchObject({ reason: 'payload-too-large' });
  });
});
