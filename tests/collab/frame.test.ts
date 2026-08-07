import { describe, it, expect } from 'vitest';
import { parseFrame, isCanonicalUuid } from '../../packages/collab/src/frame.js';

/**
 * Seeded PRNG for deterministic fuzz testing.
 * Ensures reproducible randomness without Math.random().
 */
class SeededPRNG {
  private seed: number;

  constructor(seed: number) {
    this.seed = (seed ^ 61) ^ (seed >> 16);
  }

  next(): number {
    this.seed = (this.seed * 0x27d4eb2d + 1) >>> 0;
    return (this.seed >>> 16) / 65536;
  }

  nextInt(max: number): number {
    return Math.floor(this.next() * max);
  }
}

/**
 * Generate a random JSON value for fuzz testing.
 */
// Escape-heavy palette so the fuzz corpus exercises the string scanner:
// backslashes, quotes, control shorthands, non-ASCII, combining marks, astral.
const FUZZ_CHARS = [
  'a', 'z', '0', ':', ',', '{', '}', '[', ']', ' ',
  '\\', '"', '\n', '\t', '\r', '/', "'",
  'é', 'ß', '漢', '́', 'é', '🙂', ' ', ' ',
];

function randomFuzzString(prng: SeededPRNG): string {
  const len = prng.nextInt(9);
  let s = '';
  for (let i = 0; i < len; i++) {
    s += FUZZ_CHARS[prng.nextInt(FUZZ_CHARS.length)];
  }
  return s;
}

function generateRandomValue(prng: SeededPRNG, depth: number = 0): unknown {
  const maxDepth = 3;
  if (depth >= maxDepth) {
    // Leaf: scalar value
    const typeChoice = prng.nextInt(5);
    switch (typeChoice) {
      case 0:
        return prng.next() > 0.5 ? true : false;
      case 1:
        return null;
      case 2:
        return prng.nextInt(1000) - 500;
      case 3:
        return randomFuzzString(prng);
      case 4:
        return prng.next();
    }
  }

  // Interior: object or array
  if (prng.next() > 0.3) {
    // Object
    const obj: Record<string, unknown> = {};
    const numFields = prng.nextInt(4) + 1;
    for (let i = 0; i < numFields; i++) {
      // Index prefix guarantees uniqueness; suffix exercises escapes in keys.
      const key = `f${i}_${randomFuzzString(prng)}`;
      obj[key] = generateRandomValue(prng, depth + 1);
    }
    return obj;
  } else {
    // Array
    const arr: unknown[] = [];
    const numItems = prng.nextInt(3) + 1;
    for (let i = 0; i < numItems; i++) {
      arr.push(generateRandomValue(prng, depth + 1));
    }
    return arr;
  }
}

/**
 * Generate a random frame (must be an object with type field) for fuzz testing.
 */
function generateRandomFrame(prng: SeededPRNG): object {
  const obj: Record<string, unknown> = { type: 'fuzz' };
  const numFields = prng.nextInt(3) + 1;
  for (let i = 0; i < numFields; i++) {
    const key = `field_${i}`;
    obj[key] = generateRandomValue(prng, 0);
  }
  return obj;
}

