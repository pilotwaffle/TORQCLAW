import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import {
  ClientCommandSchema,
  ConnectFrameSchema,
  GatewayRequestSchema,
  ComputeTier,
  type GatewayRequest,
} from '@torqclaw/contracts';
import { randomUUID } from 'node:crypto';
import { sessions } from './sessions.js';
import { enrichCommand } from './enrich.js';
import { dispatch, mintGrantedRequest, emitToolDenied } from './dispatch.js';
import { decideApproval, handleListApprovals } from './approvals.js';
import { makeEmitter, sessionBus, persistAndPublish, taskStore } from './events.js';
import { router } from '@torqclaw/router';
import { connectBridge, connectInProcessServer, approveSkill, getSkillDraft, cancelHermesTask } from '@torqclaw/bridge';
import { buildCollabAgentMcpServer, COLLAB_AGENT_SERVER_ID, COLLAB_AGENT_TOOL_CAPABILITIES } from './collabAgentTools.js';
import { describeSkillDecision } from './skillDecision.js';
import { assertResolvedProfile, constrainTier } from './profileResolver.js';
import { setCancelCheck, setToolAdmissionCheck } from '@torqclaw/inference';
import { cancellations } from './cancellations.js';
import { authorize, type Role } from './authz.js';
import { db } from './storage.js';
import { handleListReceipts, handleGetReceipt } from './receipts.js';
import { handleGetCostSummary } from './spend.js';
import { handlePreviewRoute } from './preview.js';
import { handleGetSafeExport } from './export.js';
import { collabEnabled, PrincipalBindingError } from './principalBridge.js';
import { resolveConnectIdentity, type ConnectionAuthContext } from './collabIdentity.js';
import { ensureSurfaceSecuritySchema, captureTaskOrigin, holdsAuthority, liveSurfaceSecurity } from './surfaceSecurity.js';
import {
  assertProductionLegacyTokenDisabled,
  assertedRoleMatches,
  authenticateConnection,
  isProductionRuntime,
} from './connectionAuth.js';
import { ensureApprovalBrokerSchema } from './approvalSchema.js';
import { sweepExpiredApprovals, sweepExpiredGrants } from './approvalWriter.js';
import { rebuildDeliveryProjection } from './approvalDelivery.js';
import { revokeInertGrants, admitToolCall } from './grantAdmission.js';
import { decideApprovalC2 } from './c2Broker.js';
import { collabSurfaceCommandsEnabled, agentParticipationEnabled, isAgentSurfaceCaller, handleListChannels, handleGetChannelTimeline, handlePostChannelMessage, setAutoReplyTrigger } from './collabSurface.js';
import { onChannelMessageCommitted, recoverStrandedAgentTurns } from './autoReplyDispatcher.js';
import { getCollabDbForAutoReply } from './collabSurface.js';
import { handleSetAutoreplyStop } from './autoReplyStopHandler.js';
import { recoverStrandedScheduleRuns, tickSchedules } from './cronDispatcher.js';
import { handleCreateSchedule, handleSetScheduleState, handleListSchedules } from './cronScheduleHandler.js';

/**
 * Re-minted requests built inside the C2 decision transaction, handed to
 * the dispatcher after it COMMITS. Keyed by dispatch_request_id.
 *
 * The task row must be created inside the writer's transaction (the
 * grant's FK depends on it), but dispatch must only run once that
 * transaction has committed -- otherwise a rolled-back decision could
 * still have started real work. This map carries the request across that
 * boundary; entries are removed as soon as they are consumed.
 */
const pendingC2Dispatch = new Map<string, GatewayRequest>();

// C1 (§6.2): additive, idempotent state.db migration. Safe to run with the
// flag OFF -- the tables are created but never read or written, which is
// exactly the §2.11 posture ("the C1 tables may exist but are inert").
// Running it unconditionally at boot means a flag flip needs no migration
// step, and re-running it is a no-op.
ensureSurfaceSecuritySchema(db);

// C2-1 (§3.1, §6.2): additive approval-broker migration -- the six guarded
// nullable columns on canonical `tool_approvals`, its one declared index,
// and the three additive sidecars. Same posture as C1 above: unconditional
// at boot, idempotent, and inert while the flag is off (no C2 path reads or
// writes any of it unless collabEnabled()).
ensureApprovalBrokerSchema(db);

// Read helper for authz's task-ownership check. Kept inline here (not in
// events.ts taskStore) per scope: this ticket may only touch authz.ts,
// server.ts, sessions.ts. Same db handle pattern sessions.ts already uses.
const lookupTaskSessionStmt = db.prepare('SELECT session_id FROM tasks WHERE request_id = ?');
function lookupTaskSession(taskId: string): string | null {
  const row = lookupTaskSessionStmt.get(taskId) as { session_id: string } | undefined;
  return row ? row.session_id : null;
}

/**
 * C1-5 (§2.13): capture immutable task origin for a request whose
 * connection presented a valid C1 surface.
 *
 * A no-op when there is no ConnectionAuthContext -- flag off, a legacy
 * root-token connection, or a C0.1 credential with no C1 surface row. That
 * is the SI-4 requirement: with the flag off no new table is written.
 *
 * Failures are swallowed deliberately. Origin capture is EVIDENCE, and a
 * duplicate/parallel write must never take down a live task submission;
 * the C2 seams that consume this evidence already treat a missing origin
 * as fail-closed (a flag-on registration without one is inert/refused,
 * §2.13), so losing the row denies later rather than opening anything.
 */
function recordTaskOrigin(
  auth: ConnectionAuthContext | null,
  requestId: string,
  sessionId: string,
): void {
  if (!collabEnabled() || auth === null) return;
  try {
    captureTaskOrigin(db, {
      requestId,
      sessionId,
      connectionId: auth.connectionId,
      principalId: auth.principalId,
      surfaceId: auth.surfaceId,
      surfaceKind: auth.surfaceKind,
      credentialId: auth.credentialId,
      credentialExpiresAt: auth.credentialExpiresAt,
      authEpoch: auth.authEpoch,
      capabilityRevision: auth.capabilityRevision,
    });
  } catch {
    /* evidence write is best-effort; consumers fail closed without it */
  }
}

// Let the LOCAL_EDGE loop observe cancellations without importing the gateway DB.
setCancelCheck((requestId) => cancellations.isCancelled(requestId));

