import fs from 'node:fs';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildLauncherConfig } from './launcher-config.mjs';

const DEFAULT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const REQUIRED_LAYOUT = [
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'ops',
  'packages/contracts', 'packages/gateway', 'apps/console',
  'engines/hermes_kernel', 'engines/hermes_kernel/pyproject.toml',
];

const record = (id, severity, status, message) => ({ id, severity, status, message });

function versionAtLeast(version, major, minor) {
  const match = String(version).match(/^(\d+)\.(\d+)/);
  return !!match && (Number(match[1]) > major || (Number(match[1]) === major && Number(match[2]) >= minor));
}

function safeCommand(spawnImpl, command, args, options) {
  try {
    const result = spawnImpl(command, args, options);
    return !result?.error && result?.status === 0;
  } catch {
    return false;
  }
}

function defaultPortProbe(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    const finish = (available) => {
      server.removeAllListeners();
      try {
        server.close(() => resolve(available));
      } catch {
        resolve(available);
      }
    };
    server.once('error', () => finish(false));
    server.listen({ port, host, exclusive: true }, () => finish(true));
  });
}

function responsePayload(response) {
  if (!response || typeof response.json !== 'function') throw new Error('invalid response');
  return response.json();
}

function exactObject(actual, expected) {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return JSON.stringify(actualKeys) === JSON.stringify(expectedKeys) &&
    expectedKeys.every((key) => actual[key] === expected[key]);
}

async function checkRuntime(records, config, env, fetchImpl) {
  const engineExpectedKeys = ['service', 'status', 'mode', 'modelConfigured', 'hermesAvailable'];
  try {
    const engineResponse = await fetchImpl(config.engineHealthUrl, { headers: { accept: 'application/json' } });
    const engine = await responsePayload(engineResponse);
    const engineShape = engineResponse.ok && engine && typeof engine === 'object' && !Array.isArray(engine) &&
      JSON.stringify(Object.keys(engine).sort()) === JSON.stringify(engineExpectedKeys.sort()) &&
      engine.service === 'torqclaw-hermes-engine' && engine.status === 'ready' &&
      (engine.mode === 'live' || engine.mode === 'stub') &&
      typeof engine.modelConfigured === 'boolean' && typeof engine.hermesAvailable === 'boolean' &&
      engine.modelConfigured === Boolean(String(env.HERMES_MODEL ?? '').trim()) &&
      engine.mode === (engine.modelConfigured ? 'live' : 'stub') &&
      (!engine.modelConfigured || engine.hermesAvailable);
    records.push(engineShape
      ? record('runtime.engine-health', 'info', 'pass', 'Hermes engine health is exact and ready')
      : record('runtime.engine-health', 'error', 'fail', 'Hermes engine health is not the exact ready contract'));
  } catch {
    records.push(record('runtime.engine-health', 'error', 'fail', 'Hermes engine health could not be read'));
  }

  try {
    const gatewayResponse = await fetchImpl(config.gatewayHealthUrl, { headers: { accept: 'application/json' } });
    const gateway = await responsePayload(gatewayResponse);
    records.push(gatewayResponse.ok && exactObject(gateway, {
      service: 'torqclaw-gateway', status: 'ready',
    })
      ? record('runtime.gateway-health', 'info', 'pass', 'Gateway health is exact and ready')
      : record('runtime.gateway-health', 'error', 'fail', 'Gateway health is not the exact ready contract'));
  } catch {
    records.push(record('runtime.gateway-health', 'error', 'fail', 'Gateway health could not be read'));
  }

  try {
    const consoleHealthResponse = await fetchImpl(config.consoleHealthUrl, { headers: { accept: 'application/json' } });
    const consoleHealth = await responsePayload(consoleHealthResponse);
    records.push(consoleHealthResponse.ok && exactObject(consoleHealth, {
      service: 'torqclaw-console', status: 'ready',
    })
      ? record('runtime.console-health', 'info', 'pass', 'Console health is exact and ready')
      : record('runtime.console-health', 'error', 'fail', 'Console health is not the exact ready contract'));
  } catch {
    records.push(record('runtime.console-health', 'error', 'fail', 'Console health could not be read'));
  }

  try {
    const rootResponse = await fetchImpl(config.consoleUrl, { redirect: 'manual' });
    records.push(rootResponse.ok
      ? record('runtime.console-root', 'info', 'pass', 'Console root is reachable')
      : record('runtime.console-root', 'error', 'fail', 'Console root is not ready'));
  } catch {
    records.push(record('runtime.console-root', 'error', 'fail', 'Console root could not be read'));
  }
}

