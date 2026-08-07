/**
 * Text normalization and validation for the Collaboration Substrate
 *
 * Normalization order (Section 7.1):
 * 1. NFC normalization
 * 2. Trim leading/trailing whitespace
 * 3. Validate bounds and control characters
 */

/**
 * Count the raw UTF-8 byte length of a string.
 * Uses the TextEncoder to measure exact bytes.
 */
function countUtf8Bytes(text: string): number {
  // TextEncoder is a global in ES2022+ (Node.js 11+)
  // Use direct instantiation since it's available globally
  const encoder = new TextEncoder();
  return encoder.encode(text).length;
}

/**
 * Count the byte length of text as it would appear in a JSON string (excluding quotes).
 * This includes escape sequences: \n, \r, \t, \\, \", etc.
 */
function countJsonEncodedBytes(text: string): number {
  // JSON.stringify adds quotes and escapes special characters
  // We need to measure the escaped form without the surrounding quotes
  const jsonString = JSON.stringify(text);
  // Subtract 2 for the opening and closing quotes
  return countUtf8Bytes(jsonString.slice(1, -1));
}

/**
 * Count the number of Unicode scalar values in a string.
 * A scalar value is a single Unicode codepoint (excluding surrogate pairs).
 */
function countScalars(text: string): number {
  // Use the array spread operator or for...of to iterate over scalar values
  let count = 0;
  for (const _ of text) {
    count++;
  }
  return count;
}

/**
 * Set of C0 control characters (U+0000 to U+001F)
 */
const C0_CONTROLS = new Set<number>();
for (let i = 0x0000; i <= 0x001F; i++) {
  C0_CONTROLS.add(i);
}

/**
 * Set of C1 control characters (U+0080 to U+009F)
 */
const C1_CONTROLS = new Set<number>();
for (let i = 0x0080; i <= 0x009F; i++) {
  C1_CONTROLS.add(i);
}

/**
 * Allowed C0/C1 control characters for message text
 */
const MESSAGE_ALLOWED_CONTROLS = new Set<number>([
  0x0009, // TAB (U+0009)
  0x000A, // LF (U+000A)
  0x000D, // CR (U+000D)
]);

/**
 * Unicode bidirectional control characters (U+202A-U+202E, U+2066-U+2069)
 */
const BIDI_CONTROLS = new Set<number>([
  0x202A, // U+202A (LEFT-TO-RIGHT EMBEDDING)
  0x202B, // U+202B (RIGHT-TO-LEFT EMBEDDING)
  0x202C, // U+202C (POP DIRECTIONAL FORMATTING)
  0x202D, // U+202D (LEFT-TO-RIGHT OVERRIDE)
  0x202E, // U+202E (RIGHT-TO-LEFT OVERRIDE)
  0x2066, // U+2066 (LEFT-TO-RIGHT ISOLATE)
  0x2067, // U+2067 (RIGHT-TO-LEFT ISOLATE)
  0x2068, // U+2068 (FIRST STRONG ISOLATE)
  0x2069, // U+2069 (POP DIRECTIONAL ISOLATE)
]);

/**
 * Line and paragraph separator characters
 */
const SEPARATOR_CHARS = new Set<number>([
  0x2028, // U+2028 (LINE SEPARATOR)
  0x2029, // U+2029 (PARAGRAPH SEPARATOR)
]);

/**
 * Normalize and validate message text.
 *
 * Per PRD v0.14 Section 7.1 and 10:
 * - Apply NFC normalization first
 * - DO NOT trim message text (names-only trimming per v0.14)
 * - Validate post-NFC text:
 *   * Raw UTF-8 bytes: 1–16,384
 *   * Encoded JSON string form (excluding quotes): 0–16,384 bytes
 *   * No C0/C1 controls except TAB (U+0009), LF (U+000A), CR (U+000D)
 *
 * All-LF and leading/trailing-space messages are ACCEPTED and persisted byte-identical.
 *
 * Returns { text: normalizedText } on success or
 *         { error: 'INVALID_REQUEST'; message: "..." } on failure
 */
