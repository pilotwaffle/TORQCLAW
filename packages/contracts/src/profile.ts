import { z } from 'zod';

/** Versioned wire identity for the effective policy bound to a task. */
export const PROFILE_CONTRACT_VERSION = 'torqclaw.effective-profile/v1' as const;
export const TOOL_REGISTRY_VERSION = 'torqclaw.tools/v1' as const;
export const PROFILE_VERSION = 1 as const;

export const ProfileIdSchema = z.enum([
  'read_only',
  'workspace_write',
  'browser_research',
  'terminal_power',
  // G1R COLLAB-WRITE-PROFILE ruling, PART 2. Reachable ONLY via the direct
  // dispatcher override in autoReplyDispatcher.ts's runAgentTurn -- NEVER
  // through DEFAULT_PROFILE_BY_TASK (profileResolver.ts) or ordinary task
  // submission (enrich.ts passes no requestedProfile). See profileResolver.ts
  // for the pinned escalation-invariant tests.
  'agent_conversation',
]);
export type ProfileId = z.infer<typeof ProfileIdSchema>;

export const CapabilityClassSchema = z.enum(['read', 'write', 'exec', 'send']);
export type CapabilityClass = z.infer<typeof CapabilityClassSchema>;

export const SideEffectClassSchema = z.enum([
  'none',
  'filesystem_write',
  'browser_mutation',
  'process',
  'network_send',
  // G1R V-S2-1. Commits a row to the collab substrate (collab_events) --
  // durable, visible to every channel member, and NOT reversible by the
  // caller. Distinct from 'none' because it mutates, and distinct from
  // 'filesystem_write'/'network_send' because it touches neither.
  //
  // WHY THIS EXISTS AS ITS OWN CLASS: the operator ruled that posting a
  // message is SPEECH and requires no approval, and that ruling is encoded
  // faithfully as capability:'read' (which drives requiresApproval via
  // isWriteClass). But `capability` carries a SECOND meaning in
  // profilePolicy.ts's sideEffectFor(), where 'read' short-circuits to
  // 'none' -- an assertion that the tool mutates NOTHING. That is false for
  // collab__post_message, and it let the read_only profile (allowedSideEffects
  // ['none']) admit it, render it to the model, and commit a row.
  //
  // "Free of approval" and "free of effect" are different claims. The operator
  // ruled the first. Nobody ruled the second.
  'collab_write',
]);
export type SideEffectClass = z.infer<typeof SideEffectClassSchema>;

export const PathScopePolicySchema = z.enum(['none', 'workspace', 'configured']);
export type PathScopePolicy = z.infer<typeof PathScopePolicySchema>;

export const NetworkScopePolicySchema = z.enum(['none', 'browser', 'configured']);
export type NetworkScopePolicy = z.infer<typeof NetworkScopePolicySchema>;

export const ApprovalRequirementsSchema = z.object({
  write: z.boolean(),
  exec: z.boolean(),
  send: z.boolean(),
});
export type ApprovalRequirements = z.infer<typeof ApprovalRequirementsSchema>;

export const ProfileScopesSchema = z.object({
  path: PathScopePolicySchema,
  network: NetworkScopePolicySchema,
});
export type ProfileScopes = z.infer<typeof ProfileScopesSchema>;

export const ProfileTierSchema = z.enum(['LOCAL_EDGE', 'FRONTIER']);
export type ProfileTier = z.infer<typeof ProfileTierSchema>;

/** Declarative policy shipped by TORQCLAW. Registry-specific operation IDs are
 * resolved later, so this contract remains independent of MCP availability. */
export const BuiltInProfileDefinitionSchema = z.object({
  profileId: ProfileIdSchema,
  profileVersion: z.literal(PROFILE_VERSION),
  allowedNamespaces: z.array(z.string()),
  allowedCapabilities: z.array(CapabilityClassSchema),
  allowedSideEffects: z.array(SideEffectClassSchema),
  allowedTiers: z.array(ProfileTierSchema),
  scopes: ProfileScopesSchema,
  approvalRequirements: ApprovalRequirementsSchema,
});
export type BuiltInProfileDefinition = z.infer<typeof BuiltInProfileDefinitionSchema>;

/** The v1 built-in profiles. Namespace matching is exact on the server ID
 * before the `__` separator; `*` means any registered namespace. */
