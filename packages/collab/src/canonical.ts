/**
 * Canonical JSON serialization for the Collaboration Substrate.
 *
 * Per PRD v0.14 (H2 / G1R revision): object keys are sorted by Unicode CODE
 * POINT order, not UTF-16 code-unit order (they diverge above the BMP: a
 * lone high surrogate half sorts differently by code unit than the full
 * astral scalar it is part of sorts by code point). Comparison is therefore
 * performed over `Array.from(key)` (which iterates by code point) rather
 * than the raw string's `<`/`>` operators (which compare by UTF-16 code
 * unit).
 *
 * Escaping is pinned to: standard JSON short escapes for the characters
 * that have one (\", \\, \b, \f, \n, \r, \t), \uXXXX for every other
 * control character (U+0000-U+001F not covered by a short escape, plus
 * U+007F DEL for defense-in-depth even though JSON does not require it —
 * DEL is left unescaped to match `JSON.stringify` and avoid inventing a
 * non-standard escape; see NOTE below), and no unnecessary escaping of any
 * other character (in particular, U+2028/U+2029 and non-ASCII scalars are
 * emitted literally, matching `JSON.stringify`).
 *
 * This is a hand-rolled serializer: it does not call `JSON.stringify` for
 * object key ordering (engine key order for non-integer-like string keys is
 * insertion order, which this function replaces), though it reuses
 * `JSON.stringify` for the leaf-level escaping of individual string values
 * as an implementation detail (its escaping behavior is exactly the pinned
 * behavior described above and is stable/specified by ECMA-262).
 *
 * Rejects `undefined`, functions, symbols, and non-finite numbers (NaN,
 * Infinity, -Infinity) anywhere in the value tree by throwing a TypeError —
 * this function is used as the sole input to request-hash computation
 * (Section 8.3 H1), so silent coercion (e.g. `undefined` -> dropped key,
 * function -> dropped key) would break the hash's bijectivity with the
 * persisted bytes.
 */

/**
 * Serialize a value to its canonical JSON string form.
 *
 * @throws TypeError if the value (at any depth) is undefined, a function,
 *   a symbol, or a non-finite number.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  const t = typeof value;

  if (t === 'boolean') {
    return value ? 'true' : 'false';
  }

  if (t === 'number') {
    const n = value as number;
    if (!Number.isFinite(n)) {
      throw new TypeError(
        `canonicalJson: non-finite number is not representable in JSON: ${String(n)}`
      );
    }
    // Number -> string conversion in JS matches JSON's number grammar for
    // all finite numbers (ECMA-262 Number::toString / JSON.stringify use
    // the same algorithm for finite values).
    return String(n);
  }

  if (t === 'string') {
    return serializeString(value as string);
  }

  if (t === 'undefined') {
    throw new TypeError('canonicalJson: undefined is not representable in JSON');
  }

  if (t === 'function') {
    throw new TypeError('canonicalJson: function is not representable in JSON');
  }

  if (t === 'symbol') {
    throw new TypeError('canonicalJson: symbol is not representable in JSON');
  }

  if (t === 'bigint') {
    throw new TypeError('canonicalJson: bigint is not representable in JSON');
  }

  if (Array.isArray(value)) {
    // Unlike JSON.stringify (which silently turns undefined array elements
    // into null), an undefined element throws here — same "no silent
    // coercion" rule as object values, applied for hash-stability reasons
    // described in the module doc comment.
    //
    // (F6) Sparse arrays (holes, e.g. `[1, , 3]` or `new Array(3)`) are
    // REJECTED by throwing, not silently emitted as invalid/misleading
    // JSON. `Array.prototype.map` skips holes entirely (its callback is
    // never invoked for an index that is not present), so a naive
    // `value.map(...).join(',')` would silently drop the hole's comma
    // separator and produce a shorter, WRONG array — e.g. `[1, , 3]` (length
    // 3) would previously serialize as `"[1,3]"` (a valid but incorrect
    // 2-element array), desynchronizing the hash from the caller's actual
    // value. We iterate by explicit index and use the `in` operator (which
    // is hole-aware, unlike `Array.prototype.map`/`forEach`) to detect and
    // reject holes explicitly.
    const parts: string[] = [];
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) {
        throw new TypeError(
          `canonicalJson: sparse array hole at index ${i} is not representable in JSON`
        );
      }
      parts.push(serialize(value[i]));
    }
    return `[${parts.join(',')}]`;
  }

  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    const sortedKeys = sortByCodePoint(keys);
    const parts: string[] = [];
    for (const key of sortedKeys) {
      const v = obj[key];
      if (v === undefined || typeof v === 'function' || typeof v === 'symbol') {
        // Object keys whose value is undefined/function/symbol are REJECTED
        // (thrown), not silently dropped — unlike JSON.stringify, which
        // drops such keys. Silent dropping would desynchronize the
        // canonical form from what the caller believes it is hashing.
        throw new TypeError(
          `canonicalJson: value for key "${key}" is not representable in JSON (${typeof v})`
        );
      }
      parts.push(`${serializeString(key)}:${serialize(v)}`);
    }
    return `{${parts.join(',')}}`;
  }

  throw new TypeError(`canonicalJson: unsupported value type: ${t}`);
}

/**
 * Sort an array of strings by Unicode CODE POINT order.
 *
 * `Array.prototype.sort` on strings compares by UTF-16 code unit by
 * default. That diverges from code point order for any BMP character above
 * U+DFFF (e.g. U+E000, a private-use character) versus any astral
 * character (>= U+10000, encoded as a surrogate pair whose lead unit is in
 * U+D800-U+DBFF): compared as raw code units, the astral character's lead
 * surrogate (<= 0xDBFF) is numerically less than 0xE000, so it sorts
 * BEFORE the BMP character — even though its actual code point (>=
 * 0x10000) is numerically larger. Comparing by code point (via
 * `Array.from(key)`, which iterates whole scalars) sorts the astral
 * character after, correctly reflecting scalar value order.
 */
function sortByCodePoint(keys: string[]): string[] {
  return [...keys].sort((a, b) => compareByCodePoint(a, b));
}

function compareByCodePoint(a: string, b: string): number {
  const aCps = Array.from(a);
  const bCps = Array.from(b);
  const len = Math.min(aCps.length, bCps.length);
  for (let i = 0; i < len; i++) {
    const aCp = aCps[i]!.codePointAt(0)!;
    const bCp = bCps[i]!.codePointAt(0)!;
    if (aCp !== bCp) {
      return aCp - bCp;
    }
  }
  return aCps.length - bCps.length;
}

/**
 * Serialize a string with pinned escaping:
 * - standard JSON short escapes: \" \\ \b \f \n \r \t
 * - \uXXXX (lowercase hex, 4 digits) for every other C0 control character
 *   (U+0000-U+001F) not covered by a short escape
 * - no escaping of any other character, including U+007F, C1 controls,
 *   U+2028/U+2029, and all non-ASCII scalars — matching JSON.stringify,
 *   which is what this delegates to (JSON.stringify's escaping behavior for
 *   strings is exactly this pinned behavior and is specified by ECMA-262
 *   `QuoteJSONString`).
 */
function serializeString(s: string): string {
  return JSON.stringify(s);
}
