/**
 * Authentication rate limiting for the Collaboration Substrate.
 *
 * Per PRD v0.14 Section 6.2:
 *  - 5 failures per normalized credential ID per 5 minutes;
 *  - 20 failures per normalized remote address per 5 minutes;
 *  - 15-minute lockout after either threshold is crossed;
 *  - IPv4 uses the host address; IPv6 uses the /64 prefix;
 *  - loopback source addresses are exempt from the ADDRESS counter only —
 *    the per-credential-ID counter still applies to loopback;
 *  - restart resets counters by design (in-memory only, no persistence);
 *  - lockout is reported as AUTH_FAILED, indistinguishable from any other
 *    authentication failure.
 *
 * G1R M2 (Medium): unparseable tokens count against the ADDRESS bucket
 * ONLY, never a credential bucket — an attacker spraying garbage tokens
 * cannot grow the credential-bucket map at all, since only well-formed
 * credential IDs (canonical lowercase UUIDs) ever become keys in it.
 *
 * (F4) That well-formedness filter alone does NOT bound the map's size: an
 * attacker (or a large real fleet) presenting many DISTINCT well-formed
 * UUIDs each with one failed attempt would otherwise grow the credential
 * bucket map without limit. `AuthRateLimiter` therefore caps it at
 * `MAX_CREDENTIAL_BUCKETS` (50,000) entries with eviction that (a) first
 * sweeps buckets whose failure window AND lockout have both fully expired,
 * then (b) evicts the oldest non-locked-out entry only if still at
 * capacity; a bucket currently serving an active lockout is NEVER evicted
 * before that lockout expires, regardless of age. See
 * `evictCredentialBuckets` for the exact two-phase algorithm.
 *
 * G2A NEW-1 (High, fixed): the Phase-1 sweep above is an O(n) scan of every
 * bucket in the map. Originally it ran on EVERY insertion once the map was
 * at capacity, so a flood of well-formed unknown UUIDs made every
 * legitimate insertion pay a full-map scan (measured 4.11 ms/attempt at
 * 50k capacity vs 0.03 ms below capacity — a 137x slowdown, ~70s of
 * blocked event loop across a 60k-attempt flood). The sweep is now
 * throttled: it runs at most once per `WINDOW_MS` (the same 5-minute
 * rolling window; expired entries can't appear faster than that), tracked
 * via `lastSweepMs`. Between sweeps, insertion at capacity relies solely on
 * Phase 2's single-victim LRU eviction, which is O(1) amortized (it stops
 * at the first non-locked-out bucket in least-recently-touched order — see
 * `getOrCreateCredentialBucket`). This preserves every existing guarantee
 * (cap never exceeded except when literally every bucket is locked out;
 * locked-out buckets are never evicted before their lockout expires;
 * expired entries are still eventually reclaimed, just on the throttled
 * cadence instead of every insertion) while making the common case O(1).
 *
 * (M1, Slice 5 debt item) `addressBuckets` mirrors this exact design: a
 * second independent cap `MAX_ADDRESS_BUCKETS`, its own throttled sweep
 * (own `lastAddressSweepMs`, same WINDOW_MS cadence), and the same
 * two-phase eviction (expired-and-unlocked sweep, then oldest-non-locked-out
 * LRU victim) via `evictAddressBuckets`/`getOrCreateAddressBucket`, which
 * replace the previous unconditional `getOrCreateBucket` call for the
 * address map. A locked-out address bucket is NEVER evicted before its
 * lockout expires, for the identical reason as the credential map: evicting
 * it would let an attacker who just tripped an address lockout immediately
 * clear it by flooding fresh distinct addresses. `bucketVisitCount` is
 * shared across both maps' sweep/prune instrumentation so a single
 * cost-regression assertion bounds total work across both.
 *
 * (F5, fixed) Per-bucket failure-window pruning (`recordFailure`) used to
 * rescan the bucket's entire `failures` array with `Array.filter` on every
 * single failure, which is quadratic in the number of failures against one
 * key (measured ~5.3s for 16k failures on one credential ID). Failures now
 * carry a `head` index into the array: expired entries are skipped by
 * advancing `head` past them (O(1) amortized per touch, since each element
 * is skipped at most once) rather than rebuilding the array; the backing
 * array is compacted (spliced down to just the live tail) only once `head`
 * exceeds half its length, keeping total memory bounded without paying an
 * O(n) compaction on every touch. This is sound because failure timestamps
 * are appended in non-decreasing order per the injected monotonic clock, so
 * "expired" is always a contiguous prefix.
 */

