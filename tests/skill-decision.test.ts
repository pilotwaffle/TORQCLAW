import { describe, expect, it } from 'vitest';

import { describeSkillDecision } from '../packages/gateway/src/skillDecision.js';

/** Pins the APPROVE_SKILL result interpretation. Before this existed,
 *  approveSkill() discarded the decide_skill payload entirely and the
 *  gateway emitted an unconditional success string — so with governed mode
 *  ON, a busy refusal or a governance-reverted-but-unproven-projection
 *  state reached the operator as "Skill q1: APPROVE". These shapes are the
 *  fix's contract; the taxonomy itself is owned by
 *  mcp_wrapper/governed_skills.map_activation_failure and pinned kernel-side.
 */
describe('describeSkillDecision', () => {
  it('plain success keeps the pre-existing message byte-identical', () => {
    const event = describeSkillDecision('q1', 'APPROVE', false, { ok: true, status: 'approved' });
    expect(event).toEqual({ type: 'SYSTEM', message: 'Skill q1: APPROVE' });
  });

  it('edited approval keeps the (with edits) marker', () => {
    const event = describeSkillDecision('q1', 'APPROVE', true, { ok: true, status: 'approved_edited' });
    expect(event).toEqual({ type: 'SYSTEM', message: 'Skill q1: APPROVE (with edits)' });
  });

  it('a reconciled prior success is labeled as recovery, not a fresh activation', () => {
    const event = describeSkillDecision('q1', 'APPROVE', false, {
      ok: true,
      reconciledFromPriorSuccess: true,
    });
    expect(event.type).toBe('SYSTEM');
    expect(event.message).toBe('Skill q1: APPROVE (recovered a previously-landed activation)');
  });

  it('SKILL_RUNTIME_BUSY surfaces as a retryable ERROR with pending-retry guidance', () => {
    const event = describeSkillDecision('q1', 'APPROVE', false, {
      ok: false,
      code: 'SKILL_RUNTIME_BUSY',
      retryable: true,
      status: 'pending',
      activeTasks: 2,
      error: 'Skill activation is blocked while 2 Hermes task(s) are running.',
    });
    expect(event.type).toBe('ERROR');
    expect(event.message).toContain('SKILL_RUNTIME_BUSY');
    expect(event.message).toContain('stays pending');
    expect(event.metadata).toMatchObject({ queueId: 'q1', code: 'SKILL_RUNTIME_BUSY', retryable: true });
  });

  it('the non-retryable UNPROVEN codes demand inspection and name the tool to use', () => {
    for (const code of ['SKILL_PROJECTION_UNPROVEN_AFTER_REVERT', 'SKILL_ACTIVATION_CACHE_UNPROVEN']) {
      const event = describeSkillDecision('q1', 'APPROVE', false, {
        ok: false,
        code,
        retryable: false,
        error: 'governed state was reverted',
      });
      expect(event.type).toBe('ERROR');
      expect(event.message).toContain(code);
      expect(event.message).toContain('NOT retryable');
      expect(event.message).toContain('list_skill_versions');
      expect(event.metadata).toMatchObject({ code, retryable: false });
    }
  });

  it('legacy refusals without a code (already decided / unknown queue id) still fail loudly', () => {
    const event = describeSkillDecision('q1', 'APPROVE', false, { ok: false, error: 'already approved' });
    expect(event.type).toBe('ERROR');
    expect(event.message).toContain('SKILL_DECISION_FAILED');
    expect(event.message).toContain('already approved');
  });

  it('a null/undefined result (older engine shape) falls back to the legacy success message', () => {
    expect(describeSkillDecision('q1', 'REJECT', false, undefined)).toEqual({
      type: 'SYSTEM',
      message: 'Skill q1: REJECT',
    });
  });
});
