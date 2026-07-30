// Dev launcher: loads .env, starts engine + gateway + console as child
// processes, prints a tagged combined log, and stays up until killed.
//   node --env-file=.env ops/dev-up.mjs
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { waitForHttpReachable, waitForHttpReady } from './readiness.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VENV_PY = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const CONSOLE_PORT = Number(process.env.TORQCLAW_CONSOLE_PORT ?? 3000);
const CONSOLE_URL = process.env.TORQCLAW_CONSOLE_URL ?? `http://localhost:${CONSOLE_PORT}`;
const CONSOLE_HEALTH_URL = process.env.TORQCLAW_CONSOLE_HEALTH_URL
  ?? `http://127.0.0.1:${CONSOLE_PORT}/api/health`;
const GATEWAY_PORT = Number(process.env.TORQCLAW_PORT ?? 18790);
const GATEWAY_HEALTH_URL = `http://127.0.0.1:${GATEWAY_PORT}/`;

const procs = [];
const shutdown = (code = 0) => {
  procs.forEach((p) => p.kill());
  process.exit(code);
};
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const launch = (cmd, args, cwd, tag) => {
  const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env, shell: process.platform === 'win32' });
  p.stdout.on('data', (d) => process.stdout.write(`[${tag}] ${d}`));
  p.stderr.on('data', (d) => process.stdout.write(`[${tag}!] ${d}`));
  p.on('exit', (code) => process.stdout.write(`[${tag}] exited ${code}\n`));
  procs.push(p);
};

const stamp = process.env.HERMES_MODEL
  ? `LIVE (${process.env.HERMES_PROVIDER}/${process.env.HERMES_MODEL})`
  : 'STUB';
console.log(`=== TORQCLAW dev up — FRONTIER tier: ${stamp} ===`);

// Engine must be listening before the gateway connects to it (the gateway
// connects to the MCP engine once, at boot — a cold engine degrades FRONTIER).
launch(`${ROOT}engines/hermes_kernel/${VENV_PY}`, ['-m', 'mcp_wrapper.server'],
  `${ROOT}engines/hermes_kernel`, 'engine');
const waitEngine = async () => {
  for (let i = 0; i < 40; i++) {
    try {
      await fetch('http://127.0.0.1:8000/mcp');
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error('Engine did not become reachable at http://127.0.0.1:8000/mcp within 20 seconds.');
};
try {
  await waitEngine();
} catch (error) {
  console.error(`[TORQCLAW] Engine readiness failed: ${error.message}`);
  shutdown(1);
}
console.log('=== engine reachable — starting gateway + console ===');
launch('node', ['dist/server.js'], `${ROOT}packages/gateway`, 'gateway');
try {
  await waitForHttpReachable(GATEWAY_HEALTH_URL, {
    timeoutMs: Number(process.env.TORQCLAW_GATEWAY_READY_TIMEOUT_MS ?? 60000),
  });
  console.log(`[TORQCLAW] Gateway reachable at ${GATEWAY_HEALTH_URL}`);
} catch (error) {
  console.error(`[TORQCLAW] Gateway readiness failed: ${error.message}`);
  shutdown(1);
}
launch(NPX, ['next', 'dev', '-p', String(CONSOLE_PORT)], `${ROOT}apps/console`, 'console');

// Optional HTTP channel adapter (role:'channel'). Off by default — set
// TORQCLAW_HTTP_CHANNEL=1 to expose POST /task at :18792. Demonstrates the
// multi-channel architecture: an external surface bridged to the same gateway.
if (process.env.TORQCLAW_HTTP_CHANNEL === '1') {
  launch('node', ['dist/server.js'], `${ROOT}packages/channel-http`, 'http-channel');
}

const openBrowser = () => {
  if (process.env.TORQCLAW_NO_BROWSER === '1') {
    console.log('[TORQCLAW] Browser launch disabled by TORQCLAW_NO_BROWSER=1');
    return;
  }

  if (process.platform === 'win32') {
    const opener = spawn('cmd.exe', ['/c', 'start', '', CONSOLE_URL], {
      windowsHide: true,
      stdio: 'ignore',
      detached: true,
    });
    opener.unref();
    return;
  }

  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const opener = spawn(command, [CONSOLE_URL], { stdio: 'ignore', detached: true });
  opener.unref();
};

try {
  const health = await waitForHttpReady(CONSOLE_HEALTH_URL, {
    expectedService: 'torqclaw-console',
    timeoutMs: Number(process.env.TORQCLAW_CONSOLE_READY_TIMEOUT_MS ?? 60000),
  });
  console.log(`[TORQCLAW] Console ready (${health.status}); opening ${CONSOLE_URL}`);
  openBrowser();
} catch (error) {
  console.error(`[TORQCLAW] Console readiness failed: ${error.message}`);
  console.error(`[TORQCLAW] Services remain attached for diagnosis; browser was not opened.`);
}
