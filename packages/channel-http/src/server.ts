import Fastify from 'fastify';
import { submitToGateway } from './gatewayClient.js';

/**
 * TORQCLAW HTTP channel adapter.
 *
 * The first non-console channel: an external surface that speaks plain HTTP
 * and bridges to the gateway via the role:'channel' seat reserved in the
 * ConnectFrame contract. Proves the multi-channel architecture end-to-end and
 * is the template a Slack/Discord adapter reuses (they only swap the HTTP
 * layer for their own transport; the gatewayClient core is shared).
 *
 *   POST /task   { prompt, sensitive?, executionMode?, sessionId?, maxCostUsd? }
 *     → { ok, tier, answer, sessionId, blockedOn?, ... }
 *   GET  /health → { ok, gateway }
 *
 * Auth: if CHANNEL_HTTP_TOKEN is set, callers must send it as a Bearer token.
 * This is the channel's OWN front-door auth — separate from the gateway token
 * the adapter uses to talk to the gateway (TORQCLAW_GATEWAY_TOKEN).
 */

const PORT = Number(process.env.CHANNEL_HTTP_PORT || 18792);
const HOST = process.env.CHANNEL_HTTP_HOST || '127.0.0.1';
const GW_URL = process.env.TORQCLAW_GW_URL || 'ws://127.0.0.1:18790/ws';
const GW_TOKEN = process.env.TORQCLAW_GATEWAY_TOKEN || 'dev';
const FRONT_TOKEN = process.env.CHANNEL_HTTP_TOKEN || '';
const TASK_TIMEOUT_MS = Number(process.env.CHANNEL_HTTP_TIMEOUT_MS || 300_000);

const app = Fastify({ logger: true });

/** Front-door auth: constant-time compare so we don't leak the token by timing.
 *  Unset token = loopback dev mode (warn once at boot, accept all). */
function frontDoorOk(authHeader: string | undefined): boolean {
  if (!FRONT_TOKEN) return true;
  const expected = `Bearer ${FRONT_TOKEN}`;
  if (!authHeader || authHeader.length !== expected.length) return false;
  // length-checked above; char-xor compare avoids early-exit timing leak
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= authHeader.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

if (!FRONT_TOKEN) {
  app.log.warn('CHANNEL_HTTP_TOKEN unset — accepting all callers (dev only)');
}

app.get('/health', async () => ({ ok: true, gateway: GW_URL }));

app.post('/task', async (req, reply) => {
  if (!frontDoorOk(req.headers.authorization)) {
    return reply.code(401).send({ ok: false, error: 'unauthorized' });
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) {
    return reply.code(400).send({ ok: false, error: 'prompt is required' });
  }

  const result = await submitToGateway(
    {
      url: GW_URL,
      token: GW_TOKEN,
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
      clientName: 'channel-http',
      timeoutMs: TASK_TIMEOUT_MS,
    },
    {
      prompt,
      sensitive: body.sensitive === true,
      urgent: body.urgent === true,
      executionMode:
        body.executionMode === 'LOCAL_ONLY' || body.executionMode === 'CLOUD_OK'
          ? body.executionMode
          : 'AUTO',
      maxCostUsd: typeof body.maxCostUsd === 'number' ? body.maxCostUsd : undefined,
      useMemory: body.useMemory !== false,
    },
  );

  const t = result.terminal;
  // Map the terminal event to a clean channel response. PENDING_APPROVAL means
  // a write-capable tool needs a human OK — a headless channel can't click a
  // permission card, so we report it honestly rather than pretend it ran.
  if (t.type === 'RESULT') {
    return reply.send({
      ok: true,
      tier: tierLabel(t.tier),
      answer: t.message,
      sessionId: result.sessionId,
      metadata: t.metadata ?? null,
    });
  }
  if (t.type === 'PENDING_APPROVAL') {
    return reply.code(202).send({
      ok: false,
      status: 'pending_approval',
      message:
        'This task needs human tool approval, which requires the interactive ' +
        'console. Approve it there, or resubmit with executionMode that avoids ' +
        'write-capable tools.',
      blockedOn: (t.metadata as any)?.toolName ?? null,
      sessionId: result.sessionId,
    });
  }
  // ERROR (incl. timeout / connection failure)
  return reply.code(result.timedOut ? 504 : 502).send({
    ok: false,
    error: t.message || 'task failed',
    sessionId: result.sessionId,
  });
});

function tierLabel(tier: unknown): string {
  if (tier === 'OLLAMA_LOCAL') return 'local';
  if (tier === 'API_EXTERNAL') return 'cloud';
  return String(tier ?? 'unknown');
}

const start = async () => {
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`[channel-http] listening on http://${HOST}:${PORT}  →  gateway ${GW_URL}`);
};

start().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
