/**
 * C2-5 — CTXHASH_V1 / ACTIONHASH_V1 frozen-vector conformance.
 * PRD-TCLAW-COLLAB-GATEWAY-004 §3.1, §3.4.1, §8 C2-5.
 *
 * Every expected value below is transcribed from the PRD, not from what
 * the implementation happens to produce. That direction matters: the AC is
 * "independently reproducible", so the test's job is to hold the code to
 * the document, never to ratify the code against itself.
 *
 * The PRD freezes five vectors and this file asserts all five:
 *   1. ACTIONHASH_V1                     (99 framed bytes)
 *   2. CTXHASH_V1 framing-only           (282 framed bytes)
 *   3-5. the three inner digests, plus the end-to-end CTXHASH (367 bytes)
 */
import { describe, it, expect } from 'vitest';
import {
  actionHash, contextHash, contextHashFields, frameFields,
  privacyContextHash, routingContextHash, securityPolicyHash,
  validateAndCanonicalizeArgs, ApprovalContextError,
  CTXHASH_VERSION, ACTIONHASH_VERSION,
} from '../packages/gateway/src/approvalContext.js';
import { canonicalJson } from '@torqclaw/collab';

// ─── Frozen values, transcribed verbatim from the PRD ───────────────────────

const SRC_REQUEST = '11111111-1111-4111-8111-111111111111';
const TOOL = 'filesystem__write_file';
const ARGS_OBJ = { a: 'é', z: 1 };
const ARGS_CANON = '{"a":"é","z":1}';

const FROZEN_ACTION_HASH = 'c3db5267496d68d9edea579e0bd43c1e397364026e281401e30fa0bc596af6bb';

const FRAMING_FIELDS = [
  'prn_operator_01', 'srf_desktop_01', SRC_REQUEST, 'desktop', 'workspace_write',
  TOOL, ARGS_CANON, 'privacy-v1:sensitive', 'routing-v1:OLLAMA_LOCAL', 'c'.repeat(64),
];
const FROZEN_FRAMING_LENGTHS = [15, 14, 36, 7, 15, 22, 16, 20, 23, 64];
const FROZEN_FRAMING_TOTAL = 282;
const FROZEN_FRAMING_HASH = '96424e5e9f3bb595e74408a9e1fe07b1b7f981d3f04c427e1af1ac5fa3ff2c2a';

const FROZEN_F8 = 'b503e9e4eb94c4c3ef34481efced486596a270955036a961f8fd02682156ad16';
const FROZEN_F9 = '944af7d5cf70a7ba35a48d1eba0255e61dda8718e9b2b11017d4c0f70cce3e25';
const FROZEN_F10 = '4ddc3aa9ad1d6a905fba67ca74183cf28cbf1141a340eee6aaf56a71c0157310';
const FROZEN_SEMANTIC_TOTAL = 367;
const FROZEN_SEMANTIC_CTX = 'd7bf709cf2ee293b854e77f7aa649cc18c3195e52870b2e8e01066e270556626';

const SEMANTIC_INPUT = {
  originPrincipalId: 'prn_operator_01',
  originSurfaceId: 'srf_desktop_01',
  sourceRequestId: SRC_REQUEST,
  originSurfaceKind: 'desktop',
  profileId: 'workspace_write',
  toolName: TOOL,
  canonicalArgs: ARGS_CANON,
  privacyContextHash: FROZEN_F8,
  routingContextHash: FROZEN_F9,
  securityPolicyHash: FROZEN_F10,
};

describe('ACTIONHASH_V1 frozen vector (§3.1)', () => {
  it('reproduces the frozen digest and its 99-byte framed stream', () => {
    const framed = frameFields(ACTIONHASH_VERSION, [SRC_REQUEST, TOOL, ARGS_CANON]);
    expect(framed.length).toBe(99);
    expect(actionHash(SRC_REQUEST, TOOL, ARGS_CANON)).toBe(FROZEN_ACTION_HASH);
  });

  it('canonicalJson of the fixture args produces the exact frozen bytes', () => {
    expect(canonicalJson(ARGS_OBJ)).toBe(ARGS_CANON);
    // key order in the source object must not matter
    expect(canonicalJson({ z: 1, a: 'é' })).toBe(ARGS_CANON);
  });

  // The PRD names each of these as a required mutation test.
  it('MUTATION: substituting the dispatch id changes the digest', () => {
    expect(actionHash('22222222-2222-4222-8222-222222222222', TOOL, ARGS_CANON))
      .not.toBe(FROZEN_ACTION_HASH);
  });

  it('MUTATION: using the raw (non-namespaced) tool name changes the digest', () => {
    expect(actionHash(SRC_REQUEST, 'write_file', ARGS_CANON)).not.toBe(FROZEN_ACTION_HASH);
  });

  it('MUTATION: changing any argument changes the digest', () => {
    expect(actionHash(SRC_REQUEST, TOOL, canonicalJson({ a: 'é', z: 2 })))
      .not.toBe(FROZEN_ACTION_HASH);
  });

  it('MUTATION: non-canonical argument bytes change the digest', () => {
    // Same semantic value, non-canonical spacing/order.
    expect(actionHash(SRC_REQUEST, TOOL, '{"z":1,"a":"é"}')).not.toBe(FROZEN_ACTION_HASH);
    expect(actionHash(SRC_REQUEST, TOOL, '{ "a": "é", "z": 1 }')).not.toBe(FROZEN_ACTION_HASH);
  });
});

