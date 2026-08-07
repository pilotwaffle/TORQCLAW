/**
 * Frame parsing and validation for TORQCLAW Collaboration Substrate
 *
 * Implements strict frame validation per PRD Section 7.1 and 7.6.
 * - Maximum 65,536 raw UTF-8 bytes
 * - Strict JSON parsing with duplicate-key rejection
 * - Non-finite number detection (1e999 -> Infinity rejection)
 * - UUID canonicalization (lowercase only)
 */

/**
 * Frame validation error type.
 * type: 'INVALID_FRAME' for frame/JSON limits
 * type: 'INVALID_REQUEST' for envelope/schema/UUID validation
 */
export type FrameValidationError = {
  type: 'INVALID_FRAME' | 'INVALID_REQUEST';
  message: string;
};

/**
 * Parse a frame from raw bytes.
 *
 * Steps per PRD Section 7.6:
 * 1. Frame size check (raw UTF-8 bytes) -> INVALID_FRAME
 * 2. UTF-8 validity check -> INVALID_FRAME
 * 3. Duplicate-key rejection (position-aware parser) -> INVALID_FRAME
 * 4. Non-finite number detection -> INVALID_FRAME
 * 5. JSON parsing and structure validation -> may be INVALID_REQUEST
 *
 * Returns the parsed frame object or a FrameValidationError.
 */
export function parseFrame(
  rawBytes: Uint8Array
): { type: string; [k: string]: unknown } | FrameValidationError {
  // Step 1: Frame size check (raw UTF-8 bytes)
  // Maximum 65,536 bytes (64 KiB)
  if (rawBytes.length > 65536) {
    return {
      type: 'INVALID_FRAME',
      message: `Frame exceeds 65,536 byte limit: ${rawBytes.length} bytes`,
    };
  }

  // Step 2: UTF-8 validity check
  let text: string;
  try {
    // TextDecoder throws on invalid UTF-8
    text = new TextDecoder('utf-8', { fatal: true }).decode(rawBytes);
  } catch {
    return {
      type: 'INVALID_FRAME',
      message: 'Frame contains invalid UTF-8',
    };
  }

  // Step 3: Duplicate-key rejection via position-aware parser
  // We scan the JSON text for duplicate keys before JSON.parse
  const dupKeyCheck = checkDuplicateKeys(text);
  if (!dupKeyCheck.valid) {
    return {
      type: 'INVALID_FRAME',
      message: dupKeyCheck.message,
    };
  }

  // Step 4: JSON parsing
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return {
      type: 'INVALID_FRAME',
      message: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // Step 5: Non-finite number detection (post-parse validation)
  // Recursively walk the parsed value tree and reject if ANY number is non-finite
  const nonFiniteCheck = checkParsedTreeForNonFiniteNumbers(parsed);
  if (!nonFiniteCheck.valid) {
    return {
      type: 'INVALID_FRAME',
      message: nonFiniteCheck.message,
    };
  }

  // Ensure result is an object with a type field
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray(parsed)
  ) {
    if (typeof parsed === 'object' && parsed !== null) {
      // It's a plain object - check for type field existence
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.type === 'string') {
        return obj as { type: string; [k: string]: unknown };
      }
    }
    return {
      type: 'INVALID_REQUEST',
      message: 'Frame must be a JSON object with a type field',
    };
  }

  return {
    type: 'INVALID_FRAME',
    message: 'Frame must be a JSON object, not an array',
  };
}

/**
 * Check for duplicate keys in a JSON text via position-aware parsing.
 *
 * Walks the JSON text manually, tracking all object keys and their positions.
 * Rejects duplicate keys at any nesting level.
 */
