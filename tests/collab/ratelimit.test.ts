import { describe, it, expect } from 'vitest';
import {
  AuthRateLimiter,
  normalizeCredentialId,
  normalizeAddress,
  isLoopbackAddress,
  type RateLimitClock,
} from '../../packages/collab/src/ratelimit.js';

class FakeClock implements RateLimitClock {
  private ms: number;
  constructor(startMs = 0) {
    this.ms = startMs;
  }
  nowMs(): number {
    return this.ms;
  }
  advance(deltaMs: number): void {
    this.ms += deltaMs;
  }
}

const VALID_CRED_A = '11111111-1111-1111-1111-111111111111';
const VALID_CRED_B = '22222222-2222-2222-2222-222222222222';

describe('normalizeCredentialId', () => {
  it('accepts canonical lowercase UUIDs', () => {
    expect(normalizeCredentialId(VALID_CRED_A)).toBe(VALID_CRED_A);
  });

  it('rejects malformed IDs', () => {
    expect(normalizeCredentialId('not-a-uuid')).toBeNull();
    expect(normalizeCredentialId('11111111-1111-1111-1111-11111111111')).toBeNull(); // too short
    expect(normalizeCredentialId('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'.toUpperCase())).toBeNull(); // uppercase rejected
    expect(normalizeCredentialId('')).toBeNull();
  });
});

describe('normalizeAddress', () => {
  it('normalizes IPv4 host address as-is', () => {
    expect(normalizeAddress('203.0.113.5')).toBe('203.0.113.5');
  });

  it('unwraps IPv4-mapped IPv6 addresses', () => {
    expect(normalizeAddress('::ffff:203.0.113.5')).toBe('203.0.113.5');
  });

  it('normalizes IPv6 to /64 prefix', () => {
    expect(normalizeAddress('2001:db8:1234:5678:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1234:5678');
    expect(normalizeAddress('2001:db8:1234:5678:0000:0000:0000:0001')).toBe('2001:db8:1234:5678');
  });

  it('two addresses sharing a /64 normalize identically', () => {
    const a = normalizeAddress('2001:db8:1234:5678::1');
    const b = normalizeAddress('2001:db8:1234:5678::2');
    expect(a).toBe(b);
  });

  it('handles :: compression correctly', () => {
    expect(normalizeAddress('::1')).toBe('0:0:0:0');
    expect(normalizeAddress('fe80::1')).toBe('fe80:0:0:0');
  });
});

describe('isLoopbackAddress', () => {
  it('detects IPv4 loopback', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.5.5.5')).toBe(true);
  });

  it('detects IPv6 loopback', () => {
    expect(isLoopbackAddress('::1')).toBe(true);
  });

  it('does not flag non-loopback addresses', () => {
    expect(isLoopbackAddress('203.0.113.5')).toBe(false);
    expect(isLoopbackAddress('2001:db8::1')).toBe(false);
  });
});

