/** Behavior-based capability classification for MCP tools (TCLAW-0C).
 *
 *  Replaces name-pattern-only "requiresApproval" gating with a first-class
 *  Capability that ALSO drives path-scope mode (read vs write), decoupling
 *  the two concerns that were previously conflated via `requiresApproval`.
 *
 *  Pure, no I/O — mirrors the authz.ts pattern (packages/gateway/src/authz.ts):
 *  a single resolver function, priority-ordered, default-deny (here:
 *  default-write, i.e. fail-closed) for anything with no signal.
 *
 *  finding-2 v3: two prior name-based READ classifiers both failed adversarial
 *  audit (a prefix allowlist leaked 196 dangerous names; a whole-name "read
 *  grammar" leaked 62 honest-dangerous names AND over-gated 100% of real read
 *  tools). Per PRD-TCLAW-TRUSTOS-001 lines 248-249, the correct design is:
 *  "resolved in priority order: server-config annotation -> MCP tool
 *  annotations -> name-pattern fallback" and "Fail closed on unknown: a tool
 *  whose capability cannot be resolved by any source is treated as
 *  write-class. UNKNOWN NEVER MEANS READ." Name patterns are ONLY ever used
 *  to catch obvious WRITE names (P4). There is NO name-based path to 'read'.
 *  The only ways to get 'read' are P1 (explicit config annotation) and P3
 *  (a trustworthy MCP readOnlyHint). Everything else — including every
 *  legitimately read-only tool that isn't annotated — fails closed to
 *  'write'. This is intentional over-gating; the PRD-specified remedy is the
 *  operator adding a `capabilities` annotation in servers.json (see
 *  ops/servers.example.json for a worked example).
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

/** Split a raw tool name into lowercase tokens on `_`, `-`, and camelCase
 *  boundaries (lower-to-upper transitions). Pure string logic, no regex
 *  backtracking risk — every character is visited once. */
function tokenize(name: string): string[] {
  // Insert a separator at every camelCase boundary, then split on all
  // separator characters (`_` and `-`).
  const withBoundaries = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  return withBoundaries
    .split(/[_-]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 0);
}

// P4: write-class name patterns — TOKEN-BOUNDED (exact-equality Set membership
// on tokenized name), NOT substring regex. Substring matching is what leaked
// read nouns like get_deployment / get_process_list / get_publisher_info in
// prior attempts (a substring `deploy` or `process` also matches inside an
// unrelated noun). Tokenizing on `_`, `-`, and camelCase boundaries and
// testing each token for EXACT membership in a verb set means a noun like
// `deployment` (token stays "deployment", never reduces to "deploy") or
// `process` (never in the exec set at all) simply doesn't match, and falls
// through to P6 fail-closed 'write' instead — which is the correct, safe
// outcome either way, but token-bounding keeps the WRITE/EXEC/SEND CATEGORY
// itself accurate (so the approval card names the right capability class)
// rather than mis-categorizing a write-class name as the wrong sub-kind.
//
// Checked in order: destructive -> exec -> send -> generic write. Any match
// wins as that class; no match falls through to P6.
const P4_DESTRUCTIVE = new Set([
  'delete', 'remove', 'rm', 'destroy', 'drop', 'kill', 'wipe', 'purge',
  'truncate', 'erase', 'shred', 'obliterate', 'nuke',
]);

const P4_EXEC = new Set([
  'exec', 'run', 'shell', 'terminal', 'eval', 'command', 'spawn', 'fork',
  'launch',
  // NOTE: 'process' is deliberately NOT included. As a bare token it is far
  // more often a noun (get_process_list, list_processes) than a verb, and
  // unlike the other verbs here there is no safe token-bounded way to
  // distinguish "process the payment" from "the process list" once reduced
  // to a single token. Leaving it out means such names fall through to P6
  // fail-closed 'write' — safe, and remediable via annotation.
]);

const P4_SEND = new Set([
  'send', 'publish', 'post', 'email', 'notify', 'tweet', 'transmit',
  'dispatch',
]);