describe('CTXHASH_V1 framing vector (§3.4.1)', () => {
  it('computes UTF-8 BYTE lengths, not JS character counts', () => {
    const lengths = FRAMING_FIELDS.map((f) => Buffer.from(f, 'utf8').length);
    expect(lengths).toEqual(FROZEN_FRAMING_LENGTHS);
    // The 'é' field is where byte-length and char-length diverge: this is
    // the exact bug the frozen vector exists to catch.
    expect(ARGS_CANON.length).toBe(15);
    expect(Buffer.from(ARGS_CANON, 'utf8').length).toBe(16);
  });

  it('reproduces the frozen 282-byte stream and digest', () => {
    const framed = frameFields(CTXHASH_VERSION, FRAMING_FIELDS);
    expect(framed.length).toBe(FROZEN_FRAMING_TOTAL);
    expect(framed.subarray(0, 10).toString('utf8')).toBe('CTXHASH_V1');
    const input = { ...SEMANTIC_INPUT, privacyContextHash: 'privacy-v1:sensitive',
      routingContextHash: 'routing-v1:OLLAMA_LOCAL', securityPolicyHash: 'c'.repeat(64) };
    expect(contextHash(input)).toBe(FROZEN_FRAMING_HASH);
  });

  it('the version tag is INSIDE the hashed bytes (V1 and V2 cannot collide)', () => {
    const v1 = frameFields('CTXHASH_V1', FRAMING_FIELDS);
    const v2 = frameFields('CTXHASH_V2', FRAMING_FIELDS);
    expect(v1.equals(v2)).toBe(false);
  });

  it('length framing prevents boundary forgery: ("ab","c") != ("a","bc")', () => {
    const a = frameFields('T', ['ab', 'c']);
    const b = frameFields('T', ['a', 'bc']);
    expect(a.equals(b)).toBe(false);
  });

  it('field order is the numbered list, not sorted', () => {
    const fields = contextHashFields(SEMANTIC_INPUT);
    expect(fields).toEqual([
      'prn_operator_01', 'srf_desktop_01', SRC_REQUEST, 'desktop',
      'workspace_write', TOOL, ARGS_CANON, FROZEN_F8, FROZEN_F9, FROZEN_F10,
    ]);
    expect(fields).not.toEqual([...fields].sort());
  });

  it('an explicitly present EMPTY string encodes as U32BE(0)...', () => {
    const framed = frameFields('T', ['']);
    expect(framed.length).toBe(1 + 4);
    expect(framed.subarray(1).readUInt32BE()).toBe(0);
  });

  it('...but ABSENCE refuses instead of collapsing to empty (injectivity)', () => {
    expect(() => frameFields('T', [undefined as unknown as string])).toThrow(ApprovalContextError);
    expect(() => frameFields('T', [null as unknown as string])).toThrow(/required and non-null/);
    // and the two are therefore distinguishable, which is the point
    expect(frameFields('T', ['']).length).toBe(5);
  });
});