// C2-8 / §1.4: install the real pre-tool-execution admission seam. The
// LOCAL_EDGE loop calls this immediately before any gated side effect,
// with the ACTUAL model-generated arguments.
//
// S0 (PRD-TCLAW-AGENT-PARTICIPATION-007 G1R Gate-1, B-1): this used to be
// gated `if (!collabEnabled()) return { ok: true }`. That mirrors the exact
// mistake `72b4d36` fixed on FRONTIER's `frontierGrantFenced` the same day:
// "a security refusal that a feature flag can switch off is not a
// refusal." `collabEnabled()` defaults FALSE (principalBridge.ts:71-72;
// `.env.example` sets no collab flag), so the LOCAL_EDGE exact-action seam
// was inert in every default install. Under human pacing a permissive
// `grantedTools.includes(name)` allowlist (ollama.ts:356) is weak but a
// human is standing next to it; the reasoning that makes that tolerable
// does not survive unattended execution (cron / agent auto-reply), where a
// once-approved tool name can be re-invoked with ANY arguments while nobody
// is watching. The flag is now REMOVED from this fence -- it runs on every
// LOCAL_EDGE dispatch, flag on or off.
//
// The remaining condition is load-bearing and is NOT the same defect:
//
//   this dispatch request actually CARRIES a C2 grant (`carriesGrant`).
//
// This exists because a request can reach this seam without ever having
// gone through C2 registration at all -- a legacy connection (no surface
// credential presented) still registers and decides through the legacy
// register/decide path even with C2 available, so its re-run has no grant
// by design (D-3/SI-4: a legacy human-paced connection must stay
// byte-identical to pre-C2 behaviour). Refusing those runs `grant-missing`
// would be a real regression the APPROVE leg of the flag-on identity
// transcript already caught (G2A D-3), and it is preserved here unchanged.
//
// A request that went through C2 always has its grant row minted inside
// the deciding transaction, so for those requests the lookup finds it and
// the full check runs regardless of the flag. What `!carriesGrant` skips is
// only requests for which C2 never issued a licence in the first place.
//
// KNOWN GAP (not closed by this change, and not silently claimed to be):
// there is not yet an unattended-run caller in this codebase (no cron, no
// agent auto-reply loop exists yet), so there is no signal at this seam
// today to distinguish "legacy human-paced connection, no grant by design"
// from "an unattended run whose grantedTools should never have been
// re-minted without an args-bound grant". G1R's B-1 fix (ii) -- refusing an
// unattended dispatch that carries `grantedTools` with no matching grant
// row -- requires that signal to exist first. TODO(S3/cron prerequisite):
// once an unattended-run marker is threaded onto GatewayRequest, add
// `!carriesGrant && isUnattendedRun(requestId) => refuse` here, preserving
// this exact arm for every other (human-paced legacy) caller.
setToolAdmissionCheck((requestId, toolName, args) => {
  const carriesGrant = db.prepare(
    'SELECT 1 FROM gateway_action_grants WHERE dispatch_request_id = ?',
  ).get(requestId) !== undefined;
  if (!carriesGrant) return { ok: true };
  const result = admitToolCall(db, {
    dispatchRequestId: requestId, toolName, args, path: 'LOCAL_EDGE',
  });
  return result.ok ? { ok: true } : { ok: false, reason: result.reason };
});

// Port deliberately != 18789 so TORQCLAW can coexist with a stock OpenClaw
// install on the same box during comparison testing.
const PORT = Number(process.env.TORQCLAW_PORT || 18790);
const HOST = process.env.TORQCLAW_HOST || '127.0.0.1';
const GATEWAY_TOKEN = process.env.TORQCLAW_GATEWAY_TOKEN || '';
const CHANNEL_SERVICE_TOKEN = process.env.TORQCLAW_CHANNEL_SERVICE_TOKEN || '';
const PRODUCTION = isProductionRuntime();
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

assertProductionLegacyTokenDisabled();

const app = Fastify({ logger: true });
await app.register(websocket);

app.get('/health', async () => ({ service: 'torqclaw-gateway', status: 'ready' }));

