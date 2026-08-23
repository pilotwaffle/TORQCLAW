import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

process.env.TORQCLAW_DATA_DIR = mkdtempSync(join(tmpdir(), 'torq-subscription-note-'));

const { ComputeTier } = await import('@torqclaw/contracts');
const { failureSideEffectNote } = await import('../packages/gateway/src/dispatch.js');

describe('subscription failure operator note', () => {
  it('states trusted CLI, possible side effects, and unavailable cost without provider data', () => {
    const note = failureSideEffectNote(ComputeTier.FRONTIER, true);
    expect(note).toBe(
      'Trusted subscription CLI execution may have started. Provider or vendor-built-in tool ' +
      'side effects may have occurred; provider cost is unavailable.',
    );
    expect(note).not.toMatch(/prompt|result|response|token|credential|secret/i);
  });

  it('preserves local and frontier failure distinctions', () => {
    expect(failureSideEffectNote(ComputeTier.LOCAL_EDGE, false))
      .toBe('No changes were made \u2014 this task ran locally with no approved write tools.');
    expect(failureSideEffectNote(ComputeTier.FRONTIER, false))
      .toBe('Some steps may have completed before the failure.');
  });
});
