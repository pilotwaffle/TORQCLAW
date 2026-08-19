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

/** Mirrors packages/gateway/src/connectionAuth.ts's isProductionRuntime()
 *  EXACTLY. Doctor must decide "is the legacy token path still open" by the
 *  same rule the gateway itself uses, or it will diagnose a contract the
 *  server is not running. */
function isProductionRuntime(env = process.env) {
  return env.TORQCLAW_RUNTIME_MODE === 'production' || env.NODE_ENV === 'production';
}

/**
 * Resolve the CONNECT auth carrier for the legacy doctor's live gateway probe.
 *
 * WHY THIS IS NOT JUST `token:` ANYMORE
 * -------------------------------------
 * The static shared TORQCLAW_GATEWAY_TOKEN root token is FATAL in production:
 * ops/launcher-config.mjs's requireProductionTokens() throws at config-build
 * time and packages/gateway/src/connectionAuth.ts's
 * assertProductionLegacyTokenDisabled() backs it up. Worse,
 * authenticateConnection() returns null for ANY tokenful legacy frame once
 * `production` is set (connectionAuth.ts: `if (deps.production) return null;`
 * precedes the legacy arm entirely), so against a production gateway the old
 * frame could only ever produce AUTH_FAILED. Same stale-harness class the CI
 * gates hit in 952e547 / 9152543 / 929e5ed; this is the last instance.
 *
 * WHY DOCTOR READS A CREDENTIAL INSTEAD OF BOOTSTRAPPING ONE
 * ----------------------------------------------------------
 * ops/e2e-production-launch.mjs RUNS ops/bootstrap-operator.mjs because it
 * owns a throwaway data dir with no operator in it. Doctor is a standalone
 * CLI pointed at the operator's REAL install, where an operator principal
 * already exists -- `principals_single_operator` (packages/collab
 * migration.ts) makes a second bootstrap a hard refusal that mints nothing.
 * So doctor must CONSUME the already-issued credential, never mint one.
 * It looks in two places, in order:
 *   1. TORQCLAW_OPERATOR_CREDENTIAL -- the operator pasted the token they
 *      copied to their password manager, the shape .env.example already tells
 *      them to keep.
 *   2. <TORQCLAW_DATA_DIR>/operator-credential.token -- the single-use file
 *      ops/bootstrap-operator.mjs writes and tells the operator to delete
 *      once copied. Present only on a fresh install; read, never deleted
 *      (deleting it here would destroy the operator's only copy).
 *
 * FAIL LOUD, NEVER DEGRADE-TO-OK
 * -------------------------------
 * A structural inability to authenticate must NEVER resolve to the same state
 * as a healthy gateway. If production mode is on and no credential can be
 * found, this returns a `problem` and the caller records a hard `fail` naming
 * the missing input -- it does NOT fall back to the legacy token (which the
 * gateway would reject anyway) and does NOT connect anonymously.
 */
export function resolveDoctorAuth(env = process.env, { readFile = readFileSync } = {}) {
  const production = isProductionRuntime(env);
  const credential = String(env.TORQCLAW_OPERATOR_CREDENTIAL ?? '').trim();
  if (credential) {
    return { kind: 'surface', credential, source: 'TORQCLAW_OPERATOR_CREDENTIAL' };
  }
  const tokenFile = join(env.TORQCLAW_DATA_DIR || join(homedir(), '.torqclaw'), 'operator-credential.token');
  let fileCredential = '';
  try {
    fileCredential = String(readFile(tokenFile, 'utf8')).trim();
  } catch { /* absent or unreadable: fall through to the production refusal */ }
  if (fileCredential) {
    return { kind: 'surface', credential: fileCredential, source: tokenFile };
  }
  if (production) {
    return {
      kind: 'problem',
      detail:
        'no operator credential available and the deprecated TORQCLAW_GATEWAY_TOKEN ' +
        'is forbidden in production, so this connection could only ever be rejected. ' +
        `Set TORQCLAW_OPERATOR_CREDENTIAL, or leave ${tokenFile} in place from ` +
        '`node ops/bootstrap-operator.mjs` (run it once if this install has never been bootstrapped).',
    };
  }
  // Non-production only: the legacy arm is still live in the gateway
  // (connectionAuth.ts authenticates a matching token, and accepts a tokenless
  // frame on loopback when no token is configured), so the existing local/dev
  // path is preserved unchanged -- but announced, never silent.
  return {
    kind: 'legacy',
    token: String(env.TORQCLAW_GATEWAY_TOKEN ?? ''),
    source: 'TORQCLAW_GATEWAY_TOKEN (deprecated development-only path)',
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
  const auth = resolveDoctorAuth();
  if (auth.kind === 'problem') {
    // A structural inability to authenticate is NOT a healthy gateway and is
    // NOT a warning. Recording 'fail' here makes result.ok false and the exit
    // code 1, exactly as a rejected or unreachable gateway would.
    record('gateway', 'fail', `cannot authenticate: ${auth.detail}`);
  } else await new Promise((resolve) => {
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
    // The legacy fallback is deliberately LOUD: an operator reading doctor
    // output must be able to see that this run proved the deprecated
    // development path, not the production credential contract.
    if (auth.kind === 'legacy') {
      process.stderr.write(
        'doctor: authenticating with the DEPRECATED TORQCLAW_GATEWAY_TOKEN legacy path ' +
        '(non-production runtime only; this token is forbidden in production). ' +
        'Set TORQCLAW_OPERATOR_CREDENTIAL to exercise the real production contract.\n'
      );
    }
    socket.on('open', () => socket.send(JSON.stringify({
      expectedRole: 'operator',
      clientInfo: { name: 'torqclaw-doctor', version: '0.1.0' },
      ...(auth.kind === 'surface'
        ? { auth: { kind: 'surface', credential: auth.credential } }
        : { token: auth.token }),
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
