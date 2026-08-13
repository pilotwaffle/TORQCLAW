#!/usr/bin/env node
/**
 * Explicit operator entrypoint for the Phase 2A offline slice.
 *
 * This file is intentionally not imported by startup, server, sessions, or
 * any live helper.  It expects package dist output to exist (run the package
 * builds first) and refuses every invocation that is not explicitly offline
 * with two existing regular database files.
 */
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';

function usage() {
  return 'Usage: node scripts/auth-phase2a-offline.mjs --offline --collab-db <existing-file> --state-db <existing-file>';
}

function parse(argv) {
  let offline = false;
  let collab;
  let state;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--offline') {
      if (offline) throw new Error('duplicate --offline');
      offline = true;
    } else if (arg === '--collab-db') {
      if (collab !== undefined || argv[i + 1] === undefined) throw new Error('explicit --collab-db is required once');
      collab = argv[++i];
    } else if (arg === '--state-db') {
      if (state !== undefined || argv[i + 1] === undefined) throw new Error('explicit --state-db is required once');
      state = argv[++i];
    } else {
      throw new Error('unknown or positional argument');
    }
  }
  if (!offline || collab === undefined || state === undefined) throw new Error('explicit --offline, --collab-db, and --state-db are required');
  const paths = { collab: resolve(collab), state: resolve(state) };
  for (const path of [paths.collab, paths.state]) {
    let stat;
    try { stat = statSync(path); } catch { throw new Error('database paths must be existing regular files'); }
    if (!stat.isFile()) throw new Error('database paths must be existing regular files');
  }
  if (paths.collab === paths.state) throw new Error('collab and state database paths must be distinct');
  return paths;
}

let collabDb;
let stateDb;
const traceStdout = process.env.TORQCLAW_PHASE2A_TRACE_STDOUT === '1';
const events = [];
function writeTrace(result) {
  if (!traceStdout) return;
  process.stdout.write(`${JSON.stringify({ phase2a_trace: 1, result, events: events.slice(0, 32) })}\n`);
}
try {
  const paths = parse(process.argv.slice(2));
  // Keep package loading inside the bounded refusal boundary too.
  const { runCollabAuthIdentityMigration } = await import('../packages/collab/dist/authIdentityMigration.js');
  const { runGatewayAuthIdentityMigration } = await import('../packages/gateway/dist/authIdentityMigration.js');
  const {
    buildAuthReconciliationDiagnostic,
    captureCollabAuthSnapshot,
    captureStateAuthSnapshot,
    writeAuthReconciliationDiagnostic,
  } = await import('../packages/gateway/dist/authReconciliationDiagnostic.js');
  // The migration acquires and releases collab's immediate lock first.  The
  // read snapshot is plain data before this handle closes; no transactions
  // overlap with state.
  events.push('collab:OPEN');
  collabDb = new Database(paths.collab);
  runCollabAuthIdentityMigration(collabDb, { events });
  const collab = captureCollabAuthSnapshot(collabDb);
  collabDb.close();
  collabDb = undefined;
  events.push('collab:CLOSED');

  events.push('state:OPEN');
  stateDb = new Database(paths.state);
  runGatewayAuthIdentityMigration(stateDb, { events });
  const state = captureStateAuthSnapshot(stateDb);
  const diagnostic = buildAuthReconciliationDiagnostic(collab, state);
  writeAuthReconciliationDiagnostic(stateDb, diagnostic, { events });
  stateDb.close();
  stateDb = undefined;
  events.push('state:CLOSED');
  process.stdout.write(`${JSON.stringify({ status: diagnostic.status, detail_code: diagnostic.detail_code, non_authoritative: 1 })}\n`);
  writeTrace('ok');
} catch (error) {
  try { collabDb?.close(); } catch { /* best effort cleanup */ }
  try { stateDb?.close(); } catch { /* best effort cleanup */ }
  events.push('state:REFUSED');
  writeTrace('refused');
  // Never echo SQLite messages, paths, table names, or other identifiers.
  // Operator-facing output is a bounded refusal code only.
  process.stderr.write(`${usage()}\nPhase 2A offline refusal: PHASE2A_OFFLINE_REFUSED\n`);
  process.exitCode = 2;
}
