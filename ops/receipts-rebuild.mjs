// pnpm-style ops CLI (TCLAW-4A): rebuild the run_receipts projection from the
// persisted event log / tasks / tool_approvals — never touches the event log,
// only recomputes the derived cache. Safe to run any time; re-projection is
// content-identical to the original (see tests/receipt-projection.test.ts).
//
// Usage:
//   node ops/receipts-rebuild.mjs --task <requestId>
//   node ops/receipts-rebuild.mjs --session <sessionId>
//   node ops/receipts-rebuild.mjs --all [--stale]
//
// Imports the BUILT gateway dist (run `pnpm build` first) — receipts.ts opens
// the same on-disk state.db as the live gateway via TORQCLAW_DATA_DIR / the
// ~/.torqclaw default, exactly like packages/gateway/src/storage.ts.
import { rebuildReceipt, rebuildSession, rebuildAll } from '../packages/gateway/dist/receipts.js';

const args = process.argv.slice(2);

function flagValue(name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

const taskId = flagValue('--task');
const sessionId = flagValue('--session');
const all = args.includes('--all');
const stale = args.includes('--stale');

if (!taskId && !sessionId && !all) {
  console.error(
    'Usage: node ops/receipts-rebuild.mjs --task <id> | --session <id> | --all [--stale]',
  );
  process.exit(1);
}

let count = 0;
if (taskId) {
  count = rebuildReceipt(taskId);
  console.log(`Rebuilt ${count} receipt(s) for task ${taskId}`);
} else if (sessionId) {
  count = rebuildSession(sessionId);
  console.log(`Rebuilt ${count} receipt(s) for session ${sessionId}`);
} else {
  count = rebuildAll({ onlyStale: stale });
  console.log(`Rebuilt ${count} receipt(s)${stale ? ' (stale only)' : ''}`);
}