function checkDuplicateKeys(text: string): {
  valid: boolean;
  message: string;
} {
  const keyStack: Set<string>[] = [];
  let i = 0;
  const n = text.length;

  try {
    while (i < n) {
      const ch = text.charAt(i);

      // Skip whitespace
      if (/\s/.test(ch)) {
        i++;
        continue;
      }

      // Object start
      if (ch === '{') {
        keyStack.push(new Set());
        i++;
        continue;
      }

      // Object end
      if (ch === '}') {
        keyStack.pop();
        i++;
        continue;
      }

      // Array start / end (no key tracking inside arrays)
      if (ch === '[' || ch === ']') {
        i++;
        continue;
      }

      // String (potential key or value)
      if (ch === '"') {
        const stringStart = i;
        i++; // skip opening quote

        while (i < n) {
          const c = text.charAt(i);

          if (c === '"') {
            // Check if quote is escaped by counting preceding backslashes
            let backslashCount = 0;
            let checkPos = i - 1;
            while (checkPos >= stringStart && text.charAt(checkPos) === '\\') {
              backslashCount++;
              checkPos--;
            }
            // Quote ends string only if preceded by EVEN number of backslashes
            if (backslashCount % 2 === 0) {
              // Quote closes the string
              break;
            } else {
              // Quote is escaped, string continues
              i++;
            }
          } else if (c === '\\' && i + 1 < n) {
            // Skip escape sequence
            i += 2;
            continue;
          } else {
            i++;
          }
        }

        if (i >= n) {
          return {
            valid: false,
            message: 'Unterminated string in JSON',
          };
        }

        // Extract string value
        const str = JSON.parse(text.substring(stringStart, i + 1));
        i++; // skip closing quote

        // Skip whitespace after string
        while (i < n && /\s/.test(text.charAt(i))) {
          i++;
        }

        // Check if this is a key (followed by ':')
        if (i < n && text.charAt(i) === ':') {
          // This is an object key
          if (keyStack.length > 0) {
            const currentKeys = keyStack[keyStack.length - 1];
            if (currentKeys !== undefined) {
              if (currentKeys.has(str)) {
                return {
                  valid: false,
                  message: `Duplicate key in JSON object: "${str}"`,
                };
              }
              currentKeys.add(str);
            }
          }
          i++; // skip ':'
        }

        continue;
      }

      // Other JSON tokens: null, true, false, numbers
      if (ch === ':' || ch === ',') {
        i++;
        continue;
      }

      // Number or literal (null, true, false)
      const substr4 = text.substring(i, i + 4);
      const substr5 = text.substring(i, i + 5);
      if (/[-\d]/.test(ch) || substr4 === 'null' ||
          substr4 === 'true' ||
          substr5 === 'false') {
        // Skip to end of token
        while (i < n && /[^,\}\]\s:]/.test(text.charAt(i))) {
          i++;
        }
        continue;
      }

      i++;
    }
  } catch {
    return {
      valid: false,
      message: 'Error parsing JSON structure for duplicate key detection',
    };
  }

  return { valid: true, message: '' };
}

/**
 * Check parsed value tree for non-finite numbers (Infinity, -Infinity, NaN).
 *
 * Recursively walks the entire parsed object/array tree and rejects
 * if ANY number fails Number.isFinite().
 *
 * This post-parse validation ensures that numbers like 9e308, 2e308,
 * or very large exponents that JSON.parse converts to Infinity are rejected.
 *
 * Valid: 1e308, -1e308, 1e-320, 0
 * Invalid: 9e308, 2e308, Infinity, -Infinity, NaN
 */
function checkParsedTreeForNonFiniteNumbers(value: unknown): {
  valid: boolean;
  message: string;
} {
  function walk(v: unknown): boolean {
    if (typeof v === 'number') {
      // Check if the number is finite
      if (!Number.isFinite(v)) {
        return false;
      }
      return true;
    }

    if (Array.isArray(v)) {
      for (const item of v) {
        if (!walk(item)) {
          return false;
        }
      }
      return true;
    }

    if (typeof v === 'object' && v !== null) {
      for (const key in v) {
        if (Object.prototype.hasOwnProperty.call(v, key)) {
          if (!walk((v as Record<string, unknown>)[key])) {
            return false;
          }
        }
      }
      return true;
    }

    // Strings, booleans, null, etc. are always valid
    return true;
  }

  if (!walk(value)) {
    return {
      valid: false,
      message: 'Non-finite number detected in parsed frame',
    };
  }

  return { valid: true, message: '' };
}

/**
 * Check if a string is a canonical UUID (lowercase only).
 *
 * Canonical format: 8-4-4-4-12 lowercase hex digits
 * Example: 550e8400-e29b-41d4-a716-446655440000
 *
 * Rejects uppercase UUIDs.
 */
export function isCanonicalUuid(s: string): boolean {
  // UUID regex: 8-4-4-4-12 hex digits, lowercase only
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  return uuidRegex.test(s);
}
