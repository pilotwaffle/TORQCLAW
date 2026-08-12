/**
 * SI-4 / A12 for the C2 slice — flag-off byte-identity across an
 * APPROVAL-BEARING legacy transcript.
 * PRD-TCLAW-COLLAB-GATEWAY-004 §1.2 constraint 4, §2.11, §6.1, §7 A12.
 *
 * The C1 SI-4 test proves the CONNECT path is inert flag-off. C2 changes a
 * different path -- registration, the approval card frame, the decision
 * transition, and the pre-tool admission seam -- so it needs its own
 * transcript, one that actually reaches a gated tool.
 *
 * The claim (deliberately the rescoped one the operator froze in §6.1):
 * observable artifacts are identical -- wire bytes, frame order, error
 * codes, and existing logical row values. An additive schema necessarily
 * changes raw SQLite file bytes, so that is NOT claimed.
 *
 * Two runs, same transcript:
 *   1. flag OFF  -- the legacy baseline.
 *   2. flag ON, but legacy traffic (no surface credential presented).
 *      This is the sharper half: it proves the C2 code is INERT for legacy
 *      traffic rather than merely absent.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import WebSocket from 'ws';
import {
  ensureGatewayBuild, launchGateway, type GatewayHandle,
} from './helpers/collab-gateway-harness.js';

let gateway: GatewayHandle | null = null;
beforeAll(async () => { await ensureGatewayBuild(); }, 200000);
afterEach(async () => { if (gateway) { await gateway.stop(); gateway = null; } });

/** The C2 tables that must stay empty for legacy traffic. */
const C2_TABLES = [
  'gateway_approval_bindings', 'gateway_action_grants', 'approval_deliveries',
];

/**
 * A fixed legacy transcript that REACHES A GATED TOOL: submit a prompt
 * with the forced-gate seam on, so the run terminates in a real
 * PENDING_APPROVAL, then decide it. That exercises registerApproval,
 * the card emit, and decideApproval -- every seam C2 touched.
 */
async function runApprovalTranscript(url: string): Promise<{
  frames: string[]; approvalId: string | null;
}> {
  const raw: string[] = [];
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  ws.on('message', (m) => raw.push(m.toString()));
  ws.send(JSON.stringify({
    role: 'operator', token: 'root-token',
    clientInfo: { name: 'legacy-approval-transcript', version: '0.1.0' },
  }));
  await new Promise((r) => setTimeout(r, 600));
  ws.send(JSON.stringify({
    action: 'SUBMIT_PROMPT',
    prompt: 'fixed legacy approval transcript',
    executionMode: 'LOCAL_ONLY',
  }));
  await new Promise((r) => setTimeout(r, 2500));

  // Decide the approval the run produced, so the DECISION path is in the
  // transcript too -- that is where C2 widened the transaction.
  let approvalId: string | null = null;
  for (const line of raw) {
    if (!line.includes('PENDING_APPROVAL')) continue;
    try { approvalId = JSON.parse(line).metadata?.approvalId ?? null; } catch { /* ignore */ }
  }
  if (approvalId) {
    ws.send(JSON.stringify({
      action: 'APPROVE_TOOL', approvalId, decision: 'REJECT',
    }));
    await new Promise((r) => setTimeout(r, 1200));
  }
  try { ws.close(); } catch { /* noop */ }
  return { frames: raw, approvalId };
}

/**
 * Scrub ONLY the fields that are non-deterministic by design and carry no
 * behavioural meaning. Over-scrubbing would hollow out the claim, so the
 * substitutions are narrow and field-anchored -- frame type, ordering,
 * message text, metadata shape/values, seq and error codes all compare
 * verbatim.
 */
function scrubAll(frames: string[]): string[] {
  const sessionMatch = frames[0]?.match(/"sessionId":"([0-9a-f-]{36})"/);
  const sessionId = sessionMatch?.[1] ?? '';
  return frames.map((raw) => {
    let out = sessionId ? raw.split(sessionId).join('<SESSION_ID>') : raw;
    out = out
      .replace(/"id":"[0-9a-f-]{36}"/g, '"id":"<UUID>"')
      .replace(/"requestId":"[0-9a-f-]{36}"/g, '"requestId":"<REQ>"')
      .replace(/"approvalId":"[0-9a-f-]{36}"/g, '"approvalId":"<APPROVAL>"')
      .replace(/"timestamp":"[^"]+"/g, '"timestamp":"<TS>"')
      // classifier latency is wall-clock measurement noise
      .replace(/"classifierLatencyMs":[0-9.]+/g, '"classifierLatencyMs":<MS>');
    return out;
  });
}

