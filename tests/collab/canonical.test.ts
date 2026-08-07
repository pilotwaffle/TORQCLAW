import { describe, it, expect } from 'vitest';
import { canonicalJson } from '../../packages/collab/src/canonical.js';

describe('canonicalJson', () => {
  it('serializes primitives', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(false)).toBe('false');
    expect(canonicalJson(0)).toBe('0');
    expect(canonicalJson(-0)).toBe('0');
    expect(canonicalJson(1.5)).toBe('1.5');
    expect(canonicalJson('hello')).toBe('"hello"');
  });

  it('sorts object keys by code point, not insertion order', () => {
    const obj = { b: 1, a: 2, c: 3 };
    expect(canonicalJson(obj)).toBe('{"a":2,"b":1,"c":3}');
  });

  it('is deterministic regardless of input key order', () => {
    const obj1 = { z: 1, a: 2, m: 3 };
    const obj2 = { a: 2, m: 3, z: 1 };
    expect(canonicalJson(obj1)).toBe(canonicalJson(obj2));
  });

  it('serializes arrays preserving element order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson(['b', 'a'])).toBe('["b","a"]');
  });

  it('serializes nested structures', () => {
    const value = { z: [1, { d: 4, c: 3 }], a: 'x' };
    expect(canonicalJson(value)).toBe('{"a":"x","z":[1,{"c":3,"d":4}]}');
  });

  // --- Byte-fixture: keys spanning BMP and astral plane, proving code
  // point sort order (G1R H2). ---
  it('sorts BMP-vs-astral keys by code point order (byte fixture)', () => {
    // U+E000 (private-use, BMP) vs U+10000 (LINEAR B SYLLABLE B008 A, astral).
    // By UTF-16 code UNIT order, U+10000's lead surrogate 0xD800 < 0xE000,
    // so a naive .sort() would place the astral key FIRST.
    // By code POINT order, 0xE000 < 0x10000, so the BMP key must sort FIRST.
    const bmpKey = '\uE000';
    const astralKey = String.fromCodePoint(0x10000);

    // Sanity: confirm the UTF-16 code-unit-order trap actually exists for
    // this pair, so the fixture is proving something real.
    expect(bmpKey < astralKey).toBe(false); // naive comparison: astral first (wrong)

    const obj = { [astralKey]: 'astral', [bmpKey]: 'bmp' };
    const result = canonicalJson(obj);
    // Correct code-point order: bmpKey (U+E000) before astralKey (U+10000).
    expect(result).toBe(`{${JSON.stringify(bmpKey)}:"bmp",${JSON.stringify(astralKey)}:"astral"}`);

    // Explicit byte assertion (defends against key-order regressions).
    // U+E000 is a private-use character, not a control character, so JSON
    // leaves it unescaped literally in the output, per the pinned "no
    // unnecessary escaping" rule.
    expect(result).toBe('{"":"bmp","𐀀":"astral"}');
  });

  it('sorts a mix of ASCII, BMP-high, and multiple astral keys by code point', () => {
    const keys = [
      String.fromCodePoint(0x1f600), // astral, emoji
      'a', // ASCII
      '\uFFFD', // BMP replacement character
      String.fromCodePoint(0x10000), // smallest astral
      'A', // ASCII uppercase, code point 0x41 < 'a' 0x61
    ];
    const obj: Record<string, number> = {};
    keys.forEach((k, i) => (obj[k] = i));
    const result = canonicalJson(obj);
    const parsedKeys = Object.keys(JSON.parse(result));
    // Expected order by code point: 'A' (0x41) < 'a' (0x61) < U+FFFD (0xFFFD)
    // < U+10000 < U+1F600
    expect(parsedKeys).toEqual(['A', 'a', '\uFFFD', String.fromCodePoint(0x10000), String.fromCodePoint(0x1f600)]);
  });

  it('uses standard JSON short escapes', () => {
    expect(canonicalJson('a"b')).toBe('"a\\"b"');
    expect(canonicalJson('a\\b')).toBe('"a\\\\b"');
    expect(canonicalJson('a\nb')).toBe('"a\\nb"');
    expect(canonicalJson('a\tb')).toBe('"a\\tb"');
    expect(canonicalJson('a\rb')).toBe('"a\\rb"');
    expect(canonicalJson('a\bb')).toBe('"a\\bb"');
    expect(canonicalJson('a\fb')).toBe('"a\\fb"');
  });

  it('uses \\uXXXX for other control characters', () => {
    expect(canonicalJson('\x01')).toBe('"\\u0001"');
    expect(canonicalJson('\x1f')).toBe('"\\u001f"');
    expect(canonicalJson('\x00')).toBe('"\\u0000"');
  });

  it('does not escape non-ASCII or U+2028/U+2029', () => {
    expect(canonicalJson('café')).toBe('"café"');
    expect(canonicalJson('\u2028')).toBe('"\u2028"');
    expect(canonicalJson('\u2029')).toBe('"\u2029"');
  });

  it('throws TypeError on undefined', () => {
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
  });

  it('throws TypeError on functions', () => {
    expect(() => canonicalJson(() => {})).toThrow(TypeError);
  });

  it('throws TypeError on non-finite numbers', () => {
    expect(() => canonicalJson(NaN)).toThrow(TypeError);
    expect(() => canonicalJson(Infinity)).toThrow(TypeError);
    expect(() => canonicalJson(-Infinity)).toThrow(TypeError);
  });

  it('throws TypeError on undefined nested in object value (no silent drop)', () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(TypeError);
  });

  it('throws TypeError on undefined nested in array (no silent null coercion)', () => {
    expect(() => canonicalJson([1, undefined, 2])).toThrow(TypeError);
  });

  it('throws TypeError on symbol and bigint', () => {
    expect(() => canonicalJson(Symbol('x'))).toThrow(TypeError);
    expect(() => canonicalJson(1n as unknown)).toThrow(TypeError);
  });

  // --- F6: sparse arrays (holes) throw TypeError instead of silently
  // emitting a shorter, invalid/misleading array. ---
  it('F6: throws TypeError on a sparse array literal with a hole', () => {
    // eslint-disable-next-line no-sparse-arrays
    const sparse = [1, , 3]; // length 3, index 1 is a hole
    expect(sparse.length).toBe(3);
    expect(1 in sparse).toBe(false); // sanity: index 1 really is a hole
    expect(() => canonicalJson(sparse)).toThrow(TypeError);
  });

  it('F6: throws TypeError on new Array(n) (all holes)', () => {
    const sparse = new Array(3);
    expect(sparse.length).toBe(3);
    expect(() => canonicalJson(sparse)).toThrow(TypeError);
  });

  it('F6: throws TypeError on a hole created by delete', () => {
    const arr = [1, 2, 3];
    delete arr[1];
    expect(() => canonicalJson(arr)).toThrow(TypeError);
  });

  it('F6: a dense array with an explicit undefined element still throws (unchanged prior behavior)', () => {
    expect(() => canonicalJson([1, undefined, 3])).toThrow(TypeError);
  });

  it('F6: a fully dense array with no holes still serializes normally', () => {
    expect(canonicalJson([1, 2, 3])).toBe('[1,2,3]');
  });

  it('is stable across repeated calls (no engine key-order reliance)', () => {
    const value: Record<string, number> = { \u00e9: 1, e: 2, z: 3, a: 4 };
    const first = canonicalJson(value);
    const second = canonicalJson(value);
    expect(first).toBe(second);
  });
});