app.get('/ws', { websocket: true }, (socket) => {
  let authed = false;
  let sessionId: string | null = null;
  let role: Role | null = null;
  let unsubscribe: (() => void) | null = null;
  // C1-5: server-derived, CONNECTION-scoped auth context. Held per socket
  // (never in a session-keyed row) because one durable session may have
  // several concurrent connections presenting different valid
  // same-principal surfaces -- §2.13.
  let connectionAuth: ConnectionAuthContext | null = null;
  // PRD-TCLAW-AGENT-PARTICIPATION-007 S1: server-derived, CONNECTION-scoped
  // collab principal id for a VERIFIED agent-kind principal, set ONLY when
  // TORQCLAW_AGENT_PARTICIPATION is on (agentParticipationEnabled()) and the
  // connection's own resolved principal (from caller.binding, never a client
  // frame) reads back kind==='agent' from the collab DB. Deliberately kept
  // SEPARATE from connectionAuth: connectionAuth is populated only for a C1
  // surface, and a createAgent()-minted credential (the only agent-minting
  // path that exists -- store.ts:426) has no C1 surface row, so it always
  // falls to the C0.1 legacy branch of resolveConnectIdentity, which returns
  // auth: null. Gating S1's new posting path on connectionAuth alone would
  // make it permanently unreachable for every agent this program can mint.
  // NULL here means "no verified agent identity for this connection" and
  // must never be widened or substituted (§2a).
  let agentCollabPrincipalId: string | null = null;

  const sendErr = (code: string, detail?: unknown) =>
    socket.send(JSON.stringify({ type: 'ERROR', code, detail }));

  socket.on('message', async (raw: Buffer) => {
    let frame: unknown;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      return sendErr('MALFORMED_JSON');
    }

    // ── Gate 1: first frame must authenticate ──
    if (!authed) {
      const conn = ConnectFrameSchema.safeParse(frame);
      if (!conn.success) {
        sendErr('AUTH_FAILED');
        return socket.close(4001, 'auth failed');
      }

      // C0.1: a surface credential is only ever consulted when the collab
      // flag is on AND the frame actually carries one. Flag-off, or a
      // legacy frame with no `auth` carrier, takes EXACTLY today's
      // verifyToken(token)-only path -- byte-identical (H-2). The binding
      // is ALWAYS server-derived from the verified credential itself, NEVER
      // read off the frame (H-1) -- see collabIdentity.ts.
      //
      // C1-5: the surface path now runs the §2.6 ordered gate. Step 2
      // (surface validity + live gateway projection) happens inside
      // resolveConnectIdentity; step 3 (assertResumeAllowed / SEC-1) still
      // happens inside sessions.resolve() below, in that order and
      // unchanged. A valid C1 surface also yields a connection-scoped
      // ConnectionAuthContext used for immutable per-task origin capture.
      const caller = authenticateConnection(conn.data, {
        legacyGatewayToken: GATEWAY_TOKEN,
        channelServiceToken: CHANNEL_SERVICE_TOKEN,
        production: PRODUCTION,
        allowTokenlessLegacy: !PRODUCTION && LOOPBACK_HOSTS.has(HOST),
        resolveSurface: (credential) => {
          if (!collabEnabled()) return null;
          const identity = resolveConnectIdentity(credential);
          connectionAuth = identity?.auth ?? null;
          return identity?.caller ?? null;
        },
      });
      if (!caller) {
        // Indistinguishable from a bad root token at the client-visible
        // level (M-1): same code, same close. Which verifier failed is
        // never surfaced here.
        sendErr('AUTH_FAILED');
        return socket.close(4001, 'auth failed');
      }

      // PRD-TCLAW-AGENT-PARTICIPATION-007 S1: resolve (never assert) this
      // connection's verified agent collab principal. Every input here is
      // server-derived: caller.binding and caller.authClass both came from a
      // cryptographically verified tq1_ credential
      // (connectionAuth.ts/collabIdentity.ts), never a client frame field.
      //
      // WHY authClass === 'agent_surface' AND NOT A SECOND DB READ:
      // collabIdentity.ts computes authClass from the SAME verified-
      // principal lookup that already produced caller.role -- 'agent_surface'
      // is set (both the C1 and C0.1-legacy branches) if-and-only-if the
      // resolved principal's kind is 'agent' AND (for a C1 surface) its
      // surfaceRole is specifically 'agent', not 'automation' or 'operator'.
      // A second, independent principals.kind lookup here would read the
      // SAME collab.db handle collabIdentity.ts already read microseconds
      // earlier in this same synchronous connect path -- it cannot
      // observe a different answer, so it would be untestable dead
      // redundancy (verified by mutation: removing such a check left every
      // test green, because no reachable input can make the two reads
      // disagree). authClass is therefore the correct, non-redundant,
      // already-verified signal to gate on. It also correctly EXCLUDES a C1
      // 'automation_surface' principal, which role-collapses to the same
      // 'node' seat but is a distinct authClass -- automation is not agent
      // participation and this slice grants it nothing.
      //
      // Flag-gated: with TORQCLAW_AGENT_PARTICIPATION off (its default),
      // agentParticipationEnabled() short-circuits this to false
      // immediately, so agentCollabPrincipalId stays null and every path
      // this slice adds is byte-identical to pre-S1 behaviour (A1-d, the
      // absent-deny discipline).
      if (agentParticipationEnabled() && isAgentSurfaceCaller(caller.authClass, caller.binding)) {
        agentCollabPrincipalId = caller.binding!.principalId;
      }

      const knownResume = Boolean(conn.data.sessionId && sessions.has(conn.data.sessionId));
      // Fresh and unknown-id frames can be checked before resolve, preventing
      // mismatch attempts from inserting an orphan session. Known resumes run
      // ownership first below so ROLE_MISMATCH cannot become an identity oracle.
      if (!knownResume && !assertedRoleMatches(conn.data, caller.role)) {
        sendErr('ROLE_MISMATCH');
        return socket.close(4003, 'role mismatch');
      }
      // sessions.resolve() throws PrincipalBindingError (via
      // assertResumeAllowed) on a cross-principal resume attempt -- this is
      // SEC-1 actually refusing on the wire, not a bug. It MUST NOT crash
      // the connection handler (an uncaught throw inside this async
      // WebSocket message handler would become an unhandled rejection and
      // could take the whole gateway process down -- a one-line DoS against
      // every other live session). Same posture as a bad root token: same
      // AUTH_FAILED code, same close(4001), no detail about which check
      // failed (M-1).
      let resolved: ReturnType<typeof sessions.resolve>;
      try {
        resolved = sessions.resolve(conn.data, caller);
      } catch (err) {
        if (err instanceof PrincipalBindingError) {
          sendErr('AUTH_FAILED');
          return socket.close(4001, 'auth failed');
        }
        throw err;
      }

      if (knownResume && !assertedRoleMatches(conn.data, caller.role)) {
        sendErr('ROLE_MISMATCH', { sessionId: resolved.sessionId });
        return socket.close(4003, 'role mismatch');
      }

      authed = true;
      sessionId = resolved.sessionId;
      role = resolved.role as Role;

      // Socket = subscriber. Execution publishes to the bus regardless of
      // whether anyone is listening.
      unsubscribe = sessionBus.subscribe(sessionId, (event) =>
        socket.send(JSON.stringify(event)),
      );

      // Replay missed events on resume (seq cursor, never timestamps).
      const lastSeen = (frame as any).lastSeenSeq ?? null;
      const backlog = resolved.resumed ? sessions.getEventLogSince(sessionId, lastSeen) : [];
      for (const ev of backlog) socket.send(JSON.stringify(ev));

      return persistAndPublish({
        id: randomUUID(), requestId: null, sessionId, tier: null,
        type: 'CONNECTED',
        message: resolved.resumed ? 'Session resumed' : 'Session created',
        metadata: { sessionId, resumed: resolved.resumed },
        timestamp: new Date().toISOString(),
      });
    }

    // ── Gate 2: every subsequent frame must be a valid ClientCommand ──
    const cmd = ClientCommandSchema.safeParse(frame);
    if (!cmd.success) return sendErr('SCHEMA_VIOLATION', cmd.error.flatten());

    const sid = sessionId!;

    // ── Gate 3: role-based command authorization ──
    // C1-4 / H-1: hand authorize() the presenting surface's own authority
    // layer so operator authority is INTERSECTED with what THIS surface
    // actually holds. Built from the server-derived connection context and
    // read live from state.db at decision time -- never from a client frame,
    // and never cached across the connection, so a revocation that commits
    // first is observed by the very next command (§1.4).
    const surfaceAuthz = connectionAuth === null ? undefined : {
      surfaceId: connectionAuth.surfaceId,
      // BOTH of these are LIVE reads, never values captured at connect.
      // The role especially: a surface demoted from operator to agent
      // mid-connection must lose `approve` on its very next command, and a
      // connect-time copy would keep it for the life of the socket.
      currentRole: () => liveSurfaceSecurity(db, connectionAuth!.surfaceId)?.surfaceRole ?? null,
      holdsAuthority: (authority: 'approve' | 'cancel' | 'delegate') =>
        holdsAuthority(db, connectionAuth!.surfaceId, authority),
    };
    // PRD-TCLAW-AGENT-PARTICIPATION-007 S1: the ONE seat-lattice widening
    // this slice adds (authz.ts's AuthzContext.agentCollabWrite doc comment
    // has the full precondition). Re-read the flag live per-call (never
    // cached from connect time) so a mid-connection flag flip takes effect
    // on the very next command, matching this file's existing discipline
    // for surfaceAuthz above. agentCollabPrincipalId itself was resolved
    // ONCE at connect from a verified credential and never changes for the
    // life of the socket -- only the flag gate is re-read live.
    const agentCollabWrite = agentCollabPrincipalId !== null && agentParticipationEnabled();
    const decision = authorize(role!, cmd.data, {
      sessionId: sid, lookupTaskSession, surface: surfaceAuthz, agentCollabWrite,
    });
    if (!decision.ok) {
      app.log.warn({ role, action: cmd.data.action }, 'authz denied');
      sendErr('UNAUTHORIZED', { action: cmd.data.action, reason: decision.reason });
      return;
    }

    switch (cmd.data.action) {
      case 'SUBMIT_PROMPT': {
        const emit = makeEmitter(sid, null, null);
        emit('USER_PROMPT', cmd.data.prompt); // feeds getContextWindow Tier 1

         // S2: authz denies SUBMIT_PROMPT outright for role 'node' (the only
         // seat an agent's own connection can hold — authz.ts), so
         // agentCollabPrincipalId is always null on every connection that
         // can reach this arm today. Passed through anyway so this call site
         // stays correct if a future slice (S3's dispatch-time binding)
         // changes that, rather than needing to be found and rewired later.
         const request = await enrichCommand(
           cmd.data, sid, 'torq-console', agentCollabPrincipalId ?? undefined,
         );
         GatewayRequestSchema.parse(request); // throws = our bug; fail loud
         assertResolvedProfile(request);

        const reqEmit = makeEmitter(sid, request.id, null);
        reqEmit('ROUTING', `Classified as ${request.payload.taskType}`, request.enrichment);

         const baseDiag = constrainTier(router.evaluateRequest(request), request.effectiveProfile!);
         const diag = {
           ...baseDiag,
           profile: request.effectiveProfile?.profileId,
           profileVersion: request.effectiveProfile?.profileVersion,
           profileHash: request.effectiveProfile?.policyHash,
         };
        makeEmitter(sid, request.id, diag.tier)('TIER_SELECTED', diag.reason, diag);

        // C1-5 (§2.13): immutable, request-keyed origin evidence, written
        // from the PROVEN connection context before dispatch. Server-derived
        // in full -- no field is ever supplied by the client. Recorded per
        // request rather than per session so concurrent connections from
        // different same-principal surfaces cannot overwrite one another.
        recordTaskOrigin(connectionAuth, request.id, sid);

        dispatch(request, diag); // returns immediately
        break;
      }
      case 'APPROVE_SKILL': {
        const result = await approveSkill(cmd.data.queueId, cmd.data.decision, cmd.data.editedMarkdown);
        const edited = cmd.data.decision === 'APPROVE' && cmd.data.editedMarkdown !== undefined;
        const event = describeSkillDecision(cmd.data.queueId, cmd.data.decision, edited, result);
        makeEmitter(sid, null, null)(event.type, event.message, event.metadata);
        break;
      }
      case 'GET_SKILL_DRAFT': {
        // P4: fetch a large draft's markdown and return it to the console so it
        // can prefill its editor. Carried on a SYSTEM event keyed by queueId.
        const draft = await getSkillDraft(cmd.data.queueId);
        makeEmitter(sid, null, null)('SYSTEM', 'Skill draft loaded', {
          queueId: cmd.data.queueId,
          skillMarkdown: draft.skillMarkdown,
          skillDraft: true,
        });
        break;
      }
      case 'APPROVE_TOOL': {
        // ── C2 path (G2A D-1): a C2-BOUND approval is decided by the one
        // centralized writer, which checks authority, compares the
        // registration context against a freshly resolved one, and -- on
        // APPROVE -- mints the re-minted task AND exactly one grant inside
        // the same transaction. `decideApprovalC2` returns `legacy` with
        // the flag off or for an unbound (pre-C2) row, and the untouched
        // legacy path below then runs byte-identically.
        // Captured before the closure: inside a callback TypeScript loses
        // the discriminated-union narrowing on `cmd`.
        const approvalIdC2 = cmd.data.approvalId;
        const c2 = decideApprovalC2(
          approvalIdC2,
          cmd.data.decision,
          connectionAuth?.principalId ?? null,
          connectionAuth?.surfaceId ?? null,
          // The re-minted request is built HERE and its tasks row is
          // written INSIDE the writer's transaction, so the grant's FK to
          // it is satisfiable and a rollback removes both.
          (dispatchRequestId) => {
            const source = db.prepare(
              `SELECT t.request_json AS requestJson, a.tool_name AS toolName
                 FROM tool_approvals a JOIN tasks t ON t.request_id = a.request_id
                WHERE a.approval_id = ?`,
            ).get(approvalIdC2) as { requestJson: string; toolName: string };
            const minted = mintGrantedRequest(source.requestJson, source.toolName);
            minted.id = dispatchRequestId;
            GatewayRequestSchema.parse(minted);
            const diagMint = router.evaluateRequest(minted);
            taskStore.create(minted, diagMint);
            pendingC2Dispatch.set(dispatchRequestId, minted);
          },
        );

        if (c2.kind === 'refused') {
          // Explicit, textual operator-facing failure (§6.8) -- never a
          // silent no-op and never an apparent success.
          makeEmitter(sid, null, null)('SYSTEM', `Approval refused: ${c2.message}`, {
            approvalId: cmd.data.approvalId, refusedCode: c2.code,
          });
          break;
        }
        if (c2.kind === 'noop') {
          makeEmitter(sid, null, null)('SYSTEM', 'Approval already decided or unknown.');
          break;
        }
        if (c2.kind === 'decided') {
          const { decided: d } = c2;
          if (d.status === 'approved') {
            const reqB = pendingC2Dispatch.get(d.dispatchRequestId!);
            pendingC2Dispatch.delete(d.dispatchRequestId!);
            if (!reqB) {
              makeEmitter(sid, null, null)('SYSTEM', 'Approval could not be re-minted.');
              break;
            }
            const diag = router.evaluateRequest(reqB);
            // D-2: FRONTIER cannot satisfy the §1.4 exact-action invariant
            // -- its Hermes hook grants by tool NAME and never inspects
            // args, so the admission seam cannot fence it. Refuse HERE,
            // before any executor runs, rather than letting the tier
            // execute real side effects under a name-only grant.
            if (diag.tier === ComputeTier.FRONTIER) {
              makeEmitter(sid, null, null)('SYSTEM',
                'Approval refused: FRONTIER has no args-aware structured grant protocol, '
                + 'so this approval cannot be fenced and is refused (fail-closed).',
                { approvalId: cmd.data.approvalId, refusedCode: 'frontier-structured-grant-unavailable' });
              break;
            }
            const reqEmit = makeEmitter(reqB.sessionId, reqB.id, null);
            reqEmit('ROUTING', `Re-running with permission for ${d.toolName}`, reqB.enrichment);
            makeEmitter(reqB.sessionId, reqB.id, diag.tier)('TIER_SELECTED', diag.reason, diag);
            dispatch(reqB, diag);
          } else {
            const source = db.prepare(
              'SELECT t.request_json AS requestJson FROM tool_approvals a '
              + 'JOIN tasks t ON t.request_id = a.request_id WHERE a.approval_id = ?',
            ).get(cmd.data.approvalId) as { requestJson: string };
            const reqDeny: GatewayRequest = {
              ...(JSON.parse(source.requestJson) as GatewayRequest),
              id: randomUUID(),
              receivedAt: new Date().toISOString(),
            };
            emitToolDenied(reqDeny, d.toolName, router.evaluateRequest(reqDeny));
          }
          break;
        }

        // ── LEGACY path (flag off, or a pre-C2 unbound row) ──
        // Byte-identical to the shipped behaviour. decideApproval is
        // idempotent + exactly-once: a double-click returns null and we
        // no-op (invariant 7 — no second re-dispatch). The granted tool is
        // read from the DB row, never the client frame, so a client can't
        // widen the grant.
        const decided = decideApproval(cmd.data.approvalId, cmd.data.decision);
        if (!decided) {
          makeEmitter(sid, null, null)('SYSTEM', 'Approval already decided or unknown.');
          break;
        }
        if (!decided.requestJson) {
          makeEmitter(sid, null, null)('SYSTEM', 'Approval has no original request to re-run.');
          break;
        }
        if (cmd.data.decision === 'APPROVE') {
          // Mint a NEW task: original constraints verbatim + grant + notice.
          const reqB = mintGrantedRequest(decided.requestJson, decided.toolName);
          GatewayRequestSchema.parse(reqB); // assert our re-mint obeys contracts
          const diag = router.evaluateRequest(reqB);
          // N-1 (2026-08-17): the SAME refusal the C2 branch performs above.
          // It was present only there, so with TORQCLAW_COLLAB_ENABLED off --
          // its default -- this legacy path dispatched a FRONTIER run under a
          // name-only grant that nothing downstream could fence. FRONTIER's
          // Hermes hook grants by tool NAME and never inspects args, so the
          // exact-action invariant (§1.4) cannot be satisfied here. Refuse
          // BEFORE dispatch: `dispatch` carries an independent fence
          // (frontierGrantFenced), and this is the defence-in-depth half so a
          // future caller reaching dispatch by another route still cannot
          // execute a name-only FRONTIER grant.
          if (diag.tier === ComputeTier.FRONTIER) {
            makeEmitter(sid, null, null)('SYSTEM',
              'Approval refused: FRONTIER has no args-aware structured grant protocol, '
              + 'so this approval cannot be fenced and is refused (fail-closed).',
              { approvalId: cmd.data.approvalId, refusedCode: 'frontier-structured-grant-unavailable' });
            break;
          }
          const reqEmit = makeEmitter(reqB.sessionId, reqB.id, null);
          reqEmit('ROUTING', `Re-running with permission for ${decided.toolName}`, reqB.enrichment);
          makeEmitter(reqB.sessionId, reqB.id, diag.tier)('TIER_SELECTED', diag.reason, diag);
          dispatch(reqB, diag);
        } else {
          // REJECT: degenerate task whose ONE terminal is an ERROR.
          const reqDeny: GatewayRequest = {
            ...(JSON.parse(decided.requestJson) as GatewayRequest),
            id: randomUUID(),
            receivedAt: new Date().toISOString(),
          };
          const diag = router.evaluateRequest(reqDeny);
          emitToolDenied(reqDeny, decided.toolName, diag);
        }
        break;
      }
      case 'MEMORY': {
        const emitMem = makeEmitter(sid, null, null);
        if (cmd.data.op === 'SHOW') {
          const episodes = sessions.showEpisodes(sid);
          emitMem('SYSTEM', `Memory: ${episodes.length} episode(s) this session`, {
            memory: 'SHOW', episodes,
          });
        } else {
          const n = sessions.forgetSession(sid);
          emitMem('SYSTEM', `Forgot ${n} episode(s) for this session`, { memory: 'FORGET_SESSION', forgotten: n });
        }
        break;
      }
      case 'CANCEL_TASK': {
        const reqId = cmd.data.taskId; // gateway request_id
        const emitCancel = makeEmitter(sid, reqId, null);
        emitCancel('SYSTEM', 'Cancellation requested');
        // Feature-on cancellation is persist-first: the resilience ledger
        // records the irreversible cancel fact before any provider transport
        // signal. A noop means this is a legacy/non-active task and falls
        // through to the unchanged cancellation path.
        if (process.env.TORQCLAW_PROVIDER_FAILOVER_ENABLED?.toLowerCase() === 'true') {
          try {
            const { cancelFailoverTask } = await import('./failover.js');
            const outcome = await cancelFailoverTask(reqId, 'USER_CANCELLED');
            if (outcome !== 'noop') {
              emitCancel('SYSTEM', outcome === 'cancelled' ? 'Cancellation acknowledged' : 'Cancellation uncertain');
              break;
            }
          } catch {
            emitCancel('SYSTEM', 'Cancel persistence failed; provider work was not signalled.');
            break;
          }
        }
        // FRONTIER: interrupt the Python agent via the bridge. LOCAL_EDGE: flip
        // the in-memory flag the ollama loop polls. Set both — the flag is free
        // and the bridge call no-ops if this wasn't a tracked frontier task.
        cancellations.request(reqId);
        try {
          await cancelHermesTask(reqId, 'USER_CANCELLED');
        } catch (err: any) {
          emitCancel('SYSTEM', `Cancel relay failed: ${String(err?.message ?? err)}`);
        }
        break;
      }
      case 'LIST_RECEIPTS': {
        // Read-only: SELECT + publishOnly, zero writes. The full handler body
        // lives in receipts.ts (handleListReceipts) so tests can drive the
        // exact production path headlessly — this switch delegates verbatim,
        // no parallel copy. Session-scoped by construction: the command
        // carries no sessionId param and we always pass the CONNECTION's own
        // sid, never a client-supplied value.
        handleListReceipts(sid, cmd.data.limit);
        break;
      }
      case 'GET_RECEIPT': {
        // Read-only: SELECT + publishOnly, zero writes. The full handler body
        // — ownership check (no existence oracle), taskPrompt lookup,
        // includeEvents oversize guard — lives in receipts.ts
        // (handleGetReceipt); this switch delegates verbatim, no parallel copy.
        handleGetReceipt(sid, {
          taskId: cmd.data.taskId,
          includeEvents: cmd.data.includeEvents,
        });
        break;
      }
      case 'GET_COST_SUMMARY': {
        // Read-only: SELECT + publishOnly, zero writes. Handler body in spend.ts
        // (handleGetCostSummary) so tests drive the production path headlessly.
        // Session-scoped by construction: no sessionId param, we pass the
        // CONNECTION's own sid, never a client value. Caps are env-only — this
        // path can never raise/edit a cap.
        handleGetCostSummary(sid, cmd.data.recentLimit);
        break;
      }
      case 'LIST_APPROVALS': {
        // Read-only: SELECT + publishOnly, zero writes. Handler body in
        // approvals.ts (handleListApprovals) so tests drive the production
        // path headlessly. Session-scoped by construction: no sessionId
        // param, we pass the CONNECTION's own sid, never a client value.
        // This path can never decide an approval — decideApproval is
        // reachable ONLY via APPROVE_TOOL.
        handleListApprovals(sid, cmd.data.limit, cmd.data.status);
        break;
      }
      case 'PREVIEW_ROUTE': {
        // Read-only route preview: real enrich + real evaluateRequest,
        // publishOnly response, ZERO writes. Handler body in preview.ts so
        // tests drive the exact production path headlessly. Session-scoped by
        // construction: no sessionId param; the CONNECTION's own sid is passed.
        await handlePreviewRoute(sid, cmd.data);
        break;
      }
      case 'GET_SAFE_EXPORT': {
        // Read-only: SELECT (receipt + LIVE tool_approvals) + publishOnly,
        // ZERO writes — safe_export_json is never touched by this path. The
        // full handler body — ownership check (no existence oracle),
        // allowlist projection, pattern scrub, fail-closed wrapper — lives in
        // export.ts (handleGetSafeExport); this switch delegates verbatim, no
        // parallel copy. This is the ONLY path that emits redacted material —
        // redaction runs in the gateway, never the client.
        handleGetSafeExport(sid, cmd.data.taskId);
        break;
      }
      case 'LIST_CHANNELS': {
        // PRD-TCLAW-COLLAB-PRESENCE-UI-005 S1: narrowing flag, independent
        // of authz's seat-level allow -- turning this OFF must remove the
        // command entirely (absent-deny) without touching authz.ts or the
        // C0/C1 identity hardening it protects (§9). Same terminal ERROR
        // shape as any other absent/denied action on this socket.
        if (!collabSurfaceCommandsEnabled()) {
          sendErr('NOT_ENABLED', { action: cmd.data.action, reason: 'not enabled' });
          break;
        }
        // §2a: the subject is the CONNECTION's resolved collab principal --
        // never the gateway seat/role, never a client-supplied id. No
        // resolved principal => the handler itself returns the terminal
        // COLLAB_IDENTITY_REQUIRED refusal (refuse, never substitute or
        // synthesize).
        const listErr = await handleListChannels(sid, connectionAuth?.principalId ?? null, cmd.data.limit);
        if (listErr) sendErr(listErr.code, listErr.detail);
        break;
      }
      case 'GET_CHANNEL_TIMELINE': {
        if (!collabSurfaceCommandsEnabled()) {
          sendErr('NOT_ENABLED', { action: cmd.data.action, reason: 'not enabled' });
          break;
        }
        const timelineErr = await handleGetChannelTimeline(
          sid,
          connectionAuth?.principalId ?? null,
          cmd.data.channelId,
          cmd.data.cursor,
          cmd.data.limit,
        );
        if (timelineErr) sendErr(timelineErr.code, timelineErr.detail);
        break;
      }
      case 'POST_CHANNEL_MESSAGE': {
        // PRD-TCLAW-COLLAB-PRESENCE-UI-005 S3: same absent-deny narrowing
        // flag as S1 -- turning the surface off removes posting too, without
        // touching authz.ts or the C0/C1 identity hardening it protects.
        if (!collabSurfaceCommandsEnabled()) {
          sendErr('NOT_ENABLED', { action: cmd.data.action, reason: 'not enabled' });
          break;
        }
        // §2a / A3: the subject and the STAMPED AUTHOR are both the
        // CONNECTION's resolved collab principal -- never a client-supplied
        // value (the command carries no author field to spoof). No resolved
        // principal => the handler returns the terminal
        // COLLAB_IDENTITY_REQUIRED refusal and posts nothing (CO-1).
        //
        // PRD-TCLAW-AGENT-PARTICIPATION-007 S1: agentCollabPrincipalId takes
        // precedence when set. By construction it is non-null here ONLY for
        // a node-seat connection that just cleared authz's agentCollabWrite
        // gate (a verified agent principal); for every other seat it is
        // always null (never set for an operator-kind principal, per A1-e),
        // so this falls through to connectionAuth?.principalId -- the exact,
        // unchanged 005 S3 behaviour for the operator seat.
        const postErr = await handlePostChannelMessage(
          sid,
          agentCollabPrincipalId ?? connectionAuth?.principalId ?? null,
          cmd.data.channelId,
          cmd.data.text,
          cmd.data.idempotencyKey,
        );
        if (postErr) sendErr(postErr.code, postErr.detail);
        break;
      }
      case 'SET_AUTOREPLY_STOP': {
        // PRD-TCLAW-AGENT-PARTICIPATION-007 S3: no absent-deny narrowing
        // flag gate here, deliberately -- unlike LIST_CHANNELS/
        // GET_CHANNEL_TIMELINE/POST_CHANNEL_MESSAGE (which surface
        // conversational data behind collabSurfaceCommandsEnabled()), STOP
        // is a pure control-plane halt with no data to leak. It is reached
        // only via authz's operator-seat-only gate above (authz.ts denies
        // it for role 'channel'/'node' unconditionally), so gating it a
        // second time on a data-surface flag would only make STOP
        // unavailable exactly when an operator might need it (e.g. to
        // confirm auto-reply is off before flipping the flag back on).
        // Read-vs-write of the underlying table is itself still gated: with
        // no collab.db resolved (getCollabDbForAutoReply() returns null
        // when getStore() has never succeeded -- e.g. no pepper), the
        // handler returns COLLAB_UNAVAILABLE, never a throw.
        const stopErr = await handleSetAutoreplyStop(
          sid,
          connectionAuth?.principalId ?? null,
          getCollabDbForAutoReply(),
          { stop: cmd.data.stop, scope: cmd.data.scope, channelId: cmd.data.channelId },
        );
        if (stopErr) sendErr(stopErr.code, stopErr.detail);
        break;
      }
      case 'CREATE_SCHEDULE': {
        // Operator-seat-only (authz.ts). Same no-absent-deny-flag-gate
        // reasoning as SET_AUTOREPLY_STOP: this is control-plane, not a
        // data surface, so it is reached only via authz's operator gate,
        // never a second time behind collabSurfaceCommandsEnabled().
        const createErr = await handleCreateSchedule(
          sid,
          connectionAuth?.principalId ?? null,
          getCollabDbForAutoReply(),
          {
            channelId: cmd.data.channelId,
            agentPrincipalId: cmd.data.agentPrincipalId,
            intervalSeconds: cmd.data.intervalSeconds,
            promptHint: cmd.data.promptHint,
            idempotencyKey: cmd.data.idempotencyKey,
          },
        );
        if (createErr) sendErr(createErr.code, createErr.detail);
        break;
      }
      case 'SET_SCHEDULE_STATE': {
        const stateErr = await handleSetScheduleState(
          sid, getCollabDbForAutoReply(), { scheduleId: cmd.data.scheduleId, state: cmd.data.state },
        );
        if (stateErr) sendErr(stateErr.code, stateErr.detail);
        break;
      }
      case 'LIST_SCHEDULES': {
        const listErr = await handleListSchedules(sid, getCollabDbForAutoReply(), cmd.data.channelId);
        if (listErr) sendErr(listErr.code, listErr.detail);
        break;
      }
    }
  });

  socket.on('close', () => unsubscribe?.());
});

