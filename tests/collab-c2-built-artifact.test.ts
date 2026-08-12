/**
 * C2 three-proofs (c) — BUILT-ARTIFACT enforcement.
 * PRD-TCLAW-COLLAB-GATEWAY-004 §5(c), §7 A11, §8 C2-1/C2-6.
 *
 * "A control present in source but stale in the shipped artifact is not
 * landed" (principalBridge.ts:69). Green units prove the logic; these
 * tests boot the REAL `packages/gateway/dist/server.js` as a child process
 * and prove the control is active THERE.
 *
 * PRE-REGISTERED OBLIGATION 2 is discharged here in its mandatory form:
 * the operator's prop-8 ruling makes "raw args never on the wire" a
 * BUILT-ARTIFACT gate, not a source-review item. So the decisive test
 * drives a real gated tool call through a booted gateway over a real
 * WebSocket and inspects the actual bytes of the PENDING_APPROVAL frame.
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

/** Drive a real connection, sending commands and collecting every frame. */
async function converse(
  url: string,
  connectFrame: unknown,
  sends: unknown[],
  quietMs = 900,
): Promise<{ raw: string[]; frames: any[] }> {
  const raw: string[] = [];
  const frames: any[] = [];
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  ws.on('message', (m) => {
    const s = m.toString();
    raw.push(s);
    try { frames.push(JSON.parse(s)); } catch { /* non-JSON is still captured raw */ }
  });
  ws.send(JSON.stringify(connectFrame));
  await new Promise((r) => setTimeout(r, 500));
  for (const cmd of sends) {
    ws.send(JSON.stringify(cmd));
    await new Promise((r) => setTimeout(r, quietMs));
  }
  await new Promise((r) => setTimeout(r, quietMs));
  try { ws.close(); } catch { /* noop */ }
  return { raw, frames };
}

function env(dataDir: string, extra: Record<string, string> = {}) {
  return {
    TORQCLAW_DATA_DIR: dataDir,
    TORQCLAW_GATEWAY_TOKEN: 'root-token',
    // Force the local tier so the run stays on-box and needs no provider.
    TORQCLAW_COLLAB_ENABLED: '0',
    ...extra,
  };
}

describe('C2 built artifact — migration runs at boot (§5(c), C2-1)', () => {
  it('the booted dist migrates the six columns, the index, and the sidecars', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'torq-c2-mig-'));
    gateway = await launchGateway(env(dataDir), false);
    await gateway.ready;
    await gateway.stop(); gateway = null;

    // Read what the ARTIFACT created -- nothing here was hand-migrated.
    const db = new Database(join(dataDir, 'state.db'), { readonly: true });
    const cols = (db.prepare(`PRAGMA table_info(tool_approvals)`).all() as { name: string }[])
      .map((c) => c.name);
    for (const c of [
      'origin_principal_id', 'origin_surface_id', 'decided_principal_id',
      'decided_surface_id', 'expires_at', 'context_hash',
    ]) expect(cols, `${c} must be migrated by the booted artifact`).toContain(c);

    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as
      { name: string }[]).map((r) => r.name);
    for (const t of [
      'gateway_approval_bindings', 'gateway_action_grants', 'approval_deliveries',
      'gateway_profile_delegations',
    ]) expect(tables, `${t} must exist on the booted artifact`).toContain(t);

    expect(db.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tool_approvals_status_expires'`,
    ).get()).toBeDefined();

    // The delegation-evidence columns (C1 §7 owed item) too.
    const originCols = (db.prepare(`PRAGMA table_info(gateway_task_origins)`).all() as
      { name: string }[]).map((c) => c.name);
    expect(originCols).toContain('delegation_id');
    expect(originCols).toContain('registry_enforcement_hash');
    db.close();
  }, 120000);

  it('re-booting the same data dir is a no-op (idempotent migration)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'torq-c2-mig2-'));
    for (let i = 0; i < 2; i += 1) {
      gateway = await launchGateway(env(dataDir), false);
      await gateway.ready;
      await gateway.stop(); gateway = null;
    }
    const db = new Database(join(dataDir, 'state.db'), { readonly: true });
    const cols = (db.prepare(`PRAGMA table_info(tool_approvals)`).all() as { name: string }[])
      .map((c) => c.name);
    // Exactly one of each -- a second ALTER would have thrown at boot.
    expect(cols.filter((c) => c === 'context_hash')).toHaveLength(1);
    db.close();
  }, 180000);
});