export interface RateLimitClock {
  nowMs(): number;
}

export const systemRateLimitClock: RateLimitClock = {
  nowMs: () => Date.now(),
};

const WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes
const CREDENTIAL_THRESHOLD = 5;
const ADDRESS_THRESHOLD = 20;

/**
 * (F4) Upper bound on the number of distinct credential-ID buckets held at
 * once. Well-formed credential IDs (canonical UUIDs) are still unbounded in
 * principle — unlike the malformed-token case M2 already handles, a flood
 * of DISTINCT real UUIDs each making one failed attempt would otherwise
 * grow this map forever. When insertion would exceed the cap, eviction
 * runs: first sweep buckets whose failure window has fully expired AND
 * whose lockout (if any) has expired, freeing space at zero cost to any
 * caller; if that alone doesn't free a slot, evict the oldest
 * (least-recently-touched) bucket that is NOT currently locked out. A
 * locked-out bucket is NEVER evicted before its lockout expires — evicting
 * it would let an attacker who just tripped a lockout immediately clear it
 * by flooding fresh distinct credential IDs, which would defeat the
 * lockout entirely.
 */
const MAX_CREDENTIAL_BUCKETS = 50_000;

/**
 * (M1) Upper bound on the number of distinct address buckets held at once,
 * mirroring MAX_CREDENTIAL_BUCKETS's rationale exactly: a flood of distinct
 * source addresses (e.g. many /64 IPv6 prefixes, or a large legitimate
 * fleet) would otherwise grow this map forever. Same eviction algorithm as
 * the credential map (see `evictAddressBuckets`).
 */
const MAX_ADDRESS_BUCKETS = 50_000;

const CANONICAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Bucket {
  /**
   * Failure timestamps (ms, ascending/non-decreasing — the injected clock
   * is monotonic). Entries before `head` are logically expired/pruned but
   * may still physically occupy the array until the next compaction (F5) —
   * always read failure count as `failures.length - head`, never
   * `failures.length`.
   */
  failures: number[];
  /** Index of the first non-expired entry in `failures` (F5 amortized prune). */
  head: number;
  /** If set, a lockout is active until this timestamp (ms). */
  lockedUntil: number | null;
}

function newBucket(): Bucket {
  return { failures: [], head: 0, lockedUntil: null };
}

/** Live failure count for a bucket, accounting for the F5 head index. */
function liveFailureCount(bucket: Bucket): number {
  return bucket.failures.length - bucket.head;
}

/**
 * Normalize a credential ID for bucketing. Only a canonical lowercase UUID
 * is a "well-formed" credential ID that may enter the bounded credential
 * bucket map; anything else returns null (caller must NOT create a bucket
 * for it — M2).
 */
export function normalizeCredentialId(rawCredentialId: string): string | null {
  return CANONICAL_UUID_RE.test(rawCredentialId) ? rawCredentialId : null;
}

/**
 * Normalize a remote address for bucketing: IPv4 uses the host address
 * as-is; IPv6 uses its /64 prefix (the first four hextets, zero-expanded).
 * Returns null if the address cannot be parsed as IPv4 or IPv6 (caller
 * should treat this defensively — see `isLoopback` note below — but in
 * practice the transport layer always supplies a parseable address).
 */
