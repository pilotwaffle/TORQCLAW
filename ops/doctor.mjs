import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';

const phase1Args = process.argv.slice(2);
const phase1Mode = phase1Args.includes('--phase1') || phase1Args.includes('--failover');

function runPhase1Doctor() {
  const jsonOutput = phase1Args.includes('--json');
  const pathArg = phase1Args.indexOf('--chains');
  const configuredPath = pathArg >= 0 ? phase1Args[pathArg + 1] : process.env.TORQCLAW_PROVIDER_CHAINS_PATH;
  const chainPath = configuredPath ? resolve(configuredPath) : null;
  const phase1Checks = [];
  const recordPhase1 = (name, status, detail) => phase1Checks.push({ name, status, detail });
  const safeSelector = (value) =>
    typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value);
  const finiteCeiling = (value) => Number.isSafeInteger(value) && value >= 0;

  if (!chainPath) {
    recordPhase1('chains-path', 'fail', 'TORQCLAW_PROVIDER_CHAINS_PATH is not configured');
  } else if (!existsSync(chainPath)) {
    recordPhase1('chains-path', 'fail', 'configured provider-chain document is not readable');
  } else {
    let document;
    try {
      document = JSON.parse(readFileSync(chainPath, 'utf8'));
    } catch {
      recordPhase1('chains-parse', 'fail', 'provider-chain document is not valid JSON');
    }
    if (document !== undefined) {
      if (!document || typeof document !== 'object' || Array.isArray(document) ||
          typeof document.revision !== 'string' || document.revision.length === 0 ||
          !document.chains || typeof document.chains !== 'object' || Array.isArray(document.chains)) {
        recordPhase1('chains-schema', 'fail', 'revision and chains are required');
      } else {
        recordPhase1('chains-parse', 'pass', 'provider-chain JSON is parseable');
        recordPhase1('revision', 'pass', 'chain revision is present');
        let allValid = true;
        let allPrivacyEligible = true;
        let allSelectorsAccepted = true;
        let allEnvNamesPresent = true;
        for (const chain of Object.values(document.chains)) {
          if (!chain || typeof chain !== 'object' || chain.id === undefined ||
              !Array.isArray(chain.providers) || chain.providers.length !== 2 ||
              chain.providers.some((provider) => !provider || typeof provider !== 'object')) {
            allValid = false;
            continue;
          }
          const ids = chain.providers.map((provider) => provider.id);
          if (new Set(ids).size !== ids.length || ids.some((id) => !safeSelector(id))) {
            allSelectorsAccepted = false;
          }
          for (const provider of chain.providers) {
            if (!finiteCeiling(provider.ceilingMicroUsd)) allValid = false;
            if (!Array.isArray(provider.privacyClasses) ||
                !provider.privacyClasses.includes('standard') ||
                !provider.privacyClasses.includes('sensitive')) {
              allPrivacyEligible = false;
            }
            for (const envName of [provider.apiKeyEnvName, provider.baseUrlEnvName]) {
              if (typeof envName !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(envName) ||
                  process.env[envName] === undefined || process.env[envName] === '') {
                allEnvNamesPresent = false;
              }
            }
          }
        }
        recordPhase1(
          'ordered-distinct-ids',
          allValid && allSelectorsAccepted ? 'pass' : 'fail',
          allValid && allSelectorsAccepted
            ? 'chains contain two ordered accepted Hermes selectors'
            : 'chain IDs or provider selectors are invalid',
        );
        recordPhase1(
          'finite-ceilings',
          allValid ? 'pass' : 'fail',
          allValid
            ? 'all provider ceilings are finite non-negative integers'
            : 'a provider ceiling is invalid',
        );
        recordPhase1(
          'privacy-eligibility',
          allPrivacyEligible ? 'pass' : 'fail',
          allPrivacyEligible
            ? 'each chain has two providers eligible for standard and sensitive work'
            : 'privacy eligibility is incomplete',
        );
        recordPhase1(
          'referenced-env-presence',
          allEnvNamesPresent ? 'pass' : 'fail',
          allEnvNamesPresent
            ? 'all referenced environment variables are present'
            : 'a referenced environment variable is absent',
        );
      }
    }
  }

  const diagnosticsArg = phase1Args.indexOf('--maintenance-diagnostics');
  const configuredDiagnosticsPath = diagnosticsArg >= 0
    ? phase1Args[diagnosticsArg + 1]
    : process.env.TORQCLAW_MAINTENANCE_DIAGNOSTICS_PATH;
  const diagnosticsPath = configuredDiagnosticsPath
    ? resolve(configuredDiagnosticsPath)
    : join(process.env.TORQCLAW_DATA_DIR || join(homedir(), '.torqclaw'), 'resilience-maintenance.json');
  if (!existsSync(diagnosticsPath)) {
    phase1Checks.push({
      name: 'maintenance', status: 'warn',
      detail: 'no shutdown maintenance snapshot is available; no checkpoint was triggered',
      maintenanceNeeded: null, lastPassiveOutcome: null, walMaintenanceDeferred: null,
    });
  } else {
    try {
      const diagnostics = JSON.parse(readFileSync(diagnosticsPath, 'utf8'));
      const valid = diagnostics && typeof diagnostics === 'object' &&
        diagnostics.schemaVersion === 1 &&
        typeof diagnostics.maintenanceNeeded === 'boolean' &&
        diagnostics.lastPassiveOutcome && typeof diagnostics.lastPassiveOutcome === 'object' &&
        typeof diagnostics.walMaintenanceDeferred === 'boolean';
      if (!valid) {
        phase1Checks.push({
          name: 'maintenance', status: 'fail',
          detail: 'maintenance snapshot is malformed',
          maintenanceNeeded: null, lastPassiveOutcome: null, walMaintenanceDeferred: null,
        });
      } else {
        phase1Checks.push({
          name: 'maintenance', status: 'pass',
          detail: 'read-only shutdown maintenance diagnostics loaded; no checkpoint triggered',
          maintenanceNeeded: diagnostics.maintenanceNeeded,
          lastPassiveOutcome: diagnostics.lastPassiveOutcome,
          walMaintenanceDeferred: diagnostics.walMaintenanceDeferred,
        });
      }
    } catch {
      phase1Checks.push({
        name: 'maintenance', status: 'fail',
        detail: 'maintenance snapshot is not valid JSON',
        maintenanceNeeded: null, lastPassiveOutcome: null, walMaintenanceDeferred: null,
      });
    }
  }

  const failed = phase1Checks.some((check) => check.status === 'fail');
  const result = { ok: !failed, mode: 'offline-secret-free', checks: phase1Checks };
  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('TORQCLAW Phase-1 doctor (offline, secret-free)');
    for (const check of phase1Checks) {
      console.log(check.status.toUpperCase() + '  ' + check.name + ': ' + check.detail);
    }
    console.log(failed ? 'Result: NOT READY' : 'Result: READY');
  }
  return failed ? 1 : 0;
}

if (phase1Mode) {
  process.exit(runPhase1Doctor());
}


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
