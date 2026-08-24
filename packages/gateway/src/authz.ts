import type { ClientCommand } from '@torqclaw/contracts';

/** Persisted session role — the ONLY source of truth for authorization.
 *  Never trust a role carried on a per-frame command; it is read from the
 *  sessions table at connect time and threaded through as ctx. */
export type Role = 'operator' | 'channel' | 'node';

export type AuthzDecision = { ok: true } | { ok: false; reason: string };

export interface AuthzContext {
  /** Resolve a task's owning session id, or null if the task is unknown. */
  lookupTaskSession: (taskId: string) => string | null;
  /** The commanding connection's own (persisted) session id. */
  sessionId: string;
  /**
   * C1-4 / H-1: the surface layer for THIS connection, when the collab
   * substrate is on and the connection authenticated with a C1 surface.
   *
   * Absent (undefined) means "no surface layer to intersect with" — either
   * the flag is off or this is a legacy/root-token connection — and the
   * operator short-circuit resolves to today's blanket ALLOW, byte-
   * identically (§2.7.1 flag semantics).
   */
  surface?: SurfaceAuthzContext;
  /**
   * PRD-TCLAW-AGENT-PARTICIPATION-007 S1: true when — and ONLY when — ALL of
   * the following hold, all computed by the caller (server.ts) from live
   * server-derived state, never from a client frame:
   *   1. TORQCLAW_AGENT_PARTICIPATION is truthy (this slice's own flag);
   *   2. collabSurfaceCommandsEnabled() is true (inherits 005's narrowing,
   *      so this can never re-enable a surface 005's flags turned off);
   *   3. this connection's resolved collab principal is REAL (a non-null
   *      binding from a verified tq1_ credential) AND that principal's
   *      `kind` — read from the collab DB, never asserted by the caller —
   *      is 'agent'.
   *
   * This is the ONE seat-lattice widening this slice adds (§2 of the PRD):
   * a `node`-seat connection backed by a verified agent collab principal may
   * reach POST_CHANNEL_MESSAGE. It grants NOTHING else — every other action
   * on the `node` role is still DENY_NOT_PERMITTED below, unchanged. The
   * gateway SEAT decision here is deliberately kept separate from the
   * substrate SUBJECT check: this field only says "this seat may attempt
   * the command class"; assertChannelVisible (store.ts) still independently
   * decides whether THIS principal may write to THIS channel.
   *
   * Absent (undefined/false) is today's behaviour byte-identically: role
   * 'node' denies every action, exactly as before this slice.
   */
  agentCollabWrite?: boolean;
}

/**
 * The presenting surface's own authority/capability, read from the live
 * gateway projection by the caller (server.ts) — never from a client frame.
 */
export interface SurfaceAuthzContext {
  surfaceId: string;
  /**
   * The presenting surface's CURRENT role, read live at decision time.
   *
   * A function, not a value: a value copied at connect goes stale the
   * moment the surface is re-provisioned, and an operator surface demoted
   * to `agent` mid-connection would keep passing this check for the life
   * of the socket (G2A round 1). Returns null when there is no live
   * projection -- which denies, same as any other missing enforcement
   * state.
   */
  currentRole: () => 'operator' | 'agent' | 'automation' | null;
  /** Live, current-epoch control-plane authority check (holdsAuthority). */
  holdsAuthority: (authority: 'approve' | 'cancel' | 'delegate') => boolean;
}

const DENY_SURFACE_NOT_OPERATOR: AuthzDecision = {
  ok: false, reason: 'presenting surface is not an operator-role surface',
};
const DENY_AUTHORITY: AuthzDecision = {
  ok: false, reason: 'presenting surface does not hold the required control-plane authority',
};

const DENY_NOT_PERMITTED: AuthzDecision = { ok: false, reason: 'action not permitted for this role' };
const DENY_NOT_OWNED: AuthzDecision = { ok: false, reason: 'task not owned by this session' };
const ALLOW: AuthzDecision = { ok: true };

/**
 * Resume-role enforcement now belongs to sessions.resolve(): it compares the
 * persisted server-derived role with the newly authenticated caller role and
 * refuses a mismatch without minting a replacement session.
 *
 * Client frame.role/expectedRole fields are assertions checked separately;
 * neither field participates in persisted authority.
 */
