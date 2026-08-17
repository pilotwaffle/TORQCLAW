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
import { connectBridge, approveSkill, getSkillDraft, cancelHermesTask } from '@torqclaw/bridge';
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
import { collabSurfaceCommandsEnabled, handleListChannels, handleGetChannelTimeline, handlePostChannelMessage } from './collabSurface.js';

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
// TWO conditions gate the fence, and the second is load-bearing:
//
//   1. the flag is on -- flag-off is byte-identical legacy (SI-4), no
//      grant table read, `grantedTools` alone still authorizes; and
//   2. this dispatch request actually CARRIES a C2 grant.
//
// Condition 2 exists because "flag on" is not the same as "this request
// went through C2". A legacy connection (no surface credential presented)
// still registers and decides through the legacy path even with the
// subsystem enabled, so its re-run has no grant by design. Fencing it on
// `collabEnabled()` alone refused those runs `grant-missing` -- a real
// SI-4 break that the APPROVE leg of the flag-on identity transcript
// caught (G2A D-3).
//
// This does NOT weaken the control. A request that went through C2 always
// has its grant row minted inside the deciding transaction, so for those
// requests the lookup finds it and the full check runs. What condition 2
// skips is only requests for which C2 never issued a licence in the first
// place -- and those are exactly the requests whose approval row is
// unbound and therefore inert/reissue-required at the decision seam.
setToolAdmissionCheck((requestId, toolName, args) => {
  if (!collabEnabled()) return { ok: true };
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
    const decision = authorize(role!, cmd.data, {
      sessionId: sid, lookupTaskSession, surface: surfaceAuthz,
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

         const request = await enrichCommand(cmd.data, sid, 'torq-console');
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
        const postErr = await handlePostChannelMessage(
          sid,
          connectionAuth?.principalId ?? null,
          cmd.data.channelId,
          cmd.data.text,
          cmd.data.idempotencyKey,
        );
        if (postErr) sendErr(postErr.code, postErr.detail);
        break;
      }
    }
  });

  socket.on('close', () => unsubscribe?.());
});

await connectBridge(); // discover + namespace MCP servers before traffic

// C2 startup recovery + projection rebuild (§1.4, §3.13, §6.6, A10).
//
// Gated on the flag: with collab off, no C2 table is read or written, which
// is the SI-4 requirement. With it on, this runs BEFORE the listener opens
// so no client can observe a half-recovered state:
//
//   1. Revoke grants left inert by a crash between decision and admission.
//      Recovery only ever REDUCES authority -- it never completes,
//      dispatches, or reissues a grant (§6.6).
//   2. Sweep approvals past their deadline through the one centralized
//      writer, so a restart cannot leave a stale row indefinitely
//      actionable.
//   3. Rebuild the delivery projection against CURRENTLY eligible operator
//      surfaces, so a surface that lost authority while the gateway was
//      down is not re-targeted (A10).
if (collabEnabled()) {
  try {
    const revokedInert = revokeInertGrants(db);
    const expired = sweepExpiredApprovals(db);
    sweepExpiredGrants(db);
    const projection = rebuildDeliveryProjection(db);
    console.log(
      `[torqclaw] C2 recovery: ${revokedInert} inert grant(s) revoked, `
      + `${expired} approval(s) expired, ${projection.created} delivery row(s) projected`
      + (projection.reason ? ` (${projection.reason})` : ''),
    );
  } catch (error) {
    // Recovery must never prevent the gateway from starting: every C2
    // consumer already fails closed without its evidence, so a failed
    // rebuild denies rather than opens.
    console.error('[torqclaw] C2 recovery failed (continuing fail-closed):', error);
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