const P4_WRITE = new Set([
  'write', 'edit', 'create', 'update', 'append', 'move', 'patch', 'set',
  'put', 'push', 'replace', 'insert', 'upsert', 'merge', 'rename', 'sync',
  'save', 'copy', 'apply', 'submit', 'deploy', 'add', 'upload', 'transfer',
  'grant', 'revoke', 'chmod', 'chown', 'sign', 'encrypt', 'decrypt', 'mount',
  'unmount', 'install', 'uninstall', 'migrate', 'seed', 'import', 'rotate',
  'reset', 'restore', 'rollback', 'overwrite', 'disable', 'enable',
  'activate', 'deactivate', 'cancel', 'close', 'flush', 'unlink', 'format',
  'reboot', 'shutdown', 'freeze', 'suspend', 'quarantine', 'seize', 'ban',
  'blacklist', 'deprovision', 'decommission', 'teardown', 'scrub', 'redact',
  'anonymize', 'tokenize', 'rekey', 'reissue', 'impersonate', 'escalate',
  'unseal', 'liquidate', 'sell', 'charge', 'debit', 'payout', 'wire',
  'disburse', 'withdraw', 'hijack', 'spoof', 'bypass', 'poison', 'corrupt',
  'tamper', 'brick', 'detonate',
]);

/** P4: token-bounded write-class name classification. Returns the capability
 *  class for the first verb set (in priority order) that has an exact-match
 *  token in the name, or undefined if no token matches any set at all. */
function classifyByNameTokens(rawName: string): Capability | undefined {
  const tokens = tokenize(rawName);
  if (tokens.some((t) => P4_DESTRUCTIVE.has(t))) return 'write';
  if (tokens.some((t) => P4_EXEC.has(t))) return 'exec';
  if (tokens.some((t) => P4_SEND.has(t))) return 'send';
  if (tokens.some((t) => P4_WRITE.has(t))) return 'write';
  return undefined;
}

/**
 * Resolve a tool's Capability. FIRST MATCH WINS, in this priority order:
 *
 *   P1 — explicit per-tool config override (`servers.json` capabilities map).
 *        The operator's explicit control; this and P3 are the ONLY ways to
 *        get 'read'.
 *   P3 — MCP tool annotations (readOnlyHint -> 'read'; destructiveHint or
 *        openWorldHint -> 'write'). readOnlyHint is the only OTHER
 *        name-independent path to 'read'.
 *   P4 — write-class name patterns (token-bounded exact match against
 *        destructive/exec/send/write verb sets). Can only ever produce a
 *        WRITE-CLASS result (write/exec/send) — never 'read'.
 *   P6 — default: fail-closed to 'write' when no signal matched at all.
 *
 * There is NO P5 / no name-based read path of any kind. A tool name can never
 * resolve to 'read' — only P1 config or P3 readOnlyHint can. Every other
 * tool, including genuinely read-only ones with no annotation, lands on P6
 * fail-closed 'write'. This is intentional: PRD-TCLAW-TRUSTOS-001 requires
 * "unknown never means read," and the remedy for the resulting over-gating is
 * the operator adding a capabilities annotation (P1) or the server publishing
 * readOnlyHint (P3) — see ops/servers.example.json.
 *
 * (There is no P2 — reserved by the design for a future signal.)
 */
export function classifyCapability(
  rawName: string,
  annotations: McpAnnotations | undefined,
  configCapability: Capability | undefined,
): Capability {
  // P1: explicit config override always wins. The operator's explicit
  // control, and (with P3) the ONLY way to get 'read'.
  if (configCapability) return configCapability;

  // P3: MCP annotations (read defensively — field is often absent).
  // readOnlyHint is the only other name-independent path to 'read'.
  if (annotations?.readOnlyHint === true) return 'read';
  if (annotations?.destructiveHint === true || annotations?.openWorldHint === true) return 'write';

  // P4: write-class name patterns, token-bounded, most-specific-first. Can
  // only ever yield a write-class capability — never 'read'.
  const byName = classifyByNameTokens(rawName);
  if (byName) return byName;

  // P6: fail-closed default — no config, no annotation, no P4 verb match.
  // This is where honest read-only tools land unless annotated (P1) or the
  // server publishes readOnlyHint (P3). UNKNOWN NEVER MEANS READ.
  return 'write';
}
