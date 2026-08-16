import Fastify from 'fastify';
import { pathToFileURL } from 'node:url';
import { submitToGateway, resolveGatewayToken } from './gatewayClient.js';

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
 * the adapter uses to talk to the gateway (TORQCLAW_CHANNEL_SERVICE_TOKEN).
 */

const PORT = Number(process.env.CHANNEL_HTTP_PORT || 18792);
const HOST = process.env.CHANNEL_HTTP_HOST || '127.0.0.1';
const GW_URL = process.env.TORQCLAW_GW_URL || 'ws://127.0.0.1:18790/ws';
// Upstream gateway token — resolved via resolveGatewayToken so the "unset means
// unset" invariant lives in one tested place (never a hardcoded 'dev'). (TCLAW-0F)
const GW_TOKEN = resolveGatewayToken();
const FRONT_TOKEN = process.env.CHANNEL_HTTP_TOKEN || '';
const TASK_TIMEOUT_MS = Number(process.env.CHANNEL_HTTP_TIMEOUT_MS || 300_000);

const app = Fastify({ logger: true });

/** Hosts on which an unauthenticated front door is reachable only from this
 *  machine. Mirrors ops/launcher-config.mjs LOOPBACK_HOSTS. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Tokens that are present but provide no security -- worse than an unset
 *  token, because they read as "auth is configured". Mirrors the
 *  PLACEHOLDER_TOKENS check in ops/launcher-config.mjs. */
const PLACEHOLDER_TOKENS = new Set([
  'dev', 'test', 'token', 'secret', 'changeme', 'change-me', 'placeholder',
  'password', 'admin', 'example', 'todo', 'xxx',
]);

/**
 * Refuse to boot in a configuration where the front door is open to the
 * network.
 *
 * `frontDoorOk` treats an unset CHANNEL_HTTP_TOKEN as loopback dev mode and
 * accepts every caller. That is fine bound to 127.0.0.1 and a serious hole
 * bound to 0.0.0.0 -- but previously nothing connected those two facts, so a
 * deploy that set CHANNEL_HTTP_HOST and forgot the token exposed an
 * unauthenticated path to the gateway with only a log line as mitigation.
 *
 * This applies the convention the repo already uses in
 * ops/launcher-config.mjs (requireLoopbackHost / requireProductionTokens):
 * fail closed at boot rather than warn and continue.
 *
 * Exported for test; called at boot below.
 */
export function assertFrontDoorSafe(
  { host, token }: { host: string; token: string },
): void {
  const bind = String(host ?? '').trim();
  const secret = String(token ?? '').trim();
  const loopbackBound = LOOPBACK_HOSTS.has(bind);

  if (secret && PLACEHOLDER_TOKENS.has(secret.toLowerCase())) {
    throw new Error(
      `CHANNEL_HTTP_TOKEN is a placeholder value (${secret.toLowerCase()}); ` +
      'set a real secret or unset it entirely and bind to loopback.',
    );
  }
  if (!secret && !loopbackBound) {
    throw new Error(
      `CHANNEL_HTTP_TOKEN is unset while binding to ${bind || '(empty)'}, which is not a ` +
      'loopback host. An unset token accepts every caller, so this would expose an ' +
      'unauthenticated front door to the gateway. Set CHANNEL_HTTP_TOKEN, or bind to 127.0.0.1.',
    );
  }
}

/** Front-door auth: constant-time compare so we don't leak the token by timing.
 *  Unset token = loopback dev mode (accept all) -- safe only because
 *  assertFrontDoorSafe() refuses that combination off-loopback at boot.
 *  `expectedToken` is a parameter (not the module constant) so this is
 *  testable without process-env mutation. */
export function frontDoorOk(
  authHeader: string | undefined,
  expectedToken: string = FRONT_TOKEN,
): boolean {
  if (!expectedToken) return true;
  const expected = `Bearer ${expectedToken}`;
  if (!authHeader || authHeader.length !== expected.length) return false;
  // length-checked above; char-xor compare avoids early-exit timing leak
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= authHeader.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
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
  // Fail closed BEFORE binding a socket: an unset token off-loopback, or a
  // placeholder token anywhere, is a configuration error rather than something
  // to warn about and continue past. (TCLAW-CH-AUTH)
  assertFrontDoorSafe({ host: HOST, token: FRONT_TOKEN });
  if (!FRONT_TOKEN) {
    app.log.warn('CHANNEL_HTTP_TOKEN unset — accepting all callers (loopback dev only)');
  }
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`[channel-http] listening on http://${HOST}:${PORT}  →  gateway ${GW_URL}`);
};

// Only boot when executed as a program. Importing this module (e.g. to unit
// test assertFrontDoorSafe/frontDoorOk) must not bind a port -- vitest.config
// scopes the suite to pure-logic tests with no network.
const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  start().catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}
