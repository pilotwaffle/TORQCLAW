/** Behavior-based capability classification for MCP tools (TCLAW-0C).
 *
 *  Replaces name-pattern-only "requiresApproval" gating with a first-class
 *  Capability that ALSO drives path-scope mode (read vs write), decoupling
 *  the two concerns that were previously conflated via `requiresApproval`.
 *
 *  Pure, no I/O — mirrors the authz.ts pattern (packages/gateway/src/authz.ts):
 *  a single resolver function, priority-ordered, default-deny (here:
 *  default-write, i.e. fail-closed) for anything with no signal.
 */

export type Capability = 'read' | 'write' | 'exec' | 'send';

/** write | exec | send all pause LOCAL_EDGE execution / scope as 'write'; only
 *  'read' is the non-gated, read-scoped class. */
export function isWriteClass(cap: Capability): boolean {
  return cap === 'write' || cap === 'exec' || cap === 'send';
}

/** Path-scope mode is derived from capability, NOT from the approval flag —
 *  this is the P5 bug fix: approvalPatterns overriding a tool to require
 *  approval must never silently narrow (or widen) its filesystem scope. */
export function scopeModeFor(cap: Capability): 'read' | 'write' {
  return isWriteClass(cap) ? 'write' : 'read';
}

export interface McpAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
}

// P4: write-class name patterns, checked in priority order — destructive/exec/send
// before the generic write bucket, so e.g. `delete_after_read` resolves to 'write'
// via the delete pattern rather than falling through to P5's read-safe allowlist.
// Destructive verbs include destroy/drop/kill/wipe/purge/truncate so a
// read-prefixed name like `query_drop_table` is caught here BEFORE the P5
// read-safe allowlist could misclassify it as ungated read (G2A finding 2).
const P4_DELETE = /delete|remove|\brm\b|destroy|drop|kill|wipe|purge|truncate/i;
const P4_EXEC = /exec|\brun\b|shell|terminal|process|eval|command/i;
const P4_SEND = /send|publish|\bpost\b|email|notify|tweet/i;
// `push` is deliberately unanchored: `_` is a regex word character, so \bpush\b
// would NOT match push_changes / git_push / push_branch — the common real-world
// names (G2A finding 3). Old-default parity for the `push` token lives here.
const P4_WRITE = /write|edit|create|update|append|move|patch|\bset\b|\bput\b|push/i;

// P5: read-safe allowlist, anchored at the start of the name only.
const P5_READ_SAFE = /^(get|list|read|search|find|query|fetch|show|describe|status|count|view|lookup|info)/i;

/**
 * Resolve a tool's Capability. FIRST MATCH WINS, in this priority order:
 *
 *   P1 — explicit per-tool config override (`servers.json` capabilities map).
 *   P3 — MCP tool annotations (readOnlyHint / destructiveHint / openWorldHint).
 *   P4 — name write-class patterns (delete/exec/send before generic write).
 *   P5 — name read-safe allowlist, anchored at name start.
 *   P6 — default: fail-closed to 'write' when no signal matched at all.
 *
 * (There is no P2 — reserved by the design for a future signal; P1/P3/P4/P5/P6
 * numbering matches the G1R-approved priority table verbatim.)
 */
export function classifyCapability(
  rawName: string,
  annotations: McpAnnotations | undefined,
  configCapability: Capability | undefined,
): Capability {
  // P1: explicit config override always wins.
  if (configCapability) return configCapability;

  // P3: MCP annotations (read defensively — field is often absent).
  if (annotations?.readOnlyHint === true) return 'read';
  if (annotations?.destructiveHint === true || annotations?.openWorldHint === true) return 'write';

  // P4: write-class name patterns, most-specific first.
  if (P4_DELETE.test(rawName)) return 'write';
  if (P4_EXEC.test(rawName)) return 'exec';
  if (P4_SEND.test(rawName)) return 'send';
  if (P4_WRITE.test(rawName)) return 'write';

  // P5: read-safe allowlist, anchored at name start.
  if (P5_READ_SAFE.test(rawName)) return 'read';

  // P6: fail-closed default — no signal anywhere means treat as write.
  return 'write';
}