export const BUILT_IN_PROFILE_DEFINITIONS = {
  read_only: {
    profileId: 'read_only',
    profileVersion: PROFILE_VERSION,
    allowedNamespaces: ['*'],
    allowedCapabilities: ['read'],
    allowedSideEffects: ['none'],
    allowedTiers: ['LOCAL_EDGE'],
    scopes: { path: 'none', network: 'none' },
    approvalRequirements: { write: false, exec: false, send: false },
  },
  workspace_write: {
    profileId: 'workspace_write',
    profileVersion: PROFILE_VERSION,
    allowedNamespaces: ['filesystem'],
    allowedCapabilities: ['read', 'write'],
    allowedSideEffects: ['none', 'filesystem_write'],
    allowedTiers: ['LOCAL_EDGE', 'FRONTIER'],
    scopes: { path: 'workspace', network: 'none' },
    approvalRequirements: { write: true, exec: false, send: false },
  },
  browser_research: {
    profileId: 'browser_research',
    profileVersion: PROFILE_VERSION,
    allowedNamespaces: ['browser', 'playwright', 'research'],
    allowedCapabilities: ['read'],
    allowedSideEffects: ['none'],
    allowedTiers: ['LOCAL_EDGE', 'FRONTIER'],
    scopes: { path: 'none', network: 'browser' },
    approvalRequirements: { write: false, exec: false, send: false },
  },
  terminal_power: {
    profileId: 'terminal_power',
    profileVersion: PROFILE_VERSION,
    allowedNamespaces: ['desktop_commander', 'sandbox', 'shell', 'terminal'],
    allowedCapabilities: ['read', 'write', 'exec'],
    allowedSideEffects: ['none', 'process'],
    allowedTiers: ['LOCAL_EDGE', 'FRONTIER'],
    scopes: { path: 'configured', network: 'configured' },
    approvalRequirements: { write: true, exec: true, send: false },
  },
  // G1R COLLAB-WRITE-PROFILE ruling §1/§10. Unblocks agent-to-agent
  // conversation (collab__post_message) without widening any existing
  // profile's blast radius. See profileResolver.ts's resolveProfile call
  // sites for how this is reached (dispatcher override only) and how
  // escalation through ordinary task submission is prevented.
  agent_conversation: {
    profileId: 'agent_conversation',
    profileVersion: PROFILE_VERSION,
    // LOAD-BEARING (ruling §1 Amendment 2): the ONLY conjunct preventing
    // this profile from admitting every read-capable tool in the entire
    // registry. capability:'read' short-circuits sideEffectFor() to 'none'
    // (profilePolicy.ts), which this profile also admits -- so widening this
    // to '*' would instantly turn this into read_only PLUS collab-write.
    // This restriction is the containment boundary, not stylistic scoping.
    allowedNamespaces: ['collab'],
    allowedCapabilities: ['read'],
    // 'none' is REQUIRED, not slack: without it collab__read_channel (side
    // effect 'none') drops out and the agent can post but never read, which
    // the auto-reply prompt explicitly instructs it to do first.
    allowedSideEffects: ['none', 'collab_write'],
    // Unattended. FRONTIER's approval posture for an agent-authored,
    // unattended prompt has never been evaluated (autoReplyDispatcher.ts's
    // forced-LOCAL_EDGE comment) -- do not widen this without that review.
    allowedTiers: ['LOCAL_EDGE'],
    scopes: { path: 'none', network: 'none' },
    // Inert-by-construction (ruling §1 Amendment 3), NOT a policy choice:
    // policyMaterial's approval derivation keys on
    // capability === 'write' | 'exec' | 'send'. post_message is
    // capability:'read' (the operator's speech ruling), so none of these
    // three flags can EVER fire for it regardless of value. Flipping
    // `write: true` here to "add approval to posting" would be inert
    // theatre -- it gates nothing. If posting ever needs approval, that
    // requires a different mechanism, not this object.
    approvalRequirements: { write: false, exec: false, send: false },
  },
} satisfies Record<ProfileId, BuiltInProfileDefinition>;

