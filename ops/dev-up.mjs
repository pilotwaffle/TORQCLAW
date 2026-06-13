// Dev launcher: loads .env, starts engine + gateway + console as child
// processes, prints a tagged combined log, and stays up until killed.
//   node --env-file=.env ops/dev-up.mjs
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VENV_PY = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const procs = [];
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
    try { await fetch('http://127.0.0.1:8000/mcp'); return; } catch { await sleep(500); }
  }
};
await waitEngine();
console.log('=== engine reachable — starting gateway + console ===');
launch('node', ['dist/server.js'], `${ROOT}packages/gateway`, 'gateway');
launch(NPX, ['next', 'dev', '-p', '3000'], `${ROOT}apps/console`, 'console');

const shutdown = () => { procs.forEach((p) => p.kill()); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
