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

/** The four v1 profiles. Namespace matching is exact on the server ID before
 * the `__` separator; `*` means any registered namespace. */
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
    allowedNamespaces: ['browser', 'playwright', 'websearch'],
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
} satisfies Record<ProfileId, BuiltInProfileDefinition>;

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