/**
 * Allow-list authorization, default DENY for anything not explicitly granted
 * to a non-operator role. Pure function, no I/O — ctx.lookupTaskSession is the
 * only side-channel, injected by the caller (server.ts) against the real DB.
 *
 * Policy:
 *   operator — every action allowed (including CANCEL_TASK on an unknown task;
 *              downstream that's a harmless no-op).
 *   channel  — SUBMIT_PROMPT: allow.
 *              MEMORY: allow only op === 'SHOW'; FORGET_SESSION denies.
 *              CANCEL_TASK: allow only if the task is owned by this session
 *              (lookupTaskSession returns a sessionId === ctx.sessionId);
 *              unknown/not-found task denies.
 *              Everything else (APPROVE_TOOL, APPROVE_SKILL, GET_SKILL_DRAFT,
 *              LIST_RECEIPTS, GET_RECEIPT, GET_COST_SUMMARY, any
 *              future/unmapped action) — deny.
 *              (TCLAW-4B: receipts are an operator-only surface for now — the
 *              per-session read scoping in listReceipts/getReceipt would make
 *              a channel grant safe in principle, but there is no product
 *              need yet, so both stay on the default-deny path below rather
 *              than earning an explicit allow branch.)
 *              (TCLAW-1B: GET_COST_SUMMARY is operator-only for the same
 *              reason PLUS a stronger one — dailyTotal is a cross-session,
 *              GLOBAL aggregate. Even though the summary itself is
 *              session-scoped in shape, cost telemetry (including the
 *              cross-session daily total) is operator-only by design, so this
 *              gets an explicit channel deny below, not just default-deny.)
 *              (TCLAW-2D-1: PREVIEW_ROUTE can trigger unmetered local
 *              inference (classifier call, GPU occupancy) and produces no
 *              task, no receipt, and no audit trail — it is not
 *              channel-grantable until real rate limiting exists. Explicit
 *              deny so the decision is legible and pinned by a test.)
 *              (TCLAW-5A-1: LIST_APPROVALS is operator-only — the live
 *              approval card (APPROVE_TOOL) is operator-only, so its history
 *              must be too; approval telemetry reveals gated tool names and
 *              decision timing across the session. Explicit deny so the
 *              decision is legible and pinned by a test.)
 *              (TCLAW-5B-1: GET_SAFE_EXPORT is operator-only — GET_RECEIPT is
 *              operator-only and the export is derived from the exact same
 *              row, so a channel grant would be a side door around that
 *              decision. This is a STRONGER reason than most other explicit
 *              denies here: this command's whole design intent is to produce
 *              an artifact that may LEAVE THE MACHINE (pasted into a support
 *              channel, an issue, a chat), whereas GET_RECEIPT stays in the
 *              same trust domain (in-console only). "Redacted" must never be
 *              read as "safe for a lower trust tier" — the redactor only
 *              removes KNOWN secret shapes, never guarantees the absence of
 *              secrets, so widening who can trigger an export would widen who
 *              can accidentally exfiltrate whatever the redactor misses.
 *              [G1R SC-1] Note: the export payload includes sessionId as a
 *              labeled support correlator by explicit decision — this is
 *              unrelated to the authz posture above (which governs who may
 *              TRIGGER the export, not what a triggered export contains).
 *              Explicit deny so the decision is legible and pinned by a test.)
 *              (PRD-TCLAW-COLLAB-PRESENCE-UI-005 S3: POST_CHANNEL_MESSAGE is
 *              operator-seat-only for the same reason as LIST_CHANNELS/
 *              GET_CHANNEL_TIMELINE above -- the seat lattice and the
 *              substrate principal lattice are never conflated; explicit
 *              deny so the decision is legible and pinned by a test.)
 *   node     — every action denied, EXCEPT: PRD-TCLAW-AGENT-PARTICIPATION-007
 *              S1 admits POST_CHANNEL_MESSAGE when ctx.agentCollabWrite is
 *              true (see AuthzContext's doc comment for the full, narrow
 *              precondition the caller must have already verified). This is
 *              the ONE widening this slice makes to the node seat; every
 *              other action on 'node' is unaffected and still denies.
 */