export function normalizeMessageText(raw: string):
  | { text: string }
  | { error: 'INVALID_REQUEST'; message: string } {

  // Step 1: Apply NFC normalization only
  const nfcText = raw.normalize('NFC');

  // Step 2: NO TRIM for message text (v0.14 change)

  // Step 3: Validate bounds and character classes on the NFC form

  // Check raw UTF-8 byte bounds: 1–16,384
  const rawBytes = countUtf8Bytes(nfcText);
  if (rawBytes < 1) {
    return {
      error: 'INVALID_REQUEST',
      message: 'Message text must be at least 1 byte (after normalization)',
    };
  }
  if (rawBytes > 16384) {
    return {
      error: 'INVALID_REQUEST',
      message: 'Message text must not exceed 16,384 UTF-8 bytes (after normalization)',
    };
  }

  // Check encoded JSON form: 0–16,384 bytes (excluding quotes)
  const jsonBytes = countJsonEncodedBytes(nfcText);
  if (jsonBytes > 16384) {
    return {
      error: 'INVALID_REQUEST',
      message: 'Message text must not exceed 16,384 bytes when JSON-encoded (after normalization)',
    };
  }

  // Check for disallowed control characters
  for (const char of nfcText) {
    const codePoint = char.codePointAt(0)!;

    const isC0 = C0_CONTROLS.has(codePoint);
    const isC1 = C1_CONTROLS.has(codePoint);

    if ((isC0 || isC1) && !MESSAGE_ALLOWED_CONTROLS.has(codePoint)) {
      return {
        error: 'INVALID_REQUEST',
        message: `Message text contains disallowed control character U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`,
      };
    }
  }

  return { text: nfcText };
}

/**
 * Normalize and validate a name (channel name or agent display name).
 *
 * Per Section 7.1:
 * - Apply NFC normalization first
 * - Then trim leading/trailing whitespace
 * - Validate post-NFC post-trim text:
 *   * 1–80 Unicode scalar values
 *   * No C0/C1 control characters (all rejected)
 *   * No U+2028 (line separator) or U+2029 (paragraph separator)
 *   * No Unicode bidirectional controls (U+202A-U+202E, U+2066-U+2069)
 *
 * Returns { name: normalizedText } on success or
 *         { error: 'INVALID_REQUEST'; message: "..." } on failure
 */
export function normalizeName(raw: string):
  | { name: string }
  | { error: 'INVALID_REQUEST'; message: string } {

  // Step 1: Apply NFC normalization
  const nfcText = raw.normalize('NFC');

  // Step 2: Trim leading/trailing whitespace
  const trimmed = nfcText.trim();

  // Step 3: Validate bounds and character classes

  // Check scalar count: 1–80 Unicode scalar values
  const scalars = countScalars(trimmed);
  if (scalars < 1) {
    return {
      error: 'INVALID_REQUEST',
      message: 'Name must be at least 1 character (after normalization and trimming)',
    };
  }
  if (scalars > 80) {
    return {
      error: 'INVALID_REQUEST',
      message: 'Name must not exceed 80 Unicode scalar values (after normalization and trimming)',
    };
  }

  // Check for disallowed control characters and special unicode chars
  for (const char of trimmed) {
    const codePoint = char.codePointAt(0)!;

    // Reject all C0 controls (no exceptions)
    if (C0_CONTROLS.has(codePoint)) {
      return {
        error: 'INVALID_REQUEST',
        message: `Name contains disallowed C0 control character U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`,
      };
    }

    // Reject all C1 controls
    if (C1_CONTROLS.has(codePoint)) {
      return {
        error: 'INVALID_REQUEST',
        message: `Name contains disallowed C1 control character U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`,
      };
    }

    // Reject line/paragraph separators
    if (SEPARATOR_CHARS.has(codePoint)) {
      return {
        error: 'INVALID_REQUEST',
        message: `Name contains disallowed separator character U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`,
      };
    }

    // Reject bidirectional controls
    if (BIDI_CONTROLS.has(codePoint)) {
      return {
        error: 'INVALID_REQUEST',
        message: `Name contains disallowed bidirectional control character U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`,
      };
    }
  }

  return { name: trimmed };
}
