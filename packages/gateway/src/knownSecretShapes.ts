/**
 * Ordered known-secret policy shared by persisted diagnostics and safe export.
 * This module is dependency-free so persistence can import it during storage
 * startup without creating a cycle through the export handlers.
 */
export interface SecretShape {
  label: string;
  re: RegExp;
}

export const KNOWN_SECRET_INPUT_MAX_CHARS = 64 * 1024;
export const KNOWN_SECRET_MAX_DEPTH = 64;
export const KNOWN_SECRET_MAX_NODES = 10_000;
export const KNOWN_SECRET_FAILURE_LABEL = 'diagnostic-too-complex';
export const KNOWN_SECRET_FAILURE_MARKER = `[REDACTED:${KNOWN_SECRET_FAILURE_LABEL}]`;

export const KNOWN_SECRET_SHAPES: SecretShape[] = [
  { label: 'bearer-token', re: /\bBearer\s+\S+/gi },
  { label: 'api-key', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { label: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { label: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    label: 'private-key',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  },
  { label: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g },
  { label: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { label: 'card-number', re: /\b(?:\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,4}|\d{15,16})\b/g },
  { label: 'path', re: /\b[A-Za-z]:\\[^\s"']*/g },
  { label: 'path', re: /\\\\[^\s"']+/g },
  { label: 'path', re: /(?:\/home\/|\/Users\/|\/root\/|~\/)[^\s"']*/g },
];

export type SecretHitRecorder = (label: string, count: number) => void;

interface RedactionBudget {
  nodes: number;
}

function recordFailure(recordHit?: SecretHitRecorder): string {
  recordHit?.(KNOWN_SECRET_FAILURE_LABEL, 1);
  return KNOWN_SECRET_FAILURE_MARKER;
}

function applyKnownSecretPatterns(value: string, recordHit?: SecretHitRecorder): string {
  let output = value;
  for (const { label, re } of KNOWN_SECRET_SHAPES) {
    let count = 0;
    output = output.replace(new RegExp(re.source, re.flags), () => {
      count += 1;
      return `[REDACTED:${label}]`;
    });
    if (count > 0) recordHit?.(label, count);
  }
  return output;
}

function isHex(value: string | undefined): boolean {
  return value !== undefined && /[0-9a-f]/i.test(value);
}

/** Linear detector for the reversible character escapes accepted by this
 *  threat model: JSON \uXXXX, JavaScript \u{X...}, and \xXX. Checking each
 *  slash once avoids catastrophic/backtracking behavior on slash-only input. */
function hasEncodedCharacterEscape(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '\\') continue;
    const kind = value[index + 1]?.toLowerCase();
    if (kind === 'x' && isHex(value[index + 2]) && isHex(value[index + 3])) {
      return true;
    }
    if (kind !== 'u') continue;
    if (
      isHex(value[index + 2]) &&
      isHex(value[index + 3]) &&
      isHex(value[index + 4]) &&
      isHex(value[index + 5])
    ) {
      return true;
    }
    if (value[index + 2] === '{') {
      let cursor = index + 3;
      let digits = 0;
      while (isHex(value[cursor])) {
        cursor += 1;
        digits += 1;
      }
      if (digits > 0 && value[cursor] === '}') return true;
      // The scanned run contained only hex characters, so no possible escape
      // start was skipped. Advancing preserves linear behavior for long runs.
      index = cursor - 1;
    }
  }
  return false;
}

export function assertBoundedJsonValue(
  value: unknown,
  maxDepth = KNOWN_SECRET_MAX_DEPTH,
  maxNodes = KNOWN_SECRET_MAX_NODES,
): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (current.depth > maxDepth || nodes > maxNodes) {
      throw new Error('diagnostic redaction resource limit exceeded');
    }
    if (Array.isArray(current.value)) {
      for (const item of current.value) {
        stack.push({ value: item, depth: current.depth + 1 });
      }
    } else if (current.value !== null && typeof current.value === 'object') {
      for (const item of Object.values(current.value as Record<string, unknown>)) {
        stack.push({ value: item, depth: current.depth + 1 });
      }
    }
  }
}

function scrubJsonValue(
  value: unknown,
  budget: RedactionBudget,
  depth: number,
  recordHit?: SecretHitRecorder,
): unknown {
  budget.nodes += 1;
  if (depth > KNOWN_SECRET_MAX_DEPTH || budget.nodes > KNOWN_SECRET_MAX_NODES) {
    throw new Error('diagnostic redaction resource limit exceeded');
  }

  if (typeof value === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      if (hasEncodedCharacterEscape(value)) {
        throw new Error('malformed encoded diagnostic');
      }
      return applyKnownSecretPatterns(value, recordHit);
    }
    return JSON.stringify(scrubJsonValue(parsed, budget, depth + 1, recordHit));
  }

  if (Array.isArray(value)) {
    return value.map((item) => scrubJsonValue(item, budget, depth + 1, recordHit));
  }

  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      // A key can contain a second, still-reversible escape layer after the
      // outer JSON parse (for example a literal "\\u0073\\u006b..."). Do not
      // preserve it for a later decoder; fail the complete diagnostic closed.
      if (hasEncodedCharacterEscape(key)) {
        throw new Error('encoded diagnostic key');
      }
      const scrubbedKey = applyKnownSecretPatterns(key, recordHit);
      if (Object.prototype.hasOwnProperty.call(output, scrubbedKey)) {
        throw new Error('redacted diagnostic key collision');
      }
      output[scrubbedKey] = scrubJsonValue(item, budget, depth + 1, recordHit);
    }
    return output;
  }

  return value;
}

/**
 * Shared fail-closed redaction core for at-rest diagnostics and safe export.
 * It scrubs decoded JSON keys and values, bounds traversal, and never falls
 * back to reversible encoded bytes after parsing or traversal fails.
 */
export function redactKnownSecretText(
  value: string,
  recordHit?: SecretHitRecorder,
): string {
  if (value.length > KNOWN_SECRET_INPUT_MAX_CHARS) {
    return recordFailure(recordHit);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    if (hasEncodedCharacterEscape(value)) {
      return recordFailure(recordHit);
    }
    return applyKnownSecretPatterns(value, recordHit);
  }

  try {
    return JSON.stringify(scrubJsonValue(parsed, { nodes: 0 }, 0, recordHit));
  } catch {
    return recordFailure(recordHit);
  }
}