export function authorize(role: Role, cmd: ClientCommand, ctx: AuthzContext): AuthzDecision {
  if (role === 'operator') return authorizeOperator(cmd, ctx);
  if (role === 'node') {
    // PRD-TCLAW-AGENT-PARTICIPATION-007 S1: the gateway SEAT lattice and the
    // substrate PRINCIPAL lattice are never conflated (§2a, inherited from
    // 005). This is a SEAT-class decision only -- "may a node-seat
    // connection attempt POST_CHANNEL_MESSAGE at all" -- never a membership
    // or visibility decision, which remains entirely the substrate's
    // (assertChannelVisible, store.ts) regardless of this branch's outcome.
    // ctx.agentCollabWrite is computed by the caller (server.ts) from live,
    // server-derived state -- the flag, collabSurfaceCommandsEnabled(), and
    // a real DB read of the connected principal's kind -- never from
    // anything a client frame carries. Absent/false is byte-identical to
    // pre-S1 behaviour: DENY_NOT_PERMITTED for every action.
    if (cmd.action === 'POST_CHANNEL_MESSAGE' && ctx.agentCollabWrite === true) {
      return ALLOW;
    }
    return DENY_NOT_PERMITTED;
  }

  // role === 'channel'
  switch (cmd.action) {
    case 'SUBMIT_PROMPT':
      return ALLOW;
    case 'MEMORY':
      return cmd.op === 'SHOW' ? ALLOW : DENY_NOT_PERMITTED;
    case 'CANCEL_TASK': {
      const owner = ctx.lookupTaskSession(cmd.taskId);
      if (owner == null) return DENY_NOT_OWNED;
      return owner === ctx.sessionId ? ALLOW : DENY_NOT_OWNED;
    }
    case 'APPROVE_TOOL':
    case 'APPROVE_SKILL':
    case 'GET_SKILL_DRAFT':
    case 'LIST_RECEIPTS':
    case 'GET_RECEIPT':
    case 'GET_COST_SUMMARY':
    case 'PREVIEW_ROUTE':
    case 'LIST_APPROVALS':
    case 'GET_SAFE_EXPORT':
      return DENY_NOT_PERMITTED;
    // PRD-TCLAW-COLLAB-PRESENCE-UI-005 S1: the gateway SEAT lattice and the
    // substrate PRINCIPAL lattice are never conflated (§2a). A channel seat
    // is a transport identity (channel-http), not a collab surface
    // credential holder, and gets no read entitlement to the collab wire
    // surface regardless of what a bare `default:` below would otherwise
    // resolve to -- explicit named deny so the decision is legible and
    // pinned by a test (house pattern, matching every other arm here).
    case 'LIST_CHANNELS':
    case 'SET_CHANNEL_EXTERNAL_EXPORT_POLICY':
    case 'LIST_AGENTS':
    case 'LIST_AGENT_PROVIDERS':
    case 'CREATE_AGENT':
    // G1D channels-agent-UX packet (2026-08-24) Item B(ii): local-agent
    // autostart inherits the exact same seat-lattice ruling as
    // CREATE_AGENT/UPDATE_AGENT_PROFILE above -- a non-operator seat gets
    // no entitlement to this collab-surface mutation.
    case 'SET_LOCAL_AGENT_AUTOSTART':
    case 'GET_CHANNEL_TIMELINE':
    // PRD-007 S4-Members: LIST_CHANNEL_MEMBERS inherits the exact same
    // seat-lattice ruling as LIST_CHANNELS/GET_CHANNEL_TIMELINE above -- a
    // channel seat is a transport identity (channel-http), not a collab
    // surface credential holder, and gets no read entitlement to the
    // collab wire surface regardless of what a bare `default:` below would
    // otherwise resolve to. Explicit named deny so the decision is legible
    // and pinned by a test (house pattern, matching every other arm here).
    case 'LIST_CHANNEL_MEMBERS':
    // PRD-TCLAW-COLLAB-PRESENCE-UI-005 S3: POST_CHANNEL_MESSAGE is the only
    // new mutation this PRD's surface adds (§5), and it inherits the exact
    // same seat-lattice ruling as the S1 reads above -- a channel seat is a
    // transport identity (channel-http), not a collab surface credential
    // holder, and gets no write entitlement to the collab wire surface
    // regardless of what the default: arm below would otherwise resolve to.
    // Explicit named deny so the decision is legible and pinned by a test
    // (T-3), matching every other arm in this switch.
    case 'POST_CHANNEL_MESSAGE':
    // PRD-TCLAW-COLLAB-PRESENCE-UI-005 S6: ACK_CHANNEL_CURSOR inherits the
    // exact same seat-lattice ruling as the S1 reads and the S3 mutation
    // above -- a channel seat is a transport identity (channel-http), not a
    // collab surface credential holder, and gets no entitlement to mutate
    // per-principal read state either. Explicit named deny so the decision
    // is legible and pinned by a test, matching every other arm here. The
    // node seat remains default-deny (no agentCollabWrite widening -- read
    // state is the 005 operator surface's subject, never an agent's).
    case 'ACK_CHANNEL_CURSOR':
    // PRD-TCLAW-AGENT-PARTICIPATION-007 S3 (R-3a): SET_AUTOREPLY_STOP is
    // operator-seat-only, explicit deny for a channel seat, matching every
    // other collab-surface command above. STOP is a control-plane action,
    // not a conversational one -- there is no product reason for a
    // channel-transport seat (channel-http) to hold it, and an explicit
    // named deny keeps the decision legible and test-pinned rather than
    // falling through to the default: arm below.
    case 'SET_AUTOREPLY_STOP':
    // CRON slice (G1R Gate-1 §2A): schedule management is operator-seat-only,
    // matching SET_AUTOREPLY_STOP's exact reasoning above -- a schedule is a
    // control-plane action (it creates a TRIGGER, never an authority grant;
    // see cron.ts's module doc), not a conversational one. No agent-reachable
    // path exists to any of the three actions below: they are not collab
    // tools, so no message content or model output can ever reach them
    // (mirrors INV-T1 Corollary C's sibling for STOP).
    case 'CREATE_SCHEDULE':
    case 'SET_SCHEDULE_STATE':
    case 'LIST_SCHEDULES':
    // G1D channels-agent-UX packet (2026-08-24), Amendment 1 Item D / delta-
    // G1R ND-4: ADD_CHANNEL_MEMBER/REMOVE_CHANNEL_MEMBER are operator-seat-
    // only, same authz class as the agent mutations above (CREATE_AGENT/
    // UPDATE_AGENT_PROFILE/LIST_AGENTS/SET_LOCAL_AGENT_AUTOSTART). A channel
    // seat is a transport identity (channel-http), not a collab surface
    // credential holder, and gets no entitlement to mutate channel
    // membership regardless of what the default: arm below would otherwise
    // resolve to. Explicit named deny so the decision is legible and
    // test-pinned (T-D5), matching every other arm in this switch. The
    // 'node' seat is UNCHANGED -- both actions fall through the existing
    // default deny below; the agentCollabWrite widening remains scoped to
    // POST_CHANNEL_MESSAGE only.
    case 'ADD_CHANNEL_MEMBER':
    case 'REMOVE_CHANNEL_MEMBER':
      return DENY_NOT_PERMITTED;
    default:
      // Default deny for any future/unmapped action on a non-operator role.
      return DENY_NOT_PERMITTED;
  }
}

