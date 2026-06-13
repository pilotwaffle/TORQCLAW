// Budget circuit-breaker e2e. Stub mode, forced cost via HERMES_STUB_COST_USD.
// Submits a FRONTIER task with a low budget; asserts the breaker fires a single
// terminal ERROR carrying the BUDGET reason, the task ends failed, exit 0.
//
//   HERMES_STUB_COST_USD=9.99      — every stub poll reports $9.99 spent
//   HERMES_STUB_DELAY_S=6          — hold the stub open long enough to poll
//   TORQCLAW_DEFAULT_MAX_COST=1.00 — env budget (P0); breaker trips at first poll
//
// Uses the env-default budget so this gate is self-contained at P0, before the
// P0.5 client-side maxCostUsd control exists.
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

// Force a non-zero reported spend and hold the stub task open across one poll.
launch(`${ROOT}engines/hermes_kernel/${VENV_PY}`, ['-m', 'mcp_wrapper.server'],
  `${ROOT}engines/hermes_kernel`, 'engine',
  { HERMES_STUB_COST_USD: '9.99', HERMES_STUB_DELAY_S: '6' });
await waitForHttp('http://127.0.0.1:8000/mcp');
console.log('=== engine up (stub cost $9.99) ===');

launch('node', ['dist/server.js'], `${ROOT}packages/gateway`, 'gw',
  { TORQCLAW_DEFAULT_MAX_COST: '1.00' });
await sleep(3500);
console.log('=== gateway up, connecting operator client ===');

const ws = new WebSocket('ws://127.0.0.1:18790/ws');
const deadline = setTimeout(() => { console.log('E2E TIMEOUT'); cleanup(1); }, 45_000);

let sawBudgetError = false;

ws.on('open', () => {
  ws.send(JSON.stringify({
    role: 'operator', token: process.env.TORQCLAW_GATEWAY_TOKEN || 'dev',
    clientInfo: { name: 'e2e-budget', version: '0.1.0' },
  }));
  // AUTONOMOUS_RESEARCH routes FRONTIER; env budget $1.00 < stub $9.99.
  setTimeout(() => ws.send(JSON.stringify({
    action: 'SUBMIT_PROMPT',
    prompt: 'Investigate which MCP gateways support tool namespacing and compare them',
    sensitive: false, urgent: false, attachmentIds: [],
  })), 400);
});

ws.on('message', (raw) => {
  const ev = JSON.parse(raw.toString());
  console.log(`>>> [seq=${ev.seq ?? '-'}] ${String(ev.type).padEnd(15)} :: ${String(ev.message).slice(0, 90)}`);
  if (ev.type === 'ERROR' && /budget/i.test(ev.message)) sawBudgetError = true;
  if (ev.type === 'ERROR') {
    clearTimeout(deadline);
    if (sawBudgetError) { console.log('=== E2E PASS (budget breaker fired) ==='); cleanup(0); }
    else { console.log('=== E2E FAIL (error was not a budget breach) ==='); cleanup(1); }
  }
  if (ev.type === 'RESULT') {
    clearTimeout(deadline);
    console.log('=== E2E FAIL (task completed despite over-budget) ===');
    cleanup(1);
  }
});
ws.on('error', (e) => { console.error('ws error', e.message); cleanup(1); });
