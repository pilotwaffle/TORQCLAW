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

/** P4-8 (§5.8/§7.3, O-12): code-specific guidance strings win over the
 * generic retryable arm. On aa6057b the guidance was a single ternary keyed
 * on `retryable` FIRST -- which would have emitted the generic busy-wait
 * wording for SKILL_TRUST_STALE (also retryable, but for a completely
 * different reason: no Hermes task is involved, refresh_skill_trust is).
 * These tests pin that the reworked structure checks code-specific strings
 * before falling through to the retryable/non-retryable generic wording. */
describe('describeSkillDecision — P4-8 trust guidance ordering (O-12)', () => {
  it('SKILL_TRUST_STALE (retryable) gets its OWN guidance, not the generic Hermes-busy wording', () => {
    const event = describeSkillDecision('q1', 'APPROVE', false, {
      ok: false,
      code: 'SKILL_TRUST_STALE',
      retryable: true,
      status: 'pending',
      error: 'stale',
      retryAfter: 'refresh_skill_trust',
    });
    expect(event.type).toBe('ERROR');
    expect(event.message).toContain('refresh_skill_trust');
    // The generic busy-wait wording (Hermes task language) must NOT appear --
    // that would be the O-12 regression this test exists to catch.
    expect(event.message).not.toContain('Hermes task');
    expect(event.metadata).toMatchObject({ code: 'SKILL_TRUST_STALE', retryable: true });
  });

  it('SKILL_TRUST_CLOCK_ROLLBACK (non-retryable) names the clock-rollback runbook', () => {
    const event = describeSkillDecision('q1', 'APPROVE', false, {
      ok: false,
      code: 'SKILL_TRUST_CLOCK_ROLLBACK',
      retryable: false,
      error: 'clock-rollback',
    });
    expect(event.type).toBe('ERROR');
    expect(event.message).toContain('clock-rollback runbook');
    expect(event.message).toContain('newer signed trust bundle');
    // Must not fall through to the generic list_skill_versions wording --
    // that inspection tool is for governed/published state, not trust state.
    expect(event.message).not.toContain('list_skill_versions');
  });

  it('a future-issued/trust-not-yet-valid detail adds the skew-wait note on top of the generic wording', () => {
    const event = describeSkillDecision('q1', 'APPROVE', false, {
      ok: false,
      code: 'SKILL_TRUST_REFUSED',
      retryable: false,
      error: 'future-issued',
    });
    expect(event.message).toContain('NOT retryable');
    expect(event.message).toContain('clock-skew');
  });

  it('every other SKILL_TRUST_* code falls through to the generic non-retryable wording unchanged', () => {
    for (const code of ['SKILL_TRUST_REVOKED_KEY', 'SKILL_TRUST_REVOKED_SKILL', 'SKILL_TRUST_CAPABILITY_UNSUPPORTED', 'SKILL_TRUST_REFUSED']) {
      const event = describeSkillDecision('q1', 'APPROVE', false, {
        ok: false, code, retryable: false, error: 'refused',
      });
      expect(event.message).toContain('NOT retryable');
      expect(event.message).toContain('list_skill_versions');
    }
  });

  it('SKILL_REMOTE_EDIT_REFUSED (non-retryable, unmapped code) falls through to the generic wording', () => {
    const event = describeSkillDecision('q1', 'APPROVE', false, {
      ok: false,
      code: 'SKILL_REMOTE_EDIT_REFUSED',
      retryable: false,
      status: 'pending',
      error: 'edited_markdown is refused for a remote (signed) skill',
    });
    expect(event.type).toBe('ERROR');
    expect(event.message).toContain('SKILL_REMOTE_EDIT_REFUSED');
    expect(event.message).toContain('NOT retryable');
  });

  it('flag-off parity: SKILL_REMOTE_SOURCES_DISABLED behaves like any other non-retryable refusal', () => {
    const event = describeSkillDecision('q1', 'APPROVE', false, {
      ok: false,
      code: 'SKILL_REMOTE_SOURCES_DISABLED',
      retryable: false,
      error: 'remote skill sources are disabled',
    });
    expect(event.type).toBe('ERROR');
    expect(event.metadata).toMatchObject({ code: 'SKILL_REMOTE_SOURCES_DISABLED', retryable: false });
  });
});
