// Dev launcher: loads .env, starts engine + gateway + console as child
// processes, prints a tagged combined log, and stays up until killed.
//   node --env-file=.env ops/dev-up.mjs
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildLauncherConfig } from './launcher-config.mjs';
import { waitForHttpOk, waitForHttpReady } from './readiness.mjs';
import { ensureRuntimeBuild } from './runtime-build.mjs';
import { openExternalUrl, runStartupSequence } from './startup-sequence.mjs';
import { doctorPassed, formatDoctor, runDoctor } from './doctor-core.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ENGINE_DIR = fileURLToPath(new URL('../engines/hermes_kernel/', import.meta.url));
const GATEWAY_DIR = fileURLToPath(new URL('../packages/gateway/', import.meta.url));
const CONSOLE_DIR = fileURLToPath(new URL('../apps/console/', import.meta.url));
const ENGINE_PYTHON = fileURLToPath(new URL(
  process.platform === 'win32'
    ? '../engines/hermes_kernel/.venv/Scripts/python.exe'
    : '../engines/hermes_kernel/.venv/bin/python',
  import.meta.url,
));
const NEXT_CLI = fileURLToPath(new URL('../apps/console/node_modules/next/dist/bin/next', import.meta.url));
const production = process.argv.includes('--production');
const envFilePresent = process.env.TORQCLAW_ENV_FILE_PRESENT === '1' ||
  (await import('node:fs')).existsSync(fileURLToPath(new URL('../.env', import.meta.url)));

const preflight = await runDoctor({
  mode: 'preflight',
  production,
  liveRequested: Boolean(String(process.env.HERMES_MODEL ?? '').trim()),
  root: ROOT,
  env: process.env,
  envFilePresent,
});
if (!doctorPassed(preflight)) {
  console.error(formatDoctor(preflight));
  process.exit(1);
}

let config;
try {
  config = buildLauncherConfig(process.env, { production });
} catch (error) {
  console.error(`[TORQCLAW] Invalid launcher configuration: ${error.message}`);
  process.exit(1);
}

// Children inherit the validated environment plus only the derived local
// endpoints needed to keep gateway and console on the exact started ports.
const runtimeEnv = {
  ...process.env,
  HERMES_ENGINE_URL: config.engineUrl,
  NEXT_PUBLIC_GATEWAY_URL: config.nextPublicGatewayUrl,
};

const procs = [];
let shuttingDown = false;

const stopProcess = (processHandle) => {
  if (!processHandle.pid || processHandle.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(processHandle.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-processHandle.pid, 'SIGTERM');
  } catch {
    processHandle.kill('SIGTERM');
  }
};

const shutdown = (code = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  procs.slice().reverse().forEach(stopProcess);
  process.exit(code);
};
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const launch = (cmd, args, cwd, tag) => {
  const child = spawn(cmd, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: runtimeEnv,
    shell: false,
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  child.stdout?.on('data', (data) => process.stdout.write(`[${tag}] ${data}`));
  child.stderr?.on('data', (data) => process.stdout.write(`[${tag}!] ${data}`));
  child.on('error', (error) => process.stderr.write(`[${tag}!] spawn failed: ${error.message}\n`));
  child.on('exit', (code, signal) => {
    process.stdout.write(`[${tag}] exited ${code ?? 'null'} (${signal ?? 'no signal'})\n`);
  });
  procs.push(child);
  return child;
};

const stamp = process.env.HERMES_MODEL
  ? `LIVE (${process.env.HERMES_PROVIDER}/${process.env.HERMES_MODEL})`
  : 'STUB';
console.log(`=== TORQCLAW dev up — FRONTIER tier: ${stamp} ===`);

try {
  console.log('[TORQCLAW] Verifying runtime build artifacts...');
  ensureRuntimeBuild({
    root: ROOT,
    includeHttpChannel: process.env.TORQCLAW_HTTP_CHANNEL === '1',
    includeConsole: production,
    force: production,
    env: runtimeEnv,
  });

  const running = await runStartupSequence({
    launchEngine: () => launch(
      ENGINE_PYTHON, ['-m', 'mcp_wrapper.server'], ENGINE_DIR, 'engine',
    ),
    waitEngine: async () => {
      await waitForHttpReady(config.engineHealthUrl, {
        expectedService: 'torqclaw-hermes-engine',
        timeoutMs: config.engineReadyTimeoutMs,
      });
      console.log(`[TORQCLAW] Engine ready at ${config.engineHealthUrl}`);
    },
    launchGateway: () => launch(process.execPath, ['dist/server.js'], GATEWAY_DIR, 'gateway'),
    waitGateway: async () => {
      await waitForHttpReady(config.gatewayHealthUrl, {
        expectedService: 'torqclaw-gateway',
        timeoutMs: config.gatewayReadyTimeoutMs,
      });
      console.log(`[TORQCLAW] Gateway ready at ${config.gatewayHealthUrl}`);
    },
    launchConsole: () => launch(
      process.execPath,
      production
        ? [NEXT_CLI, 'start', '-H', '127.0.0.1', '-p', String(config.consolePort)]
        : [NEXT_CLI, 'dev', '-p', String(config.consolePort)],
      CONSOLE_DIR,
      'console',
    ),
    onConsoleLaunched: () => {
      if (process.env.TORQCLAW_HTTP_CHANNEL === '1') {
        launch(process.execPath, ['dist/server.js'], `${ROOT}packages/channel-http`, 'http-channel');
      }
    },
    waitConsole: async () => {
      const health = await waitForHttpReady(config.consoleHealthUrl, {
        expectedService: 'torqclaw-console',
        timeoutMs: config.consoleReadyTimeoutMs,
      });
      await waitForHttpOk(config.consoleUrl, { timeoutMs: config.consoleReadyTimeoutMs });
      return health;
    },
    onReady: async (health) => {
      console.log(`[TORQCLAW] Console ready (${health.status}) at ${config.consoleUrl}`);
      const runtime = await runDoctor({
        mode: 'runtime', production, root: ROOT, env: process.env,
      });
      if (!doctorPassed(runtime)) {
        throw new Error('runtime readiness contract failed');
      }
      if (process.env.TORQCLAW_NO_BROWSER === '1') {
        console.log('[TORQCLAW] Browser launch disabled by TORQCLAW_NO_BROWSER=1');
        return;
      }
      try {
        await openExternalUrl(config.consoleUrl);
        console.log(`[TORQCLAW] Opened ${config.consoleUrl}`);
      } catch {
        console.warn(`[TORQCLAW] Browser launch failed; open this validated local URL manually: ${config.consoleUrl}`);
      }
    },
  });

  for (const [label, child] of [
    ['engine', running.engine],
    ['gateway', running.gateway],
    ['console', running.consoleProcess],
  ]) {
    if (child.exitCode !== null) {
      throw new Error(`${label} exited immediately after readiness`);
    }
    child.once('exit', (code, signal) => {
      if (!shuttingDown) {
        console.error(`[TORQCLAW] ${label} exited unexpectedly (${code ?? 'null'}/${signal ?? 'none'})`);
        shutdown(1);
      }
    });
  }
} catch (error) {
  console.error(`[TORQCLAW] Startup failed: ${error.message}`);
  shutdown(1);
}