export function normalizeAddress(rawAddress: string): string | null {
  const addr = rawAddress.trim();

  // IPv4 (possibly ::ffff:-mapped from a dual-stack socket; unwrap that).
  const v4Mapped = addr.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  const v4Candidate = v4Mapped ? v4Mapped[1]! : addr;
  if (isIPv4(v4Candidate)) {
    return v4Candidate;
  }

  if (addr.includes(':')) {
    const prefix = ipv6Slash64Prefix(addr);
    return prefix;
  }

  return null;
}

function isIPv4(addr: string): boolean {
  const parts = addr.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
}

/**
 * Expand an IPv6 address to its 8 hextets and return the /64 prefix (first
 * 4 hextets) joined with ':'. Handles "::" compression.
 */
function ipv6Slash64Prefix(addr: string): string | null {
  // Strip zone index if present (fe80::1%eth0).
  const zoneIdx = addr.indexOf('%');
  const base = zoneIdx >= 0 ? addr.slice(0, zoneIdx) : addr;

  let head: string[];
  let tail: string[];
  if (base.includes('::')) {
    const [h, t] = base.split('::');
    head = h ? h.split(':') : [];
    tail = t ? t.split(':') : [];
  } else {
    head = base.split(':');
    tail = [];
  }

  const missing = 8 - (head.length + tail.length);
  if (missing < 0) {
    return null;
  }
  const hextets = [...head, ...Array(missing).fill('0'), ...tail];
  if (hextets.length !== 8) {
    return null;
  }
  for (const h of hextets) {
    if (!/^[0-9a-fA-F]{0,4}$/.test(h)) {
      return null;
    }
  }
  const normalized = hextets.map((h) => (h === '' ? '0' : parseInt(h, 16).toString(16)));
  return normalized.slice(0, 4).join(':');
}

/**
 * True when `rawAddress` is a loopback address (IPv4 127.0.0.0/8, or IPv6
 * ::1). Loopback is exempt from the ADDRESS counter only; the
 * per-credential-ID counter still applies (Section 6.2).
 */
export function isLoopbackAddress(rawAddress: string): boolean {
  const addr = rawAddress.trim();
  const v4Mapped = addr.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  const v4Candidate = v4Mapped ? v4Mapped[1]! : addr;
  if (isIPv4(v4Candidate)) {
    return v4Candidate.startsWith('127.');
  }
  return addr === '::1';
}

// ---------------------------------------------------------------------------
// Limiter
// ---------------------------------------------------------------------------

export type AuthAttemptOutcome = 'success' | 'failure';

export interface CheckResult {
  /** True when the caller is currently locked out (report as AUTH_FAILED). */
  lockedOut: boolean;
}

/**
 * In-memory rolling-window rate limiter for authentication attempts.
 * Restart resets all state by design (Section 6.2) — this class holds no
 * persistent storage and none should be added.
 */
export class AuthRateLimiter {
  private readonly credentialBuckets = new Map<string, Bucket>();
  private readonly addressBuckets = new Map<string, Bucket>();
  private readonly clock: RateLimitClock;

  /** (NEW-1) Timestamp of the last full Phase-1 sweep, or null if none has run yet. */
  private lastSweepMs: number | null = null;

  /** (M1) Timestamp of the last full address-bucket Phase-1 sweep, independent of the credential map's throttle. */
  private lastAddressSweepMs: number | null = null;

  /**
   * (NEW-1 / F5 cost-regression instrumentation) Count of buckets visited
   * during Phase-1 sweeps plus per-failure prune-advance steps. This is an
   * operation counter, not a timer — deterministic, no wall-clock flake —
   * exported so fixtures can assert an amortized-cost bound directly
   * instead of inferring it from timing.
   */
  private _bucketVisitCount = 0;

  constructor(clock: RateLimitClock = systemRateLimitClock) {
    this.clock = clock;
  }

  /** Number of distinct credential-ID buckets currently tracked (bounded-map assertion helper). */
  get credentialBucketCount(): number {
    return this.credentialBuckets.size;
  }