/**
 * Ruling H-1 (FROZEN, §2.7.1) — subordinate the operator short-circuit.
 *
 * THE HOLE THIS CLOSES
 * --------------------
 * `authorize` used to answer `if (role === 'operator') return ALLOW` for
 * EVERY command, consulting nothing below the principal layer. That is a
 * blanket, unconditional operator authority class: a compromised operator
 * SURFACE inherits the principal's full authority, because the check never
 * looks at which surface is actually presenting.
 *
 * The corrected layering (no shortcut may skip a lower layer):
 *
 *   principal authority
 *     -> surface/session authority (what THIS surface actually holds)
 *       -> requested capability / authority token
 *         -> specific operation (the ClientCommand action)
 *           -> specific resource / task
 *
 * WHAT INTERSECTION MEANS HERE
 * -----------------------------
 * Operator authority is INTERSECTED with the presenting surface's held
 * authority. An operator principal acting through a limited or compromised
 * surface gets only what THAT surface holds -- never the full principal
 * authority.
 *
 * `APPROVE_TOOL` is the first command to carry a reserved control-plane
 * AUTHORITY (`approve`, ruling AR-1). It is gated on the surface being
 * operator-ROLE *and* holding a live current-epoch `approve` grant, read
 * from `surface_authorities` -- the authority path, NEVER the execution-
 * capability path. A surface holding every execution capability still
 * cannot approve.
 *
 * Other operator commands keep today's behaviour: C1 introduces exactly one
 * authority token, and inventing gates for commands the PRD has not
 * specified would be scope drift with real lockout risk. They intersect
 * against a surface layer that currently constrains only `approve`.
 *
 * FLAG SEMANTICS (§2.7.1, §1.2 constraint 4)
 * -------------------------------------------
 * When `ctx.surface` is absent -- flag off, or a legacy/root-token
 * connection -- there is no surface authority to intersect, so this
 * resolves to the legacy blanket ALLOW byte-identically. Enabling a
 * subsystem and changing security behaviour stay separate, individually
 * revertable decisions.
 */