function c2RowCounts(dataDir: string): Record<string, number> {
  const db = new Database(join(dataDir, 'state.db'), { readonly: true });
  const counts: Record<string, number> = {};
  for (const t of C2_TABLES) {
    const present = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
    counts[t] = present
      ? (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n
      : -1;
  }
  db.close();
  return counts;
}

/** The six C2 columns on every approval row, which must all stay NULL. */
function approvalC2Columns(dataDir: string): Record<string, unknown>[] {
  const db = new Database(join(dataDir, 'state.db'), { readonly: true });
  const rows = db.prepare(
    `SELECT status, origin_principal_id, origin_surface_id, decided_principal_id,
            decided_surface_id, expires_at, context_hash
       FROM tool_approvals ORDER BY rowid`,
  ).all() as Record<string, unknown>[];
  db.close();
  return rows;
}

describe('SI-4 / A12 (C2) — flag-off identity across an approval transcript', () => {
  it('the approval transcript is byte-identical, and no C2 row is written', async () => {
    const forcedGate = { TORQCLAW_E2E_FORCE_GATED_TOOL: 'filesystem__write_file' };

    // ---- Run 1: flag OFF (the legacy baseline) -------------------------
    const dirOff = mkdtempSync(join(tmpdir(), 'torq-c2-si4-off-'));
    gateway = await launchGateway({
      TORQCLAW_DATA_DIR: dirOff, TORQCLAW_COLLAB_ENABLED: '0',
      TORQCLAW_GATEWAY_TOKEN: 'root-token', ...forcedGate,
    }, false);
    await gateway.ready;
    const off = await runApprovalTranscript(gateway.url);
    await gateway.stop(); gateway = null;

    // ---- Run 2: flag ON, same LEGACY traffic ---------------------------
    // Legacy frames carry no surface credential, so the C2 identity path
    // is never taken even with the subsystem enabled.
    const dirOn = mkdtempSync(join(tmpdir(), 'torq-c2-si4-on-'));
    gateway = await launchGateway({
      TORQCLAW_DATA_DIR: dirOn, TORQCLAW_COLLAB_ENABLED: '1',
      TORQCLAW_GATEWAY_TOKEN: 'root-token', ...forcedGate,
    }, false);
    await gateway.ready;
    const on = await runApprovalTranscript(gateway.url);
    await gateway.stop(); gateway = null;

    // The transcript must have actually reached an approval, or this
    // proves nothing about the C2 seams.
    expect(off.approvalId, 'the transcript must reach a real approval').not.toBeNull();
    expect(on.approvalId).not.toBeNull();

    // (1) byte-identical wire transcript, frame for frame, in order
    expect(scrubAll(on.frames)).toEqual(scrubAll(off.frames));

    // (2) ZERO C2 rows in either run -- the tables exist (additive
    //     migration) but stay inert for legacy traffic (§2.11).
    for (const [table, count] of Object.entries(c2RowCounts(dirOff))) {
      expect(count, `${table} flag-off`).toBe(0);
    }
    for (const [table, count] of Object.entries(c2RowCounts(dirOn))) {
      expect(count, `${table} flag-on-but-legacy`).toBe(0);
    }

    // (3) the six additive columns stay NULL on every row, in both runs,
    //     and the legacy status transition still happened normally.
    for (const dir of [dirOff, dirOn]) {
      const rows = approvalC2Columns(dir);
      expect(rows.length, 'the run wrote a real approval row').toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.origin_principal_id).toBeNull();
        expect(row.origin_surface_id).toBeNull();
        expect(row.decided_principal_id).toBeNull();
        expect(row.decided_surface_id).toBeNull();
        expect(row.expires_at).toBeNull();
        expect(row.context_hash).toBeNull();
      }
      // The REJECT still transitioned the row -- flag-off behaviour is
      // preserved, not merely "nothing happened".
      expect(rows.some((r) => r.status === 'rejected')).toBe(true);
    }
  }, 240000);
});