// ── OBLIGATION 2: the mandatory built-artifact gate ─────────────────────────
describe('C2-6 built artifact — raw args NEVER on the wire (prop 8)', () => {
  it('a real gated tool call produces a PENDING_APPROVAL with no raw args', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'torq-c2-args-'));
    // TORQCLAW_E2E_FORCE_GATED_TOOL is the shipped determinism seam for
    // exactly this: it forces a gated-tool hit so the approval loop can be
    // driven without depending on a local model being installed. Without
    // it this test passes VACUOUSLY (zero PENDING_APPROVAL frames), which
    // would make the mandatory prop-8 gate meaningless.
    //
    // The forced hit carries `{ e2e: true, prompt }` as its args, so the
    // operator's prompt text IS raw argument content -- which is precisely
    // what the shipped `args: error.args` emit used to put on the wire.
    gateway = await launchGateway(
      env(dataDir, { TORQCLAW_E2E_FORCE_GATED_TOOL: 'filesystem__write_file' }), false,
    );
    await gateway.ready;

    const secret = 'sk-liveartifactsecret0123456789';
    const { raw } = await converse(
      gateway.url,
      {
        role: 'operator', token: 'root-token',
        clientInfo: { name: 'c2-artifact', version: '0.1.0' },
      },
      [{
        action: 'SUBMIT_PROMPT',
        prompt: `write the value ${secret} into /tmp/c2-probe.txt`,
        executionMode: 'LOCAL_ONLY',
      }],
      1500,
    );

    const wire = raw.join('\n');

    // The decisive assertion: whatever happened, the secret the operator
    // typed into a tool argument must not come BACK on the wire inside an
    // approval frame's raw args.
    const approvalFrames = raw.filter((r) => r.includes('PENDING_APPROVAL'));
    // GUARD AGAINST A VACUOUS PASS: if no gated call ever fired there is
    // nothing to assert about, and a green result would mean nothing. The
    // local model may legitimately be unavailable in a given environment,
    // so this reports rather than fails -- but it makes the difference
    // between a real proof and an empty one VISIBLE instead of silent.
    console.log('[c2-artifact] PENDING_APPROVAL frames observed:', approvalFrames.length,
      '| total frames:', raw.length);
    expect(
      approvalFrames.length,
      'the forced gated-tool seam must actually produce an approval frame, '
      + 'otherwise this mandatory gate would pass vacuously',
    ).toBeGreaterThan(0);
    for (const frame of approvalFrames) {
      const parsed = JSON.parse(frame);
      const meta = parsed?.metadata ?? parsed?.event?.metadata ?? {};
      // The shipped defect was `args: error.args` on exactly this frame.
      expect(meta, 'PENDING_APPROVAL must not carry raw args').not.toHaveProperty('args');
      if (meta.argSummaries !== undefined) {
        expect(Array.isArray(meta.argSummaries)).toBe(true);
      }
    }
    // SCOPE NOTE, deliberate: the secret DOES appear in the USER_PROMPT
    // echo, because the operator typed it into their own prompt and the
    // gateway echoes the submitted prompt back to the submitting session.
    // That is pre-existing, separate behaviour and is NOT what property 8
    // governs -- prop 8 is about the model's PROPOSED TOOL ARGUMENTS being
    // reflected onto the approval card. Asserting over `wire` as a whole
    // would conflate the two and make this gate fail for the wrong reason.
    //
    // So the assertion is scoped to the approval frames, which is exactly
    // where `args: error.args` used to put raw argument bytes.
    for (const frame of approvalFrames) {
      expect(frame, 'no raw arg content on the approval frame').not.toContain(secret);
    }
    // The forced-hit args are `{ e2e: true, prompt }`, so the prompt key
    // must be present-but-WITHHELD rather than absent: proving the card
    // saw the argument and chose not to emit its value.
    const meta = JSON.parse(approvalFrames[0]!).metadata;
    const promptSummary = (meta.argSummaries as { key: string; withheld?: boolean; value?: string }[])
      .find((sm) => sm.key === 'prompt');
    expect(promptSummary, 'the prompt argument must be summarized').toBeDefined();
    expect(promptSummary!.withheld).toBe(true);
    expect(promptSummary!.value).toBeUndefined();

    await gateway.stop(); gateway = null;
  }, 180000);

  it('the built artifact contains the redacted card path, not the raw-args emit', async () => {
    // Directly inspect the SHIPPED javascript: this is the stale-dist
    // check. If dist were stale, the string `args: error.args` (or its
    // compiled equivalent) would still be present and the redacted path
    // absent, even though the TS source looks correct.
    const { readFileSync } = await import('node:fs');
    const { GATEWAY_DIST_ENTRY } = await import('./helpers/collab-gateway-harness.js');
    const distDir = join(GATEWAY_DIST_ENTRY, '..');
    const dispatchJs = readFileSync(join(distDir, 'dispatch.js'), 'utf8');

    expect(dispatchJs).toContain('argSummaries');
    expect(dispatchJs).toContain('redactionNote');
    // The compiled emit must not pass the raw args object through.
    const emitIdx = dispatchJs.indexOf('PENDING_APPROVAL');
    expect(emitIdx).toBeGreaterThan(-1);
    const emitBlock = dispatchJs.slice(emitIdx, emitIdx + 700);
    expect(emitBlock).not.toMatch(/args:\s*error\.args/);

    // and the card module itself shipped
    expect(() => readFileSync(join(distDir, 'approvalCard.js'), 'utf8')).not.toThrow();
    const cardJs = readFileSync(join(distDir, 'approvalCard.js'), 'utf8');
    expect(cardJs).toContain('known secret shapes removed');
  }, 60000);
});

describe('C2 built artifact — flag-off inertness (SI-4)', () => {
  it('with the flag off, no C2 table is written by a normal run', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'torq-c2-flagoff-'));
    gateway = await launchGateway(env(dataDir, { TORQCLAW_COLLAB_ENABLED: '0' }), false);
    await gateway.ready;
    await converse(
      gateway.url,
      { role: 'operator', token: 'root-token', clientInfo: { name: 'c2-off', version: '0.1.0' } },
      [{ action: 'SUBMIT_PROMPT', prompt: 'say hello', executionMode: 'LOCAL_ONLY' }],
      1200,
    );
    await gateway.stop(); gateway = null;

    const db = new Database(join(dataDir, 'state.db'), { readonly: true });
    // The tables EXIST (migration is additive and unconditional) but stay
    // EMPTY -- that is exactly the §2.11 "present but inert" posture.
    for (const t of ['gateway_approval_bindings', 'gateway_action_grants', 'approval_deliveries']) {
      const { c } = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number };
      expect(c, `${t} must stay empty with the flag off`).toBe(0);
    }
    db.close();
  }, 120000);
});
