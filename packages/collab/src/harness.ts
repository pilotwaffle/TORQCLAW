/**
 * Determinism harness for Collaboration Substrate fixtures.
 * Provides monotonic clock and deterministic UUID generation.
 */

/**
 * Deterministic clock: starts at 2026-01-01T00:00:00.000Z
 * Each next() returns RFC 3339 UTC millisecond timestamp, advanced exactly 1 ms.
 */
export class DeterministicClock {
  private currentMs: number;

  constructor() {
    // 2026-01-01T00:00:00.000Z in milliseconds since epoch
    this.currentMs = new Date('2026-01-01T00:00:00.000Z').getTime();
  }

  /**
   * Returns current timestamp as RFC 3339 UTC string with milliseconds.
   * Advances internal state by exactly 1 ms for next call.
   */
  next(): string {
    const timestamp = new Date(this.currentMs).toISOString();
    this.currentMs += 1;
    return timestamp;
  }
}

/**
 * Deterministic UUID generator using seeded PRNG.
 * Same seed produces identical sequence across implementations.
 *
 * Implements FNV-1a 64-bit hash for seed derivation.
 * Uses PCG-style state advancement with 64-bit state (two 32-bit registers).
 * PRNG state is carried across next() calls.
 * All 128 UUID bits are drawn from advancing PRNG state.
 */
export class DeterministicUuids {
  // 64-bit state stored as two 32-bit unsigned values
  private state: bigint;

  /**
   * Initialize with a fixture identifier string.
   * The seed is derived using FNV-1a 64-bit hash over UTF-8 bytes.
   */
  constructor(fixtureIdentifier: string) {
    // FNV-1a 64-bit hash of the fixture identifier
    const hash = fnv1a64(fixtureIdentifier);
    this.state = hash;

    // Ensure state is non-zero
    if (this.state === 0n) {
      this.state = 1n;
    }
  }

  /**
   * Returns next deterministic UUID in canonical lowercase form.
   * Advances PRNG state and draws all 128 bits from state progression.
   */
  next(): string {
    // Generate four 32-bit unsigned values using PCG-style output
    const vals: number[] = [];
    for (let i = 0; i < 4; i++) {
      // Advance state: state = state * M + C (LCG step)
      // Using constants from Numerical Recipes
      this.state = ((this.state * 6364136223846793005n) + 1442695040888963407n) & ((1n << 64n) - 1n);

      // PCG output function: permute state to get output
      const xorshifted = ((this.state >> 18n) ^ this.state) >> 27n;
      const rot = this.state >> 59n;
      const value = ((Number(xorshifted) >>> 0) >>> Number(rot)) | ((Number(xorshifted) >>> 0) << (32 - Number(rot)));
      vals.push(value >>> 0);
    }

    // Build UUID: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    // Stamp version 4 in the 13th hex position (bit 12-15 of 3rd 16-bit word)
    // Stamp variant 8-b in the 17th hex position (bit 6-7 of 4th 16-bit word)

    const part1 = (vals[0]! >>> 0).toString(16).padStart(8, '0');
    const part2 = ((vals[1]! >>> 16) & 0xffff).toString(16).padStart(4, '0');
    const part3 = ((vals[1]! & 0x0fff) | 0x4000).toString(16).padStart(4, '0'); // Version 4
    const part4 = (((vals[2]! >>> 16) & 0x3fff) | 0x8000).toString(16).padStart(4, '0'); // Variant 10
    const part5 = ((vals[2]! & 0xffff).toString(16).padStart(4, '0') + vals[3]!.toString(16).padStart(8, '0')).slice(-12);

    const uuid = `${part1}-${part2}-${part3}-${part4}-${part5}`;
    return uuid;
  }
}

/**
 * FNV-1a 64-bit hash of a string (UTF-8 encoded).
 * Used for seed derivation.
 */
function fnv1a64(input: string): bigint {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(input);

  // FNV-1a 64-bit parameters (as BigInt)
  const fnvPrime = 1099511628211n;
  const fnvOffset = 14695981039346656037n;

  let hash = fnvOffset;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * fnvPrime) & ((1n << 64n) - 1n); // Keep 64-bit
  }

  return hash;
}
