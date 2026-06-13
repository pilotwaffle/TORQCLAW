// pnpm stats — operational + product metrics over the gateway state.db.
// All aggregation happens in SQL with native JSON operators (->>), never by
// JSON.parse-ing rows in Node. Every section handles zero rows gracefully.
import { homedir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const DATA_DIR = process.env.TORQCLAW_DATA_DIR || join(homedir(), '.torqclaw');
const DB_PATH = join(DATA_DIR, 'state.db');

let db;
try {
  db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
} catch {
  console.log(`No gateway database at ${DB_PATH} yet — run some tasks first.`);
  process.exit(0);
}

const rows = (sql) => db.prepare(sql).all();
const one = (sql) => db.prepare(sql).get();

const hr = (title) => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 50 - title.length))}`);
const fmt = (n, d = 4) => (n === null || n === undefined ? '—' : Number(n).toFixed(d));

console.log(`TORQCLAW stats · ${DB_PATH}`);

// ── Task volume by tier + state ──
hr('Tasks by tier × state');
const byTier = rows(`SELECT tier, state, COUNT(*) AS n FROM tasks GROUP BY tier, state ORDER BY tier, state`);
if (byTier.length === 0) console.log('  (no tasks yet)');
for (const r of byTier) console.log(`  ${String(r.tier).padEnd(14)} ${String(r.state).padEnd(10)} ${r.n}`);

// ── FRONTIER cost (only telemetry_json IS NOT NULL) ──
hr('FRONTIER cost (USD)');
const cost = one(`
  SELECT COUNT(*) AS n,
         ROUND(SUM(CAST(telemetry_json->>'$.costUsd' AS REAL)), 4) AS total_usd,
         ROUND(AVG(CAST(telemetry_json->>'$.costUsd' AS REAL)), 4) AS avg_usd,
         ROUND(MAX(CAST(telemetry_json->>'$.costUsd' AS REAL)), 4) AS max_usd
  FROM tasks
  WHERE tier = 'API_EXTERNAL' AND telemetry_json IS NOT NULL
    AND telemetry_json->>'$.costUsd' IS NOT NULL`);
if (!cost || cost.n === 0) console.log('  (no FRONTIER tasks with reported cost)');
else {
  console.log(`  tasks with cost: ${cost.n}`);
  console.log(`  total: $${fmt(cost.total_usd)}   avg: $${fmt(cost.avg_usd)}   max: $${fmt(cost.max_usd)}`);
  // p95: SQLite has no native percentile — fetch the ordered column, index in JS.
  const costs = rows(`
    SELECT CAST(telemetry_json->>'$.costUsd' AS REAL) AS c
    FROM tasks
    WHERE tier='API_EXTERNAL' AND telemetry_json->>'$.costUsd' IS NOT NULL
    ORDER BY c ASC`).map((r) => r.c);
  if (costs.length) {
    const p95 = costs[Math.min(costs.length - 1, Math.floor(costs.length * 0.95))];
    console.log(`  p95: $${fmt(p95)}`);
  }
}

// ── Cost per COMPLETED frontier task (unit economics) ──
hr('Unit economics');
const unit = one(`
  SELECT ROUND(AVG(CAST(telemetry_json->>'$.costUsd' AS REAL)), 4) AS avg_usd, COUNT(*) AS n
  FROM tasks
  WHERE tier='API_EXTERNAL' AND state='completed'
    AND telemetry_json->>'$.costUsd' IS NOT NULL`);
console.log(unit && unit.n
  ? `  cost per completed FRONTIER task: $${fmt(unit.avg_usd)} over ${unit.n} task(s)`
  : '  (no completed FRONTIER tasks with cost yet)');

// ── Classifier method + confidence ──
hr('Classifier method');
const cls = rows(`
  SELECT request_json->>'$.enrichment.classifierUsed' AS method, COUNT(*) AS n,
         ROUND(AVG(CAST(request_json->>'$.enrichment.classifierConfidence' AS REAL)), 2) AS avg_conf
  FROM tasks GROUP BY method ORDER BY n DESC`);
if (cls.length === 0) console.log('  (no tasks yet)');
for (const r of cls) console.log(`  ${String(r.method ?? '—').padEnd(18)} ${String(r.n).padEnd(5)} avg conf ${fmt(r.avg_conf, 2)}`);

// ── Router reason distribution (prefix before first ':') ──
hr('Router reasons');
const reasons = rows(`
  SELECT substr(router_reason, 1, instr(router_reason || ':', ':') - 1) AS reason, COUNT(*) AS n
  FROM tasks GROUP BY reason ORDER BY n DESC`);
if (reasons.length === 0) console.log('  (no tasks yet)');
for (const r of reasons) console.log(`  ${String(r.reason).padEnd(28)} ${r.n}`);

// ── Product metrics ──
hr('Product metrics');
// Non-AUTO submissions: rising share = users don't trust Auto routing.
const modes = one(`
  SELECT
    SUM(CASE WHEN request_json->>'$.constraints.executionMode' != 'AUTO' THEN 1 ELSE 0 END) AS forced,
    COUNT(*) AS total
  FROM tasks`);
if (modes && modes.total) {
  const pct = ((modes.forced ?? 0) / modes.total * 100).toFixed(1);
  console.log(`  non-Auto submissions: ${modes.forced ?? 0} / ${modes.total} (${pct}%)`);
} else console.log('  non-Auto submissions: (no tasks yet)');

// Budget breaker firings (cost > limit → the error carries 'BUDGET').
const budget = one(`SELECT COUNT(*) AS n FROM tasks WHERE error LIKE 'BUDGET:%'`);
console.log(`  budget breaker firings: ${budget?.n ?? 0}   (target after tuning: ~0)`);

// User cancellations (high = runaway-feeling tasks).
const cancels = one(`SELECT COUNT(*) AS n FROM tasks WHERE error LIKE 'CANCELLED:%' OR error LIKE '%USER_CANCELLED%'`);
console.log(`  user cancellations: ${cancels?.n ?? 0}`);

// Approval funnel (P2 fills this; print zeros gracefully if the table is absent).
hr('Approval funnel');
const hasSkillQueue = one(`SELECT name FROM sqlite_master WHERE type='table' AND name='skill_queue'`);
if (hasSkillQueue) {
  const funnel = rows(`SELECT status, COUNT(*) AS n FROM skill_queue GROUP BY status`);
  if (funnel.length === 0) console.log('  skills:  pending 0 · approved 0 · rejected 0');
  else console.log('  skills:  ' + funnel.map((r) => `${r.status} ${r.n}`).join(' · '));
} else {
  console.log('  skills:  (skill_queue table not present)');
}
// P2 tool-approval funnel: pending → approved/rejected (the re-run gate).
const hasToolApprovals = one(`SELECT name FROM sqlite_master WHERE type='table' AND name='tool_approvals'`);
if (hasToolApprovals) {
  const tf = rows(`SELECT status, COUNT(*) AS n FROM tool_approvals GROUP BY status`);
  if (tf.length === 0) console.log('  tools:   pending 0 · approved 0 · rejected 0');
  else console.log('  tools:   ' + tf.map((r) => `${r.status} ${r.n}`).join(' · '));
} else {
  console.log('  tools:   (tool_approvals table not present)');
}

// Truncation pressure (errors cluster at log ends; informs P3).
hr('Tool-result truncation');
const trunc = one(`SELECT COUNT(*) AS n FROM events WHERE message LIKE '%[TRUNCATED:%' OR metadata LIKE '%[TRUNCATED:%'`);
console.log(`  truncated tool results: ${trunc?.n ?? 0}`);

console.log('');
db.close();