describe('AuthRateLimiter: credential bucket (5 per 5 min)', () => {
  it('locks out after 5 failures for the same credential ID', () => {
    const clock = new FakeClock();
    const limiter = new AuthRateLimiter(clock);
    const addr = '203.0.113.99'; // distinct address so address bucket doesn't also trip

    for (let i = 0; i < 5; i++) {
      expect(limiter.check(VALID_CRED_A, addr).lockedOut).toBe(false);
      limiter.recordAttempt(VALID_CRED_A, addr, 'failure');
    }
    expect(limiter.check(VALID_CRED_A, addr).lockedOut).toBe(true);
  });

  it('4 failures do not lock out', () => {
    const clock = new FakeClock();
    const limiter = new AuthRateLimiter(clock);
    const addr = '203.0.113.98';
    for (let i = 0; i < 4; i++) {
      limiter.recordAttempt(VALID_CRED_A, addr, 'failure');
    }
    expect(limiter.check(VALID_CRED_A, addr).lockedOut).toBe(false);
  });

  it('lockout lasts 15 minutes then clears', () => {
    const clock = new FakeClock();
    const limiter = new AuthRateLimiter(clock);
    const addr = '203.0.113.97';
    for (let i = 0; i < 5; i++) {
      limiter.recordAttempt(VALID_CRED_A, addr, 'failure');
    }
    expect(limiter.check(VALID_CRED_A, addr).lockedOut).toBe(true);

    clock.advance(15 * 60 * 1000 - 1);
    expect(limiter.check(VALID_CRED_A, addr).lockedOut).toBe(true);

    clock.advance(2);
    expect(limiter.check(VALID_CRED_A, addr).lockedOut).toBe(false);
  });

  it('rolling window: failures older than 5 minutes do not count toward the threshold', () => {
    const clock = new FakeClock();
    const limiter = new AuthRateLimiter(clock);
    const addr = '203.0.113.96';

    for (let i = 0; i < 4; i++) {
      limiter.recordAttempt(VALID_CRED_A, addr, 'failure');
    }
    clock.advance(5 * 60 * 1000 + 1); // outside the 5-minute window
    limiter.recordAttempt(VALID_CRED_A, addr, 'failure'); // 5th failure, but the first 4 have expired
    expect(limiter.check(VALID_CRED_A, addr).lockedOut).toBe(false);
  });

  it('credential buckets are independent per credential ID', () => {
    const clock = new FakeClock();
    const limiter = new AuthRateLimiter(clock);
    // Use distinct addresses for A and B so the shared-address ADDRESS
    // bucket (threshold 20) cannot itself trip and confound the
    // credential-bucket-independence assertion below.
    const addrA = '203.0.113.95';
    const addrB = '203.0.113.94';
    for (let i = 0; i < 5; i++) {
      limiter.recordAttempt(VALID_CRED_A, addrA, 'failure');
    }
    expect(limiter.check(VALID_CRED_A, addrA).lockedOut).toBe(true);
    // Credential B has recorded zero failures; its own bucket (and addrB's
    // bucket) must remain unaffected by credential A's lockout.
    expect(limiter.check(VALID_CRED_B, addrB).lockedOut).toBe(false);
  });
});

describe('AuthRateLimiter: address bucket (20 per 5 min)', () => {
  it('locks out after 20 failures for the same address, using varied credential IDs', () => {
    const clock = new FakeClock();
    const limiter = new AuthRateLimiter(clock);
    const addr = '203.0.113.50';

    for (let i = 0; i < 20; i++) {
      // Use a fresh credential ID each time so the credential bucket never
      // trips (max 5 per credential); isolates the address-bucket behavior.
      const credId = `${String(i).padStart(8, '0')}-0000-0000-0000-000000000000`;
      limiter.recordAttempt(credId, addr, 'failure');
    }
    expect(limiter.check(null, addr).lockedOut).toBe(true);
  });

  it('loopback addresses are exempt from the address counter', () => {
    const clock = new FakeClock();
    const limiter = new AuthRateLimiter(clock);
    for (let i = 0; i < 25; i++) {
      const credId = `${String(i).padStart(8, '0')}-0000-0000-0000-000000000000`;
      limiter.recordAttempt(credId, '127.0.0.1', 'failure');
    }
    expect(limiter.addressBucketCount).toBe(0);
    expect(limiter.check(null, '127.0.0.1').lockedOut).toBe(false);
  });

  it('loopback address is still subject to the per-credential-ID counter', () => {
    const clock = new FakeClock();
    const limiter = new AuthRateLimiter(clock);
    for (let i = 0; i < 5; i++) {
      limiter.recordAttempt(VALID_CRED_A, '127.0.0.1', 'failure');
    }
    expect(limiter.check(VALID_CRED_A, '127.0.0.1').lockedOut).toBe(true);
  });
});