  /** Number of distinct address buckets currently tracked. */
  get addressBucketCount(): number {
    return this.addressBuckets.size;
  }

  /**
   * Cumulative count of bucket visits performed by Phase-1 sweeps
   * (`evictCredentialBuckets`) and by amortized failure-window pruning
   * (`recordFailure`'s head-advance). Monotonically increasing; intended
   * for cost-regression fixtures (NEW-1, F5) that assert a bound on total
   * work rather than on wall-clock time.
   */
  get bucketVisitCount(): number {
    return this._bucketVisitCount;
  }

  /**
   * Check whether an attempt from `rawCredentialId` (nullable — a parse
   * failure means "no credential bucket applies", per M2) and
   * `rawAddress` is currently locked out. Call BEFORE processing the
   * attempt.
   */
  check(rawCredentialId: string | null, rawAddress: string): CheckResult {
    const now = this.clock.nowMs();
    let lockedOut = false;

    const normalizedCredentialId = rawCredentialId === null ? null : normalizeCredentialId(rawCredentialId);
    if (normalizedCredentialId !== null) {
      const bucket = this.credentialBuckets.get(normalizedCredentialId);
      if (bucket && this.isLockedOut(bucket, now)) {
        lockedOut = true;
      }
    }

    if (!isLoopbackAddress(rawAddress)) {
      const normalizedAddress = normalizeAddress(rawAddress);
      if (normalizedAddress !== null) {
        const bucket = this.addressBuckets.get(normalizedAddress);
        if (bucket && this.isLockedOut(bucket, now)) {
          lockedOut = true;
        }
      }
    }

    return { lockedOut };
  }

  /**
   * Record the outcome of an authentication attempt. On failure, this may
   * cross a threshold and start a 15-minute lockout.
   *
   * `rawCredentialId` is null when the presented token failed to parse
   * (M2): in that case, ONLY the address bucket is updated, never a
   * credential bucket — this is what keeps the credential-bucket map
   * bounded to well-formed credential IDs only.
   */
  recordAttempt(rawCredentialId: string | null, rawAddress: string, outcome: AuthAttemptOutcome): void {
    if (outcome === 'success') {
      // Successes do not reset or grow failure buckets in this design;
      // Section 6.2 defines only failure-counted windows and a
      // failure-triggered lockout. (No PRD requirement to clear on
      // success; restart is the sole reset mechanism.)
      return;
    }

    const now = this.clock.nowMs();

    const normalizedCredentialId = rawCredentialId === null ? null : normalizeCredentialId(rawCredentialId);
    if (normalizedCredentialId !== null) {
      const bucket = this.getOrCreateCredentialBucket(normalizedCredentialId, now);
      this.recordFailure(bucket, now, CREDENTIAL_THRESHOLD);
    }
    // else: unparseable/malformed credential ID — no credential bucket is
    // created or touched (M2's bounded-map guarantee).

    if (!isLoopbackAddress(rawAddress)) {
      const normalizedAddress = normalizeAddress(rawAddress);
      if (normalizedAddress !== null) {
        const bucket = this.getOrCreateAddressBucket(normalizedAddress, now);
        this.recordFailure(bucket, now, ADDRESS_THRESHOLD);
      }
    }
  }

  /**
   * (F4) Credential-bucket-specific get-or-create that enforces
   * MAX_CREDENTIAL_BUCKETS. `map.set` on an existing key does not reorder
   * a `Map`'s iteration position, so every touch (get-or-create) explicitly
   * deletes-then-reinserts the key to keep iteration order equal to
   * least-recently-touched-first — the ordering the eviction sweep below
   * relies on to find "oldest" without a separate timestamp index.
   */
  private getOrCreateCredentialBucket(key: string, now: number): Bucket {
    const existing = this.credentialBuckets.get(key);
    if (existing) {
      this.credentialBuckets.delete(key);
      this.credentialBuckets.set(key, existing);
      return existing;
    }

    if (this.credentialBuckets.size >= MAX_CREDENTIAL_BUCKETS) {
      this.evictCredentialBuckets(now);
    }

    const bucket = newBucket();
    this.credentialBuckets.set(key, bucket);
    return bucket;
  }

