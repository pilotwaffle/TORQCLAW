import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const args = new Set(process.argv.slice(2));
const jsonOutput = args.has('--json');
const timeoutMs = Number(process.env.TORQCLAW_DOCTOR_TIMEOUT_MS || 5000);
const gatewayUrl = process.env.TORQCLAW_GW_URL || 'ws://127.0.0.1:18790/ws';
const consoleUrl = process.env.TORQCLAW_CONSOLE_URL || 'http://127.0.0.1:3000/api/health';
const ollamaUrl = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const localModel = process.env.TORQCLAW_LOCAL_MODEL || 'torq-local';

const checks = [];

function record(name, status, detail) {
  checks.push({ name, status, detail });
}

async function withTimeout(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function checkConsole() {
  try {
    const response = await withTimeout(fetch(consoleUrl), 'console health');
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.status !== 'ready') {
      record('console', 'fail', `${response.status} ${JSON.stringify(body)}`);
      return;
    }
    record('console', 'pass', `${consoleUrl} is ready`);
  } catch (error) {
    record('console', 'fail', error.message);
  }
}

async function checkGateway() {
  await new Promise((resolve) => {
    const socket = new WebSocket(gatewayUrl);
    let settled = false;
    const finish = (status, detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      record('gateway', status, detail);
      resolve();
    };
    const timer = setTimeout(() => finish('fail', `gateway timed out after ${timeoutMs}ms`), timeoutMs);
    socket.on('open', () => socket.send(JSON.stringify({
      role: 'operator',
      token: process.env.TORQCLAW_GATEWAY_TOKEN || '',
      clientInfo: { name: 'torqclaw-doctor', version: '0.1.0' },
    })));
    socket.on('message', (raw) => {
      let event;
      try { event = JSON.parse(raw.toString()); } catch { return finish('fail', 'gateway returned malformed JSON'); }
      if (event.type === 'CONNECTED') finish('pass', `authenticated WebSocket session ${event.sessionId}`);
      else if (event.code) finish('fail', `gateway rejected connection: ${event.code}`);
    });
    socket.on('error', (error) => finish('fail', error.message));
  });
}

async function checkOllama() {
  try {
    const response = await withTimeout(fetch(`${ollamaUrl.replace(/\/$/, '')}/api/tags`), 'Ollama');
    if (!response.ok) {
      record('ollama', 'warn', `HTTP ${response.status}`);
      return;
    }
    const body = await response.json().catch(() => ({}));
    const models = Array.isArray(body.models) ? body.models.map((model) => model.name) : [];
    const found = models.some((name) => name === localModel || name?.startsWith(`${localModel}:`));
    record('ollama', found ? 'pass' : 'warn', found
      ? `${localModel} is installed`
      : `${localModel} is not installed; available models: ${models.join(', ') || '(none)'}`);
  } catch (error) {
    record('ollama', 'warn', `${error.message}; local execution will be unavailable`);
  }
}

function checkMcpRoster() {
  const file = join(process.env.TORQCLAW_DATA_DIR || join(homedir(), '.torqclaw'), 'servers.json');
  if (!existsSync(file)) {
    record('mcp-roster', 'warn', `${file} does not exist`);
    return;
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const servers = Array.isArray(parsed.servers) ? parsed.servers : [];
    const enabled = servers.filter((server) => server.enabled !== false).map((server) => server.id);
    record('mcp-roster', enabled.length ? 'pass' : 'warn', `${enabled.length} enabled server(s): ${enabled.join(', ') || '(none)'}`);
  } catch (error) {
    record('mcp-roster', 'fail', `${file}: ${error.message}`);
  }
}

await Promise.all([checkConsole(), checkGateway(), checkOllama()]);
checkMcpRoster();

const failed = checks.some((check) => check.status === 'fail');
if (jsonOutput) {
  console.log(JSON.stringify({ ok: !failed, checks }, null, 2));
} else {
  console.log('TORQCLAW doctor');
  for (const check of checks) console.log(`${check.status === 'pass' ? 'PASS' : check.status === 'warn' ? 'WARN' : 'FAIL'}  ${check.name}: ${check.detail}`);
  console.log(failed ? 'Result: NOT READY' : 'Result: READY (warnings may affect local features)');
}
process.exitCode = failed ? 1 : 0;