await connectBridge(); // discover + namespace MCP servers before traffic

// PRD-TCLAW-AGENT-PARTICIPATION-007 S2: register the in-process collab
// tool server AFTER connectBridge() returns — never inside it, and never
// reachable from loadServerConfigs()/servers.json (G1R B-2; see
// registry.ts's connectInProcessServer doc comment for why that boundary
// holds by construction). Gated on agentParticipationEnabled() (S2 inherits
// S1's flag, which itself requires collabSurfaceCommandsEnabled() ->
// collabEnabled() -- so this can never register a surface those flags left
// off). Read once at boot (not per-call) because tool REGISTRATION, unlike
// the wire-command flag checks elsewhere in this file, is not something a
// live connection can race against: no traffic has been accepted yet
// (connectBridge() runs before the listener opens, and this runs
// immediately after). A boot-time flag flip requires a restart to take
// effect, matching how every other bridge server registers (connectServer
// above is equally boot-time-only).
if (agentParticipationEnabled()) {
  try {
    await connectInProcessServer(
      COLLAB_AGENT_SERVER_ID,
      buildCollabAgentMcpServer(),
      { capabilities: COLLAB_AGENT_TOOL_CAPABILITIES },
    );
  } catch (err: any) {
    // FAIL CLOSED. This used to console.warn and continue, citing CLAUDE.md
    // §4's "a malformed or unreachable server must degrade only that server".
    // That rule is about EXTERNAL MCP servers from servers.json, which the
    // operator did not write and cannot be expected to have working. This is
    // an IN-PROCESS server built from this repo's own code, reached only
    // because agentParticipationEnabled() is true -- i.e. only because the
    // operator explicitly set TORQCLAW_AGENT_PARTICIPATION on top of the
    // whole COLLAB_ENABLED -> SURFACE_COMMANDS chain. Degrading it is not
    // resilience; it is silently not delivering a feature that was asked for.
    //
    // WHY THIS IS WORSE THAN A CRASH. resolveEffectiveProfile materializes
    // allowedOperationIds FROM THE TOOL REGISTRY (profilePolicy.ts), so with
    // collab tools absent every profile resolves with an empty operation set.
    // Every auto-reply turn then fails the §5A pre-dispatch assertion and
    // throws -- deterministically, forever, for the life of the process --
    // while the gateway reports healthy and this warn line scrolls away in
    // startup output. The operator sees agents that never speak and no error
    // to explain it.
    //
    // A structural inability to act must never resolve to the same state as
    // a deliberate choice not to act. If the operator asked for agent
    // participation and it cannot be provided, that is a startup failure.
    throw new Error(
      `agent participation is enabled (TORQCLAW_AGENT_PARTICIPATION) but its collab tools failed to register: ${err?.message ?? err}. ` +
      'Refusing to start: without these tools every agent turn would fail its profile-admission assertion, ' +
      'so the gateway would report healthy while agents stayed permanently silent. ' +
      'Unset TORQCLAW_AGENT_PARTICIPATION to start without agent participation.',
      { cause: err },
    );
  }
}

