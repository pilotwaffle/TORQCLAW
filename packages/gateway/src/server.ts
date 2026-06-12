import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import {
  ClientCommandSchema,
  ConnectFrameSchema,
  GatewayRequestSchema,
} from '@torqclaw/contracts';
import { randomUUID } from 'node:crypto';
import { sessions } from './sessions.js';
import { enrichCommand } from './enrich.js';
import { dispatch } from './dispatch.js';
import { makeEmitter, sessionBus, persistAndPublish } from './events.js';
import { router } from '@torqclaw/router';
import { connectBridge, approveSkill } from '@torqclaw/bridge';

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
  return token === GATEWAY_TOKEN;
}

const app = Fastify({ logger: true });
await app.register(websocket);

app.get('/ws', { websocket: true }, (socket) => {
  let authed = false;
  let sessionId: string | null = null;
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
      authed = true;
      const resolved = sessions.resolve(conn.data);
      sessionId = resolved.sessionId;

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
        await approveSkill(cmd.data.queueId, cmd.data.decision);
        makeEmitter(sid, null, null)(
          'SYSTEM', `Skill ${cmd.data.queueId}: ${cmd.data.decision}`,
        );
        break;
      }
      case 'CANCEL_TASK': {
        // v1: mark failed; engine-side cancellation lands with task polling.
        makeEmitter(sid, cmd.data.taskId, null)('SYSTEM', 'Cancellation requested');
        break;
      }
    }
  });

  socket.on('close', () => unsubscribe?.());
});

await connectBridge(); // discover + namespace MCP servers before traffic
await app.listen({ port: PORT, host: HOST });
console.log(`[torqclaw] gateway listening on ws://${HOST}:${PORT}/ws`);
