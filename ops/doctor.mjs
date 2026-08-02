import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { runDoctor, doctorPassed, formatDoctor, DEFAULT_ROOT } from './doctor-core.mjs';
import { runPhase1Doctor } from './phase1-doctor.mjs';

export function parseArgs(argv) {
  if (argv.includes('--phase1') || argv.includes('--failover')) return { phase1: true, argv };
  const modes = argv.filter((arg) => arg === '--preflight' || arg === '--runtime');
  if (modes.length > 1) throw new Error('doctor requires exactly one of --preflight or --runtime');
  if (modes.length === 0) {
    if (argv.length === 0) throw new Error('doctor requires exactly one of --preflight or --runtime');
    return { legacy: true, mode: 'runtime', json: argv.includes('--json'), production: false, liveRequested: false };
  }
  const mode = modes[0]?.slice(2) ?? 'runtime';
  return {
    mode,
    json: argv.includes('--json'),
    production: argv.includes('--production'),
    liveRequested: argv.includes('--live'),
  };
}

async function runLegacyDoctor(argv) {
  const jsonOutput = argv.includes('--json');
  const timeoutMs = Number(process.env.TORQCLAW_DOCTOR_TIMEOUT_MS || 5000);
  const gatewayUrl = process.env.TORQCLAW_GW_URL || 'ws://127.0.0.1:18790/ws';
  const consoleUrl = process.env.TORQCLAW_CONSOLE_URL || 'http://127.0.0.1:3000/api/health';
  const ollamaUrl = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
  const localModel = process.env.TORQCLAW_LOCAL_MODEL || 'torq-local';
  const checks = [];
  const record = (name, status, detail) => checks.push({ name, status, detail });
  const withTimeout = async (promise, label) => {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    try { return await Promise.race([promise, timeout]); } finally { clearTimeout(timer); }
  };
  try {
    const response = await withTimeout(fetch(consoleUrl), 'console health');
    const body = await response.json().catch(() => ({}));
    record('console', response.ok && body.status === 'ready' ? 'pass' : 'fail',
      response.ok && body.status === 'ready' ? `${consoleUrl} is ready` : `${response.status} ${JSON.stringify(body)}`);
  } catch (error) { record('console', 'fail', error.message); }
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
      role: 'operator', token: process.env.TORQCLAW_GATEWAY_TOKEN || '',
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
  try {
    const response = await withTimeout(fetch(`${ollamaUrl.replace(/\/$/, '')}/api/tags`), 'Ollama');
    if (!response.ok) record('ollama', 'warn', `HTTP ${response.status}`);
    else {
      const body = await response.json().catch(() => ({}));
      const models = Array.isArray(body.models) ? body.models.map((model) => model.name) : [];
      const found = models.some((name) => name === localModel || name?.startsWith(`${localModel}:`));
      record('ollama', found ? 'pass' : 'warn', found ? `${localModel} is installed`
        : `${localModel} is not installed; available models: ${models.join(', ') || '(none)'}`);
    }
  } catch (error) { record('ollama', 'warn', `${error.message}; local execution will be unavailable`); }
  const roster = join(process.env.TORQCLAW_DATA_DIR || join(homedir(), '.torqclaw'), 'servers.json');
  if (!existsSync(roster)) record('mcp-roster', 'warn', `${roster} does not exist`);
  else {
    try {
      const parsed = JSON.parse(readFileSync(roster, 'utf8'));
      const servers = Array.isArray(parsed.servers) ? parsed.servers : [];
      const enabled = servers.filter((server) => server.enabled !== false).map((server) => server.id);
      record('mcp-roster', enabled.length ? 'pass' : 'warn', `${enabled.length} enabled server(s): ${enabled.join(', ') || '(none)'}`);
    } catch (error) { record('mcp-roster', 'fail', `${roster}: ${error.message}`); }
  }
  const result = { ok: !checks.some((check) => check.status === 'fail'), checks };
  if (jsonOutput) console.log(JSON.stringify(result, null, 2));
  else {
    console.log('TORQCLAW doctor');
    for (const check of checks) console.log(`${check.status === 'pass' ? 'PASS' : check.status === 'warn' ? 'WARN' : 'FAIL'}  ${check.name}: ${check.detail}`);
    console.log(result.ok ? 'Result: READY (warnings may affect local features)' : 'Result: NOT READY');
  }
  return result.ok ? 0 : 1;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.phase1) return runPhase1Doctor(argv);
  if (options.legacy) return runLegacyDoctor(argv);
  const records = await runDoctor({ ...options, root: DEFAULT_ROOT });
  process.stdout.write(`${formatDoctor(records, options.json)}\n`);
  return doctorPassed(records) ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'doctor failed'}\n`);
    process.exitCode = 2;
  }
}
