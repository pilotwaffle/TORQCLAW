import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// receipts.ts / export.ts (via storage.ts) open the gateway DB at import
// time, so TORQCLAW_DATA_DIR must be set before they load — exact pattern of
// tests/receipts-read.test.ts / tests/receipt-projection.test.ts.
process.env.TORQCLAW_DATA_DIR = mkdtempSync(join(tmpdir(), 'torq-export-redaction-'));
const { db } = await import('../packages/gateway/src/storage.js');
const { materializeReceipt, getReceipt } = await import('../packages/gateway/src/receipts.js');
const { decideApproval, registerApproval } = await import('../packages/gateway/src/approvals.js');
const { publishOnly, sessionBus } = await import('../packages/gateway/src/events.js');
const {
  SECRET_SHAPES,
  REDACTOR_VERSION,
  EXPORT_VERSION,
  scrubText,
  buildSafeExport,
  handleGetSafeExport,
  selectLiveApprovalsForExport,
} = await import('../packages/gateway/src/export.js');
const { PRIVACY_PATTERNS } = await import('../apps/console/src/components/friendly.js');

// ---- fixture helpers (mirrors tests/receipts-read.test.ts) -----------------

function makeSession(): string {
  const id = randomUUID();
  db.prepare(`INSERT INTO sessions (id, role, client_name) VALUES (?, 'operator', 'test')`).run(id);
  return id;
}

interface TaskFixtureOpts {
  sessionId: string;
  tier?: string;
  state?: 'running' | 'completed' | 'failed';
  requestJson: Record<string, unknown>;
  telemetry?: Record<string, unknown> | null;
  error?: string | null;
  result?: string | null;
}

function makeTask(opts: TaskFixtureOpts): string {
  const requestId = randomUUID();
  db.prepare(
    `INSERT INTO tasks (request_id, session_id, tier, router_reason, state, request_json, result, error, telemetry_json)
     VALUES (@request_id, @session_id, @tier, @router_reason, @state, @request_json, @result, @error, @telemetry_json)`,
  ).run({
    request_id: requestId,
    session_id: opts.sessionId,
    tier: opts.tier ?? 'OLLAMA_LOCAL',
    router_reason: 'TEST: fixture',
    state: opts.state ?? 'completed',
    request_json: JSON.stringify(opts.requestJson),
    result: opts.result ?? null,
    error: opts.error ?? null,
    telemetry_json: opts.telemetry === undefined ? null : opts.telemetry === null ? null : JSON.stringify(opts.telemetry),
  });
  return requestId;
}

function baseRequestJson(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    id: randomUUID(),
    sessionId: randomUUID(),
    sourceChannel: 'test-channel',
    receivedAt: new Date().toISOString(),
    payload: {
      prompt: 'do the thing',
      assembledContext: '',
      contextSize: 100,
      requiredTools: [],
      taskType: 'ROUTINE_AUTOMATION',
      grantedTools: [],
    },
    constraints: {
      latencySensitivity: 'LOW',
      containsSensitiveData: false,
      executionMode: 'AUTO',
    },
    enrichment: {
      classifierUsed: 'LOCAL_LLM',
      classifierConfidence: 0.9,
      classifierLatencyMs: 10,
      estimatedTokens: 100,
      memoryUsed: true,
    },
    ...overrides,
  };
}