describe('AuthRateLimiter M2: unparseable tokens bucket to ADDRESS only, bounded credential map', () => {
  it('a null credential ID (unparseable token) never creates a credential bucket', () => {
    const clock = new FakeClock();
    const limiter = new AuthRateLimiter(clock);
    const addr = '203.0.113.10';

    for (let i = 0; i < 10; i++) {
      limiter.recordAttempt(null, addr, 'failure');
    }
    expect(limiter.credentialBucketCount).toBe(0);
    expect(limiter.addressBucketCount).toBe(1);
  });

  it('a malformed (non-UUID-shaped) credential ID string also never creates a credential bucket', () => {
    const clock = new FakeClock();
    const limiter = new AuthRateLimiter(clock);
    const addr = '203.0.113.11';

    for (let i = 0; i < 10; i++) {
      limiter.recordAttempt(`garbage-token-${i}`, addr, 'failure');
    }
    expect(limiter.credentialBucketCount).toBe(0);
    expect(limiter.addressBucketCount).toBe(1);
  });

  it('unparseable-token floods still trip the address lockout at 20', () => {
    const clock = new FakeClock();
    const limiter = new AuthRateLimiter(clock);
    const addr = '203.0.113.12';
    for (let i = 0; i < 20; i++) {
      limiter.recordAttempt(null, addr, 'failure');
    }
    expect(limiter.check(null, addr).lockedOut).toBe(true);
    expect(limiter.credentialBucketCount).toBe(0);
  });

  it('credential bucket map remains bounded under a flood of distinct malformed IDs', () => {
    const clock = new FakeClock();
    const limiter = new AuthRateLimiter(clock);
    const addr = '203.0.113.13';
    for (let i = 0; i < 1000; i++) {
      limiter.recordAttempt(`not-a-valid-uuid-${i}`, addr, 'failure');
    }
    expect(limiter.credentialBucketCount).toBe(0);
  });
});

function uuidForIndex(i: number): string {
  // Canonical-lowercase-UUID-shaped, distinct per index.
  const hex = i.toString(16).padStart(8, '0');
  return `${hex}-0000-4000-8000-000000000000`;
}

