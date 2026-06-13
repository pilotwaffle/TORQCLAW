/** Typed errors that cross execution-layer boundaries. They live in contracts
 *  (the shared base) so any package — bridge, inference, gateway — can both
 *  THROW and `instanceof`-check them without import cycles.
 *
 *  Per invariant 7, execution layers THROW these; only dispatch's single
 *  catch/complete path turns them into terminal RESULT/ERROR/PENDING_APPROVAL. */

/** A gated tool was hit with no matching grant. Carries the facts dispatch
 *  needs to register the approval and emit the terminal PENDING_APPROVAL.
 *  Thrown by BOTH tiers: inference (LOCAL_EDGE loop) and bridge (FRONTIER, when
 *  the engine's pre_tool_call hook blocked a tool). */
export class ToolApprovalRequired extends Error {
  readonly toolName: string;
  readonly args: unknown;

  constructor(toolName: string, args: unknown) {
    super(`Tool requires approval: ${toolName}`);
    this.name = 'ToolApprovalRequired';
    this.toolName = toolName;
    this.args = args;
  }
}
