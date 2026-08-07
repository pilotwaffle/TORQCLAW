import { describe, it, expect, beforeEach } from 'vitest';
import {
  issueCredential,
  verifyCredential,
  hmacSha256,
  credentialHmacOperationCount,
  resetCredentialHmacOperationCount,
  type CredentialLookup,
} from '../../packages/collab/src/credentials.js';
import { nodeRandomSource } from '../../packages/collab/src/bootstrap.js';

const PRINCIPAL_PEPPER = Buffer.alloc(32, 0x42);
const ACTIVE_ID = '11111111-1111-1111-1111-111111111111';
const REVOKED_ID = '22222222-2222-2222-2222-222222222222';
const UNKNOWN_ID = '33333333-3333-3333-3333-333333333333';

function makeLookup(): { lookup: CredentialLookup; activeToken: string; revokedToken: string } {
  const active = issueCredential(ACTIVE_ID, PRINCIPAL_PEPPER, nodeRandomSource);
  const revoked = issueCredential(REVOKED_ID, PRINCIPAL_PEPPER, nodeRandomSource);

  const lookup: CredentialLookup = (id: string) => {
    if (id === ACTIVE_ID) return { secretHmac: active.secretHmac, state: 'active' };
    if (id === REVOKED_ID) return { secretHmac: revoked.secretHmac, state: 'revoked' };
    return undefined;
  };

  return { lookup, activeToken: active.token, revokedToken: revoked.token };
}

describe('issueCredential', () => {
  it('produces the tq1_<credentialId>_<secret> format', () => {
    const issued = issueCredential(ACTIVE_ID, PRINCIPAL_PEPPER, nodeRandomSource);
    expect(issued.token).toMatch(/^tq1_[0-9a-f-]{36}_[A-Za-z0-9_-]+$/);
    expect(issued.token.startsWith(`tq1_${ACTIVE_ID}_`)).toBe(true);
    issued.secretBytes.fill(0);
  });

  it('secretHmac equals HMAC-SHA-256(principalPepper, complete-token-bytes)', () => {
    const issued = issueCredential(ACTIVE_ID, PRINCIPAL_PEPPER, nodeRandomSource);
    const expected = hmacSha256(PRINCIPAL_PEPPER, Buffer.from(issued.token, 'utf8'));
    expect(issued.secretHmac.equals(expected)).toBe(true);
    issued.secretBytes.fill(0);
  });

  it('secretBytes is exactly 32 bytes and independently fillable', () => {
    const issued = issueCredential(ACTIVE_ID, PRINCIPAL_PEPPER, nodeRandomSource);
    expect(issued.secretBytes.length).toBe(32);
    issued.secretBytes.fill(0);
    expect(issued.secretBytes.every((b) => b === 0)).toBe(true);
  });
});

describe('verifyCredential: correctness', () => {
  it('accepts a valid active credential', () => {
    const { lookup, activeToken } = makeLookup();
    const result = verifyCredential(activeToken, PRINCIPAL_PEPPER, lookup);
    expect(result).toEqual({ ok: true, credentialId: ACTIVE_ID });
  });

  it('rejects a revoked credential with AUTH_FAILED', () => {
    const { lookup, revokedToken } = makeLookup();
    const result = verifyCredential(revokedToken, PRINCIPAL_PEPPER, lookup);
    expect(result).toEqual({ ok: false, reason: 'AUTH_FAILED' });
  });

  it('rejects an unknown credential ID with AUTH_FAILED', () => {
    const { lookup } = makeLookup();
    const fakeToken = `tq1_${UNKNOWN_ID}_${Buffer.alloc(32, 9).toString('base64url')}`;
    const result = verifyCredential(fakeToken, PRINCIPAL_PEPPER, lookup);
    expect(result).toEqual({ ok: false, reason: 'AUTH_FAILED' });
  });

  it('rejects a wrong secret for a valid credential ID', () => {
    const { lookup } = makeLookup();
    const wrongToken = `tq1_${ACTIVE_ID}_${Buffer.alloc(32, 0xff).toString('base64url')}`;
    const result = verifyCredential(wrongToken, PRINCIPAL_PEPPER, lookup);
    expect(result).toEqual({ ok: false, reason: 'AUTH_FAILED' });
  });

  it('rejects malformed tokens (bad prefix, missing parts, empty parts)', () => {
    const { lookup } = makeLookup();
    const malformed = [
      '',
      'not-a-token',
      'tq2_11111111-1111-1111-1111-111111111111_abc',
      'tq1_',
      'tq1_11111111-1111-1111-1111-111111111111_',
      'tq1__abc',
      'tq1_not-a-uuid_abc',
      'garbage'.repeat(100),
    ];
    for (const token of malformed) {
      const result = verifyCredential(token, PRINCIPAL_PEPPER, lookup);
      expect(result).toEqual({ ok: false, reason: 'AUTH_FAILED' });
    }
  });
});