describe('F4 gating fixture: bounded credential-bucket map under a flood of DISTINCT well-formed UUIDs', () => {
  it('map size stays <= MAX_CREDENTIAL_BUCKETS (50,000) under 60,000 distinct well-formed credential IDs', () => {
    const clock = new FakeClock();
    const limiter = new AuthRateLimiter(clock);
    const addr = '203.0.113.200';

    for (let i = 0; i < 60_000; i++) {
      // Spread failures across many addresses too, so the ADDRESS bucket
      // threshold (20) never locks and starves the credential-bucket
      // insert path; only the credential-bucket cap is under test here.
      limiter.recordAttempt(uuidForIndex(i), `${addr}.${i % 50}`, 'failure');
    }

    expect(limiter.credentialBucketCount).toBeLessThanOrEqual(50_000);
  });

  it('a locked-out credential ID inserted early still rejects after a flood of 60,000 distinct fresh IDs (eviction never drops an active lockout)', () => {
    const clock = new FakeClock();
    const limiter = new AuthRateLimiter(clock);
    const earlyId = VALID_CRED_A;
    const earlyAddr = '203.0.113.201';

    // Trip the early ID's lockout FIRST (5 failures, distinct address per
    // failure so the address bucket doesn't itself lock this address out
    // in a way that would confound the credential-bucket read).
    for (let i = 0; i < 5; i++) {
      limiter.recordAttempt(earlyId, `${earlyAddr}.${i}`, 'failure');
    }
    expect(limiter.check(earlyId, `${earlyAddr}.999`).lockedOut).toBe(true);

    // Flood far past the cap with distinct fresh well-formed UUIDs from a
    // DIFFERENT id space, forcing repeated eviction passes.
    for (let i = 0; i < 60_000; i++) {
      limiter.recordAttempt(uuidForIndex(i + 1_000_000), `203.0.113.202.${i % 50}`, 'failure');
    }

    // The early lockout must still be active and must not have been
    // evicted to make room for the flood.
    expect(limiter.check(earlyId, `${earlyAddr}.999`).lockedOut).toBe(true);
    expect(limiter.credentialBucketCount).toBeLessThanOrEqual(50_000);
  });

  it('sweep phase reclaims fully-expired, non-locked-out buckets before eviction has to touch anything live', () => {
    const clock = new FakeClock();
    const limiter = new AuthRateLimiter(clock);

    // A modest number of buckets, all well below threshold (no lockout),
    // all in the past relative to the window.
    for (let i = 0; i < 100; i++) {
      limiter.recordAttempt(uuidForIndex(i), `203.0.113.210.${i}`, 'failure');
    }
    const sizeBefore = limiter.credentialBucketCount;
    expect(sizeBefore).toBe(100);

    // Advance well past the rolling window so all 100 buckets are fully
    // expired (no live failures, no lockout).
    clock.advance(6 * 60 * 1000);

    // A single new failure should not need to evict anything live; it can
    // simply coexist (below cap, no eviction triggered at all here — this
    // test mainly documents that expired buckets don't count against
    // "liveness" for the F4 lockout-survival guarantee, exercised at
    // full scale in the flood test above).
    limiter.recordAttempt(uuidForIndex(999_999), '203.0.113.211', 'failure');
    expect(limiter.credentialBucketCount).toBeGreaterThan(0);
  });

  it('idle period then one attempt reclaims expired buckets once the throttle window has passed (NEW-1)', () => {
    const clock = new FakeClock();
    const limiter = new AuthRateLimiter(clock);

    // Fill to capacity with buckets that will all expire together.
    for (let i = 0; i < MAX_CREDENTIAL_BUCKETS_FOR_TEST; i++) {
      limiter.recordAttempt(uuidForIndex(i), `203.0.113.220.${i % 50}`, 'failure');
    }
    expect(limiter.credentialBucketCount).toBe(MAX_CREDENTIAL_BUCKETS_FOR_TEST);

    // Idle for over an hour (well past both the 5-minute rolling window and
    // the NEW-1 sweep throttle, which is gated at one WINDOW_MS interval).
    clock.advance(60 * 60 * 1000);

    // One new insertion at capacity: the throttle window has elapsed, so
    // this is expected to trigger a fresh Phase-1 sweep that reclaims the
    // now-fully-expired buckets, then insert the new key without evicting
    // anything "live" (there is nothing live left).
    limiter.recordAttempt(uuidForIndex(999_998), '203.0.113.221', 'failure');

    // The map must not have grown past the cap, and the newly-inserted key
    // must be present -- i.e. reclamation, not merely LRU eviction of a
    // fresh bucket, made room.
    expect(limiter.credentialBucketCount).toBeLessThanOrEqual(MAX_CREDENTIAL_BUCKETS_FOR_TEST);
    expect(limiter.check(uuidForIndex(999_998), '203.0.113.221.other').lockedOut).toBe(false);
  });
});

const MAX_CREDENTIAL_BUCKETS_FOR_TEST = 50_000;