describe('CTXHASH_V1 end-to-end semantic vector (§3.4.1)', () => {
  it('reproduces the three frozen inner digests', () => {
    expect(privacyContextHash({ containsSensitiveData: true })).toBe(FROZEN_F8);
    expect(routingContextHash({
      executionMode: 'AUTO', selectedTier: 'OLLAMA_LOCAL', ruleId: 'LOCAL_TOOL_INTENT',
    })).toBe(FROZEN_F9);
    expect(securityPolicyHash({
      effectiveProfile: {
        schemaVersion: 'torqclaw.effective-profile/v1',
        profileId: 'workspace_write',
        profileVersion: 1,
        toolRegistryVersion: 'torqclaw.tools/v1',
        effectiveProfilePolicyHash:
          'e67951376789e1ae88b2388f22351fc8bc5a5c93dcbce7f1d412926f8bfc0b7e',
      },
      capabilityRevision: 7,
      profileDelegationRevision: 11,
      registryEnforcementHash: 'd'.repeat(64),
    })).toBe(FROZEN_F10);
  });

  it('reproduces the frozen 367-byte stream and final CTXHASH_V1', () => {
    const framed = frameFields(CTXHASH_VERSION, contextHashFields(SEMANTIC_INPUT));
    expect(framed.length).toBe(FROZEN_SEMANTIC_TOTAL);
    expect(contextHash(SEMANTIC_INPUT)).toBe(FROZEN_SEMANTIC_CTX);
  });

  it('permuting the ARGUMENT keys preserves the digest (canonicalJson sorts)', () => {
    const permuted = { ...SEMANTIC_INPUT, canonicalArgs: canonicalJson({ z: 1, a: 'é' }) };
    expect(contextHash(permuted)).toBe(FROZEN_SEMANTIC_CTX);
  });

  it('changing ANY semantic field changes the final digest', () => {
    const mutations: Array<[string, Record<string, string>]> = [
      ['principal', { originPrincipalId: 'prn_other' }],
      ['surface', { originSurfaceId: 'srf_other' }],
      ['request', { sourceRequestId: '22222222-2222-4222-8222-222222222222' }],
      ['origin kind', { originSurfaceKind: 'mobile' }],
      ['PROFILE (A9 defence)', { profileId: 'terminal_power' }],
      ['tool', { toolName: 'filesystem__read_file' }],
      ['args', { canonicalArgs: '{"a":"e","z":1}' }],
      ['PRIVACY (A9 defence)', { privacyContextHash: 'a'.repeat(64) }],
      ['routing', { routingContextHash: 'b'.repeat(64) }],
      ['policy', { securityPolicyHash: 'e'.repeat(64) }],
    ];
    for (const [label, patch] of mutations) {
      expect(contextHash({ ...SEMANTIC_INPUT, ...patch }), label).not.toBe(FROZEN_SEMANTIC_CTX);
    }
  });

  it('profile and privacy are INPUTS, which is why A9 fails by construction', () => {
    // The PRD's rationale: a tool+args-only hash could not detect a profile
    // or privacy-posture change between request and apply. These two
    // assertions are that claim, mechanically.
    expect(contextHash({ ...SEMANTIC_INPUT, profileId: 'read_only' }))
      .not.toBe(contextHash(SEMANTIC_INPUT));
    expect(contextHash({
      ...SEMANTIC_INPUT, privacyContextHash: privacyContextHash({ containsSensitiveData: false }),
    })).not.toBe(contextHash(SEMANTIC_INPUT));
  });

  it('privacy/routing inner digests change with their own inputs', () => {
    expect(privacyContextHash({ containsSensitiveData: false })).not.toBe(FROZEN_F8);
    expect(routingContextHash({
      executionMode: 'AUTO', selectedTier: 'FRONTIER', ruleId: 'LOCAL_TOOL_INTENT',
    })).not.toBe(FROZEN_F9);
    // explicit null ruleId is a distinct, representable value (never omitted)
    expect(routingContextHash({
      executionMode: 'AUTO', selectedTier: 'OLLAMA_LOCAL', ruleId: null,
    })).not.toBe(FROZEN_F9);
  });
});

describe('C2 argument validation (§3.1) — refuse before any pending row', () => {
  it('accepts a plain object, including the no-argument {} case', () => {
    expect(validateAndCanonicalizeArgs({})).toBe('{}');
    expect(validateAndCanonicalizeArgs({ a: 'é', z: 1 })).toBe(ARGS_CANON);
    expect(validateAndCanonicalizeArgs({ nested: { b: [1, 2, null] } }))
      .toBe('{"nested":{"b":[1,2,null]}}');
  });

  it('refuses null and undefined (never coerced to {} or "null")', () => {
    expect(() => validateAndCanonicalizeArgs(null)).toThrow(/present plain object/);
    expect(() => validateAndCanonicalizeArgs(undefined)).toThrow(/present plain object/);
  });

  it('refuses root arrays and scalars', () => {
    for (const bad of [[1, 2], 'str', 42, true]) {
      expect(() => validateAndCanonicalizeArgs(bad)).toThrow(ApprovalContextError);
    }
  });

  it('refuses cycles, sparse arrays, functions, symbols, bigint, non-finite', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => validateAndCanonicalizeArgs(cyclic)).toThrow(/cycle/);

    const sparse = [1]; sparse[3] = 4;
    expect(() => validateAndCanonicalizeArgs({ sparse })).toThrow(/sparse/);

    expect(() => validateAndCanonicalizeArgs({ f: () => 1 })).toThrow(/functions/);
    expect(() => validateAndCanonicalizeArgs({ s: Symbol('x') })).toThrow(/symbols/);
    expect(() => validateAndCanonicalizeArgs({ b: BigInt(1) })).toThrow(/bigint/);
    expect(() => validateAndCanonicalizeArgs({ n: Number.NaN })).toThrow(/non-finite/);
    expect(() => validateAndCanonicalizeArgs({ n: Infinity })).toThrow(/non-finite/);
  });

  it('refuses non-plain objects (class instances, Date, Map)', () => {
    class Thing { x = 1; }
    expect(() => validateAndCanonicalizeArgs(new Thing())).toThrow(/plain object/);
    expect(() => validateAndCanonicalizeArgs({ d: new Date() })).toThrow(/plain object/);
    expect(() => validateAndCanonicalizeArgs({ m: new Map() })).toThrow(/plain object/);
  });

  it('handles a large field without silently truncating it', () => {
    const big = 'x'.repeat(200_000);
    const canon = validateAndCanonicalizeArgs({ big });
    expect(canon.length).toBeGreaterThan(200_000);
    // and it frames/hashes deterministically
    expect(actionHash(SRC_REQUEST, TOOL, canon)).toBe(actionHash(SRC_REQUEST, TOOL, canon));
  });
});
