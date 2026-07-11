import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import {
  ClientCommandSchema,
  ConnectFrameSchema,
  GatewayRequestSchema,
  type GatewayRequest,
} from '@torqclaw/contracts';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { sessions } from './sessions.js';
import { enrichCommand } from './enrich.js';
import { dispatch, mintGrantedRequest, emitToolDenied } from './dispatch.js';
import { decideApproval, handleListApprovals } from './approvals.js';
import { makeEmitter, sessionBus, persistAndPublish } from './events.js';
import { router } from '@torqclaw/router';
import { connectBridge, approveSkill, getSkillDraft, cancelHermesTask } from '@torqclaw/bridge';
import { setCancelCheck } from '@torqclaw/inference';
import { cancellations } from './cancellations.js';
import { authorize, checkResumeRole, type Role } from './authz.js';
import { db } from './storage.js';
import { handleListReceipts, handleGetReceipt } from './receipts.js';
import { handleGetCostSummary } from './spend.js';
import { handlePreviewRoute } from './preview.js';

// Read helper for authz's task-ownership check. Kept inline here (not in
// events.ts taskStore) per scope: this ticket may only touch authz.ts,
// server.ts, sessions.ts. Same db handle pattern sessions.ts already uses.
const lookupTaskSessionStmt = db.prepare('SELECT session_id FROM tasks WHERE request_id = ?');
function lookupTaskSession(taskId: string): string | null {
  const row = lookupTaskSessionStmt.get(taskId) as { session_id: string } | undefined;
  return row ? row.session_id : null;
}

// Let the LOCAL_EDGE loop observe cancellations without importing the gateway DB.
setCancelCheck((requestId) => cancellations.isCancelled(requestId));

// Port deliberately != 18789 so TORQCLAW can coexist with a stock OpenClaw
// install on the same box during comparison testing.
const PORT = Number(process.env.TORQCLAW_PORT || 18790);
const HOST = process.env.TORQCLAW_HOST || '127.0.0.1';
const GATEWAY_TOKEN = process.env.TORQCLAW_GATEWAY_TOKEN || '';

function verifyToken(token: string): boolean {
  if (!GATEWAY_TOKEN) {
    console.warn('[gateway] TORQCLAW_GATEWAY_TOKEN unset — accepting all loopback clients (dev only)');
    return true;
  }
  // Constant-time compare: plain === leaks match length/position via timing.
  const received = Buffer.from(token);
  const expected = Buffer.from(GATEWAY_TOKEN);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

const app = Fastify({ logger: true });
await app.register(websocket);

app.get('/ws', { websocket: true }, (socket) => {
  let authed = false;
  let sessionId: string | null = null;
  let role: Role | null = null;
  let unsubscribe: (() => void) | null = null;

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
      if (!conn.success || !verifyToken(conn.data.token)) {
        sendErr('AUTH_FAILED');
        return socket.close(4001, 'auth failed');
      }
      const resolved = sessions.resolve(conn.data);

      // A RESUME (sessionId matched an existing row) whose frame.role disagrees
      // with the stored role is rejected outright — never mint a fresh session
      // as a fallback, since that would let a client re-cast its own role.
      // The guard itself lives in authz.ts (checkResumeRole) so the unit tests
      // cover the actual production path.
      const roleCheck = checkResumeRole(resolved.resumed, resolved.role, conn.data.role);
      if (!roleCheck.ok) {
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
    const decision = authorize(role!, cmd.data, { sessionId: sid, lookupTaskSession });
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

        const reqEmit = makeEmitter(sid, request.id, null);
        reqEmit('ROUTING', `Classified as ${request.payload.taskType}`, request.enrichment);

        const diag = router.evaluateRequest(request);
        makeEmitter(sid, request.id, diag.tier)('TIER_SELECTED', diag.reason, diag);

        dispatch(request, diag); // returns immediately
        break;
      }
      case 'APPROVE_SKILL': {
        await approveSkill(cmd.data.queueId, cmd.data.decision, cmd.data.editedMarkdown);
        const edited = cmd.data.decision === 'APPROVE' && cmd.data.editedMarkdown !== undefined;
        makeEmitter(sid, null, null)(
          'SYSTEM',
          `Skill ${cmd.data.queueId}: ${cmd.data.decision}${edited ? ' (with edits)' : ''}`,
        );
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
        // Decide the grant. decideApproval is idempotent + exactly-once: a
        // double-click returns null and we no-op (invariant 7 — no second
        // re-dispatch). The granted tool is read from the DB row, never the
        // client frame, so a client can't widen the grant.
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
          const reqEmit = makeEmitter(reqB.sessionId, reqB.id, null);
          reqEmit('ROUTING', `Re-running with permission for ${decided.toolName}`, reqB.enrichment);
          const diag = router.evaluateRequest(reqB);
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
    }
  });

  socket.on('close', () => unsubscribe?.());
});

await connectBridge(); // discover + namespace MCP servers before traffic
await app.listen({ port: PORT, host: HOST });
console.log(`[torqclaw] gateway listening on ws://${HOST}:${PORT}/ws`);