// C2 startup recovery + projection rebuild (§1.4, §3.13, §6.6, A10).
//
// S0 (PRD-TCLAW-AGENT-PARTICIPATION-007 G1R Gate-1, B-7): the three sweep
// calls below used to sit INSIDE the `if (collabEnabled())` block below,
// which defaults false. Same defect class as B-1, in the recovery path: a
// gateway that crashes between an admission decision and tool execution
// leaves an inert grant unrevoked, and a gateway that crashes with a
// pending approval past its deadline leaves it actionable indefinitely --
// in the DEFAULT configuration. This matters materially more than for a
// human-paced run, because nobody is watching a crashed-and-restarted
// gateway's boot log for a stale grant. Run unconditionally, still BEFORE
// the listener opens so no client can observe a half-recovered state:
//
//   1. Revoke grants left inert by a crash between decision and admission.
//      Recovery only ever REDUCES authority -- it never completes,
//      dispatches, or reissues a grant (§6.6).
//   2. Sweep approvals and grants past their deadline through the one
//      centralized writer, so a restart cannot leave a stale row
//      indefinitely actionable.
//
// This is safe unconditionally: with collab off, these three sweeps read
// and write ONLY the C2 tables (`gateway_action_grants`, `tool_approvals`'
// C2 columns), which `ensureApprovalBrokerSchema(db)` above already creates
// unconditionally at boot (C2-1, additive migration) and which no flag-off
// path writes to in the first place -- so with the flag off these sweeps
// simply find nothing to revoke or expire and are a no-op in practice, not
// merely in principle.
try {
  const revokedInert = revokeInertGrants(db);
  const expired = sweepExpiredApprovals(db);
  sweepExpiredGrants(db);
  console.log(
    `[torqclaw] C2 recovery: ${revokedInert} inert grant(s) revoked, `
    + `${expired} approval(s) expired`,
  );
} catch (error) {
  // Recovery must never prevent the gateway from starting: every C2
  // consumer already fails closed without its evidence, so a failed sweep
  // denies rather than opens.
  console.error('[torqclaw] C2 grant/approval sweep failed (continuing fail-closed):', error);
}

