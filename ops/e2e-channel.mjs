// HTTP channel adapter e2e (stub mode). Spawns engine + gateway + the
// channel-http adapter, POSTs a prompt to /task, asserts a clean RESULT comes
// back through the full HTTP → gateway(role:channel) → engine path. Exit 0 on
// a routed answer. Proves the multi-channel architecture end-to-end.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VENV_PY = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';

const children = [];
const launch = (cmd, args, cwd, logPrefix, extraEnv = {}) => {
  const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...extraEnv } });
  p.stdout.on('data', (d) => process.stdout.write(`[${logPrefix}] ${d}`));
  p.stderr.on('data', (d) => process.stdout.write(`[${logPrefix}!] ${d}`));
  children.push(p);
  return p;
};
const cleanup = (code) => { children.forEach((p) => p.kill('SIGKILL')); process.exit(code); };

const waitForHttp = async (url, tries = 30) => {
  for (let i = 0; i < tries; i++) {
    try { await fetch(url); return; } catch { await sleep(500); }
  }
  throw new Error(`not up: ${url}`);
};
const waitForWs = async (url, tries = 40) => {
  for (let i = 0; i < tries; i++) {
    const ok = await new Promise((res) => {
      const probe = new WebSocket(url);
      const done = (v) => { try { probe.close(); } catch {} res(v); };
      probe.on('open', () => done(true));
      probe.on('error', () => done(false));
    });
    if (ok) return;
    await sleep(500);
  }
  throw new Error(`ws not up: ${url}`);
};
// /health returns 200 once Fastify is listening — use it as readiness.
const waitForHealth = async (url, tries = 40) => {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* not up */ }
    await sleep(500);
  }
  throw new Error(`health not up: ${url}`);
};

launch(`${ROOT}engines/hermes_kernel/${VENV_PY}`, ['-m', 'mcp_wrapper.server'],
  `${ROOT}engines/hermes_kernel`, 'engine');
await waitForHttp('http://127.0.0.1:8000/mcp');
console.log('=== engine up ===');

launch('node', ['dist/server.js'], `${ROOT}packages/gateway`, 'gw');
await waitForWs('ws://127.0.0.1:18790/ws');
console.log('=== gateway up ===');

launch('node', ['dist/server.js'], `${ROOT}packages/channel-http`, 'http-channel');
await waitForHealth('http://127.0.0.1:18792/health');
console.log('=== http channel up, POSTing a task ===');

const deadline = setTimeout(() => { console.log('E2E TIMEOUT'); cleanup(1); }, 60_000);

try {
  const res = await fetch('http://127.0.0.1:18792/task', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt: 'Investigate which MCP gateways support tool namespacing and compare them',
    }),
  });
  const json = await res.json();
  clearTimeout(deadline);
  console.log(`>>> HTTP ${res.status}  ${JSON.stringify(json).slice(0, 200)}`);

  if (res.status === 200 && json.ok === true && typeof json.answer === 'string' && json.sessionId) {
    console.log(`=== E2E PASS (tier=${json.tier}, session=${json.sessionId.slice(0, 8)}…) ===`);
    cleanup(0);
  } else {
    console.log('=== E2E FAIL (no clean RESULT from the channel) ===');
    cleanup(1);
  }
} catch (e) {
  clearTimeout(deadline);
  console.error('fetch error', e.message);
  cleanup(1);
}
