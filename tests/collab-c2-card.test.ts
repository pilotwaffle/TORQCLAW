/**
 * C2-6 — bounded/redacted approval card (property 8).
 * PRD-TCLAW-COLLAB-GATEWAY-004 §3.3 prop 8, §3.10, §6.9, §8 C2-6.
 *
 * PRE-REGISTERED OBLIGATION 2 lives here: the shipped pre-C2 path emitted
 * the model's RAW proposed args in PENDING_APPROVAL metadata
 * (`args: error.args`), and that frame goes to the wire AND into the
 * persisted event log. The operator's at-rest retention ruling explicitly
 * did NOT waive "raw args never on wire/log".
 *
 * The unit half of that obligation is here; the booted-artifact half is in
 * tests/collab-c2-built-artifact.test.ts, because a control proven only in
 * source is not landed (the stale-dist lesson).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildApprovalCard, summarizeArgs, buildActionLabel, redactCardText,
  REDACTION_NOTE, MAX_SUMMARIZED_KEYS, MAX_VALUE_CHARS, APPROVAL_CARD_VERSION,
} from '../packages/gateway/src/approvalCard.js';

const here = dirname(fileURLToPath(import.meta.url));

const SECRET = 'sk-abcdefghijklmnop0123456789';

function card(canonicalArgs: string) {
  return buildApprovalCard({
    approvalId: 'a1', requestId: 'r1', toolName: 'filesystem__write_file',
    status: 'pending', createdAt: '2026-01-01 00:00:00', expiresAt: '2026-01-01 00:15:00',
    serverNow: '2026-01-01 00:00:05', canApprove: true, canReject: true,
    canonicalArgs,
  });
}

describe('C2-6 card redaction + bounding (prop 8)', () => {
  it('never emits raw args: the card has no args/args_json field at all', () => {
    const c = card('{"path":"/tmp/x","secret_payload":"hunter2"}');
    expect(c).not.toHaveProperty('args');
    expect(c).not.toHaveProperty('args_json');
    expect(c).not.toHaveProperty('argsJson');
    expect(JSON.stringify(c)).not.toContain('hunter2');
  });

  it('ALLOWLIST: an unclassified key is summarized by shape, never by value', () => {
    const c = card('{"totally_new_field":"leak-me-please"}');
    const s = c.argSummaries[0]!;
    expect(s.key).toBe('totally_new_field');
    expect(s.type).toBe('string');
    expect(s.withheld).toBe(true);
    expect(s.value).toBeUndefined();
    expect(s.size).toBe('leak-me-please'.length);
    expect(JSON.stringify(c)).not.toContain('leak-me-please');
  });

  it('shows values ONLY for allowlisted keys, and redacts them', () => {
    const c = card(`{"path":"/tmp/${SECRET}/f.txt"}`);
    const s = c.argSummaries[0]!;
    expect(s.key).toBe('path');
    expect(s.value).toBeDefined();
    expect(s.value).toContain('[REDACTED:api-key]');
    expect(s.value).not.toContain(SECRET);
  });

  // D-4: numbers and booleans used to bypass the allowlist entirely.
  it('D-4: a NUMERIC value on a non-allowlisted key is withheld, not stringified', () => {
    const c = card('{"account":4111111111111111,"pin":123456}');
    const account = c.argSummaries.find((s) => s.key === 'account')!;
    expect(account.type).toBe('number');
    expect(account.withheld, 'a number on an unclassified key must be withheld').toBe(true);
    expect(account.value).toBeUndefined();
    expect(c.argSummaries.find((s) => s.key === 'pin')!.withheld).toBe(true);
    // The decisive check: neither number may appear anywhere in the card.
    const serialized = JSON.stringify(c);
    expect(serialized).not.toContain('4111111111111111');
    expect(serialized).not.toContain('123456');
  });

  it('D-4: a BOOLEAN on a non-allowlisted key is withheld too', () => {
    const c = card('{"isAdmin":true}');
    const s = c.argSummaries[0]!;
    expect(s.type).toBe('boolean');
    expect(s.withheld).toBe(true);
    expect(s.value).toBeUndefined();
  });

  it('D-4: allowlisted keys still render numbers/booleans normally', () => {
    // The fix must not withhold everything -- an allowlisted key keeps its
    // value, which is what makes the card useful at all.
    const c = card('{"path":"/tmp/x","name":42}');
    expect(c.argSummaries.find((s) => s.key === 'name')!.value).toBe('42');
    expect(c.argSummaries.find((s) => s.key === 'path')!.value).toBe('/tmp/x');
  });

  it('nested objects and arrays are withheld wholesale, with a size hint only', () => {
    const c = card('{"payload":{"deep":{"secret":"nope"}},"items":["a","b","c"]}');
    const payload = c.argSummaries.find((s) => s.key === 'payload')!;
    expect(payload.type).toBe('object');
    expect(payload.withheld).toBe(true);
    expect(payload.value).toBeUndefined();
    const items = c.argSummaries.find((s) => s.key === 'items')!;
    expect(items.type).toBe('array');
    expect(items.size).toBe(3);
    expect(JSON.stringify(c)).not.toContain('nope');
  });

  it('caps the number of summarized keys and flags truncation', () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < MAX_SUMMARIZED_KEYS + 10; i += 1) many[`k${i}`] = 'v';
    const c = card(JSON.stringify(many));
    expect(c.argSummaries).toHaveLength(MAX_SUMMARIZED_KEYS);
    expect(c.argsTruncated).toBe(true);
  });

  it('caps long shown values', () => {
    const c = card(JSON.stringify({ path: 'x'.repeat(500) }));
    const s = c.argSummaries[0]!;
    expect(s.value!.length).toBeLessThanOrEqual(MAX_VALUE_CHARS + 1); // +1 for the ellipsis
  });

  it('redacts BEFORE capping (capping first could sever a secret un-marked)', () => {
    // Put the secret past the cap boundary; if capping ran first the
    // pattern would never match and a raw prefix could survive.
    const value = `${'a'.repeat(MAX_VALUE_CHARS - 5)}${SECRET}`;
    const out = redactCardText(value);
    expect(out).not.toContain('sk-abcdefghijklmnop');
  });

  it('uses HONEST wording -- never "safe" or "no secrets" (§3.10)', () => {
    const c = card('{"path":"/tmp/x"}');
    expect(c.redactionNote).toBe(REDACTION_NOTE);
    expect(c.redactionNote).toContain('known secret shapes removed');
    expect(c.redactionNote).toContain('not a guarantee');
    expect(c.redactionNote.toLowerCase()).not.toMatch(/\bsafe\b|\bsanitiz|no secrets/);
  });

  it('is deterministic and pure (rebuildable projections depend on this)', () => {
    const args = '{"path":"/tmp/x","n":1}';
    expect(JSON.stringify(card(args))).toBe(JSON.stringify(card(args)));
  });

  it('survives malformed or non-object stored args without throwing', () => {
    for (const bad of ['not json', '[1,2,3]', 'null', '"str"']) {
      expect(() => card(bad)).not.toThrow();
      expect(card(bad).argSummaries).toEqual([]);
    }
  });
});

describe('C2-6 accessibility + contract data (§6.9)', () => {
  it('carries the accessible name, status, timing and server-derived permission', () => {
    const c = card('{"path":"/tmp/report.txt"}');
    expect(c.actionLabel.length).toBeGreaterThan(0);
    expect(c.actionLabel).toContain('filesystem__write_file');   // meaning preserved
    expect(c.status).toBe('pending');
    expect(c.createdAt).toBeTruthy();
    expect(c.expiresAt).toBeTruthy();
    expect(c.serverNow).toBeTruthy();                            // server-authoritative clock
    expect(typeof c.canApprove).toBe('boolean');
    expect(typeof c.canReject).toBe('boolean');
    expect(c.cardVersion).toBe(APPROVAL_CARD_VERSION);
  });

  it('redaction does NOT erase the action\'s meaningful name', () => {
    // Even when every argument is withheld, the label still says what the
    // action IS -- an operator must never face an unlabelled decision.
    const label = buildActionLabel('shell__run', summarizeArgs('{"blob":"x"}').summaries);
    expect(label).toContain('shell__run');
  });

  it('states the one-shot scope on the card (property 11)', () => {
    expect(card('{}').grantScope).toBe('one-shot');
  });

  it('an unavailable card carries a TEXTUAL reason, not a colour/icon', () => {
    const c = buildApprovalCard({
      approvalId: 'a1', requestId: 'r1', toolName: 't', status: 'expired',
      createdAt: '2026-01-01 00:00:00', expiresAt: '2026-01-01 00:15:00',
      serverNow: '2026-01-01 01:00:00', canApprove: false, canReject: false,
      unavailableReason: 'approval-expired', canonicalArgs: '{}',
    });
    expect(c.unavailableReason).toBe('approval-expired');
    expect(typeof c.unavailableReason).toBe('string');
  });
});

// ── OBLIGATION 2, source half ──────────────────────────────────────────────
describe('OBLIGATION 2: the raw-args PENDING_APPROVAL emit is gone', () => {
  const rawDispatchSrc = readFileSync(
    join(here, '..', 'packages', 'gateway', 'src', 'dispatch.ts'), 'utf8',
  );
  // Strip comments before scanning: the doc comment on the replacement
  // deliberately QUOTES the old defect (`args: error.args`) to explain what
  // was removed, and a naive scan would match that prose and report the
  // hole as still open.
  const dispatchSrc = rawDispatchSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('dispatch.ts no longer puts `args:` on the PENDING_APPROVAL frame', () => {
    // The exact shipped defect: `args: error.args` inside the emit.
    expect(dispatchSrc).not.toMatch(/args:\s*error\.args/);
  });

  it('the PENDING_APPROVAL emit carries redacted summaries instead', () => {
    const emitBlock = dispatchSrc.slice(
      dispatchSrc.indexOf("emit('PENDING_APPROVAL'"),
      dispatchSrc.indexOf("emit('PENDING_APPROVAL'") + 600,
    );
    expect(emitBlock).toContain('argSummaries');
    expect(emitBlock).toContain('redactionNote');
    expect(emitBlock).not.toMatch(/\bargs:/);
  });

  it('gate-fact `targets` (raw arg values) are redacted too', () => {
    // extractPaths lifts strings verbatim out of the proposed args, so it
    // is raw argument content on the same frame.
    expect(dispatchSrc).toMatch(/targets:\s*extractPaths[\s\S]{0,120}redactCardText/);
  });
});