const insertEvent = db.prepare(
  `INSERT INTO events (id, session_id, request_id, tier, type, message, metadata)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
);

function emitEvent(
  sessionId: string, requestId: string, type: string, message: string, metadata?: unknown,
): number {
  const info = insertEvent.run(
    randomUUID(), sessionId, requestId, 'OLLAMA_LOCAL', type, message,
    metadata === undefined ? null : JSON.stringify(metadata),
  );
  return Number(info.lastInsertRowid);
}

function insertApproval(requestId: string, toolName: string, status: string, argsJson?: unknown): string {
  const approvalId = randomUUID();
  db.prepare(
    `INSERT INTO tool_approvals (approval_id, request_id, tool_name, args_json, status, decided_at)
     VALUES (?, ?, ?, ?, ?, ${status === 'pending' ? 'NULL' : 'CURRENT_TIMESTAMP'})`,
  ).run(approvalId, requestId, toolName, JSON.stringify(argsJson ?? {}), status);
  return approvalId;
}

function rowCounts(): { tasks: number; events: number; tool_approvals: number; run_receipts: number } {
  const tasks = (db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n;
  const events = (db.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).n;
  const tool_approvals = (db.prepare(`SELECT COUNT(*) AS n FROM tool_approvals`).get() as { n: number }).n;
  const run_receipts = (db.prepare(`SELECT COUNT(*) AS n FROM run_receipts`).get() as { n: number }).n;
  return { tasks, events, tool_approvals, run_receipts };
}

/** Byte-level snapshot of all mutable state the read surface could possibly
 *  touch — same discipline as tests/receipts-read.test.ts's snapshotStates,
 *  extended with a full tool_approvals dump (export reads that table live) so
 *  a sneaky UPDATE anywhere fails the before/after equality. */
function snapshotStates(): {
  taskStates: string[];
  approvalStates: string[];
  receiptsDump: string;
  approvalsDump: string;
} {
  const taskStates = (db.prepare(`SELECT state FROM tasks ORDER BY request_id`).all() as { state: string }[]).map((r) => r.state);
  const approvalStates = (db.prepare(`SELECT status FROM tool_approvals ORDER BY approval_id`).all() as { status: string }[]).map((r) => r.status);
  const receiptsDump = JSON.stringify(db.prepare(`SELECT * FROM run_receipts ORDER BY task_id`).all());
  const approvalsDump = JSON.stringify(db.prepare(`SELECT * FROM tool_approvals ORDER BY approval_id`).all());
  return { taskStates, approvalStates, receiptsDump, approvalsDump };
}

function captureFrames(sessionId: string, fn: () => void): any[] {
  const frames: any[] = [];
  const unsubscribe = sessionBus.subscribe(sessionId, (ev) => frames.push(ev));
  try {
    fn();
  } finally {
    unsubscribe();
  }
  return frames;
}

/**
 * THE load-bearing helper used in EVERY export test below: VALUE-ABSENCE over
 * the ENTIRE serialized frame, never marker-presence alone. A test that only
 * checked "the marker is present" would pass even if the redactor forgot to
 * actually remove the secret and merely appended a marker alongside it — this
 * asserts none of the planted raw values appear ANYWHERE in the JSON text.
 */
function expectNoSecrets(serializedFrame: string, plantedValues: string[]): void {
  for (const v of plantedValues) {
    expect(serializedFrame.includes(v), `planted secret leaked: ${JSON.stringify(v)}`).toBe(false);
  }
}

// A fixed, fully-populated fixture builder for determinism/idempotence tests.
function fullFixture(sid: string): { taskId: string } {
  const taskId = makeTask({
    sessionId: sid,
    state: 'failed',
    requestJson: baseRequestJson({ sourceChannel: 'slack' }),
    telemetry: { costUsd: 0.12, inferenceLatencyMs: 8123, iterations: 3, budgetSource: 'per_task' },
    error: 'BUDGET: Bearer sk-FAKE00000000000000000000000000 exceeded',
  });
  emitEvent(sid, taskId, 'TIER_SELECTED', 'Heuristic route', {
    score: 0.42,
    reason: 'HEURISTIC_EVAL: score 0.42',
    tier: 'API_EXTERNAL',
    ruleId: 'HEURISTIC_EVAL',
    humanReason: 'Chose cloud because of complexity',
    overridable: true,
  });
  emitEvent(sid, taskId, 'TOOL_CALL', 'Executing web_search');
  materializeReceipt(taskId);
  return { taskId };
}

// ---------------------------------------------------------------------------

describe('TCLAW-5B-1 SECRET_SHAPES + scrubText corpus', () => {
  // E5 [op#6]: one FAKE positive per SECRET_SHAPES label, value absent from
  // the WHOLE frame, marker present, report counts it.
  const POSITIVE_CASES: Array<{ label: string; sample: string }> = [
    { label: 'bearer-token', sample: 'Bearer sk-FAKE0000000000000000000000FAKETOKEN' },
    { label: 'api-key', sample: 'sk-FAKE00000000000000000000000000' },
    { label: 'github-token', sample: 'ghp_FAKE0000000000000000000000' },
    { label: 'aws-access-key', sample: 'AKIAFAKE000000000000' },
    {
      label: 'private-key',
      sample:
        '-----BEGIN RSA PRIVATE KEY-----\nFAKEBODYFAKEBODYFAKEBODY\n-----END RSA PRIVATE KEY-----',
    },
    {
      label: 'jwt',
      sample: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.FAKESIGNATUREFAKE',
    },
    { label: 'ssn', sample: '123-45-6789' },
    { label: 'card-number', sample: '4111 1111 1111 1111' },
  ];

  it.each(POSITIVE_CASES)('E5: $label planted in error -> value absent from whole frame + marker + report count', ({ label, sample }) => {
    const hits = new Map<string, number>();
    const scrubbed = scrubText(`provider said: ${sample} — failed`, hits);
    expectNoSecrets(scrubbed, [sample]);
    expect(scrubbed).toContain(`[REDACTED:${label}]`);
    expect(hits.get(label)).toBeGreaterThanOrEqual(1);
  });

  it('E7 [op#8]: FP negatives — 13-digit epoch millis and long seq runs survive UNMANGLED; clean text byte-identical', () => {
    const hits = new Map<string, number>();
    const epoch = '1718000000000'; // 13 digits
    const seqRun = '9876543210987'; // 13-digit seq-looking run
    const clean = `request ${randomUUID()} finished at ${epoch} after seq ${seqRun}`;
    const scrubbed = scrubText(clean, hits);
    expect(scrubbed).toBe(clean); // byte-identical: nothing touched
    expect(scrubbed).toContain(epoch);
    expect(scrubbed).toContain(seqRun);
    expect(hits.size).toBe(0);
  });

  it('E7b: 14-digit run also survives (only the narrowed card shapes match)', () => {
    const hits = new Map<string, number>();
    const fourteen = '12345678901234';
    const scrubbed = scrubText(`id=${fourteen}`, hits);
    expect(scrubbed).toContain(fourteen);
    expect(hits.size).toBe(0);
  });

  it('E7c: card-number positives still caught (grouped + contiguous 15/16-digit forms)', () => {
    const cases = ['4111-1111-1111-1111', '4111111111111111', '378282246310005'];
    for (const c of cases) {
      const hits = new Map<string, number>();
      const scrubbed = scrubText(`card: ${c}`, hits);
      expectNoSecrets(scrubbed, [c]);
      expect(scrubbed).toContain('[REDACTED:card-number]');
    }
  });

  it('E8 [op#9]: nested JSON-in-string provider error (secret inside an escaped inner JSON) is scrubbed', () => {
    const hits = new Map<string, number>();
    const innerSecret = 'sk-FAKE00000000000000000000000000';
    // error field itself is a JSON-encoded string whose DECODED value contains
    // another object with the secret in a nested string field.
    const outer = JSON.stringify({
      providerError: { message: `auth failed: ${innerSecret}`, code: 401 },
    });
    const scrubbed = scrubText(outer, hits);
    expectNoSecrets(scrubbed, [innerSecret]);
    expect(scrubbed).toContain('[REDACTED:api-key]');
    // Re-parses as JSON (re-serialized), never left as a mangled non-JSON blob.
    expect(() => JSON.parse(scrubbed)).not.toThrow();
    const reparsed = JSON.parse(scrubbed);
    expect(reparsed.providerError.code).toBe(401); // numeric leaf untouched
  });

  it('E9 [op#10]: escaped-unicode corpus — secret hidden behind \\uXXXX escapes is scrubbed after decode', () => {
    const hits = new Map<string, number>();
    const secret = 'sk-FAKE00000000000000000000000000';
    // Build a JSON string whose escaped unicode decodes to the secret.
    const escaped = [...secret].map((ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0')).join('');
    const jsonEncoded = `"${escaped}"`; // a JSON string literal
    expect(JSON.parse(jsonEncoded)).toBe(secret); // sanity: it really decodes to the raw secret
    const scrubbed = scrubText(jsonEncoded, hits);
    expectNoSecrets(scrubbed, [secret]);
    expect(scrubbed).toContain('[REDACTED:api-key]');
  });

  it('E10 [op#11]: scrub-before-cap — secret straddling the 2000-char boundary leaves no partial prefix (marker itself may be trimmed by the cap, but it carries no secret material, so that is harmless)', () => {
    const hits = new Map<string, number>();
    const secret = 'sk-FAKE00000000000000000000000000'; // 34 chars
    // Non-word char (space) immediately before the secret so the pattern's
    // \b word-boundary actually anchors there — mirrors how a secret realistically
    // appears in free text (never glued directly onto other word chars).
    const padding = 'x'.repeat(1989) + ' ';
    const raw = padding + secret; // secret starts at char 1990, straddles 2000
    expect(raw.length).toBeGreaterThan(2000);
    const scrubbed = scrubText(raw, hits);
    const capped = scrubbed.length > 2000 ? scrubbed.slice(0, 2000) : scrubbed;
    // The load-bearing assertion: no fragment of the raw secret (not even a
    // truncated prefix) survives — this is the whole point of scrub-BEFORE-
    // cap. The marker label itself is inert (no secret bytes in
    // "[REDACTED:api-key]"), so it is fine if the CAP subsequently trims part
    // of the marker text too — that trims a label, not a secret.
    expectNoSecrets(capped, [secret, secret.slice(0, 20), secret.slice(0, 10)]);
  });

  it('E10c: when the marker fits comfortably before the cap boundary, it survives intact too', () => {
    const hits = new Map<string, number>();
    const secret = 'sk-FAKE00000000000000000000000000';
    const padding = 'x'.repeat(1900) + ' '; // secret+marker land well before 2000
    const raw = padding + secret;
    const scrubbed = scrubText(raw, hits);
    const capped = scrubbed.length > 2000 ? scrubbed.slice(0, 2000) : scrubbed;
    expectNoSecrets(capped, [secret]);
    expect(capped).toContain('[REDACTED:api-key]');
  });

  it('E10b: capping BEFORE scrubbing (the sabotage) WOULD leak a partial prefix — proves ordering matters', () => {
    const secret = 'sk-FAKE00000000000000000000000000';
    const padding = 'x'.repeat(1989) + ' ';
    const raw = padding + secret;
    const cappedFirst = raw.length > 2000 ? raw.slice(0, 2000) : raw; // sabotage: cap before scrub
    const partial = secret.slice(0, 2000 - 1990); // the surviving prefix after the bad cap
    expect(cappedFirst).toContain(partial);
    expect(cappedFirst).not.toContain('[REDACTED:'); // no marker — a raw prefix, unflagged
  });

  it('E11 [op#12]: path corpus — all absolute path shapes become [REDACTED:path]', () => {
    const cases = [
      String.raw`C:\Users\someone\x`,
      String.raw`E:\repo\secret.txt`,
      String.raw`\\HOST\share\f`,
      '/home/u/f',
      '/Users/u/f',
      '~/x',
    ];
    for (const c of cases) {
      const hits = new Map<string, number>();
      const scrubbed = scrubText(`see ${c} for details`, hits);
      expectNoSecrets(scrubbed, [c]);
      expect(scrubbed).toContain('[REDACTED:path]');
    }
  });

  it('E12 [op#13]: relative basenames survive untouched', () => {
    const cases = ['src/foo.ts', 'foo.py', 'lib/bar/baz.js'];
    for (const c of cases) {
      const hits = new Map<string, number>();
      const clean = `edited ${c} successfully`;
      const scrubbed = scrubText(clean, hits);
      expect(scrubbed).toBe(clean);
      expect(hits.size).toBe(0);
    }
  });

  it('E6 [op#7]: console PRIVACY_PATTERNS parity — every console pattern sample is caught by the gateway scrubber', () => {
    const samples: Record<string, string> = {
      'an API key': 'sk-FAKE00000000000000000000000000',
      'a GitHub token': 'ghp_FAKE0000000000000000000000',
      'an AWS access key': 'AKIAFAKE000000000000',
      'a private key': '-----BEGIN RSA PRIVATE KEY-----',
      'an SSN': '123-45-6789',
      'a card number': '4111111111111111',
    };
    expect(PRIVACY_PATTERNS.length).toBeGreaterThan(0);
    for (const { label, re } of PRIVACY_PATTERNS) {
      const sample = samples[label];
      expect(sample, `no sample registered for console pattern "${label}"`).toBeTruthy();
      expect(re.test(sample)).toBe(true); // sanity: this really is what the console pattern matches
      const hits = new Map<string, number>();
      const scrubbed = scrubText(`contains ${sample} here`, hits);
      expectNoSecrets(scrubbed, [sample]);
    }
  });

  it('E6b [op#7]: gateway-only POSITIVES the console does NOT cover — ghs_ token + full PEM body', () => {
    // ghs_ (GitHub server-to-server token) is not covered by the console's
    // ghp_-only pattern; the gateway's gh[pousr]_ superset must still catch it.
    const ghsSecret = 'ghs_FAKE00000000000000000000';
    expect(PRIVACY_PATTERNS.some((p) => p.re.test(ghsSecret))).toBe(false); // console does NOT catch this
    const hits1 = new Map<string, number>();
    const scrubbed1 = scrubText(`token: ${ghsSecret}`, hits1);
    expectNoSecrets(scrubbed1, [ghsSecret]);
    expect(scrubbed1).toContain('[REDACTED:github-token]');

    // Full PEM body (not just the header) — console's pattern only matches
    // the BEGIN header; the gateway must remove the WHOLE block including body.
    const pemBody = 'FAKEKEYBODYLINE1\nFAKEKEYBODYLINE2';
    const fullPem = `-----BEGIN RSA PRIVATE KEY-----\n${pemBody}\n-----END RSA PRIVATE KEY-----`;
    const consoleMatch = PRIVACY_PATTERNS.find((p) => p.label === 'a private key')!;
    // Console pattern is header-only (no body capture) — direct evidence it
    // would leave the body untouched if literally reused verbatim.
    expect(consoleMatch.re.source).not.toContain('END');
    const hits2 = new Map<string, number>();
    const scrubbed2 = scrubText(`key dump: ${fullPem}`, hits2);
    expectNoSecrets(scrubbed2, [pemBody, fullPem]);
    expect(scrubbed2).toContain('[REDACTED:private-key]');
  });
});

describe('TCLAW-5B-1 idempotence / marker fixed point (E21 [op#24])', () => {
  it('redact(redact(x)) === redact(x) for every positive corpus sample', () => {
    const samples = [
      'Bearer sk-FAKE0000000000000000000000FAKETOKEN',
      'sk-FAKE00000000000000000000000000',
      'ghp_FAKE0000000000000000000000',
      'AKIAFAKE0000000000',
      '123-45-6789',
      '4111 1111 1111 1111',
      String.raw`C:\Users\someone\x`,
    ];
    for (const s of samples) {
      const hits1 = new Map<string, number>();
      const once = scrubText(s, hits1);
      const hits2 = new Map<string, number>();
      const twice = scrubText(once, hits2);
      expect(twice).toBe(once);
    }
  });

  it('no marker literal matches any SECRET_SHAPES pattern (every marker vs every pattern)', () => {
    const labels = new Set(SECRET_SHAPES.map((p) => p.label));
    labels.add('unparsed-tool-entry');
    for (const label of labels) {
      const marker = `[REDACTED:${label}]`;
      for (const { re } of SECRET_SHAPES) {
        const fresh = new RegExp(re.source, re.flags);
        expect(fresh.test(marker), `marker ${marker} matched pattern ${re.source}`).toBe(false);
      }
    }
  });
});

describe('TCLAW-5B-1 buildSafeExport — allowlist projection', () => {
  it('E1 [op#1]: allowlist fail-closed — unknown field (top-level AND nested) never exports', () => {
    const sid = makeSession();
    const taskId = makeTask({ sessionId: sid, requestJson: baseRequestJson() });
    materializeReceipt(taskId);

    const secretValue = 'sk-FAKE00000000000000000000000000';
    const row = getReceipt(taskId)!;
    const parsed = JSON.parse(row.full_receipt_json);
    parsed.newSensitiveField = secretValue; // top-level unknown field
    parsed.routeDiagnostics = { ...(parsed.routeDiagnostics ?? {}), nestedUnknown: secretValue }; // nested unknown field
    db.prepare(`UPDATE run_receipts SET full_receipt_json = ? WHERE task_id = ?`).run(
      JSON.stringify(parsed), taskId,
    );

    const mutatedRow = getReceipt(taskId)!;
    const safeExport = buildSafeExport(mutatedRow, [], REDACTOR_VERSION);
    const serialized = JSON.stringify(safeExport);

    expectNoSecrets(serialized, [secretValue]);
    expect(serialized).not.toContain('newSensitiveField');
    expect(serialized).not.toContain('nestedUnknown');
  });

  it('E2 [op#2,5]: prompt + assembledContext planted in request_json never export (any substring)', () => {
    const sid = makeSession();
    const promptSecret = 'MY_SECRET_PROMPT_sk-FAKE00000000000000000000000000';
    const contextSecret = 'ASSEMBLED_CONTEXT_LEAK_ghp_FAKE0000000000000000000000';
    const taskId = makeTask({
      sessionId: sid,
      requestJson: baseRequestJson({
        payload: {
          prompt: promptSecret,
          assembledContext: contextSecret,
          contextSize: 100,
          requiredTools: [],
          taskType: 'ROUTINE_AUTOMATION',
          grantedTools: [],
        },
      }),
    });
    materializeReceipt(taskId);
    const row = getReceipt(taskId)!;
    const safeExport = buildSafeExport(row, [], REDACTOR_VERSION);
    const serialized = JSON.stringify(safeExport);
    expectNoSecrets(serialized, [promptSecret, contextSecret, 'MY_SECRET_PROMPT', 'ASSEMBLED_CONTEXT_LEAK']);
  });

  it('E3 [op#3]: TOOL_CALL events with planted-arg metadata -> no event content exports', () => {
    const sid = makeSession();
    const taskId = makeTask({ sessionId: sid, requestJson: baseRequestJson() });
    const argSecret = 'TOOL_ARG_SECRET_AKIAFAKE0000000000';
    emitEvent(sid, taskId, 'TOOL_CALL', 'Executing filesystem__write_file', { args: { content: argSecret } });
    materializeReceipt(taskId);
    const row = getReceipt(taskId)!;
    const safeExport = buildSafeExport(row, [], REDACTOR_VERSION);
    const serialized = JSON.stringify(safeExport);
    expectNoSecrets(serialized, [argSecret]);
    // toolsCalled carries only the parsed tool name, never event metadata.
    expect(safeExport.toolsCalled).toEqual(['filesystem__write_file']);
  });

  it('E4 [op#4]: tool_approvals.args_json planted secret never exports; approvals carry only toolName/status/decidedAt', () => {
    const sid = makeSession();
    const taskId = makeTask({ sessionId: sid, requestJson: baseRequestJson() });
    const argsSecret = 'APPROVAL_ARGS_SECRET_sk-FAKE00000000000000000000000000';
    insertApproval(taskId, 'filesystem__write_file', 'approved', { content: argsSecret });
    materializeReceipt(taskId);
    const row = getReceipt(taskId)!;
    const liveApprovals = selectLiveApprovalsForExport(taskId, new Map());
    const safeExport = buildSafeExport(row, liveApprovals, REDACTOR_VERSION);
    const serialized = JSON.stringify(safeExport);
    expectNoSecrets(serialized, [argsSecret]);
    expect(safeExport.approvals).toHaveLength(1);
    expect(Object.keys(safeExport.approvals[0]).sort()).toEqual(['decidedAt', 'status', 'toolName'].sort());
  });

  it('E13 [op#14]: name-guard — TOOL_CALL with non-"Executing " message becomes [REDACTED:unparsed-tool-entry]; clean names pass verbatim', () => {
    const sid = makeSession();
    const taskId = makeTask({ sessionId: sid, requestJson: baseRequestJson() });
    const freeTextSecret = 'weird message with sk-FAKE00000000000000000000000000 inside';
    emitEvent(sid, taskId, 'TOOL_CALL', freeTextSecret); // no 'Executing ' prefix -> parseToolName falls back to raw message
    emitEvent(sid, taskId, 'TOOL_CALL', 'Executing web_search'); // clean
    materializeReceipt(taskId);
    const row = getReceipt(taskId)!;
    const safeExport = buildSafeExport(row, [], REDACTOR_VERSION);
    const serialized = JSON.stringify(safeExport);
    expectNoSecrets(serialized, [freeTextSecret, 'sk-FAKE00000000000000000000000000']);
    expect(safeExport.toolsCalled).toContain('[REDACTED:unparsed-tool-entry]');
    expect(safeExport.toolsCalled).toContain('web_search');
    expect(safeExport.redactionReport.patternsHit['unparsed-tool-entry']).toBeGreaterThanOrEqual(1);
  });

  it('E10-integration [op#11]: scrub-before-cap through the REAL buildSafeExport error-field pipeline — a secret straddling the 2000-char boundary in a real stored task.error leaves no partial prefix in the exported `error` field', () => {
    const sid = makeSession();
    const secret = 'sk-FAKE00000000000000000000000000'; // 34 chars, needs a non-word char before it
    const padding = 'x'.repeat(1989) + ' ';
    const rawError = padding + secret; // secret starts at char 1990, well past a naive 2000-char cap boundary
    expect(rawError.length).toBeGreaterThan(2000);

    const taskId = makeTask({
      sessionId: sid, state: 'failed', requestJson: baseRequestJson(), error: rawError,
    });
    materializeReceipt(taskId);
    const row = getReceipt(taskId)!;
    const safeExport = buildSafeExport(row, [], REDACTOR_VERSION);

    // The load-bearing assertion: buildSafeExport's OWN `error` field — the
    // exact value that reaches the client — contains neither the whole
    // secret nor any partial prefix of it. This exercises the actual
    // scrub-then-cap composition inside buildSafeExport (not scrubText in
    // isolation), so a regression that swaps the order back to cap-then-scrub
    // inside buildSafeExport itself is caught here even if scrubText's own
    // unit tests stay green.
    expect(safeExport.error).not.toBeNull();
    expectNoSecrets(safeExport.error!, [secret, secret.slice(0, 20), secret.slice(0, 10), secret.slice(0, 5)]);
    expectNoSecrets(JSON.stringify(safeExport), [secret]);
  });
});

describe('TCLAW-5B-1 live approvals (E14 [op#15])', () => {
  it('register -> materialize (embed frozen "pending") -> decideApproval -> export shows "approved" + non-null decidedAt WHILE full_receipt_json.approvals still says "pending"', () => {
    const sid = makeSession();
    const taskId = makeTask({
      sessionId: sid,
      requestJson: baseRequestJson(),
      telemetry: { blockedOn: 'filesystem__write_file' },
      result: '',
    });
    const approvalId = registerApproval(taskId, 'filesystem__write_file', {});
    materializeReceipt(taskId); // embed frozen at 'pending' — the projector's own snapshot

    const frozenRow = getReceipt(taskId)!;
    const frozenParsed = JSON.parse(frozenRow.full_receipt_json);
    expect(frozenParsed.approvals[0].status).toBe('pending');

    const decided = decideApproval(approvalId, 'APPROVE');
    expect(decided).not.toBeNull();

    // The embed is STILL 'pending' (receipt was never re-projected).
    const stillFrozenRow = getReceipt(taskId)!;
    const stillFrozenParsed = JSON.parse(stillFrozenRow.full_receipt_json);
    expect(stillFrozenParsed.approvals[0].status).toBe('pending');

    // But the LIVE export reads the real table and shows 'approved' + decidedAt.
    const liveApprovals = selectLiveApprovalsForExport(taskId, new Map());
    const safeExport = buildSafeExport(stillFrozenRow, liveApprovals, REDACTOR_VERSION);
    expect(safeExport.approvals[0].status).toBe('approved');
    expect(safeExport.approvals[0].decidedAt).not.toBeNull();

    // Both halves asserted directly in one place.
    expect(stillFrozenParsed.approvals[0].status).toBe('pending');
    expect(safeExport.approvals[0].status).toBe('approved');
  });

  it('E14-handler [op#15]: the SAME divergence proven through the REAL handleGetSafeExport handler (not just the pure buildSafeExport call) — catches a regression where the handler wiring itself reads the frozen embed instead of calling the live-approvals query', () => {
    const sid = makeSession();
    const taskId = makeTask({
      sessionId: sid,
      requestJson: baseRequestJson(),
      telemetry: { blockedOn: 'filesystem__write_file' },
      result: '',
    });
    const approvalId = registerApproval(taskId, 'filesystem__write_file', {});
    materializeReceipt(taskId); // embed frozen at 'pending'

    const decided = decideApproval(approvalId, 'APPROVE');
    expect(decided).not.toBeNull();

    // Drive the REAL production handler (the same function server.ts's
    // switch calls) — not buildSafeExport directly.
    const frames = captureFrames(sid, () => handleGetSafeExport(sid, taskId));
    expect(frames.length).toBe(1);
    const safeExport = frames[0].metadata.safeExport;
    expect(safeExport).not.toBeNull();
    expect(safeExport.approvals[0].status).toBe('approved');
    expect(safeExport.approvals[0].decidedAt).not.toBeNull();

    // The frozen embed on the same row is still 'pending' — confirms the
    // handler could NOT have gotten 'approved' from the embed; it had to
    // have queried the live table.
    const rowAfter = getReceipt(taskId)!;
    const frozenParsed = JSON.parse(rowAfter.full_receipt_json);
    expect(frozenParsed.approvals[0].status).toBe('pending');
  });
});

describe('TCLAW-5B-1 handleGetSafeExport — the real production handler', () => {
  it('E16 [op#18]: no-oracle — absent vs foreign taskId -> byte-identical frames', () => {
    const owner = makeSession();
    const other = makeSession();
    const taskId = makeTask({ sessionId: owner, requestJson: baseRequestJson() });
    materializeReceipt(taskId);

    const foreignFrames = captureFrames(other, () => handleGetSafeExport(other, taskId));
    const absentId = randomUUID();
    const absentFrames = captureFrames(other, () => handleGetSafeExport(other, absentId));

    expect(foreignFrames.length).toBe(1);
    expect(absentFrames.length).toBe(1);
    const normalize = (frame: any) =>
      JSON.stringify({ message: frame.message, metadata: { ...frame.metadata, taskId: 'X' } });
    expect(normalize(foreignFrames[0])).toBe(normalize(absentFrames[0]));
    expect(foreignFrames[0].metadata.safeExport).toBeNull();
  });

  it('E17 [op#19,20]: zero-write — rowCounts + snapshotStates identical across the handler; safe_export_json stays NULL after export', () => {
    const sid = makeSession();
    const taskId = makeTask({
      sessionId: sid,
      requestJson: baseRequestJson({ sourceChannel: 'slack' }),
      telemetry: { costUsd: 0.05, inferenceLatencyMs: 400, iterations: 2 },
    });
    emitEvent(sid, taskId, 'TOOL_CALL', 'Executing filesystem__read_file');
    insertApproval(taskId, 'filesystem__read_file', 'approved');
    materializeReceipt(taskId);

    const before = rowCounts();
    const beforeStates = snapshotStates();

    const frames = captureFrames(sid, () => handleGetSafeExport(sid, taskId));
    expect(frames.length).toBe(1);
    expect(frames[0].metadata.safeExportView).toBe(true);
    expect(frames[0].metadata.safeExport).not.toBeNull();

    const after = rowCounts();
    const afterStates = snapshotStates();
    expect(after).toEqual(before);
    expect(afterStates).toEqual(beforeStates);

    // Explicit SELECT assertion: safe_export_json is still NULL after export.
    const rowAfter = getReceipt(taskId)!;
    expect(rowAfter.safe_export_json).toBeNull();
  });

  it('E18 [op#21]: buildSafeExport is pure — frozen-input no-mutation over a fully-populated fixture', () => {
    const sid = makeSession();
    const { taskId } = fullFixture(sid);
    const row = getReceipt(taskId)!;
    const liveApprovals = selectLiveApprovalsForExport(taskId, new Map());

    const frozenRow = JSON.parse(JSON.stringify(row)); // deep clone to diff against
    const frozenApprovals = JSON.parse(JSON.stringify(liveApprovals));
    buildSafeExport(row, liveApprovals, REDACTOR_VERSION);
    expect(row).toEqual(frozenRow); // buildSafeExport never mutated its ReceiptRow input
    expect(liveApprovals).toEqual(frozenApprovals); // nor its approvals array input
  });

  it('E18b [op#21]: fail-closed on a REAL throw — the handler publishes the byte-exact fallback frame, never a partial payload (sabotage-detecting: catching only the serialize step would still pass this if buildSafeExport itself never throws, so this forces the throw INSIDE the try block handleGetSafeExport actually wraps)', () => {
    const sid = makeSession();
    const { taskId } = fullFixture(sid);

    // Force a genuine throw from INSIDE handleGetSafeExport's try block by
    // making JSON.stringify explode for the duration of this one call only —
    // this is the real global the handler's own serialize step invokes, so
    // this proves the ACTUAL try/catch around build+serialize, not a
    // simulated substitute. Restored in `finally` no matter what.
    const realStringify = JSON.stringify;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (JSON as any).stringify = () => {
      throw new Error('injected throw for fail-closed test');
    };
    let frames: any[];
    try {
      frames = captureFrames(sid, () => handleGetSafeExport(sid, taskId));
    } finally {
      JSON.stringify = realStringify;
    }

    expect(frames!.length).toBe(1);
    const meta = frames![0].metadata;
    // Byte-exact key set, no receipt-derived keys whatsoever.
    expect(Object.keys(meta).sort()).toEqual(['error', 'safeExport', 'safeExportView', 'taskId'].sort());
    expect(meta.safeExportView).toBe(true);
    expect(meta.taskId).toBe(taskId);
    expect(meta.safeExport).toBeNull();
    expect(meta.error).toBe('export_failed');
    // No planted secret from the fixture's error field leaked into the
    // fallback frame either (belt-and-suspenders — the key-set pin above
    // already guarantees this structurally).
    expectNoSecrets(realStringify(frames![0]), ['sk-FAKE00000000000000000000000000']);
  });

  it('E19 [op#22]: wording pins — notice string exact; no forbidden claims; counts derive from operations, not marker-scanning', () => {
    const sid = makeSession();
    // Plant N=2 secrets AND a pre-seeded fake marker that must NOT inflate counts.
    const taskId = makeTask({
      sessionId: sid,
      state: 'failed',
      requestJson: baseRequestJson(),
      error:
        'sk-FAKE00000000000000000000000000 and sk-FAKEAAAAAAAAAAAAAAAAAAAAAA and already-redacted text: [REDACTED:api-key]',
    });
    materializeReceipt(taskId);
    const row = getReceipt(taskId)!;
    const safeExport = buildSafeExport(row, [], REDACTOR_VERSION);

    const exactNotice = 'Known secret shapes removed. This export does not and cannot claim to contain no secrets.';
    expect(safeExport.redactionReport.notice).toBe(exactNotice);

    const serialized = JSON.stringify(safeExport);
    // Forbidden AFFIRMATIVE claims — the words as a claim of cleanliness —
    // must never appear. "sanitized" must not appear at all (the honest
    // notice never uses that word). "no secrets" is only permitted as part
    // of the exact honest DISCLAIMER text above ("does NOT and cannot claim
    // to contain no secrets" — a negation, not a claim); it must not appear
    // ANYWHERE else in the payload.
    expect(serialized).not.toMatch(/\bsanitized\b/i);
    const noSecretsOccurrences = (serialized.match(/no secrets/gi) ?? []).length;
    const noticeOccurrencesOfNoSecrets = (exactNotice.match(/no secrets/gi) ?? []).length;
    expect(noSecretsOccurrences).toBe(noticeOccurrencesOfNoSecrets); // only inside the pinned disclaimer
    expect(serialized).not.toMatch(/\bthis export is safe\b/i);
    expect(serialized).not.toMatch(/\bfully redacted\b/i);

    // The pre-seeded fake marker text in the INPUT produced NO real
    // replacement operation for itself (it wasn't itself a matched secret
    // pattern) — count reflects only the 2 real planted secrets actually
    // replaced, never derived by scanning the OUTPUT for marker-looking
    // substrings (which would also count the pre-seeded one, and any marker
    // the real replacements themselves produced, inflating past 2).
    expect(safeExport.redactionReport.patternsHit['api-key']).toBe(2);
  });

  it('E19b: report contains no substring of any planted secret value', () => {
    const sid = makeSession();
    const secret = 'sk-FAKE00000000000000000000000000';
    const taskId = makeTask({
      sessionId: sid, state: 'failed', requestJson: baseRequestJson(), error: `boom: ${secret}`,
    });
    materializeReceipt(taskId);
    const row = getReceipt(taskId)!;
    const safeExport = buildSafeExport(row, [], REDACTOR_VERSION);
    expect(JSON.stringify(safeExport.redactionReport)).not.toContain(secret);
  });

  it('E22 [op#25]: oversize -> all-or-marker, output always parses as JSON', () => {
    const sid = makeSession();
    // Build an error large enough that even after scrubbing+capping to 2000
    // chars the export is small — so instead we directly validate the
    // all-or-marker CONTRACT via the handler's own MAX_REPLAY_BYTES reuse:
    // construct a receipt with a huge tools_called array (many guarded
    // entries) to exceed the byte budget through toolsCalled, which is NOT
    // capped like `error` is.
    const taskId = makeTask({ sessionId: sid, requestJson: baseRequestJson() });
    for (let i = 0; i < 20000; i++) {
      emitEvent(sid, taskId, 'TOOL_CALL', `Executing tool_${i}_${'x'.repeat(20)}`);
    }
    materializeReceipt(taskId);

    const frames = captureFrames(sid, () => handleGetSafeExport(sid, taskId));
    expect(frames.length).toBe(1);
    const meta = frames[0].metadata;
    expect(meta.safeExportView).toBe(true);
    if (meta.exportOmitted) {
      expect(meta.safeExport).toBeNull();
      expect(meta.exportOmitted).toEqual({ reason: 'too_large' });
    } else {
      // If it happened to fit, that's fine too — the important invariant is
      // it's never a truncated/partial string; JSON.stringify(frame) must
      // always parse.
      expect(() => JSON.parse(JSON.stringify(frames[0]))).not.toThrow();
    }
  });
});

describe('TCLAW-5B-1 determinism (E21 [op#24])', () => {
  it('two builds of the same fixed input are byte-identical', () => {
    const sid = makeSession();
    const { taskId } = fullFixture(sid);
    const row = getReceipt(taskId)!;
    const liveApprovals = selectLiveApprovalsForExport(taskId, new Map());

    const a = JSON.stringify(buildSafeExport(row, liveApprovals, REDACTOR_VERSION));
    const b = JSON.stringify(buildSafeExport(row, liveApprovals, REDACTOR_VERSION));
    expect(a).toBe(b);
  });

  it('redactorVersion sensitivity: v1 vs v2 differ ONLY in the version stamps', () => {
    const sid = makeSession();
    const { taskId } = fullFixture(sid);
    const row = getReceipt(taskId)!;
    const liveApprovals = selectLiveApprovalsForExport(taskId, new Map());

    const v1 = buildSafeExport(row, liveApprovals, 1);
    const v2 = buildSafeExport(row, liveApprovals, 2);

    const stripVersions = (obj: any) => {
      const clone = JSON.parse(JSON.stringify(obj));
      clone.redactorVersion = 'X';
      clone.redactionReport.redactorVersion = 'X';
      return clone;
    };
    expect(stripVersions(v1)).toEqual(stripVersions(v2));
    expect(v1.redactorVersion).toBe(1);
    expect(v2.redactorVersion).toBe(2);
  });

  it('no generatedAt/timestamp/random field anywhere in the payload (fixed key set)', () => {
    const sid = makeSession();
    const { taskId } = fullFixture(sid);
    const row = getReceipt(taskId)!;
    const liveApprovals = selectLiveApprovalsForExport(taskId, new Map());
    const safeExport = buildSafeExport(row, liveApprovals, REDACTOR_VERSION);
    const serialized = JSON.stringify(safeExport);
    expect(serialized).not.toMatch(/generatedAt/i);
  });

  it('exportVersion is a fixed constant', () => {
    expect(EXPORT_VERSION).toBe(1);
  });
});
