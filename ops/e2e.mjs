// One-shot e2e: spawn engine + gateway, drive a prompt through the full
// pipeline, print the typed event stream, clean up. Exits 0 on RESULT.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VENV_PY = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
const children = [];
const launch = (cmd, args, cwd, logPrefix) => {
  const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
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

launch(`${ROOT}engines/hermes_kernel/${VENV_PY}`, ['-m', 'mcp_wrapper.server'],
  `${ROOT}engines/hermes_kernel`, 'engine');
await waitForHttp('http://127.0.0.1:8000/mcp');
console.log('=== engine up ===');

launch('node', ['dist/server.js'], `${ROOT}packages/gateway`, 'gw');
await sleep(3500);
console.log('=== gateway up, connecting operator client ===');

const ws = new WebSocket('ws://127.0.0.1:18790/ws');
// Stub round-trips in seconds; a live Hermes run makes real model/tool calls.
const DEADLINE_MS = process.env.HERMES_MODEL ? 300_000 : 30_000;
const deadline = setTimeout(() => { console.log('E2E TIMEOUT'); cleanup(1); }, DEADLINE_MS);

ws.on('open', () => {
  ws.send(JSON.stringify({
    role: 'operator', token: process.env.TORQCLAW_GATEWAY_TOKEN || 'dev',
    clientInfo: { name: 'e2e-client', version: '0.1.0' },
  }));
  // Optional CLI overrides: node ops/e2e.mjs "<prompt>" [--sensitive]
  // --sensitive triggers the router's privacy override -> LOCAL_EDGE.
  setTimeout(() => ws.send(JSON.stringify({
    action: 'SUBMIT_PROMPT',
    prompt: process.argv[2] || 'Investigate which MCP gateways support tool namespacing and compare them',
    sensitive: process.argv.includes('--sensitive'), urgent: false, attachmentIds: [],
  })), 400);
});

ws.on('message', (raw) => {
  const ev = JSON.parse(raw.toString());
  console.log(`>>> [seq=${ev.seq ?? '-'}] ${String(ev.type).padEnd(15)} tier=${String(ev.tier ?? '-').padEnd(14)} :: ${String(ev.message).slice(0, 100)}`);
  if (ev.type === 'RESULT') { clearTimeout(deadline); console.log('=== E2E PASS ==='); cleanup(0); }
  if (ev.type === 'ERROR') { clearTimeout(deadline); console.log('=== E2E FAIL ==='); cleanup(1); }
});
ws.on('error', (e) => { console.error('ws error', e.message); cleanup(1); });
