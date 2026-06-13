// Cancel e2e: submit a FRONTIER stub task held open, send CANCEL_TASK, assert
// the task ends (ERROR with CANCELLED) within ~one poll interval. Not part of
// the Sprint-1 gate set; a manual check for the cancel relay.
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
  for (let i = 0; i < tries; i++) { try { await fetch(url); return; } catch { await sleep(500); } }
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

launch(`${ROOT}engines/hermes_kernel/${VENV_PY}`, ['-m', 'mcp_wrapper.server'],
  `${ROOT}engines/hermes_kernel`, 'engine', { HERMES_STUB_DELAY_S: '20' });
await waitForHttp('http://127.0.0.1:8000/mcp');
console.log('=== engine up (stub held 20s) ===');
launch('node', ['dist/server.js'], `${ROOT}packages/gateway`, 'gw');
await waitForWs('ws://127.0.0.1:18790/ws');

const ws = new WebSocket('ws://127.0.0.1:18790/ws');
const deadline = setTimeout(() => { console.log('E2E TIMEOUT'); cleanup(1); }, 30_000);
let requestId = null;
let submittedAt = 0;

ws.on('open', () => {
  ws.send(JSON.stringify({
    role: 'operator', token: process.env.TORQCLAW_GATEWAY_TOKEN || 'dev',
    clientInfo: { name: 'e2e-cancel', version: '0.1.0' },
  }));
  setTimeout(() => {
    submittedAt = Date.now();
    ws.send(JSON.stringify({
      action: 'SUBMIT_PROMPT',
      prompt: 'Investigate which MCP gateways support tool namespacing and compare them',
      sensitive: false, urgent: false, attachmentIds: [],
    }));
  }, 400);
});

ws.on('message', (raw) => {
  const ev = JSON.parse(raw.toString());
  console.log(`>>> [seq=${ev.seq ?? '-'}] ${String(ev.type).padEnd(15)} :: ${String(ev.message).slice(0, 80)}`);
  if (ev.type === 'TIER_SELECTED' && ev.requestId) {
    requestId = ev.requestId;
    // Let it start, then cancel.
    setTimeout(() => {
      console.log('--- sending CANCEL_TASK ---');
      ws.send(JSON.stringify({ action: 'CANCEL_TASK', taskId: requestId }));
    }, 3000);
  }
  if (ev.type === 'ERROR' || ev.type === 'RESULT') {
    clearTimeout(deadline);
    const elapsed = Date.now() - submittedAt;
    if (ev.type === 'ERROR' && /cancel/i.test(ev.message)) {
      console.log(`=== E2E PASS (cancelled in ${elapsed}ms) ===`); cleanup(0);
    } else {
      console.log(`=== E2E FAIL (${ev.type}) ===`); cleanup(1);
    }
  }
});
ws.on('error', (e) => { console.error('ws error', e.message); cleanup(1); });
