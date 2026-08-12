/**
 * SI-4 / A12 — flag-off byte-identity against a fixed legacy transcript.
 * PRD-TCLAW-COLLAB-GATEWAY-004 §6.1 (frozen SI-4 meaning), §2.11, §7 A12.
 *
 * §6.1 defines SI-4 as identity of the OBSERVABLE ARTIFACTS for a fixed
 * legacy transcript: protocol response bytes and ordering, error codes,
 * dispatch decisions, and the ABSENCE of reads/writes to new tables. It
 * explicitly does NOT claim the raw SQLite file is byte-identical -- an
 * additive schema necessarily changes file bytes, and the earlier
 * raw-file reading was physically unsatisfiable.
 *
 * This test therefore pins exactly what the frozen definition claims:
 *   (1) the wire transcript is byte-identical, frame for frame, in order;
 *   (2) the C1 tables receive ZERO rows across the whole transcript;
 *   (3) the documented SEC-1 legacy hole is preserved (owner==null resumes).
 *
 * It runs against the BUILT ARTIFACT, not TS source, because a control
 * proven only in source is exactly the stale-`dist` failure this program
 * treats as unlanded (§5(c), A11).
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  ensureGatewayBuild, launchGateway, connectAndCollect, closeWire, lastFrame,
  type GatewayHandle,
} from './helpers/collab-gateway-harness.js';

let gateway: GatewayHandle | null = null;
beforeAll(async () => { await ensureGatewayBuild(); }, 200000);
afterEach(async () => { if (gateway) { await gateway.stop(); gateway = null; } });

/** The fixed legacy transcript: a create, a resume, and a bad-token attempt. */
async function runLegacyTranscript(url: string) {
  const created = await connectAndCollect(url, {
    role: 'operator', token: 'root-token',
    clientInfo: { name: 'legacy-fixed-transcript', version: '0.1.0' },
  });
  const sessionId = lastFrame(created).metadata.sessionId;
  await closeWire(created);

  const resumed = await connectAndCollect(url, {
    role: 'operator', token: 'root-token', sessionId,
    clientInfo: { name: 'legacy-fixed-transcript', version: '0.1.0' },
  });
  await closeWire(resumed);

  const refused = await connectAndCollect(url, {
    role: 'operator', token: 'wrong-token',
    clientInfo: { name: 'legacy-fixed-transcript', version: '0.1.0' },
  });
  await closeWire(refused);

  // Normalize ONLY the fields that are non-deterministic by design and
  // carry no behavioural meaning: the server-minted session id, the
  // per-event uuid, and the wall-clock timestamp. Everything else --
  // frame type, ordering, message text, metadata shape and values,
  // seq numbering, error codes -- is compared verbatim. Over-scrubbing
  // here would hollow out the very claim the test exists to make, so the
  // substitutions are deliberately narrow and field-anchored.
  const scrub = (raw: string) =>
    raw
      .split(sessionId).join('<SESSION_ID>')
      .replace(/"id":"[0-9a-f-]{36}"/g, '"id":"<UUID>"')
      .replace(/"timestamp":"[^"]+"/g, '"timestamp":"<TS>"');
  return {
    created: created.rawMessages.map(scrub),
    resumedFrames: resumed.rawMessages.map(scrub),
    resumedFlag: lastFrame(resumed).metadata.resumed,
    refused: { raw: refused.rawMessages.map(scrub), close: refused.close },
  };
}

const C1_TABLES = ['gateway_surface_security', 'surface_authorities', 'gateway_task_origins'];

function c1RowCounts(dataDir: string): Record<string, number> {
  const db = new Database(join(dataDir, 'state.db'), { readonly: true });
  const counts: Record<string, number> = {};
  for (const t of C1_TABLES) {
    const present = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
    counts[t] = present
      ? (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n
      : -1;   // -1 = table absent
  }
  db.close();
  return counts;
}

describe('SI-4 / A12 — flag-off observable identity on the built artifact', () => {
  it('produces a byte-identical wire transcript with the flag off vs on-but-unused, and writes no C1 rows', async () => {
    // ---- Run 1: flag OFF (the legacy baseline) -------------------------
    const dirOff = mkdtempSync(join(tmpdir(), 'torq-c1-si4-off-'));
    gateway = await launchGateway({
      TORQCLAW_DATA_DIR: dirOff,
      TORQCLAW_COLLAB_ENABLED: '0',
      TORQCLAW_GATEWAY_TOKEN: 'root-token',
    }, false);
    await gateway.ready;
    const off = await runLegacyTranscript(gateway.url);
    await gateway.stop();
    gateway = null;
    const offCounts = c1RowCounts(dirOff);

    // ---- Run 2: flag ON, but the SAME legacy transcript ----------------
    // Legacy frames carry no `auth` carrier, so even with the subsystem
    // enabled the surface path is never taken. This is the sharper test:
    // it proves the C1 code is inert for legacy traffic, not merely absent.
    const dirOn = mkdtempSync(join(tmpdir(), 'torq-c1-si4-on-'));
    gateway = await launchGateway({
      TORQCLAW_DATA_DIR: dirOn,
      TORQCLAW_COLLAB_ENABLED: '1',
      TORQCLAW_GATEWAY_TOKEN: 'root-token',
    }, false);
    await gateway.ready;
    const on = await runLegacyTranscript(gateway.url);
    await gateway.stop();
    gateway = null;
    const onCounts = c1RowCounts(dirOn);

    // (1) Observable protocol bytes and ordering are identical.
    expect(on.created).toEqual(off.created);
    expect(on.resumedFrames).toEqual(off.resumedFrames);
    expect(on.refused).toEqual(off.refused);

    // (3) The documented SEC-1 legacy hole is preserved: a session created
    // with no principal owner still resumes for a caller presenting none.
    expect(off.resumedFlag).toBe(true);
    expect(on.resumedFlag).toBe(true);

    // The bad token is refused identically in both runs.
    expect(off.refused.raw).toEqual(['{"type":"ERROR","code":"AUTH_FAILED"}']);
    expect(off.refused.close).toEqual({ code: 4001, reason: 'auth failed' });

    // (2) No C1 table receives a single row in either run. The tables exist
    // (the migration is additive and safe to run with the flag off, §2.11)
    // but stay inert for legacy traffic.
    for (const t of C1_TABLES) {
      expect(offCounts[t]).toBe(0);
      expect(onCounts[t]).toBe(0);
    }
    console.log(`SI4_TRANSCRIPT_OFF ${JSON.stringify(off)}`);
    console.log(`SI4_C1_ROWCOUNTS off=${JSON.stringify(offCounts)} on=${JSON.stringify(onCounts)}`);
  }, 120000);
});
