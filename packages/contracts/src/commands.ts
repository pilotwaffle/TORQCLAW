import { z } from 'zod';
import { SubscriptionProviderIdSchema } from './routing.js';

/** Dumb client, smart server: the ONLY judgment calls the client makes
 *  are things only the user can know. */
export const ClientCommandSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('SUBMIT_PROMPT'),
    prompt: z.string().min(1).max(32_000),
    sensitive: z.boolean().default(false),
    urgent: z.boolean().default(false),
    attachmentIds: z.array(z.string()).default([]),
    // User judgments only the user can make — budget, where it may run.
    maxCostUsd: z.number().min(0).max(100).optional(),
    executionMode: z.enum(['AUTO', 'LOCAL_ONLY', 'CLOUD_OK']).default('AUTO'),
    // P4.5: when false, enrich skips memory recall for this task (no past
    // context assembled). Default true = normal tiered-memory behavior.
    useMemory: z.boolean().default(true),
  }),
  z.object({
    action: z.literal('APPROVE_SKILL'),
    queueId: z.string(),
    decision: z.enum(['APPROVE', 'REJECT']),
    // P4: approve-with-edits. Operator-edited SKILL.md to write instead of the
    // draft. APPROVE only (a REJECT discards). Capped to keep frames sane.
    editedMarkdown: z.string().max(100_000).optional(),
  }),
  z.object({
    // P4: fetch a skill draft's full markdown when it was too large (>8KB) to
    // ride along in the PENDING_APPROVAL event metadata.
    action: z.literal('GET_SKILL_DRAFT'),
    queueId: z.string(),
  }),
  z.object({
    // P2: decide a one-time tool grant. Carries NO tool name — the granted
    // tool is read server-side from the approval row, so a client can never
    // widen the grant. decision APPROVE re-runs; REJECT aborts with an ERROR.
    action: z.literal('APPROVE_TOOL'),
    approvalId: z.string(),
    decision: z.enum(['APPROVE', 'REJECT']),
  }),
  z.object({
    action: z.literal('CANCEL_TASK'),
    taskId: z.uuid(),
  }),
  z.object({
    // P4.5: memory controls. SHOW lists this session's episodes; FORGET_SESSION
    // deletes them (+ FTS entries via the delete triggers).
    action: z.literal('MEMORY'),
    op: z.enum(['SHOW', 'FORGET_SESSION']),
  }),
  z.object({
    // TCLAW-4B: list this session's run receipts (summary columns only).
    // Session-scoped by the connection's own sid on the server side — there is
    // deliberately NO sessionId param here, which closes foreign-session reads
    // by construction (a client cannot even ask for another session's list).
    action: z.literal('LIST_RECEIPTS'),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  z.object({
    action: z.literal('LIST_AGENTS'),
    limit: z.number().int().min(1).max(100).default(50),
  }),
  z.object({
    action: z.literal('LIST_AGENT_PROVIDERS'),
  }),
  z.object({
    action: z.literal('CREATE_AGENT'),
    displayName: z.string().trim().min(1).max(80),
    providerId: z.string().trim().min(1).max(80),
    modelId: z.string().trim().min(1).max(160),
    autostart: z.boolean().default(false),
    /** Explicit operator consent for unattended channel context to leave the
     *  machine. Required when a subscription-backed agent autostarts. */
    externalContextConfirmed: z.boolean().default(false),
    channelIds: z.array(z.string().trim().min(1).max(160)).max(20).default([]),
    idempotencyKey: z.uuid(),
  }),
  z.object({
    action: z.literal('UPDATE_AGENT_PROFILE'),
    agentPrincipalId: z.uuid(),
    iconId: z.enum(['robot', 'brain', 'shield', 'search', 'code', 'spark', 'bolt', 'target']),
    systemDirectives: z.string().trim().max(4000).refine(
      (value) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u.test(value),
      'System directives contain forbidden control or bidirectional formatting characters',
    ).default(''),
    expectedRevision: z.number().int().min(0),
    /** Explicit operator reconsent after the persona write. The gateway
     * derives and atomically binds the resulting canonical persona snapshot. */
    reconfirmExternalContext: z.boolean().default(false),
    idempotencyKey: z.uuid(),
  }),
  z.object({
    // G1D channels-agent-UX packet (2026-08-24), Item B(ii): the one true
    // missing writer -- a post-creation autostart toggle for LOCAL
    // (ollama-local) agents only. Deliberately narrower than
    // UPSERT_AGENT_RUNTIME_PROFILE: it carries no provider/adapter/model
    // fields, so it can never be used to change what an agent runs, only
    // whether an already-local agent is allowed to answer automatically.
    // The server rejects this command outright for any non-ollama-local
    // profile; subscription autostart moves only through
    // UPDATE_AGENT_PROFILE's reconfirmExternalContext path.
    action: z.literal('SET_LOCAL_AGENT_AUTOSTART'),
    agentPrincipalId: z.uuid(),
    autostart: z.boolean(),
    idempotencyKey: z.uuid(),
  }),
  z.object({
    // TCLAW-4B: fetch one receipt (+ optionally its evidence events) by task.
    // taskId = gateway request_id, same field type as CANCEL_TASK.taskId.
    action: z.literal('GET_RECEIPT'),
    taskId: z.uuid(),
    includeEvents: z.boolean().default(false),
  }),
  z.object({
    // TCLAW-1B: read-only Cost Control Center summary for this session.
    // Session-scoped by construction (NO sessionId param — server passes the
    // connection's own sid), exactly like LIST_RECEIPTS. recentLedger is a
    // preview window only; authoritative totals come from the backend SUMs.
    action: z.literal('GET_COST_SUMMARY'),
    recentLimit: z.number().int().min(1).max(100).default(20),
  }),
  z.object({
    // TCLAW-2D-1: read-only route preview ("simulate this route"). Runs the
    // REAL enrichment (classifier + memory-derived contextSize + predictTools)
    // and the REAL router.evaluateRequest at compose time, WITHOUT dispatching:
    // no task, no persisted event, no TIER_SELECTED, no receipt, no spend.
    // Mirrors SUBMIT_PROMPT's judgment fields exactly (field-parity keeps a
    // future shared composer field-mapper honest); deliberately NO sessionId
    // (session-scoped by the connection's own sid) and NO attachmentIds
    // (enrichment never reads them). previewOf is a client nonce echoed back
    // verbatim so the UI can bind responses to draft instances (stale/edit-back
    // safety) — it is never persisted.
    action: z.literal('PREVIEW_ROUTE'),
    previewOf: z.string().min(1).max(128),
    prompt: z.string().min(1).max(32_000),
    sensitive: z.boolean().default(false),
    urgent: z.boolean().default(false),
    maxCostUsd: z.number().min(0).max(100).optional(),
    executionMode: z.enum(['AUTO', 'LOCAL_ONLY', 'CLOUD_OK']).default('AUTO'),
    useMemory: z.boolean().default(true),
  }),
  z.object({
    // TCLAW-5A-1: list this session's tool-approval history — summary columns
    // ONLY (approvalId/requestId/toolName/status/createdAt/decidedAt); there is
    // deliberately NO args payload per row (proposed args are display/audit-only
    // and can be large — the drill-down is the existing GET_RECEIPT, whose
    // replayed PENDING_APPROVAL event carries them, oversize-guarded).
    // Session-scoped by construction: NO sessionId param — the server always
    // passes the connection's own sid, exactly like LIST_RECEIPTS. This is a
    // pure read surface: it can never decide, expire, or re-dispatch an
    // approval (the ONLY decide path remains APPROVE_TOOL). status values are
    // the raw persisted three states — there is no 'expired' (no TTL exists)
    // and no actor (no actor column exists); absent facts are never fabricated.
    action: z.literal('LIST_APPROVALS'),
    limit: z.number().int().min(1).max(100).default(20),
    status: z.enum(['pending', 'approved', 'rejected']).optional(),
  }),
  z.object({
    // TCLAW-5B-1: server-redacted diagnostic export for ONE receipt. The ONLY
    // path that emits redacted material — redaction runs in the gateway
    // (packages/gateway/src/export.ts), never assembled client-side. taskId =
    // gateway request_id, same field type as GET_RECEIPT/CANCEL_TASK.
    // Deliberately NO sessionId param (a client can never even ask for
    // another session's export; ownership is re-checked server-side against
    // the owning session regardless). Deliberately NO includeEvents — event
    // replay is categorically omitted from this export, not merely
    // size-guarded like GET_RECEIPT's. Deliberately NO format param — this
    // command always returns one canonical JSON artifact; a Markdown
    // projection (if any) is a pure client-side rendering of that JSON only.
    action: z.literal('GET_SAFE_EXPORT'),
    taskId: z.uuid(),
  }),
  z.object({
    // PRD-TCLAW-COLLAB-PRESENCE-UI-005 S1: read-only channel listing for the
    // connection's own resolved collab principal. Deliberately NO
    // principalId/surfaceId/authorPrincipalId param — identity is always
    // server-derived from the connection's authenticated surface credential
    // (§2a), never trusted from the wire. A connection with no resolved
    // principal is refused COLLAB_IDENTITY_REQUIRED; it never falls back to
    // an operator-wide or unscoped listing.
    action: z.literal('LIST_CHANNELS'),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  z.object({
    // PRD-007 S4-Members (G1D resolution table, item B-1) + S4 presence
    // overlay (OQ-2, GRANTED 2026-08-23): read-only channel roster, scoped
    // to the CALLER'S OWN resolved collab principal exactly like
    // LIST_CHANNELS/GET_CHANNEL_TIMELINE above -- no principalId/surfaceId
    // param, identity is always server-derived (§2a). Each returned member
    // object carries EXACTLY {principalId, displayName, role, kind,
    // working, since} -- the operator's verbatim OQ-2 ruling grants
    // co-members the "working now" side-channel: `working`/`since` are
    // derived at READ TIME from collab_agent_turns
    // (state='dispatched' AND resolved_at IS NULL), never persisted, never
    // client-supplied, always false/null for human/owner rows. NEVER
    // taskId, prompt, tier, tool name, cost, spend, provider, or model --
    // enforced by key-set equality in tests/agent-participation-s4-
    // members.test.ts and tests/agent-participation-s4-presence.test.ts.
    action: z.literal('LIST_CHANNEL_MEMBERS'),
    channelId: z.string().min(1),
  }),
  z.object({
    action: z.literal('SET_CHANNEL_EXTERNAL_EXPORT_POLICY'),
    channelId: z.string().trim().min(1).max(160),
    externalExportPolicy: z.enum(['local_only', 'operator_confirmed_non_sensitive']),
    idempotencyKey: z.uuid(),
  }),
  z.object({
    // PRD-TCLAW-COLLAB-PRESENCE-UI-005 S1: read-only, cursor-paged channel
    // timeline read, scoped to the connection's own resolved collab
    // principal (same identity rule as LIST_CHANNELS above). channelId
    // confers no entitlement by itself -- the substrate re-checks
    // membership server-side on every call (assertChannelVisible), and a
    // hidden or nonexistent channel returns the SAME byte-identical
    // COLLAB_NOT_FOUND payload either way.
    // G2A D-1 fix: the grammar below mirrors the substrate's own
    // parseCursor (packages/collab/src/store.ts) exactly -- an unsigned
    // base-10 integer with no leading zeroes -- so a malformed cursor is
    // refused at the wire boundary (SCHEMA_VIOLATION) instead of reaching
    // the handler and throwing past it.
    action: z.literal('GET_CHANNEL_TIMELINE'),
    channelId: z.string().min(1),
    cursor: z.string().regex(/^(0|[1-9][0-9]*)$/).default('0'),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  z.object({
    // PRD-TCLAW-COLLAB-PRESENCE-UI-005 S6: persist the connection's own read
    // position. Same §2a identity rule as LIST_CHANNELS/GET_CHANNEL_TIMELINE —
    // no principalId field; the subject is the server-derived collab principal.
    // `cursor` uses the SAME wire grammar as GET_CHANNEL_TIMELINE (unsigned
    // base-10, no leading zeroes), mirroring store.parseCursor; the
    // caller-visible bound is enforced server-side by store.ackChannelCursor
    // (CURSOR_OUT_OF_RANGE), never by this coarse wire grammar. Ack is
    // idempotent and monotonic -- acking backwards is a substrate no-op (L2).
    action: z.literal('ACK_CHANNEL_CURSOR'),
    channelId: z.string().min(1),
    cursor: z.string().regex(/^(0|[1-9][0-9]*)$/),
  }),
  z.object({
    // PRD-TCLAW-COLLAB-PRESENCE-UI-005 S3: human posting. Deliberately NO
    // author/principalId/surfaceId field -- the server ALWAYS stamps the
    // author from the connection's resolved collab principal (§2a), so
    // spoofing the author in the command shape is structurally impossible
    // (A3). Field name `text`, not `body`, matching the substrate's actual
    // contract exactly (postChannelMessage(caller, { channelId, text },
    // idempotencyKey) -- store.ts:1422-1425).
    //
    // A6(a) validator citations (file:line, evidence for the T-9 matrix):
    //  - text: this grammar (1-16384 chars) is a coarse pre-filter only. The
    //    substrate's REAL bound is TWO independent BYTE bounds on the
    //    NFC-normalized form -- packages/collab/src/text.ts:122
    //    (countUtf8Bytes(nfcText) in [1,16384]) AND text.ts:137
    //    (countJsonEncodedBytes(nfcText) <= 16384) -- neither of which is a
    //    JS-string-length check and neither of which is regex-expressible
    //    (residue: a 16,384-newline string passes a naive char-length check
    //    but JSON-encodes to 32,768 bytes and is REJECTED by text.ts:137).
    //    normalizeMessageText (text.ts:110) is the consuming validator; its
    //    caller is store.ts:1428. This contract's max(16384) bound on
    //    JS .length is intentionally COARSER than the byte bound (a
    //    multi-byte string can exceed the byte cap at far fewer than 16384
    //    chars) so it can never falsely admit something the byte bound
    //    would reject while still rejecting some inputs early; the
    //    authoritative rejection for the byte/JSON-byte bounds is, and must
    //    stay, server-side in text.ts. min(1) is likewise a coarse
    //    pre-filter -- text.ts:123 is the real floor, evaluated on the
    //    POST-NFC-normalization form (a string that normalizes to zero
    //    length, e.g. some combining-mark-only inputs, could in principle
    //    pass min(1) here and still be rejected by text.ts:123; that
    //    rejection is a structured INVALID_REQUEST from store.ts:1430, not
    //    a throw that escapes the handler -- see collabSurface.ts).
    //  - channelId: no format is asserted by the substrate itself (any
    //    non-empty string id) -- the REAL narrowing validator is
    //    assertChannelVisible (store.ts:2032), which does a membership JOIN
    //    and throws CollabError('COLLAB_NOT_FOUND') for absent, hidden, OR
    //    malformed-but-syntactically-fine channelId alike (byte-identical
    //    per T-2). min(1) here matches GET_CHANNEL_TIMELINE's existing
    //    channelId grammar exactly (no new pattern invented for this field).
    //  - idempotencyKey: NOTHING in the substrate validates its shape.
    //    packages/collab/src/migration.ts:137 declares the backing column
    //    `idempotency_key TEXT NOT NULL` with no length/format CHECK, and
    //    runKeyedCommand (store.ts:2182-2253) uses it as an opaque dedup key
    //    in a (principal_id, command, idempotency_key) lookup -- ANY
    //    non-empty string is accepted and would silently "work" as a
    //    dedup key. The PRD (§4 S3, A3/B-3) specifies this MUST be a
    //    client-supplied canonical UUID specifically so a retry after a
    //    dropped socket reuses one deterministic value instead of a
    //    server/random one. Since the substrate enforces no shape at all,
    //    THIS CONTRACT is the only enforcement point -- z.uuid() below is
    //    added deliberately to close that gap, not because a downstream
    //    validator required it.
    action: z.literal('POST_CHANNEL_MESSAGE'),
    channelId: z.string().min(1),
    text: z.string().min(1).max(16384),
    idempotencyKey: z.uuid(),
  }),
  z.object({
    // PRD-TCLAW-AGENT-PARTICIPATION-007 S3 (R-3a): the STOP control. A
    // visible, operator-reachable halt for agent auto-reply. `scope`
    // determines whether this stops one channel or every channel
    // (global); `channelId` is required for scope='channel' and forbidden
    // for scope='global' -- that combination cannot be expressed inside a
    // discriminatedUnion member (zod v4 requires each member to be a bare
    // object so the literal discriminant stays directly inspectable, which
    // rules out a `.refine()`-wrapped member), so it is validated in the
    // gateway handler (autoReplyStopHandler.ts) instead, returning a
    // structured COLLAB_INVALID_REQUEST rather than a schema rejection.
    // `stop: true` sets the halt; `stop: false` clears it. Operator-seat-
    // only (see authz.ts) -- an agent has no path to this command: it is
    // not a collab tool, so no message content or model output can ever
    // reach it (INV-T1 Corollary C's sibling for STOP).
    action: z.literal('SET_AUTOREPLY_STOP'),
    stop: z.boolean(),
    scope: z.enum(['global', 'channel']),
    channelId: z.string().min(1).optional(),
  }),
  z.object({
    // CRON slice (G1R Gate-1 §2A): create a schedule that wakes an agent,
    // already a member of channelId, on a fixed interval. Deliberately NO
    // authority field of any kind -- the creating connection's OWN resolved
    // operator principal is what the handler stamps as
    // created_by_principal_id (audit only, never consulted for
    // authorization; every wake independently re-validates membership at
    // fire time -- packages/collab/src/cron.ts's assertScheduleStillAuthorized).
    // A6(a): intervalSeconds' floor of 60 matches the migration's own
    // CHECK(interval_seconds >= 60) (packages/collab/src/migration.ts) --
    // this contract enforces the SAME floor the substrate would otherwise
    // reject with a raw SQLite CHECK constraint violation (an unhandled
    // throw), so the client gets a structured 400-shape refusal instead.
    // promptHint is NEVER a command or an authority grant -- cronDispatcher.ts
    // renders it into the model's prompt as inert text, exactly like any
    // other channel content; it cannot widen what tools render or what
    // profile resolves (see cronDispatcher.ts's hintLine comment).
    action: z.literal('CREATE_SCHEDULE'),
    channelId: z.string().min(1),
    agentPrincipalId: z.string().min(1),
    intervalSeconds: z.number().int().min(60).max(86400 * 7),
    promptHint: z.string().max(2000).optional(),
    idempotencyKey: z.uuid(),
  }),
  z.object({
    // Operator-visible on/off switch for one schedule (distinct from
    // SET_AUTOREPLY_STOP, which is the channel/global auto-reply kill
    // switch cron ALSO obeys -- see cron.ts's module doc). 'stopped' also
    // survives restart (same collab.db persistence discipline as every
    // other collab-surface write).
    action: z.literal('SET_SCHEDULE_STATE'),
    scheduleId: z.string().min(1),
    state: z.enum(['active', 'stopped']),
  }),
  z.object({
    action: z.literal('LIST_SCHEDULES'),
    channelId: z.string().min(1),
  }),
  z.object({
    // G1D channels-agent-UX packet (2026-08-24), Amendment 1 Item D (curated
    // channel membership) + delta-G1R disposition ND-1..ND-6: operator-seat-
    // only, same authz class as the agent mutations above (CREATE_AGENT/
    // UPDATE_AGENT_PROFILE/LIST_AGENTS/SET_LOCAL_AGENT_AUTOSTART) -- see
    // authz.ts's authorizeOperator NAMED arm and the explicit 'channel'/'node'
    // seat deny arm (ND-4). `agentPrincipalId` (not a bare `principalId`) is
    // deliberate: this command can only ever target an AGENT principal, never
    // a human/operator one -- the store's existing validation 3
    // (addChannelMember, store.ts:2064-2074) rejects any target that is not
    // kind='agent' owned by the channel's own operator, so a human/operator
    // id submitted here is refused server-side (COLLAB_NOT_FOUND, D-5)
    // regardless of what this contract's string type would otherwise admit.
    // The collabSurface handler is a THIN, CALL-ONLY wrap of the EXISTING
    // store.addChannelMember (store.ts:2037-2183, already keyed/idempotent/
    // sequenced with epoch bump, committed member_added event, and post-lock
    // fanout) -- ND-1: no new business logic lives outside that function or
    // assertChannelOwner (store.ts:3507).
    action: z.literal('ADD_CHANNEL_MEMBER'),
    channelId: z.string().min(1),
    agentPrincipalId: z.string().min(1),
    idempotencyKey: z.uuid(),
  }),
  z.object({
    // Sibling of ADD_CHANNEL_MEMBER above -- same operator-seat-only authz
    // class, same agent-only target constraint, same thin call-only wrap
    // (this time of store.removeChannelMember, store.ts:2185-2305). Removal
    // eagerly closes the removed principal's own live subscription with
    // `authorization_lost` (ND-2/T-1 pattern, existing store/coordinator
    // behavior, not new for this command) and bumps membership_epoch; a
    // re-add after remove starts a fresh epoch (D-3). Mid-turn removal is
    // enforced in-transaction by the EXISTING store.ts:2653 dispatch guard
    // (COLLAB_NOT_PERMITTED) -- this command adds no new dispatcher check
    // (ND-2, T-D8: autoReplyDispatcher.ts stays at Builder P's two hunks).
    action: z.literal('REMOVE_CHANNEL_MEMBER'),
    channelId: z.string().min(1),
    agentPrincipalId: z.string().min(1),
    idempotencyKey: z.uuid(),
  }),
]).superRefine((command, ctx) => {
  if (
    command.action === 'CREATE_AGENT'
    && SubscriptionProviderIdSchema.safeParse(command.providerId).success
    && command.autostart
    && !command.externalContextConfirmed
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['externalContextConfirmed'],
      message: 'subscription autostart requires explicit external context confirmation',
    });
  }
});
export type ClientCommand = z.infer<typeof ClientCommandSchema>;

/** First frame on every connection — no anonymous sockets.
 *  sessionId present = resume; absent = create. Sessions outlive sockets.
 *
 *  C0.1: `auth` is an OPTIONAL discriminated carrier for a collab surface
 *  credential (packages/collab tq1_... token), additive to the legacy
 *  `token` field so an existing client's exact frame bytes still parse
 *  identically (z.object strips unknown keys but never requires new ones).
 *  A frame with no `auth` is legacy_gateway: the server treats it exactly as
 *  before (verifyToken(token) only). Deliberately NO client-supplied
 *  principalId/surfaceId — identity is always server-derived from the
 *  verified credential, never trusted from the wire (H-1). */
export const ConnectFrameSchema = z.object({
  // Compatibility assertions only. The gateway derives authority from the
  // authenticated credential and rejects either field when it disagrees.
  role: z.enum(['operator', 'channel', 'node']).optional(),
  expectedRole: z.enum(['operator', 'channel', 'node']).optional(),
  // Deprecated legacy transport. Production rejects this path regardless of
  // value; it remains optional for the bounded development migration window.
  token: z.string().optional(),
  sessionId: z.uuid().optional(),
  clientInfo: z.object({ name: z.string(), version: z.string() }),
  auth: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('surface'), credential: z.string() }),
    z.object({ kind: z.literal('channel_service'), credential: z.string() }),
  ]).optional(),
});
export type ConnectFrame = z.infer<typeof ConnectFrameSchema>;