/**
 * G1R COLLAB-WRITE-PROFILE ruling §9C/§9D (converged, "build as ONE
 * artifact"). Root cause of the `collab_write`/`browser_mutation`/
 * `network_send`/send defect class: a side-effect or capability class can be
 * ADDED to the enums above with no decision about which profile (if any)
 * admits it, and nothing fails -- the tool is just silently dropped from
 * every model's rendered tool list (toolFilter.ts's `.filter()`, no throw,
 * no log). This map closes that gap at BUILD TIME: every member of
 * SideEffectClassSchema and CapabilityClassSchema must appear here, mapped
 * either to the profile(s) that admit it or to the literal
 * 'INTENTIONALLY_UNADMITTED' sentinel with a reason. Adding an enum member
 * without a decision here is a TypeScript compile error (the `satisfies
 * Record<...>` below is exhaustive over the enum), not a silent gap.
 *
 * THE RESERVED HALF IS ESSENTIAL, not a softening: without it, the only way
 * to make a "is this class reachable" test pass is to GRANT the class to
 * some profile -- turning a detector into a privilege-escalation pump. Each
 * 'INTENTIONALLY_UNADMITTED' entry is validated (assertSideEffectAdmissionMap
 * / assertCapabilityAdmissionMap below) against BUILT_IN_PROFILE_DEFINITIONS
 * itself, so this map cannot drift into a second, lying copy of the truth --
 * it is checked, not merely documented.
 *
 * G2A NB-3: this comment previously named `profile-conformance-runtime.test.ts`
 * as the exercising suite. It is NOT -- the validators are called from
 * `tests/profile-conformance-declared.test.ts` and `tests/profile-policy.test.ts`
 * (grep-verified). The wrong pointer cost a reviewer a misleading 18/18 from the
 * file it named before they found the real one. A citation that sends the next
 * reader to the wrong place is the same defect class as a comment asserting a
 * guard the code does not perform.
 */
export const SIDE_EFFECT_ADMISSION: Record<SideEffectClass, ProfileId[] | 'INTENTIONALLY_UNADMITTED'> = {
  none: ['read_only', 'workspace_write', 'browser_research', 'terminal_power', 'agent_conversation'],
  filesystem_write: ['workspace_write'],
  // RESERVED-BY-DEFECT, not by design (ruling §9D). browser_research is the
  // only browser-namespace profile and it sets allowedCapabilities:['read'];
  // sideEffectFor() only ever derives 'browser_mutation' for a NON-read
  // capability. The two conjuncts are mutually exclusive by construction, so
  // no click/type/fill tool has ever been admissible by any profile despite
  // toolFilter.ts routing playwright__ tools to three task types. Do NOT
  // grant this as a side effect of making a conformance test green -- it
  // needs its own threat-model review (unattended browser mutation is a
  // materially larger question than posting to a channel). Filed, not fixed,
  // by this ruling.
  browser_mutation: 'INTENTIONALLY_UNADMITTED',
  process: ['terminal_power'],
  // RESERVED: no profile grants messaging. Previously pinned by a bespoke
  // assertion in profile-conformance-declared.test.ts; this map subsumes
  // that one-off test with the general reachability form.
  network_send: 'INTENTIONALLY_UNADMITTED',
  collab_write: ['agent_conversation'],
};

export const CAPABILITY_ADMISSION: Record<CapabilityClass, ProfileId[] | 'INTENTIONALLY_UNADMITTED'> = {
  read: ['read_only', 'workspace_write', 'browser_research', 'terminal_power', 'agent_conversation'],
  write: ['workspace_write', 'terminal_power'],
  exec: ['terminal_power'],
  // RESERVED: capability:'send' is fully plumbed (classifyByNameTokens can
  // produce it; policyMaterial's approval derivation branches on it) but no
  // profile has ever admitted it, so the consuming branches are unreachable
  // dead code today. Same reason as network_send above -- messaging has no
  // grant decision yet, filed not fixed.
  send: 'INTENTIONALLY_UNADMITTED',
};

/** Runtime validation that SIDE_EFFECT_ADMISSION is not a second, lying copy
 * of BUILT_IN_PROFILE_DEFINITIONS: every listed profile must genuinely admit
 * that side-effect class, and every 'INTENTIONALLY_UNADMITTED' entry must
 * genuinely appear in NO profile's allowedSideEffects. Called from
 * profile-conformance-runtime.test.ts; also safe to call at any startup
 * path that wants a fail-fast guarantee. */
