/** Interpret the engine's decide_skill result for the operator event stream.
 *
 * The governed kernel returns every refusal as ok:false DATA, never an MCP
 * error: SKILL_RUNTIME_BUSY is retryable (the queue row stays pending); the
 * two UNPROVEN codes are NOT retryable — the operator must inspect published
 * skill state before any retry (see mcp_wrapper/governed_skills.
 * map_activation_failure for the taxonomy's authority). The legacy path can
 * also refuse with plain {ok:false, error:"already approved"} shapes.
 *
 * Until governed mode went live this result was discarded wholesale in
 * approveSkill(), so every refusal — including a governance-reverted state
 * with unproven published bytes — reached the operator as a claimed
 * success. This interpreter is the fix; its shapes are pinned by
 * tests/skill-decision.test.ts.
 */
export interface SkillDecisionEvent {
  type: 'SYSTEM' | 'ERROR';
  message: string;
  metadata?: Record<string, unknown>;
}

/** Phase 4 (§5.8/§7.3, O-12): code-specific guidance strings, checked BEFORE
 * the generic retryable/non-retryable arms below. On aa6057b the guidance
 * was a single three-way ternary keyed on `retryable` first, which would
 * have emitted the generic "retry when the running Hermes task(s) finish"
 * wording for SKILL_TRUST_STALE — wrong, because the real remedy is
 * refresh_skill_trust, not waiting out a busy Hermes run. Named codes win;
 * everything else falls through to the pre-existing retryable/non-retryable
 * wording, unchanged. */
const SKILL_DECISION_GUIDANCE: Record<string, string> = {
  SKILL_TRUST_STALE:
    ' Run refresh_skill_trust for the source, then decide again.',
  SKILL_TRUST_CLOCK_ROLLBACK:
    ' See the clock-rollback runbook; a newer signed trust bundle is required to clear quarantine.',
};

/** future-issued / trust-not-yet-valid refusals ride the generic
 * SKILL_TRUST_REFUSED code (§5.8's registry has no dedicated code for
 * them), so they are distinguished by matching the `error` detail text
 * rather than the `code` field -- the skew-wait note is added on top of
 * the generic non-retryable wording rather than replacing it. */
function skewWaitNote(detail: string): string {
  return /future-issued|trust-not-yet-valid/.test(detail)
    ? ' This is a clock-skew condition (≤ 2 minutes); wait briefly and retry.'
    : '';
}

export function describeSkillDecision(
  queueId: string,
  decision: 'APPROVE' | 'REJECT',
  edited: boolean,
  result: Record<string, unknown> | null | undefined,
): SkillDecisionEvent {
  if (result && (result as { ok?: unknown }).ok === false) {
    const rawCode = (result as { code?: unknown }).code;
    const code = typeof rawCode === 'string' ? rawCode : 'SKILL_DECISION_FAILED';
    const retryable = (result as { retryable?: unknown }).retryable === true;
    const rawDetail = (result as { error?: unknown }).error;
    const detail = typeof rawDetail === 'string' && rawDetail.length > 0 ? ` ${rawDetail}` : '';
    // Guidance must name the next action, not just the failure class: with no
    // console chrome for the governed tools yet, this message is the only
    // thing telling the operator what to actually do.
    //
    // O-12 ordering: code-specific strings are checked FIRST, before the
    // generic retryable/non-retryable arms.
    const guidance =
      SKILL_DECISION_GUIDANCE[code] ??
      (retryable
        ? ' The approval stays pending; retry when the running Hermes task(s) finish.'
        : code === 'SKILL_DECISION_FAILED'
          ? ' The decision did not take effect.'
          : ` NOT retryable: inspect published skill state (list_skill_versions) before deciding again.${skewWaitNote(detail)}`);
    return {
      type: 'ERROR',
      message: `Skill ${queueId}: ${decision} failed — ${code}.${detail}${guidance}`,
      metadata: { queueId, code, retryable, skillDecision: true },
    };
  }

  // Success path: keep the pre-existing message byte-identical (console
  // renderers key off it) and add only the recovery marker when the kernel
  // reports a reconciled prior success instead of a fresh activation.
  const recovered =
    result !== null &&
    result !== undefined &&
    (result as { reconciledFromPriorSuccess?: unknown }).reconciledFromPriorSuccess === true;
  return {
    type: 'SYSTEM',
    message: `Skill ${queueId}: ${decision}${edited ? ' (with edits)' : ''}${
      recovered ? ' (recovered a previously-landed activation)' : ''
    }`,
  };
}