// PRD-TCLAW-AGENT-PARTICIPATION-007 S3 (G1R B-3b): wire the trigger BEFORE
// running the recovery sweep below, so a stranded turn the sweep
// re-dispatches has somewhere to go. Injected (never a direct import from
// collabSurface.ts) to avoid a circular import -- see collabSurface.ts's
// setAutoReplyTrigger doc comment. Unconditional wiring is safe: with
// either flag off, onChannelMessageCommitted's own first line returns
// immediately (absent-deny), matching every other flag-gated seam in this
// file.
setAutoReplyTrigger(onChannelMessageCommitted);

// Boot-time recovery for the auto-reply watermark (G1R B-3b's required
// recovery, same discipline as revokeInertGrants above): find every
// collab_agent_turns row left 'dispatched' by a crash between claim and
// resolution, and RE-DISPATCH it rather than leaving it silently
// indistinguishable from legitimate A3-f silence. Runs unconditionally,
// before the listener opens, for the identical reason the C2 sweep above
// does. Safe with the flag off: with no auto-reply ever having run, there
// are no rows to find.
try {
  const recovered = await recoverStrandedAgentTurns();
  if (recovered > 0) {
    console.log(`[torqclaw] agent auto-reply recovery: ${recovered} stranded turn(s) re-dispatched`);
  }
} catch (error) {
  console.error('[torqclaw] agent auto-reply recovery sweep failed (continuing):', error);
}