describe('Frame Validation', () => {
  describe('parseFrame', () => {
    it('accepts valid frame', () => {
      const frame = { type: 'command', requestId: 'test-id' };
      const bytes = Buffer.from(JSON.stringify(frame), 'utf-8');
      const result = parseFrame(bytes);

      expect(result).toEqual(frame);
    });

    it('rejects frame exceeding 65,536 bytes', () => {
      // Create a frame that exceeds the limit
      const largeObj = { type: 'test', data: 'x'.repeat(70000) };
      const bytes = Buffer.from(JSON.stringify(largeObj), 'utf-8');

      const result = parseFrame(bytes);
      expect(result).toHaveProperty('type', 'INVALID_FRAME');
      expect(result).toHaveProperty('message');
    });

    it('killer pair: accepts a frame of exactly 65,536 bytes and rejects 65,537', () => {
      // Build the frame with ASCII padding so byte length equals string length,
      // then assert the real byte counts so the pins cannot silently drift.
      const overhead = Buffer.byteLength('{"type":"t","pad":""}', 'utf-8');
      const atLimit = `{"type":"t","pad":"${'x'.repeat(65536 - overhead)}"}`;
      const atLimitBytes = Buffer.from(atLimit, 'utf-8');
      expect(atLimitBytes.length).toBe(65536);
      const accepted = parseFrame(atLimitBytes);
      expect(accepted).not.toHaveProperty('type', 'INVALID_FRAME');
      expect(accepted).toHaveProperty('type', 't');

      const overLimit = `{"type":"t","pad":"${'x'.repeat(65537 - overhead)}"}`;
      const overLimitBytes = Buffer.from(overLimit, 'utf-8');
      expect(overLimitBytes.length).toBe(65537);
      const rejected = parseFrame(overLimitBytes);
      expect(rejected).toHaveProperty('type', 'INVALID_FRAME');
    });

    it('rejects frame with duplicate keys', () => {
      // Manually create JSON with duplicate keys
      // JSON.stringify won't do this, so we construct the string directly
      const json = '{"type":"test","key":"value1","key":"value2"}';
      const bytes = Buffer.from(json, 'utf-8');

      const result = parseFrame(bytes);
      expect(result).toHaveProperty('type', 'INVALID_FRAME');
      if (typeof result !== 'string' && 'message' in result) {
        expect(result.message).toMatch(/duplicate|key/i);
      }
    });

    it('accepts string ending with escaped backslash: {"type":"a","s":"ends\\\\"}', () => {
      // String value is: ends\ (backslash at end)
      // After the closing quote of the string, there is a final quote to close the object
      // This tests escape-parity tracking: the quote before the final } should close the string
      const json = '{"type":"a","s":"ends\\\\"}';
      const bytes = Buffer.from(json, 'utf-8');

      const result = parseFrame(bytes);
      // Should be accepted (not an INVALID_FRAME for duplicate keys)
      expect(result).not.toHaveProperty('type', 'INVALID_FRAME');
      if (typeof result === 'object' && result !== null) {
        expect(result.type).toBe('a');
        expect((result as any).s).toBe('ends\\');
      }
    });

    it('rejects frame with escaped-quote duplicate keys: {"a\\"b":1,"a\\"b":2}', () => {
      // Two keys: a"b (contains escaped quote)
      // The scanner must handle escape parity to detect these as duplicates
      const json = '{"a\\"b":1,"a\\"b":2}';
      const bytes = Buffer.from(json, 'utf-8');

      const result = parseFrame(bytes);
      expect(result).toHaveProperty('type', 'INVALID_FRAME');
      if (typeof result !== 'string' && 'message' in result) {
        expect(result.message).toMatch(/duplicate|key/i);
      }
    });

    it('fuzz test: ≥2,000 random frames via JSON.stringify (0% false positives)', () => {
      const prng = new SeededPRNG(12345); // Deterministic seed
      const numFrames = 2000;

      for (let i = 0; i < numFrames; i++) {
        const obj = generateRandomFrame(prng);
        const json = JSON.stringify(obj);
        const bytes = Buffer.from(json, 'utf-8');

        // All frames produced by JSON.stringify should be valid
        const result = parseFrame(bytes);

        // Should not produce INVALID_FRAME errors
        expect(result).not.toHaveProperty('type', 'INVALID_FRAME');
        if (typeof result === 'object' && result !== null) {
          // Result should be an object
          expect(typeof result.type).toBe('string');
        }
      }
    });

    it('rejects non-finite number 9e308 -> Infinity', () => {
      const json = '{"type":"test","value":9e308}';
      const bytes = Buffer.from(json, 'utf-8');
      const result = parseFrame(bytes);
      expect(result).toHaveProperty('type', 'INVALID_FRAME');
    });

    it('rejects non-finite number 2e308 -> Infinity', () => {
      const json = '{"type":"test","value":2e308}';
      const bytes = Buffer.from(json, 'utf-8');
      const result = parseFrame(bytes);
      expect(result).toHaveProperty('type', 'INVALID_FRAME');
    });

    it('rejects very large exponent (1 + 400 zeros)', () => {
      // 1 followed by 400 zeros is equivalent to 1e400, which parses to Infinity
      const json = '{"type":"test","value":1' + '0'.repeat(400) + '}';
      const bytes = Buffer.from(json, 'utf-8');
      const result = parseFrame(bytes);
      expect(result).toHaveProperty('type', 'INVALID_FRAME');
    });

    it('accepts finite number 1e308', () => {
      const json = '{"type":"test","value":1e308}';
      const bytes = Buffer.from(json, 'utf-8');
      const result = parseFrame(bytes);
      expect(result).not.toHaveProperty('type', 'INVALID_FRAME');
    });

    it('accepts finite number -1e308', () => {
      const json = '{"type":"test","value":-1e308}';
      const bytes = Buffer.from(json, 'utf-8');
      const result = parseFrame(bytes);
      expect(result).not.toHaveProperty('type', 'INVALID_FRAME');
    });

    it('accepts finite number 1e-320', () => {
      const json = '{"type":"test","value":1e-320}';
      const bytes = Buffer.from(json, 'utf-8');
      const result = parseFrame(bytes);
      expect(result).not.toHaveProperty('type', 'INVALID_FRAME');
    });

    it('accepts zero', () => {
      const json = '{"type":"test","value":0}';
      const bytes = Buffer.from(json, 'utf-8');
      const result = parseFrame(bytes);
      expect(result).not.toHaveProperty('type', 'INVALID_FRAME');
    });

    it('rejects invalid UTF-8', () => {
      const bytes = Buffer.from([0xff, 0xfe, 0xfd]);
      const result = parseFrame(bytes);

      expect(result).toHaveProperty('type', 'INVALID_FRAME');
      expect(result).toHaveProperty('message');
    });

    it('returns parsed frame with all fields', () => {
      const frame = {
        type: 'command',
        requestId: '550e8400-e29b-41d4-a716-446655440000',
        command: 'TEST_COMMAND',
        body: { test: true },
      };
      const bytes = Buffer.from(JSON.stringify(frame), 'utf-8');
      const result = parseFrame(bytes);

      expect(result).toEqual(frame);
    });

    it('handles nested objects', () => {
      const frame = {
        type: 'command',
        nested: {
          deep: {
            value: 'test',
          },
        },
      };
      const bytes = Buffer.from(JSON.stringify(frame), 'utf-8');
      const result = parseFrame(bytes);

      expect(result).toEqual(frame);
    });

    it('handles arrays in frame', () => {
      const frame = {
        type: 'result',
        items: [1, 2, 3],
        names: ['a', 'b', 'c'],
      };
      const bytes = Buffer.from(JSON.stringify(frame), 'utf-8');
      const result = parseFrame(bytes);

      expect(result).toEqual(frame);
    });

    it('rejects frame without type field', () => {
      const frame = { requestId: 'test' };
      const bytes = Buffer.from(JSON.stringify(frame), 'utf-8');
      const result = parseFrame(bytes);

      expect(result).toHaveProperty('type', 'INVALID_REQUEST');
    });

    it('rejects frame that is an array', () => {
      const bytes = Buffer.from('["not","an","object"]', 'utf-8');
      const result = parseFrame(bytes);

      expect(result).toHaveProperty('type', 'INVALID_FRAME');
    });
  });

  describe('isCanonicalUuid', () => {
    it('accepts valid lowercase UUID', () => {
      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      expect(isCanonicalUuid(uuid)).toBe(true);
    });

    it('rejects uppercase UUID', () => {
      const uuid = '550E8400-E29B-41D4-A716-446655440000';
      expect(isCanonicalUuid(uuid)).toBe(false);
    });

    it('rejects mixed case UUID', () => {
      const uuid = '550e8400-E29b-41d4-a716-446655440000';
      expect(isCanonicalUuid(uuid)).toBe(false);
    });

    it('rejects malformed UUID (wrong format)', () => {
      expect(isCanonicalUuid('550e8400-e29b-41d4-a716')).toBe(false);
      expect(isCanonicalUuid('550e8400e29b41d4a716446655440000')).toBe(false);
      expect(isCanonicalUuid('not-a-uuid')).toBe(false);
    });

    it('rejects non-hex characters', () => {
      const uuid = '550e8400-e29b-41d4-a716-44665544000g';
      expect(isCanonicalUuid(uuid)).toBe(false);
    });

    it('accepts all zeros UUID', () => {
      expect(isCanonicalUuid('00000000-0000-0000-0000-000000000000')).toBe(true);
    });

    it('accepts all f UUID', () => {
      expect(isCanonicalUuid('ffffffff-ffff-ffff-ffff-ffffffffffff')).toBe(true);
    });
  });
});
