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
    const guidance = retryable
      ? ' The approval stays pending; retry when the running Hermes task(s) finish.'
      : code === 'SKILL_DECISION_FAILED'
        ? ' The decision did not take effect.'
        : ' NOT retryable: inspect published skill state (list_skill_versions) before deciding again.';
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