// CRON slice (G1R Gate-1 §2A): boot-time recovery for stranded schedule
// runs, same discipline as recoverStrandedAgentTurns immediately above --
// a crash between claim and resolution is RE-DISPATCHED, never left
// silently indistinguishable from a legitimate outcome. Runs
// unconditionally, before the listener opens, for the identical reason.
try {
  const recoveredSchedules = await recoverStrandedScheduleRuns();
  if (recoveredSchedules > 0) {
    console.log(`[torqclaw] scheduled-turn recovery: ${recoveredSchedules} stranded run(s) re-dispatched`);
  }
} catch (error) {
  console.error('[torqclaw] scheduled-turn recovery sweep failed (continuing):', error);
}

// CRON slice: the scheduler ticker. A schedule "fires" only when this
// interval calls tickSchedules() -- there is no other path to a scheduled
// dispatch. tickSchedules() itself is the absent-deny gate (its own first
// line: `if (!agentCronEnabled()) return 0`), so this timer is harmless to
// start unconditionally, matching every other unconditional-wiring/
// internal-gate pattern in this file (setAutoReplyTrigger above, C2's
// admission check). The interval is intentionally SHORT (polling
// granularity, not the schedule's own interval, which is >=60s by
// migration CHECK) so a due schedule fires close to its due time rather
// than drifting by however long between ticks. unref() so this timer alone
// never keeps the process alive past a deliberate shutdown.
const cronTickTimer = setInterval(() => {
  tickSchedules().catch((err) => {
    console.error(`[torqclaw] scheduler tick failed (continuing):`, err);
  });
}, 15_000);
cronTickTimer.unref();