function authorizeOperator(cmd: ClientCommand, ctx: AuthzContext): AuthzDecision {
  const surface = ctx.surface;

  if (
    cmd.action === 'CREATE_AGENT'
    || cmd.action === 'UPDATE_AGENT_PROFILE'
    || cmd.action === 'LIST_AGENTS'
    || cmd.action === 'SET_LOCAL_AGENT_AUTOSTART'
    // G1D channels-agent-UX packet (2026-08-24), Amendment 1 Item D / delta-
    // G1R ND-4: ADD_CHANNEL_MEMBER/REMOVE_CHANNEL_MEMBER join the EXACT SAME
    // operator + live-delegate authority gate as the agent-mutation commands
    // above -- no new authority token, no parallel formula. The store's own
    // assertChannelOwner (store.ts:3507) re-asserts channel ownership inside
    // the transaction regardless (ND-1/ND-5: "surface AND store
    // re-assertion"), so this surface-layer gate is defense in depth, not
    // the sole enforcement point.
    || cmd.action === 'ADD_CHANNEL_MEMBER'
    || cmd.action === 'REMOVE_CHANNEL_MEMBER'
  ) {
    if (!surface) return DENY_AUTHORITY;
    if (surface.currentRole() !== 'operator') return DENY_SURFACE_NOT_OPERATOR;
    return surface.holdsAuthority('delegate') ? ALLOW : DENY_AUTHORITY;
  }

  // No surface layer => legacy behaviour, unchanged (SI-4).
  if (!surface) return ALLOW;

  if (
    cmd.action === 'LIST_AGENT_PROVIDERS'
  ) {
    return surface.currentRole() === 'operator' ? ALLOW : DENY_SURFACE_NOT_OPERATOR;
  }

  // Phase 4 (R-10a, PRD-TCLAW-REMOTE-SKILL-SOURCES-005 §2/§7.1): APPROVE_SKILL
  // joins the approve-authority gate. Specified against current master
  // independently -- it inherits nothing from any other lane. The deeper,
  // writer-level re-check for a remote (signed) skill lives with the kernel
  // decision seam (skill_queue.decide -- approval-token digest binding plus
  // activation-time trust evaluation via _enforce_activation_policy), so this
  // gate is a surface gate, never the enforcement of record. Lockout surface
  // is identical to APPROVE_TOOL's: an operator surface without a live
  // `approve` grant loses skill approval ONLY when ctx.surface is present
  // (collab flag on + C1 surface); flag-off/legacy connections keep today's
  // blanket allow byte-identically (the `if (!surface) return ALLOW;` above).
  if (cmd.action === 'APPROVE_TOOL' || cmd.action === 'APPROVE_SKILL') {
    // CT-2 decision-time enforcement: operator ROLE is required, and role
    // is the predicate -- never surface kind (§3.14).
    //
    // Read LIVE, never from a value captured at connect: a demotion that
    // lands mid-connection must bite on the very next command. Null (no
    // live projection) denies.
    if (surface.currentRole() !== 'operator') return DENY_SURFACE_NOT_OPERATOR;
    // The single authority seam. Absence, revocation, epoch drift, or a
    // missing/stale projection all resolve to false => deny (fail-closed).
    if (!surface.holdsAuthority('approve')) return DENY_AUTHORITY;
    return ALLOW;
  }

  return ALLOW;
}
