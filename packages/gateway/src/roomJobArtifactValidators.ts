import { createHash } from 'node:crypto';

const MAX_JSON_DEPTH = 12;
const MAX_JSON_ITEMS = 1_000;
const MAX_STRING_BYTES = 60_000;
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);

export class RoomJobArtifactValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoomJobArtifactValidationError';
  }
}

type Fact = { factId: string; sha256: string };
export type ValidatedProposal = { title: string; body: string; facts: Fact[] };
export type ValidatedReview = {
  verdict: 'acceptable' | 'revise';
  summary: string;
  proposal: { revision: number; sha256: string };
  facts: Fact[];
};

function assertExactKeys(value: Record<string, unknown>, expected: string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new RoomJobArtifactValidationError('Room-job artifact has unknown or missing keys');
  }
}

function inspect(value: unknown, depth = 0, budget = { items: 0 }): void {
  if (depth > MAX_JSON_DEPTH) throw new RoomJobArtifactValidationError('Room-job artifact nesting exceeds limit');
  budget.items += 1;
  if (budget.items > MAX_JSON_ITEMS) throw new RoomJobArtifactValidationError('Room-job artifact item count exceeds limit');
  if (typeof value === 'string') {
    if (value !== value.normalize('NFC') || Buffer.byteLength(value, 'utf8') > MAX_STRING_BYTES) {
      throw new RoomJobArtifactValidationError('Room-job artifact string is invalid or oversized');
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) inspect(entry, depth + 1, budget);
    return;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (forbiddenKeys.has(key)) throw new RoomJobArtifactValidationError('Room-job artifact contains forbidden key');
      inspect((value as Record<string, unknown>)[key], depth + 1, budget);
    }
  }
}

function parse(text: string): Record<string, unknown> {
  if (Buffer.byteLength(text, 'utf8') > 65_536) throw new RoomJobArtifactValidationError('Room-job artifact exceeds byte limit');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new RoomJobArtifactValidationError('Room-job artifact is not JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RoomJobArtifactValidationError('Room-job artifact must be an object');
  inspect(value);
  return value as Record<string, unknown>;
}

function validateFacts(value: unknown, admitted: Fact[]): Fact[] {
  if (!Array.isArray(value) || value.length !== admitted.length) throw new RoomJobArtifactValidationError('Room-job artifact fact set is invalid');
  const expected = new Map(admitted.map((fact) => [fact.factId, fact.sha256]));
  const seen = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new RoomJobArtifactValidationError('Room-job artifact fact is invalid');
    const fact = entry as Record<string, unknown>;
    assertExactKeys(fact, ['factId', 'sha256']);
    if (typeof fact.factId !== 'string' || typeof fact.sha256 !== 'string' || seen.has(fact.factId)
      || expected.get(fact.factId) !== fact.sha256) throw new RoomJobArtifactValidationError('Room-job artifact fact does not match admitted input');
    seen.add(fact.factId);
    return { factId: fact.factId, sha256: fact.sha256 };
  });
}

export function validateRoomJobProposal(text: string, admittedFacts: Fact[]): ValidatedProposal {
  const value = parse(text);
  assertExactKeys(value, ['body', 'facts', 'title']);
  if (typeof value.title !== 'string' || value.title.length < 1 || value.title.length > 180
    || typeof value.body !== 'string' || value.body.length < 1 || Buffer.byteLength(value.body, 'utf8') > 60_000) {
    throw new RoomJobArtifactValidationError('Room-job proposal fields are invalid');
  }
  return { title: value.title, body: value.body, facts: validateFacts(value.facts, admittedFacts) };
}

export function validateRoomJobReview(
  text: string,
  admittedFacts: Fact[],
  proposal: { revision: number; sha256: string },
): ValidatedReview {
  const value = parse(text);
  assertExactKeys(value, ['facts', 'proposal', 'summary', 'verdict']);
  if (value.verdict !== 'acceptable' && value.verdict !== 'revise') throw new RoomJobArtifactValidationError('Room-job review verdict is invalid');
  if (typeof value.summary !== 'string' || value.summary.length < 1 || Buffer.byteLength(value.summary, 'utf8') > 60_000) {
    throw new RoomJobArtifactValidationError('Room-job review summary is invalid');
  }
  if (!value.proposal || typeof value.proposal !== 'object' || Array.isArray(value.proposal)) throw new RoomJobArtifactValidationError('Room-job review proposal binding is invalid');
  const bound = value.proposal as Record<string, unknown>;
  assertExactKeys(bound, ['revision', 'sha256']);
  if (bound.revision !== proposal.revision || bound.sha256 !== proposal.sha256) {
    throw new RoomJobArtifactValidationError('Room-job review does not bind the committed proposal');
  }
  return { verdict: value.verdict, summary: value.summary, proposal, facts: validateFacts(value.facts, admittedFacts) };
}

export function canonicalRoomJobArtifact(value: ValidatedProposal | ValidatedReview): Buffer {
  const text = JSON.stringify(value);
  return Buffer.from(text, 'utf8');
}

export function roomJobArtifactHash(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}
