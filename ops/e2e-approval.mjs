// Approval-flow e2e (P2). Proves the full one-shot grant loop in stub mode:
//   1. A LOCAL_EDGE task hits a gated tool (forced via TORQCLAW_E2E_FORCE_GATED_TOOL).
//   2. The run STOPS with a terminal PENDING_APPROVAL carrying approvalId.
//   3. APPROVE_TOOL{approvalId, APPROVE} mints a re-run WITH the grant.
//   4. The re-run executes the tool and reaches RESULT. Exit 0.
//
// No provider key needed: the LOCAL_EDGE engine is the gateway's own loop, and
// the forced gate short-circuits before any real Ollama call.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VENV_PY = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
const FORCED_TOOL = 'filesystem__write_file';

const children = [];
const launch = (cmd, args, cwd, tag, extraEnv = {}) => {
  const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...extraEnv } });
  p.stdout.on('data', (d) => process.stdout.write(`[${tag}] ${d}`));
  p.stderr.on('data', (d) => process.stdout.write(`[${tag}!] ${d}`));
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
  `${ROOT}engines/hermes_kernel`, 'engine');
await waitForHttp('http://127.0.0.1:8000/mcp');
console.log('=== engine up ===');

// Gateway carries the forced-gate seam so executeLocalEdge throws on first hit.
launch('node', ['dist/server.js'], `${ROOT}packages/gateway`, 'gw',
  { TORQCLAW_E2E_FORCE_GATED_TOOL: FORCED_TOOL });
await waitForWs('ws://127.0.0.1:18790/ws');
console.log('=== gateway up, connecting operator client ===');

const ws = new WebSocket('ws://127.0.0.1:18790/ws');
const deadline = setTimeout(() => { console.log('E2E TIMEOUT'); cleanup(1); }, 45_000);

let approvalId = null;
let sawBlock = false;
let approved = false;

ws.on('open', () => {
  ws.send(JSON.stringify({
    role: 'operator', token: process.env.TORQCLAW_GATEWAY_TOKEN || 'dev',
    clientInfo: { name: 'e2e-approval', version: '0.1.0' },
  }));
  // executionMode LOCAL_ONLY forces the LOCAL_EDGE loop where the gate lives.
  setTimeout(() => ws.send(JSON.stringify({
    action: 'SUBMIT_PROMPT',
    prompt: 'write a file in the workspace',
    sensitive: false, urgent: false, attachmentIds: [], executionMode: 'LOCAL_ONLY',
  })), 400);
});

ws.on('message', (raw) => {
  const ev = JSON.parse(raw.toString());
  const meta = ev.metadata ?? {};
  console.log(`>>> [seq=${ev.seq ?? '-'}] ${String(ev.type).padEnd(15)} :: ${String(ev.message).slice(0, 70)}`);

  // Step 2: the blocked run's terminal PENDING_APPROVAL with an approvalId.
  if (ev.type === 'PENDING_APPROVAL' && meta.approvalId) {
    sawBlock = true;
    approvalId = meta.approvalId;
    if (meta.toolName !== FORCED_TOOL) {
      console.log(`=== E2E FAIL (wrong toolName: ${meta.toolName}) ===`); cleanup(1);
    }
    const decision = process.argv.includes('--reject') ? 'REJECT' : 'APPROVE';
    console.log(`--- ${decision} ${meta.toolName} (approvalId ${approvalId}) ---`);
    setTimeout(() => ws.send(JSON.stringify({
      action: 'APPROVE_TOOL', approvalId, decision,
    })), 300);
    return;
  }

  // Step 4: the re-run executes the tool under the grant, then RESULT.
  if (sawBlock && ev.type === 'TOOL_CALL' && meta.granted) approved = true;

  if (ev.type === 'RESULT') {
    clearTimeout(deadline);
    if (sawBlock && approved && /executed .*write_file under grant/.test(ev.message)) {
      console.log('=== E2E PASS (block -> approve -> re-run executed the tool) ===');
      cleanup(0);
    } else {
      console.log(`=== E2E FAIL (RESULT without the gated re-run: block=${sawBlock} approved=${approved}) ===`);
      cleanup(1);
    }
  }
  if (ev.type === 'ERROR') {
    clearTimeout(deadline);
    // In --reject mode, the denied tool MUST produce a terminal ERROR (invariant 7).
    if (process.argv.includes('--reject') && sawBlock && /denied/i.test(ev.message)) {
      console.log('=== E2E PASS (reject -> terminal ERROR "tool denied") ===');
      cleanup(0);
    }
    console.log('=== E2E FAIL (unexpected ERROR) ==='); cleanup(1);
  }
});
ws.on('error', (e) => { console.error('ws error', e.message); cleanup(1); });