describe('verifyCredential: C1 — never throws, wraps entirely', () => {
  it('never throws for any malformed/oversized/weird input', () => {
    const { lookup } = makeLookup();
    const nasty = [
      '',
      'tq1_' + 'x'.repeat(100000), // huge malformed token — must not blow up timingSafeEqual
      'tq1_11111111-1111-1111-1111-111111111111_' + 'x'.repeat(100000),
      '\x00\x01\x02',
      'tq1_11111111-1111-1111-1111-111111111111_short',
      String.fromCharCode(0xd800), // lone surrogate — invalid UTF-16
    ];
    for (const token of nasty) {
      expect(() => verifyCredential(token, PRINCIPAL_PEPPER, lookup)).not.toThrow();
      const result = verifyCredential(token, PRINCIPAL_PEPPER, lookup);
      expect(result.ok).toBe(false);
    }
  });

  it('a short secret (not 32 bytes when decoded) does not throw timingSafeEqual length errors', () => {
    const { lookup } = makeLookup();
    // "short" base64url-decodes to far fewer than 32 bytes but is embedded
    // in an otherwise well-formed-looking token (valid UUID + underscore).
    const token = `tq1_${ACTIVE_ID}_short`;
    expect(() => verifyCredential(token, PRINCIPAL_PEPPER, lookup)).not.toThrow();
    expect(verifyCredential(token, PRINCIPAL_PEPPER, lookup)).toEqual({ ok: false, reason: 'AUTH_FAILED' });
  });
});

describe('verifyCredential: HMAC-operation-count equality (C1 / G1R explicit answer (c))', () => {
  beforeEach(() => {
    resetCredentialHmacOperationCount();
  });

  it('hit, miss, revoked, and malformed paths perform the same number of HMAC operations', () => {
    const { lookup, activeToken, revokedToken } = makeLookup();
    const fakeToken = `tq1_${UNKNOWN_ID}_${Buffer.alloc(32, 9).toString('base64url')}`;
    const malformedToken = 'not-a-valid-token-at-all';

    resetCredentialHmacOperationCount();
    verifyCredential(activeToken, PRINCIPAL_PEPPER, lookup);
    const hitCount = credentialHmacOperationCount();

    resetCredentialHmacOperationCount();
    verifyCredential(revokedToken, PRINCIPAL_PEPPER, lookup);
    const revokedCount = credentialHmacOperationCount();

    resetCredentialHmacOperationCount();
    verifyCredential(fakeToken, PRINCIPAL_PEPPER, lookup);
    const missCount = credentialHmacOperationCount();

    resetCredentialHmacOperationCount();
    verifyCredential(malformedToken, PRINCIPAL_PEPPER, lookup);
    const malformedCount = credentialHmacOperationCount();

    expect(hitCount).toBe(revokedCount);
    expect(hitCount).toBe(missCount);
    expect(hitCount).toBe(malformedCount);
    expect(hitCount).toBe(2); // presentedHmac + decoyHmac, per implementation contract
  });

  it('counter increments monotonically across multiple verifications', () => {
    const { lookup, activeToken } = makeLookup();
    resetCredentialHmacOperationCount();
    verifyCredential(activeToken, PRINCIPAL_PEPPER, lookup);
    const afterOne = credentialHmacOperationCount();
    verifyCredential(activeToken, PRINCIPAL_PEPPER, lookup);
    const afterTwo = credentialHmacOperationCount();
    expect(afterTwo).toBe(afterOne * 2);
  });
});
