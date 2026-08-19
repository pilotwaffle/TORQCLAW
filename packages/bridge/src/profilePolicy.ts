import { createHash } from 'node:crypto';
import {
  BUILT_IN_PROFILE_DEFINITIONS,
  EffectiveProfileSchema,
  PROFILE_CONTRACT_VERSION,
  ProfileIdSchema,
  TOOL_REGISTRY_VERSION,
  type CapabilityClass,
  type BuiltInProfileDefinition,
  type EffectiveProfile,
  type ProfileId,
  type SideEffectClass,
} from '@torqclaw/contracts';
import { getRegistry, type RegisteredTool } from './registry.js';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Stable JSON sufficient for this contract: object keys are sorted and arrays
 * are already normalized by resolveEffectiveProfile. */
export function canonicalizePolicy(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalizePolicy).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalizePolicy(value[key]!)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function namespaceOf(toolName: string): string {
  return toolName.split('__', 1)[0] ?? '';
}

function isNamespaceAllowed(tool: RegisteredTool, namespaces: readonly string[]): boolean {
  const namespace = namespaceOf(tool.name);
  return namespaces.includes('*') || namespaces.includes(namespace);
}

/**
 * Collab tools that genuinely mutate NOTHING. Everything else in the `collab`
 * namespace is classified `collab_write` (G2A NB-S2-1's fail-closed
 * inversion), so adding a tool here is a deliberate, reviewable assertion
 * that it is read-only -- not something a tool obtains by being named
 * inoffensively.
 */
const COLLAB_READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['collab__read_channel']);

function sideEffectFor(tool: RegisteredTool): SideEffectClass {
  // G1R V-S2-1 -- THIS ARM MUST STAY FIRST, ahead of the capability
  // short-circuits below.
  //
  // collab__post_message carries capability:'read' because the operator ruled
  // posting is SPEECH and requires no approval (capability drives
  // requiresApproval via isWriteClass -- that encoding is correct and must not
  // change). But `capability` is overloaded: the `=== 'read'` line below
  // short-circuits to side-effect 'none', asserting the tool mutates NOTHING.
  // For post_message that is false -- it commits a durable collab_events row.
  //
  // Proven by execution before this fix: resolveEffectiveProfile('read_only')
  // -- the repo's MOST restrictive profile, allowedSideEffects ['none'] --
  // admitted collab__post_message, rendered it to the model with
  // requiresApproval:false, and executing it committed a row (before=0,
  // after=1). isOperationAllowed could not catch it because the registry entry
  // and the profile snapshot shared the same false claim, and the policyHash
  // then certified it.
  //
  // Namespace-based, not capability-based, precisely so the two meanings stop
  // sharing one field. A future collab tool that only READS must set its own
  // truthful class rather than inherit this one.
  // Keyed on the tool's own name, NOT on capability -- capability is the very
  // field whose overloading caused this defect, so reusing it here would
  // rebuild the bug.
  //
  // G2A NB-S2-1: this arm now FAILS CLOSED within the collab namespace. The
  // first version matched write-ish verbs (/post|write|send|.../) and let
  // everything else fall through to 'none' -- so a FUTURE collab tool whose
  // name did not happen to match (collab__archive_channel,
  // collab__add_member, collab__ack) would silently inherit "mutates
  // nothing" and reappear in read_only. That is the same failure this arm
  // exists to fix, deferred to whoever adds the next tool.
  //
  // Inverted: everything in the collab namespace is 'collab_write' UNLESS it
  // is on an explicit read allowlist. Mirrors capability.ts's own posture --
  // "UNKNOWN NEVER MEANS READ" -- and makes the safe direction the default
  // one. A genuinely read-only collab tool must be DECLARED here, which is a
  // one-line, reviewable act rather than an accident of naming.
  if (namespaceOf(tool.name) === 'collab') {
    return COLLAB_READ_ONLY_TOOLS.has(tool.name) ? 'none' : 'collab_write';
  }
  if (tool.capability === 'read') return 'none';
  if (tool.capability === 'exec') return 'process';
  if (tool.capability === 'send') return 'network_send';
  const namespace = namespaceOf(tool.name);
  if (namespace === 'filesystem') return 'filesystem_write';
  if (namespace === 'browser' || namespace === 'playwright') return 'browser_mutation';
  return 'process';
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort() as T[];
}