  /**
   * (F4, throttled per NEW-1) Free at least one slot in `credentialBuckets`,
   * called only when the map is at (or above) capacity and a new key is
   * about to be inserted. Two-phase, in order:
   *   1. Sweep (THROTTLED): drop every bucket whose rolling failure window
   *      has fully expired (no live failure timestamps within WINDOW_MS of
   *      `now`) AND whose lockout (if any) has already expired. This full
   *      O(n) scan runs at most once per `WINDOW_MS` — tracked via
   *      `lastSweepMs` — rather than on every insertion. Running it more
   *      often than the window itself is pointless (no bucket can newly
   *      expire faster than the window elapses) and was the source of
   *      NEW-1: at capacity, every insertion paid a full 50,000-bucket scan
   *      (measured 4.11 ms/attempt, 137x slower than below-capacity,
   *      ~70s of blocked event loop across a 60k-attempt flood). Skipping
   *      the sweep between throttle windows is safe because Phase 2 alone
   *      already holds the cap (see below) — the sweep only exists to
   *      reclaim space cheaply, not to enforce the bound.
   *   2. If still at (or, because the sweep was skipped, still above)
   *      capacity, evict the single oldest (least-recently-touched — first
   *      in iteration order, see `getOrCreateCredentialBucket`) bucket that
   *      is NOT currently locked out. Locked-out buckets are skipped and
   *      never evicted while their lockout is active, even if they are the
   *      very oldest entry — this is the invariant the fixture "a
   *      locked-out ID inserted early still rejects after the flood"
   *      asserts. This step is O(1) amortized: Map iteration order is
   *      least-recently-touched-first, and eviction of any given key
   *      happens at most once, so the total work across N insertions is
   *      bounded by N regardless of whether the sweep ran.
   */
  private evictCredentialBuckets(now: number): void {
    const sweepDue = this.lastSweepMs === null || now - this.lastSweepMs >= WINDOW_MS;

    if (sweepDue) {
      const windowStart = now - WINDOW_MS;
      for (const [key, bucket] of this.credentialBuckets) {
        this._bucketVisitCount++;
        const hasLiveFailures = liveFailureCount(bucket) > 0 && bucket.failures[bucket.failures.length - 1]! > windowStart;
        const isLocked = bucket.lockedUntil !== null && now < bucket.lockedUntil;
        if (!hasLiveFailures && !isLocked) {
          this.credentialBuckets.delete(key);
        }
      }
      this.lastSweepMs = now;
    }

    if (this.credentialBuckets.size < MAX_CREDENTIAL_BUCKETS) {
      return;
    }

    // Phase 2: evict the oldest non-locked-out bucket. Map iteration order
    // is least-recently-touched-first (maintained by
    // getOrCreateCredentialBucket's delete+set-on-touch), so the first
    // non-locked-out entry encountered is the correct victim.
    for (const [key, bucket] of this.credentialBuckets) {
      this._bucketVisitCount++;
      const isLocked = bucket.lockedUntil !== null && now < bucket.lockedUntil;
      if (!isLocked) {
        this.credentialBuckets.delete(key);
        return;
      }
    }
    // Every remaining bucket is locked out: the map is allowed to exceed
    // the nominal cap in this (bounded-by-threshold-effort) scenario rather
    // than ever evict a live lockout. In practice this requires
    // MAX_CREDENTIAL_BUCKETS distinct credential IDs to simultaneously hold
    // an active 15-minute lockout, which is itself already bounded by the
    // 5-failure threshold per ID.
  }

