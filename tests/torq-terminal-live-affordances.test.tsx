// @vitest-environment jsdom
// LIVE-vs-REPLAY boundary: QA-1 proves replay rows dispatch nothing; QA-2
// proves live rows dispatch the correct command. The SAME dangerous event
// shapes fed here are proven INERT in the ReceiptsPanel replay by
// tests/receipts-panel.test.tsx (test 2, the structural zero-button
// assertion) — do not duplicate that half here.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { GatewayEvent } from '@torqclaw/contracts';

// jsdom does not implement Element.prototype.scrollTo (TorqTerminal.tsx :101
// calls scrollRef.current?.scrollTo(...) in a mount effect to auto-scroll the
// event log). This is a jsdom environment gap, not a product bug — polyfill
// it here rather than touch TorqTerminal source.
if (typeof Element !== 'undefined' && !Element.prototype.scrollTo) {
  Element.prototype.scrollTo = function scrollTo() {};
}

// MODULE-SCOPE mock object (vi.mock is hoisted; the factory must reference a
// hoisted-safe holder). Use a mutable object the tests reassign .events on.
const stream: { events: GatewayEvent[]; isConnected: boolean; sendCommand: ReturnType<typeof vi.fn> } = {
  events: [],
  isConnected: true,
  sendCommand: vi.fn(() => true),
};
vi.mock('../apps/console/src/components/useGatewayStream.js', () => ({
  useGatewayStream: () => stream,
}));
// import AFTER the mock (static import is fine — vi.mock is hoisted above imports)
import TorqTerminal from '../apps/console/src/components/TorqTerminal.js';

afterEach(() => {
  cleanup(); // LOAD-BEARING: root config has no globals:true.
  stream.events = [];
  stream.sendCommand.mockClear();
  stream.sendCommand = vi.fn(() => true); // guards against a leaked mockReturnValueOnce
});

let idCounter = 0;
function ev(p: Partial<GatewayEvent>): GatewayEvent {
  idCounter++;
  return {
    id: `id-${idCounter}`,
    requestId: null,
    sessionId: 's',
    tier: null,
    type: 'SYSTEM',
    message: '',
    timestamp: '2026-01-01T00:00:00.000Z',
    ...p,
  } as GatewayEvent;
}

function tierSelected(requestId: string, diag: object): GatewayEvent {
  return ev({ type: 'TIER_SELECTED', requestId, tier: (diag as any).tier ?? 'OLLAMA_LOCAL', message: 'routed', metadata: diag });
}
// A non-terminal event referencing the SAME requestId as an active anchor,
// used to keep activeRequestId resolved (busy = last event not RESULT/ERROR/
// CONNECTED/PENDING_APPROVAL) without a terminal event nulling it out.
function toolCall(requestId: string): GatewayEvent {
  return ev({ type: 'TOOL_CALL', requestId, message: 'Executing filesystem__read_file' });
}

const diagA = { score: 10, reason: 'a', tier: 'OLLAMA_LOCAL', ruleId: 'LOCAL_INTENT', overridable: false };