function policyMaterial(profileId: ProfileId, tools: readonly RegisteredTool[]) {
  const definition = BUILT_IN_PROFILE_DEFINITIONS[profileId] as BuiltInProfileDefinition;
  const allowed = tools
    .filter(
      (tool) =>
        isNamespaceAllowed(tool, definition.allowedNamespaces) &&
        definition.allowedCapabilities.includes(tool.capability as CapabilityClass) &&
        definition.allowedSideEffects.includes(sideEffectFor(tool)),
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  const allowedOperationIds = allowed.map((tool) => tool.name);
  const operationCapabilities = Object.fromEntries(
    allowed.map((tool) => [tool.name, tool.capability]),
  ) as Record<string, CapabilityClass>;
  const operationSideEffects = Object.fromEntries(
    allowed.map((tool) => [tool.name, sideEffectFor(tool)]),
  ) as Record<string, SideEffectClass>;
  const operationApprovals = Object.fromEntries(
    allowed.map((tool) => [
      tool.name,
      tool.requiresApproval ||
        (tool.capability === 'write' && definition.approvalRequirements.write) ||
        (tool.capability === 'exec' && definition.approvalRequirements.exec) ||
        (tool.capability === 'send' && definition.approvalRequirements.send),
    ]),
  ) as Record<string, boolean>;

  return {
    schemaVersion: PROFILE_CONTRACT_VERSION,
    profileId,
    profileVersion: definition.profileVersion,
    toolRegistryVersion: TOOL_REGISTRY_VERSION,
    allowedOperationIds,
    capabilityClasses: sortedUnique(allowed.map((tool) => tool.capability as CapabilityClass)),
    sideEffectClasses: sortedUnique(allowed.map((tool) => sideEffectFor(tool))),
    allowedTiers: [...new Set(definition.allowedTiers)].sort(),
    operationCapabilities,
    operationSideEffects,
    operationApprovals,
    scopes: definition.scopes,
    approvalRequirements: definition.approvalRequirements,
  };
}

export function hashPolicyMaterial(material: JsonValue): string {
  return createHash('sha256').update(canonicalizePolicy(material)).digest('hex');
}

/** Resolve against an explicit snapshot in tests or the live registry in the
 * bridge. No I/O or mutation occurs here. */
export function resolveEffectiveProfile(
  profileId: ProfileId | string,
  tools: readonly RegisteredTool[] = getRegistry(),
): EffectiveProfile {
  const parsedProfile = ProfileIdSchema.safeParse(profileId);
  if (!parsedProfile.success) throw new Error(`Unknown effective profile '${String(profileId)}'`);
  const material = policyMaterial(parsedProfile.data, tools);
  return EffectiveProfileSchema.parse({
    ...material,
    policyHash: hashPolicyMaterial(material as unknown as JsonValue),
  });
}

export function isOperationAllowed(profile: EffectiveProfile, tool: RegisteredTool): boolean {
  return (
    profile.allowedOperationIds.includes(tool.name) &&
    profile.operationCapabilities[tool.name] === tool.capability &&
    profile.operationSideEffects[tool.name] === sideEffectFor(tool) &&
    profile.operationApprovals[tool.name] ===
      (tool.requiresApproval ||
        (tool.capability === 'write' && profile.approvalRequirements.write) ||
        (tool.capability === 'exec' && profile.approvalRequirements.exec) ||
        (tool.capability === 'send' && profile.approvalRequirements.send))
  );
}

/** The bridge re-resolves before execution and blocks stale policy snapshots. */
export function assertCurrentPolicy(profile: EffectiveProfile): void {
  const current = resolveEffectiveProfile(profile.profileId);
  if (current.policyHash !== profile.policyHash || current.toolRegistryVersion !== profile.toolRegistryVersion) {
    throw new Error(`Stale effective profile policy '${profile.profileId}'`);
  }
}

export function assertOperationAllowed(profile: EffectiveProfile, tool: RegisteredTool): void {
  assertCurrentPolicy(profile);
  if (!isOperationAllowed(profile, tool)) {
    throw new Error(`Tool '${tool.name}' is outside effective profile '${profile.profileId}'`);
  }
}

export type ProfileRelation = 'same' | 'stricter' | 'broader' | 'incomparable';

function isSubset<T>(left: readonly T[], right: readonly T[]): boolean {
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function retainedApprovalsAtLeastAsStrict(left: EffectiveProfile, right: EffectiveProfile): boolean {
  // Approval requirements for operations removed by a stricter profile are
  // irrelevant. Compare only operations both policies retain.
  return left.allowedOperationIds.every((operationId) => {
    if (!(operationId in right.operationApprovals)) return true;
    return !right.operationApprovals[operationId] || left.operationApprovals[operationId] === true;
  });
}

const pathBreadth = { none: 0, workspace: 1, configured: 2 } as const;
const networkBreadth = { none: 0, browser: 1, configured: 2 } as const;

function noBroaderScopes(left: EffectiveProfile, right: EffectiveProfile): boolean {
  return (
    pathBreadth[left.scopes.path] <= pathBreadth[right.scopes.path] &&
    networkBreadth[left.scopes.network] <= networkBreadth[right.scopes.network]
  );
}

/** Compare only what the policy proves. Cross-family profiles are deliberately
 * incomparable, so a caller cannot silently turn a stricter request into a
 * different kind of access. */
export function compareProfilePolicies(
  left: EffectiveProfile,
  right: EffectiveProfile,
): ProfileRelation {
  if (left.policyHash === right.policyHash) return 'same';
  const leftStricter =
    isSubset(left.allowedOperationIds, right.allowedOperationIds) &&
    isSubset(left.capabilityClasses, right.capabilityClasses) &&
    isSubset(left.sideEffectClasses, right.sideEffectClasses) &&
    retainedApprovalsAtLeastAsStrict(left, right) &&
    noBroaderScopes(left, right);
  const rightStricter =
    isSubset(right.allowedOperationIds, left.allowedOperationIds) &&
    isSubset(right.capabilityClasses, left.capabilityClasses) &&
    isSubset(right.sideEffectClasses, left.sideEffectClasses) &&
    retainedApprovalsAtLeastAsStrict(right, left) &&
    noBroaderScopes(right, left);
  if (leftStricter) return 'stricter';
  if (rightStricter) return 'broader';
  return 'incomparable';
}
