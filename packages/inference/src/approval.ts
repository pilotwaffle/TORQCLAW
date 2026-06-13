/** Thrown by an execution adapter when a gated tool is hit with no matching
 *  grant. Carries ONLY the facts dispatch needs to register the approval row
 *  and emit the terminal PENDING_APPROVAL. Inference never imports the gateway
 *  DB; this error is the entire upward channel.
 *
 *  Fail-fast: throwing unwinds the loop so no further tool fires — no side
 *  effects after the gate. Dispatch (the single terminal-emission point per
 *  invariant 7) catches this and turns it into the one terminal PENDING_APPROVAL;
 *  inference never emits that event itself. */
export class ToolApprovalRequired extends Error {
  readonly toolName: string; // resolved real (namespaced) tool name = grant unit
  readonly args: unknown;    // parsed args as the model emitted them (display/audit)

  constructor(toolName: string, args: unknown) {
    super(`Tool requires approval: ${toolName}`);
    this.name = 'ToolApprovalRequired';
    this.toolName = toolName;
    this.args = args;
  }
}