export async function runDoctor({
  mode = 'preflight',
  production = false,
  liveRequested = false,
  root = DEFAULT_ROOT,
  env = process.env,
  fsImpl = fs,
  spawnImpl = spawnSync,
  fetchImpl = fetch,
  portProbe = defaultPortProbe,
  nodeVersion = process.versions.node,
  envFilePresent,
} = {}) {
  if (mode !== 'preflight' && mode !== 'runtime') {
    throw new Error('doctor mode must be preflight or runtime');
  }
  const records = [];
  const live = liveRequested || Boolean(String(env.HERMES_MODEL ?? '').trim());
  const exists = (target) => {
    try { return Boolean(fsImpl.existsSync(target)); } catch { return false; }
  };
  const envPresent = envFilePresent ?? exists(path.join(root, '.env'));
  if (mode === 'preflight') {
    records.push(versionAtLeast(nodeVersion, 20, 9)
      ? record('preflight.node-version', 'info', 'pass', 'Node.js version is supported')
      : record('preflight.node-version', 'error', 'fail', 'Node.js >=20.9 is required'));

    const missingLayout = REQUIRED_LAYOUT.filter((relative) => !exists(path.join(root, relative)));
    records.push(missingLayout.length === 0
      ? record('preflight.repo-layout', 'info', 'pass', 'Repository layout is complete')
      : record('preflight.repo-layout', 'error', 'fail', 'Repository layout is incomplete'));

    records.push(envPresent
      ? record('preflight.env-file', 'info', 'pass', '.env is present or supplied by the caller')
      : record('preflight.env-file', production ? 'error' : 'warning', production ? 'fail' : 'warn',
        production ? '.env is required for production' : '.env is absent; development may use inherited env'));

    const jsInstallComplete = exists(path.join(root, 'node_modules', 'turbo', 'bin', 'turbo')) &&
      exists(path.join(root, 'apps/console/node_modules/next/dist/bin/next'));
    records.push(jsInstallComplete
      ? record('preflight.js-install', 'info', 'pass', 'JavaScript install artifacts are present')
      : record('preflight.js-install', 'error', 'fail', 'JavaScript install artifacts are incomplete'));

    const venvPython = process.platform === 'win32'
      ? path.join(root, 'engines/hermes_kernel/.venv/Scripts/python.exe')
      : path.join(root, 'engines/hermes_kernel/.venv/bin/python');
    records.push(exists(venvPython)
      ? record('preflight.python-venv', 'info', 'pass', 'Python virtual environment is present')
      : record('preflight.python-venv', 'error', 'fail', 'Python virtual environment is missing'));

    records.push(exists(path.join(root, 'engines/hermes_kernel/vendor/hermes-agent/run_agent.py'))
      ? record('preflight.submodule', 'info', 'pass', 'Hermes submodule is present')
      : record('preflight.submodule', 'error', 'fail', 'Hermes submodule is missing'));

    const importOk = safeCommand(spawnImpl, venvPython, ['-c', 'from run_agent import AIAgent'], {
      cwd: path.join(root, 'engines/hermes_kernel'), env, shell: false, stdio: 'ignore', windowsHide: true,
    });
    records.push(importOk
      ? record('preflight.hermes-import', 'info', 'pass', 'Hermes import is available')
      : record('preflight.hermes-import', live ? 'error' : 'warning', live ? 'fail' : 'warn',
        live ? 'Hermes import is required for live mode' : 'Hermes import is unavailable in stub mode'));

    if (live) {
      records.push(String(env.HERMES_PROVIDER ?? '').trim()
        ? record('preflight.hermes-provider', 'info', 'pass', 'Live Hermes provider is configured')
        : record('preflight.hermes-provider', 'error', 'fail', 'Live Hermes provider is required'));
      records.push(String(env.HERMES_API_KEY ?? '').trim()
        ? record('preflight.hermes-api-key', 'info', 'pass', 'Live Hermes API key is configured')
        : record('preflight.hermes-api-key', 'error', 'fail', 'Live Hermes API key is required'));
    }

    // Phase 4 remote skill sources (R-5): conditional preflight in the same
    // env-gated idiom above. When TORQCLAW_REMOTE_SKILL_SOURCES is truthy,
    // skill_sources.json must parse, every authority publicKey must parse as a
    // valid Ed25519 SPKI key (N-4), and $TORQCLAW_DATA_DIR/skill_trust/ must be
    // writable. When the flag is OFF the record is ABSENT (not a pass) so
    // flag-off doctor output is byte-identical (AC-8).
    const remoteFlag = String(env.TORQCLAW_REMOTE_SKILL_SOURCES ?? '').trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(remoteFlag)) {
      const preflightOk = safeCommand(spawnImpl, venvPython,
        ['-m', 'mcp_wrapper.remote_preflight'], {
          cwd: path.join(root, 'engines/hermes_kernel'), env, shell: false,
          stdio: 'ignore', windowsHide: true,
        });
      records.push(preflightOk
        ? record('preflight.remote-skill-sources', 'info', 'pass',
          'Remote skill sources config parses; authority keys valid; trust store writable')
        : record('preflight.remote-skill-sources', 'error', 'fail',
          'Remote skill sources preflight failed (config invalid, authority key invalid, or trust store not writable)'));
    }

    let config;
    try {
      config = buildLauncherConfig(env, { production });
      records.push(record('preflight.config', 'info', 'pass', 'Launcher configuration is valid'));
    } catch {
      records.push(record('preflight.config', 'error', 'fail', 'Launcher configuration is invalid'));
    }

    if (production && config) {
      for (const [id, port, host] of [
        ['gateway', config.gatewayPort, config.gatewayHost],
        ['engine', config.enginePort, config.engineHost],
        ['console', config.consolePort, '127.0.0.1'],
      ]) {
        let available = false;
        try { available = await portProbe(port, host); } catch { available = false; }
        records.push(available
          ? record(`preflight.port-${id}`, 'info', 'pass', `${id} port is available`)
          : record(`preflight.port-${id}`, 'error', 'fail', `${id} port is unavailable`));
      }
    }
  } else {
    let config;
    try {
      config = buildLauncherConfig(env, { production });
    } catch {
      records.push(record('runtime.config', 'error', 'fail', 'Launcher configuration is invalid'));
    }
    if (config) await checkRuntime(records, config, env, fetchImpl);
  }

  return records;
}

export function doctorPassed(records) {
  return records.every((entry) => entry.status !== 'fail');
}

export function formatDoctor(records, json = false) {
  return json
    ? JSON.stringify(records)
    : records.map((entry) => `${entry.severity.toUpperCase()} ${entry.id} ${entry.status}: ${entry.message}`).join('\n');
}

export { DEFAULT_ROOT, defaultPortProbe };
