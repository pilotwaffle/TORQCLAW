import {
  V2ControlCommandSchema,
  V2PromptOrPreviewSchema,
  V2SkillDecisionSchema,
  V2HelloSchema,
  V2_HELLO_MAX_BYTES,
  V2_CONTROL_MAX_BYTES,
  V2_PROMPT_MAX_BYTES,
  V2_SKILL_DECISION_MAX_BYTES,
  type V2ClientCommand,
  type V2PromptOrPreview,
  type V2SkillDecision,
  type V2Hello,
} from './v2Contracts.js';
export class StrictWireError extends Error {
  constructor(message = 'strict wire input rejected') {
    super(message);
    this.name = 'StrictWireError';
  }
}
function asUtf8(input: string): { text: string; bytes: number } {
  if (typeof input !== 'string') throw new StrictWireError();
  const bytes = new TextEncoder().encode(input);
  return { text: input, bytes: bytes.byteLength };
}
function skipWhitespace(text: string, index: number): number {
  while (index < text.length && /\s/.test(text[index]!)) index += 1;
  return index;
}
function scanString(text: string, start: number): { value: string; next: number } {
  if (text[start] !== '"') throw new StrictWireError();
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === '"' && !escaped) {
      const raw = text.slice(start, index + 1);
      try {
        return { value: JSON.parse(raw) as string, next: index + 1 };
      } catch {
        throw new StrictWireError();
      }
    }
    if (char === '\n' || char === '\r') throw new StrictWireError();
    if (char === '\\' && !escaped) escaped = true;
    else escaped = false;
  }
  throw new StrictWireError();
}

function scanValue(text: string, start: number): number {
  let index = skipWhitespace(text, start);
  const kind = text[index];
  if (kind === '"') return scanString(text, index).next;
  if (kind === '{') {
    index = skipWhitespace(text, index + 1);
    const keys = new Set<string>();
    if (text[index] === '}') return index + 1;
    for (;;) {
      const key = scanString(text, index);
      if (keys.has(key.value)) throw new StrictWireError();
      keys.add(key.value);
      index = skipWhitespace(text, key.next);
      if (text[index] !== ':') throw new StrictWireError();
      index = scanValue(text, index + 1);
      index = skipWhitespace(text, index);
      if (text[index] === '}') return index + 1;
      if (text[index] !== ',') throw new StrictWireError();
      index = skipWhitespace(text, index + 1);
    }
  }
  if (kind === '[') {
    index = skipWhitespace(text, index + 1);
    if (text[index] === ']') return index + 1;
    for (;;) {
      index = scanValue(text, index);
      index = skipWhitespace(text, index);
      if (text[index] === ']') return index + 1;
      if (text[index] !== ',') throw new StrictWireError();
      index = skipWhitespace(text, index + 1);
    }
  }
  // Primitive validation and delimiter handling remain JSON.parse's job.
  while (index < text.length && !',]}\r\n\t '.includes(text[index]!)) index += 1;
  if (index === start) throw new StrictWireError();
  return index;
}

function rejectSemanticDuplicates(text: string): void {
  const end = scanValue(text, 0);
  if (skipWhitespace(text, end) !== text.length) throw new StrictWireError();
}

export function parseStrictJson<T = unknown>(
  input: string,
  maxBytes: number,
): T {
  const { text, bytes } = asUtf8(input);
  if (bytes > maxBytes) throw new StrictWireError();
  rejectSemanticDuplicates(text);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new StrictWireError();
  }
}

export function parseV2Hello(input: string): V2Hello {
  try {
    return V2HelloSchema.parse(parseStrictJson(input, V2_HELLO_MAX_BYTES));
  } catch {
    throw new StrictWireError();
  }
}

export function parseV2ClientCommand(input: string): V2ClientCommand {
  try {
    const parsed = parseStrictJson<Record<string, unknown>>(input, V2_SKILL_DECISION_MAX_BYTES);
    switch (parsed.action) {
      case 'SUBMIT_PROMPT':
      case 'PREVIEW_ROUTE':
        return V2PromptOrPreviewSchema.parse(parseStrictJson(input, V2_PROMPT_MAX_BYTES));
      case 'APPROVE_SKILL':
        return V2SkillDecisionSchema.parse(parseStrictJson(input, V2_SKILL_DECISION_MAX_BYTES));
      default:
        return V2ControlCommandSchema.parse(parseStrictJson(input, V2_CONTROL_MAX_BYTES));
    }
  } catch {
    throw new StrictWireError();
  }
}

export function parseV2PromptOrPreview(input: string): V2PromptOrPreview {
  try {
    const parsed = parseStrictJson<Record<string, unknown>>(input, V2_PROMPT_MAX_BYTES);
    return V2PromptOrPreviewSchema.parse(parsed);
  } catch {
    throw new StrictWireError();
  }
}

export function parseV2SkillDecision(input: string): V2SkillDecision {
  try {
    const parsed = parseStrictJson<Record<string, unknown>>(input, V2_SKILL_DECISION_MAX_BYTES);
    return V2SkillDecisionSchema.parse(parsed);
  } catch {
    throw new StrictWireError();
  }
}
