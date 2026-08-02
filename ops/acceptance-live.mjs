import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { buildLauncherConfig } from './launcher-config.mjs';
import { doctorPassed, runDoctor } from './doctor-core.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const LIVE_PROMPT = 'Reply with exactly TORQCLAW_LIVE_OK. Do not call tools.';
const LIVE_MAX_COST_USD = 0.25;

export function requireLiveEnvironment(env) {
  for (const key of ['HERMES_MODEL', 'HERMES_PROVIDER', 'HERMES_API_KEY']) {
    if (!String(env[key] ?? '').trim()) throw new Error(`live acceptance requires ${key}`);
  }
}

export function buildLiveRequest() {
  return {
    action: 'SUBMIT_PROMPT',
    prompt: LIVE_PROMPT,
    sensitive: false,
    urgent: false,
    attachmentIds: [],
    useMemory: false,
    executionMode: 'CLOUD_OK',
    maxCostUsd: LIVE_MAX_COST_USD,
  };
}

export function evaluateLiveAcceptance(events, {
  expectedModel,
  submitSentAfterConnected = true,
} = {}) {
  if (!submitSentAfterConnected) return { ok: false, reason: 'submit was not sent after CONNECTED' };
  if (!Array.isArray(events) || !events.some((event) => event?.type === 'CONNECTED')) {
    return { ok: false, reason: 'missing CONNECTED' };
  }
  if (!expectedModel) return { ok: false, reason: 'missing expected model' };

  let requestId = null;
  let sawFrontier = false;
  let result = null;
  for (const event of events) {
    if (!event || typeof event !== 'object') return { ok: false, reason: 'malformed event' };
    if (event.type === 'ERROR') return { ok: false, reason: 'ERROR terminal' };
    if (event.type === 'PENDING_APPROVAL') return { ok: false, reason: 'PENDING_APPROVAL terminal' };
    if (event.type === 'TIER_SELECTED') {
      if (event.tier !== 'API_EXTERNAL' || !event.requestId) {
        return { ok: false, reason: 'missing correlated FRONTIER TIER_SELECTED' };
      }
      if (requestId && event.requestId !== requestId) {
        return { ok: false, reason: 'unrelated TIER_SELECTED' };
      }
      requestId = event.requestId;
      sawFrontier = true;
    } else if (event.type === 'ROUTING' && requestId && event.requestId !== requestId) {
      return { ok: false, reason: 'unrelated ROUTING' };
    }
    if (event.type === 'RESULT') {
      if (!requestId || event.requestId !== requestId || event.tier !== 'API_EXTERNAL') {
        return { ok: false, reason: 'unrelated or non-FRONTIER RESULT' };
      }
      if (event.message !== 'TORQCLAW_LIVE_OK') {
        return { ok: false, reason: 'live sentinel mismatch' };
      }
      if (event.metadata?.engineUsed !== `hermes:${expectedModel}`) {
        return { ok: false, reason: 'RESULT engineUsed mismatch or stub' };
      }
      if (result) return { ok: false, reason: 'multiple RESULT terminals' };
      result = event;
    }
  }
  if (!sawFrontier) return { ok: false, reason: 'missing FRONTIER TIER_SELECTED' };
  if (!result) return { ok: false, reason: 'missing RESULT' };
  return { ok: true, requestId, result };
}

export async function runLiveAcceptance({
  env = process.env,
  root = ROOT,
  config,
  timeoutMs = 300_000,
  WebSocketImpl = WebSocket,
} = {}) {
  requireLiveEnvironment(env);
  const effectiveConfig = config ?? buildLauncherConfig(env, { production: true });
  const runtime = await runDoctor({ mode: 'runtime', production: true, root, env });
  if (!doctorPassed(runtime)) throw new Error('runtime readiness failed');

  const events = [];
  let submitSentAfterConnected = false;
  const socket = new WebSocketImpl(effectiveConfig.nextPublicGatewayUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('live acceptance timed out')), timeoutMs);
    let connected = false;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    socket.on('open', () => {
      socket.send(JSON.stringify({
        role: 'operator',
        token: env.TORQCLAW_GATEWAY_TOKEN,
        clientInfo: { name: 'torqclaw-live-acceptance', version: '1.0.0' },
      }));
    });
    socket.on('message', (raw) => {
      let event;
      try { event = JSON.parse(raw.toString()); } catch { finish(reject, new Error('malformed gateway event')); return; }
      events.push(event);
      if (event.type === 'ERROR' || event.type === 'PENDING_APPROVAL') {
        finish(reject, new Error(`live acceptance received ${event.type}`));
        return;
      }
      if (event.type === 'CONNECTED' && !connected) {
        connected = true;
        socket.send(JSON.stringify(buildLiveRequest()));
        submitSentAfterConnected = true;
        return;
      }
      if (event.type === 'RESULT') finish(resolve, event);
    });
    socket.on('error', () => finish(reject, new Error('gateway connection failed')));
    socket.on('close', () => {
      if (!settled) finish(reject, new Error('gateway connection closed before acceptance'));
    });
  }).finally(() => { try { socket.close(); } catch { /* already closed */ } });

  const verdict = evaluateLiveAcceptance(events, {
    expectedModel: env.HERMES_MODEL,
    submitSentAfterConnected,
  });
  if (!verdict.ok) throw new Error(`live acceptance failed: ${verdict.reason}`);
  return verdict;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const verdict = await runLiveAcceptance();
    process.stdout.write(`LIVE ACCEPTANCE PASS request=${verdict.requestId}\n`);
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'live acceptance failed'}\n`);
    process.exit(1);
  }
}