  /**
   * (M1) Address-bucket-specific get-or-create, mirroring
   * `getOrCreateCredentialBucket` exactly: same delete-then-reinsert-on-touch
   * discipline (keeps Map iteration order least-recently-touched-first for
   * the LRU eviction phase), same MAX_ADDRESS_BUCKETS enforcement.
   */
  private getOrCreateAddressBucket(key: string, now: number): Bucket {
    const existing = this.addressBuckets.get(key);
    if (existing) {
      this.addressBuckets.delete(key);
      this.addressBuckets.set(key, existing);
      return existing;
    }

    if (this.addressBuckets.size >= MAX_ADDRESS_BUCKETS) {
      this.evictAddressBuckets(now);
    }

    const bucket = newBucket();
    this.addressBuckets.set(key, bucket);
    return bucket;
  }

  /**
   * (M1) Free at least one slot in `addressBuckets`, mirroring
   * `evictCredentialBuckets`'s two-phase algorithm and throttled-sweep
   * rationale exactly, against its own independent `lastAddressSweepMs`
   * throttle (so a credential-bucket flood and an address-bucket flood
   * never contend for the same throttle window). A locked-out address
   * bucket is never evicted before its lockout expires.
   */
  private evictAddressBuckets(now: number): void {
    const sweepDue = this.lastAddressSweepMs === null || now - this.lastAddressSweepMs >= WINDOW_MS;

    if (sweepDue) {
      const windowStart = now - WINDOW_MS;
      for (const [key, bucket] of this.addressBuckets) {
        this._bucketVisitCount++;
        const hasLiveFailures = liveFailureCount(bucket) > 0 && bucket.failures[bucket.failures.length - 1]! > windowStart;
        const isLocked = bucket.lockedUntil !== null && now < bucket.lockedUntil;
        if (!hasLiveFailures && !isLocked) {
          this.addressBuckets.delete(key);
        }
      }
      this.lastAddressSweepMs = now;
    }

    if (this.addressBuckets.size < MAX_ADDRESS_BUCKETS) {
      return;
    }

    for (const [key, bucket] of this.addressBuckets) {
      this._bucketVisitCount++;
      const isLocked = bucket.lockedUntil !== null && now < bucket.lockedUntil;
      if (!isLocked) {
        this.addressBuckets.delete(key);
        return;
      }
    }
    // Every remaining address bucket is locked out: allowed to exceed the
    // nominal cap rather than ever evict a live lockout, mirroring the
    // credential map's identical final-fallback comment above.
  }

  private isLockedOut(bucket: Bucket, now: number): boolean {
    return bucket.lockedUntil !== null && now < bucket.lockedUntil;
  }

  /**
   * (F5, amortized) Prune failures outside the rolling window and append
   * `now`. Timestamps arrive in non-decreasing order (the injected clock is
   * monotonic per caller), so every expired entry is a contiguous prefix of
   * `failures` — pruning is therefore "advance `head` past expired
   * entries," never a full-array rebuild. Each element is visited by this
   * advance at most once across its lifetime (once skipped, `head` never
   * moves backward), so total head-advance work across N failures on one
   * bucket is O(N), not O(N^2) like the old `Array.filter` rescan (which
   * rescanned the full live suffix on every single failure — ~5.3s for 16k
   * failures on one key). The backing array is compacted — spliced down to
   * just `failures.slice(head)` — only once `head` exceeds half the
   * array's length, so memory doesn't grow unboundedly while compaction
   * itself stays amortized O(1) per element.
   */
  private recordFailure(bucket: Bucket, now: number, threshold: number): void {
    const windowStart = now - WINDOW_MS;
    while (bucket.head < bucket.failures.length && bucket.failures[bucket.head]! <= windowStart) {
      bucket.head++;
      this._bucketVisitCount++;
    }
    if (bucket.head > bucket.failures.length / 2) {
      bucket.failures = bucket.failures.slice(bucket.head);
      bucket.head = 0;
    }
    bucket.failures.push(now);

    if (bucket.lockedUntil !== null && now >= bucket.lockedUntil) {
      bucket.lockedUntil = null;
    }

    if (liveFailureCount(bucket) >= threshold) {
      bucket.lockedUntil = now + LOCKOUT_MS;
    }
  }
}
