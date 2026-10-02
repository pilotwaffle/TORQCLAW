import { describe, expect, it } from 'vitest';
import { RoomJobArtifactValidationError, validateRoomJobReview } from '../packages/gateway/src/roomJobArtifactValidators.js';

describe('Room-job artifact validators', () => {
  const facts = [{ factId: 'fact-a', sha256: 'a'.repeat(64) }];
  const proposal = { revision: 2, sha256: 'b'.repeat(64) };

  it('rejects source-only fact content rather than silently stripping it', () => {
    const response = JSON.stringify({
      verdict: 'acceptable', summary: 'The configured review is acceptable.', proposal,
      facts: [{ ...facts[0], content: 'Input-only source text' }],
    });

    expect(() => validateRoomJobReview(response, facts, proposal)).toThrow(RoomJobArtifactValidationError);
  });

  it('keeps immutable proposal bindings authoritative after schema-constrained generation', () => {
    const response = JSON.stringify({
      verdict: 'acceptable', summary: 'The configured review is acceptable.',
      proposal: { revision: 3, sha256: proposal.sha256 }, facts,
    });

    expect(() => validateRoomJobReview(response, facts, proposal)).toThrow(RoomJobArtifactValidationError);
  });

  it('keeps admitted fact id/hash bindings authoritative after schema-constrained generation', () => {
    const response = JSON.stringify({
      verdict: 'acceptable', summary: 'The configured review is acceptable.', proposal,
      facts: [{ factId: facts[0]!.factId, sha256: 'c'.repeat(64) }],
    });

    expect(() => validateRoomJobReview(response, facts, proposal)).toThrow(RoomJobArtifactValidationError);
  });
});