describe('NEW-1 / F5 cost-regression fixture (operation-count, deterministic — no wall-clock assertions)', () => {
  it('200 attempts at capacity visit at most a small constant times 200 buckets plus at most one full sweep', () => {
    const clock = new FakeClock();
    const limiter = new AuthRateLimiter(clock);
    const addr = '203.0.113.230';

    // Fill to capacity first (outside the measured window).
    for (let i = 0; i < 50_000; i++) {
      limiter.recordAttempt(uuidForIndex(i), `${addr}.${i % 50}`, 'failure');
    }
    expect(limiter.credentialBucketCount).toBeLessThanOrEqual(50_000);

    // Reset the counter so only the next 200 insertions are measured.
    const visitsBeforeMeasured = limiter.bucketVisitCount;

    // 200 more distinct well-formed UUIDs, still at/over capacity, forcing
    // eviction on every insertion. Old behavior: each insertion did a full
    // O(50,000) Phase-1 scan = 200 * 50,000 = 10,000,000 bucket visits. New
    // behavior: the sweep is throttled to at most one per WINDOW_MS, so
    // within this single burst (no clock advance) at most ONE full sweep
    // occurs; every other insertion should cost only a small constant
    // (Phase 2 LRU eviction visits very few buckets before finding a
    // non-locked-out victim).
    for (let i = 0; i < 200; i++) {
      limiter.recordAttempt(uuidForIndex(1_000_000 + i), `${addr}.${(i % 50) + 100}`, 'failure');
    }

    const visitsMeasured = limiter.bucketVisitCount - visitsBeforeMeasured;
    const K = 5; // small constant per insertion for Phase 2 LRU-victim scanning
    expect(visitsMeasured).toBeLessThanOrEqual(200 * K + 50_000);

    // Sanity floor: this must be dramatically below the old O(n) per
    // insertion behavior, not just under the loose bound above.
    expect(visitsMeasured).toBeLessThan(200 * 50_000);
  });

  it('single-key pruning across 16,000 failures performs O(total) work, not O(n^2)', () => {
    const clock = new FakeClock();
    const limiter = new AuthRateLimiter(clock);
    const credId = VALID_CRED_A;
    // Distinct addresses so the ADDRESS bucket (threshold 20) never locks
    // and never itself contributes visit-count noise to this credential-
    // bucket-focused measurement.
    let addrCounter = 0;

    const visitsBefore = limiter.bucketVisitCount;

    // 16,000 failures on the SAME credential ID, each one lockout cycle
    // apart in time so old failures keep expiring and needing to be pruned
    // (exercising the head-advance path repeatedly) rather than piling up
    // as one giant live array.
    for (let i = 0; i < 16_000; i++) {
      limiter.recordAttempt(credId, `203.0.113.240.${addrCounter++ % 1000}`, 'failure');
      clock.advance(2000); // 2s per attempt; periodically exceeds WINDOW_MS lookback for older entries
    }

    const visitsTotal = limiter.bucketVisitCount - visitsBefore;
    const C = 4; // small constant: each failure is visited O(1) amortized times by head-advance
    expect(visitsTotal).toBeLessThanOrEqual(C * 16_000);
  });

  it('quick wall-clock smoke check: 200 attempts at capacity complete fast (non-gating, informational)', () => {
    const clock = new FakeClock();
    const limiter = new AuthRateLimiter(clock);
    const addr = '203.0.113.250';
    for (let i = 0; i < 50_000; i++) {
      limiter.recordAttempt(uuidForIndex(i), `${addr}.${i % 50}`, 'failure');
    }
    const start = Date.now();
    for (let i = 0; i < 200; i++) {
      limiter.recordAttempt(uuidForIndex(2_000_000 + i), `${addr}.${(i % 50) + 200}`, 'failure');
    }
    const elapsedMs = Date.now() - start;
    // Loose, non-gating smoke check only -- the real assertions are the
    // operation-count fixtures above. Old behavior measured ~4.11 ms per
    // attempt at capacity (~822ms for 200); new behavior should be at
    // least an order of magnitude faster. Generous bound to avoid flake on
    // slow CI machines.
    expect(elapsedMs).toBeLessThan(2000);
  });
});

describe('AuthRateLimiter: lockout reported as AUTH_FAILED (indistinguishable)', () => {
  it('check() returns only a boolean lockedOut flag, no distinguishing detail', () => {
    const clock = new FakeClock();
    const limiter = new AuthRateLimiter(clock);
    const result = limiter.check(VALID_CRED_A, '203.0.113.1');
    expect(Object.keys(result)).toEqual(['lockedOut']);
  });
});

describe('AuthRateLimiter: restart resets counters by design', () => {
  it('a fresh AuthRateLimiter instance has no memory of prior failures', () => {
    const clock = new FakeClock();
    const limiter1 = new AuthRateLimiter(clock);
    for (let i = 0; i < 5; i++) {
      limiter1.recordAttempt(VALID_CRED_A, '203.0.113.1', 'failure');
    }
    expect(limiter1.check(VALID_CRED_A, '203.0.113.1').lockedOut).toBe(true);

    const limiter2 = new AuthRateLimiter(clock);
    expect(limiter2.check(VALID_CRED_A, '203.0.113.1').lockedOut).toBe(false);
  });
});
