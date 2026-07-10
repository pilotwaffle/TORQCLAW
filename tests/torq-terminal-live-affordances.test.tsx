// @vitest-environment jsdom
// LIVE-vs-REPLAY boundary: QA-1 proves replay rows dispatch nothing; QA-2
// proves live rows dispatch the correct command. The SAME dangerous event
// shapes fed here are proven INERT in the ReceiptsPanel replay by
// tests/receipts-panel.test.tsx (test 2, the structural zero-button
// assertion) — do not duplicate that half here.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
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

      // Deny wires onDecide(queueId,'REJECT') with no text (:741); :226 only
      // attaches editedMarkdown on APPROVE. Exact toHaveBeenCalledWith proves
      // the edited text is NOT leaked into the REJECT payload.
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

    it('copy diagnostic writes to the clipboard and does NOT dispatch sendCommand (the one inert recovery chip)', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, { clipboard: { writeText } });

      stream.events = [
        ev({ type: 'ERROR', requestId: 'r1', metadata: { recovery: ['RETRY', 'RETRY_LOCAL', 'RETRY_CLOUD', 'COPY_DIAGNOSTIC'], prompt: 'do it again', suggestedBudget: 2 } }),
      ];
      render(<TorqTerminal />);

      const copyBtn = screen.getByText('copy diagnostic');
      fireEvent.click(copyBtn);

      expect(writeText).toHaveBeenCalledTimes(1);
      expect(stream.sendCommand).toHaveBeenCalledTimes(0);

      // restore — do not leak the clipboard stub into other tests.
      // @ts-expect-error test cleanup of a test-local stub
      delete (navigator as any).clipboard;
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
});