export function assertSideEffectAdmissionMap(
  definitions: Record<ProfileId, BuiltInProfileDefinition> = BUILT_IN_PROFILE_DEFINITIONS,
): void {
  for (const sideEffect of SideEffectClassSchema.options) {
    const entry = SIDE_EFFECT_ADMISSION[sideEffect];
    if (entry === 'INTENTIONALLY_UNADMITTED') {
      for (const [profileId, def] of Object.entries(definitions) as [ProfileId, BuiltInProfileDefinition][]) {
        if (def.allowedSideEffects.includes(sideEffect)) {
          throw new Error(
            `SIDE_EFFECT_ADMISSION drift: '${sideEffect}' is marked INTENTIONALLY_UNADMITTED ` +
            `but profile '${profileId}' admits it`,
          );
        }
      }
      continue;
    }
    for (const profileId of entry) {
      if (!definitions[profileId].allowedSideEffects.includes(sideEffect)) {
        throw new Error(
          `SIDE_EFFECT_ADMISSION drift: claims '${profileId}' admits '${sideEffect}' but it does not`,
        );
      }
    }
    const admittedBy = (Object.entries(definitions) as [ProfileId, BuiltInProfileDefinition][])
      .filter(([, def]) => def.allowedSideEffects.includes(sideEffect))
      .map(([id]) => id);
    if (admittedBy.length === 0) {
      throw new Error(
        `SIDE_EFFECT_ADMISSION drift: '${sideEffect}' lists admitting profiles but NONE actually admit it`,
      );
    }
  }
}

/** Same validation as assertSideEffectAdmissionMap, for CAPABILITY_ADMISSION
 * against allowedCapabilities. */
export function assertCapabilityAdmissionMap(
  definitions: Record<ProfileId, BuiltInProfileDefinition> = BUILT_IN_PROFILE_DEFINITIONS,
): void {
  for (const capability of CapabilityClassSchema.options) {
    const entry = CAPABILITY_ADMISSION[capability];
    if (entry === 'INTENTIONALLY_UNADMITTED') {
      for (const [profileId, def] of Object.entries(definitions) as [ProfileId, BuiltInProfileDefinition][]) {
        if (def.allowedCapabilities.includes(capability)) {
          throw new Error(
            `CAPABILITY_ADMISSION drift: '${capability}' is marked INTENTIONALLY_UNADMITTED ` +
            `but profile '${profileId}' admits it`,
          );
        }
      }
      continue;
    }
    for (const profileId of entry) {
      if (!definitions[profileId].allowedCapabilities.includes(capability)) {
        throw new Error(
          `CAPABILITY_ADMISSION drift: claims '${profileId}' admits '${capability}' but it does not`,
        );
      }
    }
    const admittedBy = (Object.entries(definitions) as [ProfileId, BuiltInProfileDefinition][])
      .filter(([, def]) => def.allowedCapabilities.includes(capability))
      .map(([id]) => id);
    if (admittedBy.length === 0) {
      throw new Error(
        `CAPABILITY_ADMISSION drift: '${capability}' lists admitting profiles but NONE actually admit it`,
      );
    }
  }
}

export const EffectiveProfileSchema = z.object({
  schemaVersion: z.literal(PROFILE_CONTRACT_VERSION),
  profileId: ProfileIdSchema,
  profileVersion: z.literal(PROFILE_VERSION),
  toolRegistryVersion: z.string().min(1),
  allowedOperationIds: z.array(z.string()),
  /** Aggregate fields are useful for display; operation maps are authoritative. */
  capabilityClasses: z.array(CapabilityClassSchema),
  sideEffectClasses: z.array(SideEffectClassSchema),
  allowedTiers: z.array(ProfileTierSchema),
  operationCapabilities: z.record(z.string(), CapabilityClassSchema),
  operationSideEffects: z.record(z.string(), SideEffectClassSchema),
  operationApprovals: z.record(z.string(), z.boolean()),
  scopes: ProfileScopesSchema,
  approvalRequirements: ApprovalRequirementsSchema,
  policyHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type EffectiveProfile = z.infer<typeof EffectiveProfileSchema>;

export const EffectiveProfileMaterialSchema = EffectiveProfileSchema.omit({ policyHash: true });
export type EffectiveProfileMaterial = z.infer<typeof EffectiveProfileMaterialSchema>;
