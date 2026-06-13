// FRONTIER per-tool approval e2e (P6). Proves the cloud tier now gates tools:
//   1. A FRONTIER task hits a gated tool (forced via the engine seam).
//   2. The engine blocks it; the bridge throws ToolApprovalRequired; dispatch
//      emits the ONE terminal PENDING_APPROVAL with a gateway approvalId.
//   3. APPROVE_TOOL re-mints with grantedTools=[tool]; the re-run executes it.
// Stub mode, no provider key — the engine seam stands in for a live block.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VENV_PY = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
const FORCED_TOOL = 'write_file'; // Hermes-internal tool name (not namespaced)

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

// Engine carries the force-gate seam (FRONTIER block simulation).
launch(`${ROOT}engines/hermes_kernel/${VENV_PY}`, ['-m', 'mcp_wrapper.server'],
  `${ROOT}engines/hermes_kernel`, 'engine', { TORQCLAW_E2E_FORCE_GATED_TOOL: FORCED_TOOL });
await waitForHttp('http://127.0.0.1:8000/mcp');
console.log('=== engine up (force-gate seam) ===');
launch('node', ['dist/server.js'], `${ROOT}packages/gateway`, 'gw');
await sleep(3500);
console.log('=== gateway up, connecting operator client ===');

const ws = new WebSocket('ws://127.0.0.1:18790/ws');
const deadline = setTimeout(() => { console.log('E2E TIMEOUT'); cleanup(1); }, 45_000);

let approvalId = null;
let sawBlock = false;
let approved = false;

ws.on('open', () => {
  ws.send(JSON.stringify({
    role: 'operator', token: process.env.TORQCLAW_GATEWAY_TOKEN || 'dev',
    clientInfo: { name: 'e2e-approval-cloud', version: '0.1.0' },
  }));
  // AUTONOMOUS_RESEARCH routes FRONTIER (no executionMode override).
  setTimeout(() => ws.send(JSON.stringify({
    action: 'SUBMIT_PROMPT',
    prompt: 'Investigate which MCP gateways support tool namespacing and compare them',
    sensitive: false, urgent: false, attachmentIds: [],
  })), 400);
});

ws.on('message', (raw) => {
  const ev = JSON.parse(raw.toString());
  const meta = ev.metadata ?? {};
  console.log(`>>> [seq=${ev.seq ?? '-'}] ${String(ev.type).padEnd(15)} tier=${String(ev.tier ?? '-')} :: ${String(ev.message).slice(0, 60)}`);

  if (ev.type === 'PENDING_APPROVAL' && meta.approvalId) {
    sawBlock = true;
    approvalId = meta.approvalId;
    if (meta.toolName !== FORCED_TOOL) { console.log(`=== E2E FAIL (toolName ${meta.toolName}) ===`); cleanup(1); }
    if (ev.tier !== 'API_EXTERNAL') { console.log(`=== E2E FAIL (block not on FRONTIER: ${ev.tier}) ===`); cleanup(1); }
    console.log(`--- approving ${meta.toolName} on FRONTIER (approvalId ${approvalId}) ---`);
    setTimeout(() => ws.send(JSON.stringify({ action: 'APPROVE_TOOL', approvalId, decision: 'APPROVE' })), 300);
    return;
  }
  if (sawBlock && ev.type === 'TOOL_CALL' && meta.granted) approved = true;
  if (ev.type === 'RESULT') {
    clearTimeout(deadline);
    if (sawBlock && approved && /executed write_file under grant/.test(ev.message)) {
      console.log('=== E2E PASS (FRONTIER block -> approve -> re-run executed) ===');
      cleanup(0);
    } else {
      console.log(`=== E2E FAIL (RESULT without gated re-run: block=${sawBlock} approved=${approved}) ===`);
      cleanup(1);
    }
  }
  if (ev.type === 'ERROR') { clearTimeout(deadline); console.log('=== E2E FAIL (unexpected ERROR) ==='); cleanup(1); }
});
ws.on('error', (e) => { console.error('ws error', e.message); cleanup(1); });