// Delivery-projection rebuild stays flag-gated: it is UI-delivery routing
// for the collab approval surface, not part of the exact-action admission
// fence, and it is out of this slice's scope (task names only the three
// sweep calls above).
if (collabEnabled()) {
  try {
    const projection = rebuildDeliveryProjection(db);
    console.log(
      `[torqclaw] C2 recovery: ${projection.created} delivery row(s) projected`
      + (projection.reason ? ` (${projection.reason})` : ''),
    );
  } catch (error) {
    console.error('[torqclaw] C2 delivery projection rebuild failed (continuing fail-closed):', error);
  }
}

if (process.env.TORQCLAW_PROVIDER_FAILOVER_ENABLED?.toLowerCase() === 'true') {
  const { ensureResilienceProjection, reconcileGatewayProjection } = await import('./storage.js');
  const { pageOutbox, isHermesAvailable, onHermesReady } = await import('@torqclaw/bridge');
  ensureResilienceProjection();
  // Boot must not hard-crash because the engine's outbox is unreachable
  // (engine down or still starting). Both reconcileGatewayProjection and
  // recoverFailoverTasks call pageOutbox -> the ENGINE's resilience_page_outbox
  // over MCP; with no engine there is no outbox to read and the call rejects
  // with 'invalid outbox page', which used to take the whole gateway down at
  // boot. (ensureResilienceProjection above is local-DDL only and stays
  // unconditional.)
  //
  // HONEST LIMITATION (security audit B-1): skipping here does NOT weaken the
  // per-task fail-closed guarantee -- every FRONTIER admission lazily
  // reconciles via ensureInitialResilienceProjection and fails closed if it
  // cannot, and spend caps read the local spend_ledger, never this projection.
  // recoverFailoverTasks has no per-task equivalent, so if the engine is down
  // at boot we DEFER it via onHermesReady: the bridge retries the hermes
  // connection in the background and runs the recovery as soon as the engine
  // connects (hermes-agent reconnect-watcher pattern). A boot with the engine
  // down therefore no longer strands in-flight tasks until the next restart.
  if (isHermesAvailable()) {
    try {
      await reconcileGatewayProjection(async (afterCursor, limit) => pageOutbox(afterCursor, limit));
      const { recoverFailoverTasks } = await import('./failover.js');
      await recoverFailoverTasks();
    } catch (error) {
      // Engine IS up yet reconciliation/recovery failed — a real integrity
      // error (outbox gap, cursor regression, ...). Loud on purpose: the
      // projection may be corrupt and monitoring must see it. Per-task
      // fail-closed still holds for subsequent FRONTIER dispatches.
      console.error('[torqclaw] failover boot reconciliation/recovery FAILED: ' + ((error as Error)?.message ?? String(error)));
    }
  } else {
    // Engine down at boot: don't log-and-forget. When the bridge's background
    // reconnect lands, run the recovery we skipped. Recovery is idempotent
    // (only acts on still-pending candidates); a failure here is a REAL
    // integrity error (the engine IS up by then), so it is logged loudly
    // rather than silently retried.
    console.warn('[torqclaw] failover boot recovery deferred: hermes engine unavailable — will run when the engine connects');
    onHermesReady(async () => {
      try {
        await reconcileGatewayProjection(async (afterCursor, limit) => pageOutbox(afterCursor, limit));
        const { recoverFailoverTasks } = await import('./failover.js');
        const summary = await recoverFailoverTasks();
        console.log(`[torqclaw] deferred failover recovery completed (engine connected after boot): ${summary.candidates} candidate(s)`);
      } catch (error) {
        console.error('[torqclaw] deferred failover recovery FAILED: ' + ((error as Error)?.message ?? String(error)));
      }
    });
  }
}
await app.listen({ port: PORT, host: HOST });
console.log(`[torqclaw] gateway listening on ws://${HOST}:${PORT}/ws`);