describe('TorqTerminal live affordances (TCLAW-QA-2 — mounts the REAL TorqTerminal via vi.mock)', () => {
  describe('A. tool approval', () => {
    it('Allow once dispatches APPROVE_TOOL with no toolName, then dedups', () => {
      stream.events = [
        ev({ type: 'PENDING_APPROVAL', requestId: 'r1', metadata: { approvalId: 'appr-1', toolName: 'filesystem__write_file', args: { path: '/x' } } }),
      ];
      render(<TorqTerminal />);

      const allowBtn = screen.getByText('Allow once'); // anti-vacuous: exact button present before click
      fireEvent.click(allowBtn);

      // EXACT shape — no toolName (granted tool is read server-side; commands.ts:37-40).
      expect(stream.sendCommand).toHaveBeenCalledWith({
        action: 'APPROVE_TOOL',
        approvalId: 'appr-1',
        decision: 'APPROVE',
      });

      // DEDUP (render-driven, approvals only — see honesty comment below).
      expect(stream.sendCommand).toHaveBeenCalledTimes(1);
      expect(screen.queryByText('Allow once')).not.toBeInTheDocument();
      expect(screen.getByText('✓ allowed once')).toBeInTheDocument();
      // The no-double-dispatch guarantee is RENDER-DRIVEN: the decided map (:72)
      // gates the card off (!decision, :530/:542), unmounting the buttons.
      // decideTool/decideSkill themselves call sendCommand UNCONDITIONALLY
      // (:225,:234) — do not mistake this for internal idempotency.
    });

    it('Deny dispatches APPROVE_TOOL REJECT, then dedups', () => {
      stream.events = [
        ev({ type: 'PENDING_APPROVAL', requestId: 'r1', metadata: { approvalId: 'appr-1', toolName: 'filesystem__write_file', args: { path: '/x' } } }),
      ];
      render(<TorqTerminal />);

      const denyBtn = screen.getByText('Deny');
      fireEvent.click(denyBtn);

      expect(stream.sendCommand).toHaveBeenCalledWith({
        action: 'APPROVE_TOOL',
        approvalId: 'appr-1',
        decision: 'REJECT',
      });

      expect(stream.sendCommand).toHaveBeenCalledTimes(1);
      expect(screen.queryByText('Deny')).not.toBeInTheDocument();
      expect(screen.getByText('✕ denied')).toBeInTheDocument();
      // Same render-driven dedup guarantee as Allow once above.
    });
  });

  describe('B. skill approval', () => {
    it('plain Allow dispatches APPROVE_SKILL with no editedMarkdown, then dedups', () => {
      stream.events = [
        ev({ type: 'PENDING_APPROVAL', requestId: 'r1', metadata: { queueId: 'queue-1', skillName: 'do-thing', skillMarkdown: '# draft' } }),
      ];
      render(<TorqTerminal />);

      const allowBtn = screen.getByText('Allow');
      fireEvent.click(allowBtn);

      // EXACT — the :226 branch requires editedMarkdown!==undefined AND
      // decision==='APPROVE'; plain Allow never sets text, so no editedMarkdown key.
      expect(stream.sendCommand).toHaveBeenCalledWith({
        action: 'APPROVE_SKILL',
        queueId: 'queue-1',
        decision: 'APPROVE',
      });

      // DEDUP.
      expect(stream.sendCommand).toHaveBeenCalledTimes(1);
      expect(screen.queryByText('Allow')).not.toBeInTheDocument();
      expect(screen.getByText('✓ allowed once')).toBeInTheDocument();
      // The no-double-dispatch guarantee is RENDER-DRIVEN: the decided map (:72)
      // gates the card off (!decision, :530/:542), unmounting the buttons.
      // decideTool/decideSkill themselves call sendCommand UNCONDITIONALLY
      // (:225,:234) — do not mistake this for internal idempotency.
    });

    it('Approve with edits: textarea renders before typing, then dispatches APPROVE_SKILL with editedMarkdown', () => {
      stream.events = [
        ev({ type: 'PENDING_APPROVAL', requestId: 'r1', metadata: { queueId: 'queue-1', skillName: 'do-thing', skillMarkdown: '# draft' } }),
      ];
      render(<TorqTerminal />);

      const editBtn = screen.getByText('Edit'); // draft already present -> label is 'Edit', not 'load draft to edit'
      fireEvent.click(editBtn);

      // G1R suggested #2: assert the textarea rendered BEFORE typing.
      // NOTE: getByRole('textbox') would collide with the main prompt <input
      // type="text">, which also carries the implicit textbox role — query
      // the <textarea> tag directly to disambiguate (R8 text-query pitfall).
      const textarea = document.querySelector('textarea');
      expect(textarea).toBeInTheDocument();

      fireEvent.change(textarea, { target: { value: '# edited draft' } });

      const approveEditsBtn = screen.getByText('Approve with edits'); // label flips once editing
      fireEvent.click(approveEditsBtn);

      expect(stream.sendCommand).toHaveBeenCalledWith({
        action: 'APPROVE_SKILL',
        queueId: 'queue-1',
        decision: 'APPROVE',
        editedMarkdown: '# edited draft',
      });
    });

    it('Deny-after-edit dispatches APPROVE_SKILL REJECT with NO editedMarkdown (shape-leak guard)', () => {
      stream.events = [
        ev({ type: 'PENDING_APPROVAL', requestId: 'r1', metadata: { queueId: 'queue-1', skillName: 'do-thing', skillMarkdown: '# draft' } }),
      ];
      render(<TorqTerminal />);

      const editBtn = screen.getByText('Edit');
      fireEvent.click(editBtn);

      const textarea = document.querySelector('textarea')!;
      fireEvent.change(textarea, { target: { value: '# edited draft' } });

      const denyBtn = screen.getByText('Deny');
      fireEvent.click(denyBtn);

      // G2A-verified attribution: the PRIMARY guard is the Deny button itself,
      // which wires onDecide(queueId,'REJECT') passing NO text argument (:741) —
      // so editedMarkdown reaches decideSkill as undefined regardless. The
      // decideSkill branch (:226, editedMarkdown!==undefined && decision===
      // 'APPROVE') is a SECONDARY, defense-in-depth filter; sabotaging :226
      // alone does not flip this test — only breaking the button-level guard
      // does. Exact toHaveBeenCalledWith pins the observable end-to-end
      // contract: edited text is never leaked into the REJECT payload.
      expect(stream.sendCommand).toHaveBeenCalledWith({
        action: 'APPROVE_SKILL',
        queueId: 'queue-1',
        decision: 'REJECT',
      });
    });
  });

  describe('C. skill draft fetch', () => {
    it('load draft to edit dispatches GET_SKILL_DRAFT and renders no textarea (fetch-then-edit flow)', () => {
      stream.events = [
        // OMIT skillMarkdown so original = draft ?? fetchedDraft = undefined (:658).
        ev({ type: 'PENDING_APPROVAL', requestId: 'r1', metadata: { queueId: 'queue-1', skillName: 'do-thing' } }),
      ];
      render(<TorqTerminal />);

      const loadDraftBtn = screen.getByText('load draft to edit'); // anti-vacuous: exact label present
      fireEvent.click(loadDraftBtn);

      expect(stream.sendCommand).toHaveBeenCalledWith({
        action: 'GET_SKILL_DRAFT',
        queueId: 'queue-1',
      });

      // startEdit only sets editing=true when original !== undefined; here it
      // stays undefined (fetch pending), so no textarea appears yet. Query the
      // <textarea> tag directly — queryByRole('textbox') would also match the
      // main prompt <input type="text">, which is always present.
      expect(document.querySelector('textarea')).not.toBeInTheDocument();
    });
  });

  describe('D. error recovery', () => {
    it("retry at $2 dispatches SUBMIT_PROMPT with forced custom budget", () => {
      stream.events = [
        ev({ type: 'ERROR', requestId: 'r1', metadata: { recovery: ['RETRY', 'RETRY_LOCAL', 'RETRY_CLOUD', 'COPY_DIAGNOSTIC'], prompt: 'do it again', suggestedBudget: 2 } }),
      ];
      render(<TorqTerminal />);

      const retryBtn = screen.getByText('retry at $2');
      fireEvent.click(retryBtn);

      expect(stream.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'SUBMIT_PROMPT', prompt: 'do it again', executionMode: 'AUTO', maxCostUsd: 2 }),
      );
    });

    it("retry (no suggestedBudget) dispatches SUBMIT_PROMPT with NO maxCostUsd key", () => {
      stream.events = [
        ev({ type: 'ERROR', requestId: 'r1', metadata: { recovery: ['RETRY', 'RETRY_LOCAL', 'RETRY_CLOUD', 'COPY_DIAGNOSTIC'], prompt: 'do it again' } }),
      ];
      render(<TorqTerminal />);

      const retryBtn = screen.getByText('retry'); // no suggestedBudget -> plain 'retry' label
      fireEvent.click(retryBtn);

      // G1R REQUIRED #1: read the actual call arg — objectContaining alone
      // cannot prove absence of a key.
      const arg = stream.sendCommand.mock.calls[0][0];
      expect(arg).toEqual(expect.objectContaining({ action: 'SUBMIT_PROMPT', prompt: 'do it again', executionMode: 'AUTO' }));
      expect(arg).not.toHaveProperty('maxCostUsd');
      // executionMode:'AUTO' relies on fresh-mount DEFAULT_CONTROLS (mode:'AUTO');
      // resendLocal/resendCloud force their mode explicitly and don't have this
      // coupling.
    });

    it("run on this machine dispatches SUBMIT_PROMPT forcing LOCAL_ONLY", () => {
      stream.events = [
        ev({ type: 'ERROR', requestId: 'r1', metadata: { recovery: ['RETRY', 'RETRY_LOCAL', 'RETRY_CLOUD', 'COPY_DIAGNOSTIC'], prompt: 'do it again', suggestedBudget: 2 } }),
      ];
      render(<TorqTerminal />);

      const localBtn = screen.getByText('run on this machine');
      fireEvent.click(localBtn);

      // G2A-verified attribution: on a fresh mount (controls.budget === ''),
      // resendLocal (:181-183) sets budget:'free', and it is buildSubmit's
      // budget==='free' branch (:45) that pins executionMode:'LOCAL_ONLY' —
      // the explicit mode:'LOCAL_ONLY' override in resendLocal only carries
      // independent weight when a non-empty budget is already set. This test
      // asserts the observable LOCAL_ONLY output on the fresh-mount path.
      expect(stream.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'SUBMIT_PROMPT', prompt: 'do it again', executionMode: 'LOCAL_ONLY' }),
      );
    });

    it("run on cloud (faster) dispatches SUBMIT_PROMPT forcing CLOUD_OK", () => {
      stream.events = [
        ev({ type: 'ERROR', requestId: 'r1', metadata: { recovery: ['RETRY', 'RETRY_LOCAL', 'RETRY_CLOUD', 'COPY_DIAGNOSTIC'], prompt: 'do it again', suggestedBudget: 2 } }),
      ];
      render(<TorqTerminal />);

      const cloudBtn = screen.getByText('run on cloud (faster)');
      fireEvent.click(cloudBtn);

      expect(stream.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'SUBMIT_PROMPT', prompt: 'do it again', executionMode: 'CLOUD_OK' }),
      );
    });

    it('T-L1/T-L2 [op#18,19] copy raw diagnostic (local, unredacted): EXACT relabel + tooltip pin, EXACT legacy payload bytes, does NOT dispatch sendCommand (the one inert recovery chip)', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, { clipboard: { writeText } });

      const errEvent = ev({ type: 'ERROR', requestId: 'r1', message: 'Task failed', metadata: { recovery: ['RETRY', 'RETRY_LOCAL', 'RETRY_CLOUD', 'COPY_DIAGNOSTIC'], prompt: 'do it again', suggestedBudget: 2 } });
      stream.events = [errEvent];
      render(<TorqTerminal />);

      // T-L1: EXACT relabel present (the OLD selector 'copy diagnostic' is
      // deliberately broken by this relabel — that breakage IS the tooth
      // proving the relabel landed, per the G1R ruling).
      const copyBtn = screen.getByText('copy raw diagnostic (local, unredacted)');
      expect(screen.queryByText('copy diagnostic')).not.toBeInTheDocument();
      expect(copyBtn).toHaveAttribute(
        'title',
        'copies requestId, reason, and the last 10 event messages exactly as shown in this terminal — no redaction',
      );

      fireEvent.click(copyBtn);

      // T-L2: EXACT legacy payload bytes, byte-unchanged from copyDiagnostic
      // (:242-251) — requestId/reason/last-10-events block, built from the
      // SAME fixture events this test set up.
      const recent = stream.events.slice(-10).map((e) => `[${e.type}] ${e.message}`);
      const expectedBlock = [
        `requestId: ${errEvent.requestId ?? '(none)'}`,
        `reason: ${errEvent.message}`,
        '--- last 10 events ---',
        ...recent,
      ].join('\n');
      expect(writeText).toHaveBeenCalledWith(expectedBlock);
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(stream.sendCommand).toHaveBeenCalledTimes(0);

      // restore — do not leak the clipboard stub into other tests.
      // @ts-expect-error test cleanup of a test-local stub
      delete (navigator as any).clipboard;
    });
  });

  describe('D2. TCLAW-5B-2 terminal "copy safe export" chip [G1R RC-5 proven — see TorqTerminal.tsx top-of-file comment]', () => {
    function errorWithChip(requestId = 'r1'): GatewayEvent {
      return ev({
        type: 'ERROR',
        requestId,
        message: 'Task failed',
        metadata: { recovery: ['RETRY', 'COPY_DIAGNOSTIC'], prompt: 'do it again' },
      });
    }
    function safeExportFrame(taskId: string, meta: Record<string, unknown>): GatewayEvent {
      return ev({ type: 'SYSTEM', message: 'Safe export', metadata: { safeExportView: true, taskId, ...meta } });
    }
    const fixtureSafeExport = {
      torqclawSafeExport: true as const,
      exportVersion: 1,
      redactorVersion: 1,
      projectionVersion: 1,
      taskId: 'r1',
      sessionId: 's',
      sourceChannel: 'cli',
      selectedTier: 'OLLAMA_LOCAL',
      state: 'terminal',
      resultState: 'failed',
      cancelled: false,
      blockedOn: null,
      route: { tier: 'OLLAMA_LOCAL', ruleId: 'LOCAL_INTENT', score: 10, overridable: false, safetyLock: null, profile: null, reason: null, humanReason: null, blockedAlternatives: null, routerReason: null },
      cost: { budgetLimit: null, budgetSource: null, costUsd: 0, costSource: null, costEnforceable: null },
      execution: { elapsedMs: 10, iterations: 1, memoryUsed: false, contextChars: null },
      toolsCalled: [],
      approvals: [],
      evidence: { startSeq: 1, endSeq: 2 },
      errorClass: null,
      error: 'boom',
      redactionReport: { redactorVersion: 1, patternsHit: { 'api-key': 1 }, fieldsOmitted: ['taskPrompt', 'assembledContext', 'events', 'toolCallArgs', 'results', 'approvalArgs'], notice: 'Known secret shapes removed. This export does not and cannot claim to contain no secrets.' },
    };

    it('T-L3 [op#20]: click #1 dispatches exact GET_SAFE_EXPORT; click #2 (after the frame lands) writes EXACTLY renderSafeExportMarkdown(snapshot)', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, { clipboard: { writeText } });

      stream.events = [errorWithChip('r1')];
      render(<TorqTerminal />);

      // Listed BEFORE the raw chip (design §4.2 — preferred action first).
      const initialChip = screen.getByText('copy safe export');
      const rawChip = screen.getByText('copy raw diagnostic (local, unredacted)');
      const position = initialChip.compareDocumentPosition(rawChip);
      expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

      fireEvent.click(initialChip);
      expect(stream.sendCommand).toHaveBeenCalledWith({ action: 'GET_SAFE_EXPORT', taskId: 'r1' });
      // Nothing written yet — click #1 only fetches.
      expect(writeText).toHaveBeenCalledTimes(0);

      // Frame lands (push into stream.events + rerender).
      stream.events = [errorWithChip('r1'), safeExportFrame('r1', { safeExport: fixtureSafeExport })];
      const { rerender } = render(<TorqTerminal />);
      rerender(<TorqTerminal />);

      const readyChip = screen.getByText('copy safe export (ready)');
      await act(async () => {
        fireEvent.click(readyChip);
      });

      const { renderSafeExportMarkdown } = await import('../apps/console/src/components/friendly.js');
      expect(writeText).toHaveBeenCalledWith(renderSafeExportMarkdown(fixtureSafeExport as any));
      expect(writeText).toHaveBeenCalledTimes(1);

      // @ts-expect-error test cleanup of a test-local stub
      delete (navigator as any).clipboard;
    });

    it('T-L3 inert failure texts, not buttons: not-found/too_large/failed', () => {
      // not-found
      {
        stream.events = [errorWithChip('r1'), safeExportFrame('r1', { safeExport: null })];
        const { unmount } = render(<TorqTerminal />);
        const text = screen.getByText('no receipt for this task');
        expect(text.tagName).not.toBe('BUTTON');
        unmount();
        cleanup();
      }
      // too_large
      {
        stream.events = [errorWithChip('r1'), safeExportFrame('r1', { safeExport: null, exportOmitted: { reason: 'too_large' } })];
        const { unmount } = render(<TorqTerminal />);
        const text = screen.getByText('export exceeds the frame size limit — not available');
        expect(text.tagName).not.toBe('BUTTON');
        unmount();
        cleanup();
      }
      // export_failed
      {
        stream.events = [errorWithChip('r1'), safeExportFrame('r1', { safeExport: null, error: 'export_failed' })];
        render(<TorqTerminal />);
        const text = screen.getByText('safe export failed (nothing copied)');
        expect(text.tagName).not.toBe('BUTTON');
      }
    });

    it('T-L3 retryable sendFailed/timeout states', () => {
      // sendFailed
      {
        stream.events = [errorWithChip('r1')];
        stream.sendCommand.mockReturnValueOnce(false);
        render(<TorqTerminal />);
        fireEvent.click(screen.getByText('copy safe export'));
        expect(screen.getByText("couldn't request — try again")).toBeInTheDocument();
        cleanup();
        stream.sendCommand.mockClear();
        stream.sendCommand.mockImplementation(() => true);
      }
      // timeout
      {
        vi.useFakeTimers();
        stream.events = [errorWithChip('r1')];
        render(<TorqTerminal />);
        fireEvent.click(screen.getByText('copy safe export'));
        act(() => {
          vi.advanceTimersByTime(5000);
        });
        expect(screen.getByText('no response — try again')).toBeInTheDocument();
        vi.useRealTimers();
      }
    });

    it('T-L4 [op#21] payload purity: existing APPROVE_TOOL dispatch shape untouched by the new wiring', () => {
      stream.events = [
        ev({ type: 'PENDING_APPROVAL', requestId: 'r1', metadata: { approvalId: 'appr-1', toolName: 'filesystem__write_file', args: { path: '/x' } } }),
      ];
      render(<TorqTerminal />);
      fireEvent.click(screen.getByText('Allow once'));
      expect(stream.sendCommand).toHaveBeenCalledWith({ action: 'APPROVE_TOOL', approvalId: 'appr-1', decision: 'APPROVE' });
      expect(stream.sendCommand).toHaveBeenCalledTimes(1);
    });
  });

  describe('E. cancel', () => {
    it('happy path: stop dispatches CANCEL_TASK and flips to "stopping"', () => {
      stream.events = [tierSelected('r1', diagA), toolCall('r1')];
      render(<TorqTerminal />);

      const stopBtn = screen.getByText('stop'); // anti-vacuous presence guard
      fireEvent.click(stopBtn);

      expect(stream.sendCommand).toHaveBeenCalledWith({ action: 'CANCEL_TASK', taskId: 'r1' });
      // NOTE: taskId 'r1' is not a UUID; commands.ts:43 declares z.uuid(), but
      // the MOCKED sendCommand (vi.fn) never runs schema validation, so 'r1'
      // is fine here. Do NOT swap in the real useGatewayStream (it validates
      // AND opens a WebSocket).
      expect(screen.getByText('stopping')).toBeInTheDocument();
    });

    it('send-dropped: sendCommand returning false flips to "failed" feedback', () => {
      stream.events = [tierSelected('r1', diagA), toolCall('r1')];
      stream.sendCommand.mockReturnValueOnce(false); // one-shot drop, not a blanket mockReturnValue
      render(<TorqTerminal />);

      const stopBtn = screen.getByText('stop');
      fireEvent.click(stopBtn);

      expect(screen.getByText(/couldn.t send stop/)).toBeInTheDocument();
    });

    it('negative: no stop button while paused for approval (busy excludes PENDING_APPROVAL)', () => {
      stream.events = [tierSelected('r1', diagA), ev({ type: 'PENDING_APPROVAL', requestId: 'r1', metadata: { approvalId: 'a1' } })];
      render(<TorqTerminal />);

      // Documents: a task paused for approval shows no stop button.
      expect(screen.queryByText('stop')).not.toBeInTheDocument();
      // Do NOT test the null-activeRequestId branch (:213-217) — it is not
      // constructible through the live UI (busy requires events that also
      // set the activeRequestId anchor), so there is no way to reach `stop()`
      // with activeRequestId null via a real click path.
    });
  });

  describe('F. Approval Card v2 gate facts', () => {
    function toolApproval(gate: unknown, overrides: Record<string, unknown> = {}): GatewayEvent {
      const metadata: Record<string, unknown> = {
        approvalId: 'appr-1',
        toolName: 'filesystem__write_file',
        args: { path: '/x' },
        ...overrides,
      };
      if (gate !== undefined) metadata.gate = gate;
      return ev({ type: 'PENDING_APPROVAL', requestId: 'r1', metadata });
    }

    it('F1. gate ABSENT (pre-5A-1 backlog compat) -> card renders, no "unclassified", no heuristic caption', () => {
      stream.events = [toolApproval(undefined)];
      render(<TorqTerminal />);

      expect(screen.getByText('Allow once')).toBeInTheDocument(); // anti-vacuous
      expect(screen.queryByText(/unclassified/)).not.toBeInTheDocument();
      expect(screen.queryByText(/path heuristic/)).not.toBeInTheDocument();
      expect(screen.queryByText('may touch')).not.toBeInTheDocument();
    });

    it('F1b. gate:null -> card renders (no crash), no gate section', () => {
      stream.events = [toolApproval(null)];
      expect(() => render(<TorqTerminal />)).not.toThrow();

      expect(screen.getByText('Allow once')).toBeInTheDocument();
      expect(screen.queryByText(/unclassified/)).not.toBeInTheDocument();
      expect(screen.queryByText('may touch')).not.toBeInTheDocument();
    });

    it('F2. hit write-class (write/fs//tmp/x) -> all rows + caption; "unclassified" absent', () => {
      stream.events = [toolApproval({
        targets: ['/tmp/x'], targetsSource: 'path-heuristic',
        capability: 'write', sourceServerId: 'fs', rule: 'write-class-capability',
      })];
      render(<TorqTerminal />);

      expect(screen.getByText('Allow once')).toBeInTheDocument();
      expect(screen.getByText('write')).toBeInTheDocument();
      expect(screen.getByText('write-class capability')).toBeInTheDocument();
      expect(screen.getByText('fs')).toBeInTheDocument();
      expect(screen.getByText('/tmp/x')).toBeInTheDocument();
      expect(screen.getByText('"may touch" is a path heuristic over the proposed arguments — not verified.')).toBeInTheDocument();
      expect(screen.queryByText(/unclassified/)).not.toBeInTheDocument();
    });

    it('F3. hit approval-pattern with capability:read -> "read" shown (genuine hit), pattern line', () => {
      stream.events = [toolApproval({
        targets: [], targetsSource: 'path-heuristic',
        capability: 'read', sourceServerId: 'fs', rule: 'approval-pattern',
      })];
      render(<TorqTerminal />);

      expect(screen.getByText('Allow once')).toBeInTheDocument();
      expect(screen.getByText('read')).toBeInTheDocument();
      expect(screen.getByText('matched an approval pattern')).toBeInTheDocument();
    });

    it('F4. miss -> EXACT "write-class (unclassified)"; "read" absent; no server/rule rows', () => {
      stream.events = [toolApproval({ targets: ['/tmp/x'], targetsSource: 'path-heuristic' })];
      render(<TorqTerminal />);

      expect(screen.getByText('Allow once')).toBeInTheDocument();
      expect(screen.getByText('write-class (unclassified)')).toBeInTheDocument();
      expect(screen.queryByText('read')).not.toBeInTheDocument();
      expect(screen.queryByText('matched an approval pattern')).not.toBeInTheDocument();
      expect(screen.queryByText('write-class capability')).not.toBeInTheDocument();
      expect(screen.queryByText('engine approval hook (frontier tier)')).not.toBeInTheDocument();
    });

    it('F5. frontier -> engine line, NO capability word, "unclassified" ABSENT (the miss/frontier disambiguation tooth)', () => {
      stream.events = [toolApproval({
        targets: ['/tmp/x'], targetsSource: 'path-heuristic', rule: 'engine-approval-hook',
      })];
      render(<TorqTerminal />);

      expect(screen.getByText('Allow once')).toBeInTheDocument();
      expect(screen.getByText('engine approval hook (frontier tier)')).toBeInTheDocument();
      expect(screen.queryByText(/unclassified/)).not.toBeInTheDocument();
      expect(screen.queryByText('write')).not.toBeInTheDocument();
      expect(screen.queryByText('read')).not.toBeInTheDocument();
      expect(screen.queryByText('exec')).not.toBeInTheDocument();
      expect(screen.queryByText('send')).not.toBeInTheDocument();
    });

    it('F6. targets heuristic caption pin; [] -> "none detected"; targets:"nope" -> "none detected" no crash (RC-2); targetsSource:"other" -> raw caption, heuristic sentence absent (RC-6)', () => {
      stream.events = [toolApproval({ targets: [], targetsSource: 'path-heuristic' })];
      const { unmount } = render(<TorqTerminal />);
      expect(screen.getByText('Allow once')).toBeInTheDocument();
      expect(screen.getByText('none detected')).toBeInTheDocument();
      unmount();
      cleanup();
      stream.sendCommand.mockClear();

      stream.events = [toolApproval({ targets: 'nope', targetsSource: 'path-heuristic' })];
      expect(() => render(<TorqTerminal />)).not.toThrow();
      expect(screen.getByText('none detected')).toBeInTheDocument();
      cleanup();
      stream.sendCommand.mockClear();

      stream.events = [toolApproval({ targets: [], targetsSource: 'other-source' })];
      render(<TorqTerminal />);
      expect(screen.getByText('targets source: other-source')).toBeInTheDocument();
      expect(screen.queryByText(/path heuristic/)).not.toBeInTheDocument();
    });

    it('F8. exactly-4 targets -> exactly 2 buttons (Allow once, Deny), no expander', () => {
      stream.events = [toolApproval({
        targets: ['/a', '/b', '/c', '/d'], targetsSource: 'path-heuristic',
        capability: 'write', sourceServerId: 'fs', rule: 'write-class-capability',
      })];
      render(<TorqTerminal />);

      const card = screen.getByText('Allow once').closest('div.rounded')!;
      const buttons = within(card).getAllByRole('button');
      expect(buttons).toHaveLength(2);
      expect(screen.queryByText(/show all/)).not.toBeInTheDocument();
    });

    it('F8b. exactly-5 targets -> exactly 3 buttons; clicking "show all (5)" dispatches NOTHING and reveals all paths', () => {
      stream.events = [toolApproval({
        targets: ['/a', '/b', '/c', '/d', '/e'], targetsSource: 'path-heuristic',
        capability: 'write', sourceServerId: 'fs', rule: 'write-class-capability',
      })];
      render(<TorqTerminal />);

      const card = screen.getByText('Allow once').closest('div.rounded')!;
      const buttons = within(card).getAllByRole('button');
      expect(buttons).toHaveLength(3);

      const beforeCalls = stream.sendCommand.mock.calls.length;
      fireEvent.click(screen.getByText('show all (5)'));
      expect(stream.sendCommand.mock.calls.length).toBe(beforeCalls); // dispatches nothing

      // All paths now revealed — the inline truncated list (still 4 shown by
      // slice semantics is superseded once expanded) plus the full-path
      // expanded block both render '/e'; assert at least one, not exactly one.
      expect(screen.getAllByText('/e').length).toBeGreaterThanOrEqual(1);
    });

    it('F9. Allow with gate present -> exact APPROVE_TOOL arg, not.toHaveProperty gate/targets, calledTimes(1), dedup badge', () => {
      stream.events = [toolApproval({
        targets: ['/tmp/x'], targetsSource: 'path-heuristic',
        capability: 'write', sourceServerId: 'fs', rule: 'write-class-capability',
      })];
      render(<TorqTerminal />);

      fireEvent.click(screen.getByText('Allow once'));

      const arg = stream.sendCommand.mock.calls[0][0];
      expect(arg).toEqual({ action: 'APPROVE_TOOL', approvalId: 'appr-1', decision: 'APPROVE' });
      expect(arg).not.toHaveProperty('gate');
      expect(arg).not.toHaveProperty('targets');
      expect(stream.sendCommand).toHaveBeenCalledTimes(1);
      expect(screen.getByText('✓ allowed once')).toBeInTheDocument();
    });

    it('F10. post-decision remnant shows no "may touch"/"write-class"/capability words', () => {
      stream.events = [toolApproval({
        targets: ['/tmp/x'], targetsSource: 'path-heuristic',
        capability: 'write', sourceServerId: 'fs', rule: 'write-class-capability',
      })];
      render(<TorqTerminal />);

      fireEvent.click(screen.getByText('Allow once'));

      expect(screen.getByText('✓ allowed once')).toBeInTheDocument();
      expect(screen.queryByText('may touch')).not.toBeInTheDocument();
      expect(screen.queryByText(/write-class/)).not.toBeInTheDocument();
      expect(screen.queryByText('write')).not.toBeInTheDocument();
    });

    it('F11. overflow smoke: 300-char toolName + long targets present in DOM', () => {
      const longName = 'server__' + 'x'.repeat(292);
      const longPath = '/very/long/path/' + 'y'.repeat(100) + '/file.txt';
      stream.events = [toolApproval(
        { targets: [longPath], targetsSource: 'path-heuristic', capability: 'write', sourceServerId: 'fs', rule: 'write-class-capability' },
        { toolName: longName },
      )];
      render(<TorqTerminal />);

      expect(screen.getByText('Allow once')).toBeInTheDocument();
      expect(screen.getByText(longName)).toBeInTheDocument();
      // the target path is middle-truncated in visible text but the full path
      // must survive in the title attribute (no silent drop).
      const truncated = screen.getByTitle(longPath);
      expect(truncated).toBeInTheDocument();
    });
  });

  describe('Triple-stack smoke (SC-3): approvals open while receipts open, both mounted, no coordination', () => {
    it('receipts panel and approvals panel can both be open simultaneously', () => {
      stream.events = [];
      render(<TorqTerminal />);

      fireEvent.click(screen.getByText('receipts'));
      fireEvent.click(screen.getByText('approvals'));

      expect(screen.getByText('Receipts')).toBeInTheDocument();
      expect(screen.getByText('Approval History')).toBeInTheDocument();
    });
  });
});
