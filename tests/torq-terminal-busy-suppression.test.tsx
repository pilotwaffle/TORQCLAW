// @vitest-environment jsdom
// TCLAW-UIFIX-1: shared SYSTEM-frame predicates for busy/suppression.
// Header cross-reference: tests/torq-terminal-preview.test.tsx test 8 (the
// three RC-1 busy cases: [RESULT,preview]->not busy; [TIER_SELECTED,
// TOOL_CALL,preview]->busy; [preview] alone->not busy) is the untouched
// compatibility witness — those cases must keep holding unmodified under the
// new skip-ALL-SYSTEM busy scan, since routePreview is one instance of the
// general SYSTEM-frame class this ticket covers.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { GatewayEvent } from '@torqclaw/contracts';

// jsdom does not implement Element.prototype.scrollTo (TorqTerminal.tsx calls
// scrollRef.current?.scrollTo(...) in a mount effect to auto-scroll the event
// log). This is a jsdom environment gap, not a product bug — polyfill it here
// rather than touch TorqTerminal source.
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
  cleanup(); // LOAD-BEARING (G1R RC-4, mirrored from preview test): root config has no globals:true.
  stream.events = [];
  stream.sendCommand.mockClear();
  stream.sendCommand.mockImplementation(() => true);
  vi.useRealTimers();
  // TorqTerminal persists `controls` to sessionStorage (torqclaw.controls);
  // jsdom's sessionStorage otherwise leaks control state across test cases.
  sessionStorage.clear();
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

function tierSelected(requestId: string): GatewayEvent {
  return ev({
    type: 'TIER_SELECTED',
    requestId,
    tier: 'OLLAMA_LOCAL',
    message: 'routed',
    metadata: { score: 10, reason: 'a', tier: 'OLLAMA_LOCAL', ruleId: 'LOCAL_INTENT', overridable: false },
  });
}
function toolCall(requestId: string): GatewayEvent {
  return ev({ type: 'TOOL_CALL', requestId, message: 'Executing filesystem__read_file' });
}
function resultFrame(requestId: string): GatewayEvent {
  return ev({ type: 'RESULT', requestId, message: 'done' });
}

// ── Frame fixture builders (mirror the real emission shapes) ──────────────

/** dispatch.ts:230-233 tail: RESULT then SYSTEM 'Done' carrying the receipt —
 *  the LAST event of EVERY completed task. Persisted. Renders ReceiptCard. */
function doneReceipt(requestId = 'A'): GatewayEvent {
  return ev({
    type: 'SYSTEM',
    requestId,
    message: 'Done',
    metadata: { receipt: { taskId: requestId, tier: 'API_EXTERNAL', costUsd: 0.01, elapsedMs: 500 } },
  });
}
/** server.ts:204-215 via makeEmitter — PERSISTED, seq-bearing, backlog-replayed. */
function memoryShow(): GatewayEvent {
  return ev({
    type: 'SYSTEM',
    message: 'Memory: 2 episode(s) this session',
    metadata: { memory: 'SHOW', episodes: [] },
  });
}
function memoryForget(): GatewayEvent {
  return ev({
    type: 'SYSTEM',
    message: 'Memory: forgot this session',
    metadata: { memory: 'FORGET_SESSION', forgotten: 2 },
  });
}
function receiptListFrame(): GatewayEvent {
  return ev({ type: 'SYSTEM', message: 'Receipts', metadata: { receiptList: true, items: [] } });
}
function receiptViewFrame(receipt: unknown = null): GatewayEvent {
  return ev({ type: 'SYSTEM', message: 'Receipt', metadata: { receiptView: true, receipt } });
}
function costSummaryFrame(): GatewayEvent {
  return ev({ type: 'SYSTEM', message: 'Cost summary', metadata: { costSummary: true } });
}
function previewFrame(): GatewayEvent {
  return ev({ type: 'SYSTEM', message: 'Route preview', metadata: { routePreview: true, previewOf: 'n1' } });
}
/** server.ts:152-155 skill confirm — no metadata at all. */
function markerlessSystem(): GatewayEvent {
  return ev({ type: 'SYSTEM', message: 'Skill q1: APPROVE' });
}
/** RC-3: a raw-relayed engine SYSTEM frame with unknown metadata shape —
 *  proves skip-ALL-SYSTEM, not skip-known-markers-only. */
function arbitrarySystem(): GatewayEvent {
  return ev({ type: 'SYSTEM', message: 'x', metadata: { someUnknownKey: true } });
}

describe('TorqTerminal busy/suppression (TCLAW-UIFIX-1)', () => {
  it('1. MANDATORY Done-receipt production order (dispatch.ts:230-233 exact tail) -> NOT busy, no stop', () => {
    stream.events = [tierSelected('A'), toolCall('A'), resultFrame('A'), doneReceipt('A')];
    render(<TorqTerminal />);

    expect(screen.queryByText('working…')).not.toBeInTheDocument();
    expect(screen.queryByText('stop')).not.toBeInTheDocument();
  });

  it('2. preview frame alone -> not busy (regression cover of 2D-2 8c under the new predicate)', () => {
    stream.events = [previewFrame()];
    render(<TorqTerminal />);

    expect(screen.queryByText('working…')).not.toBeInTheDocument();
    expect(screen.queryByText('stop')).not.toBeInTheDocument();
  });

  it('3. [RESULT, receiptListFrame] and [RESULT, receiptViewFrame] (receipt:null and full) -> not busy', () => {
    stream.events = [resultFrame('A'), receiptListFrame()];
    const { unmount: u1 } = render(<TorqTerminal />);
    expect(screen.queryByText('working…')).not.toBeInTheDocument();
    u1();
    cleanup();

    stream.events = [resultFrame('A'), receiptViewFrame(null)];
    const { unmount: u2 } = render(<TorqTerminal />);
    expect(screen.queryByText('working…')).not.toBeInTheDocument();
    u2();
    cleanup();

    stream.events = [resultFrame('A'), receiptViewFrame({ taskId: 'A', tier: 'OLLAMA_LOCAL' })];
    render(<TorqTerminal />);
    expect(screen.queryByText('working…')).not.toBeInTheDocument();
  });

  it('4. [RESULT, costSummaryFrame] -> not busy', () => {
    stream.events = [resultFrame('A'), costSummaryFrame()];
    render(<TorqTerminal />);

    expect(screen.queryByText('working…')).not.toBeInTheDocument();
  });

  it('5. [RESULT, memoryShow] -> not busy AND the memory message stays VISIBLE; same for memoryForget (busy only)', () => {
    stream.events = [resultFrame('A'), memoryShow()];
    const { unmount } = render(<TorqTerminal />);
    expect(screen.queryByText('working…')).not.toBeInTheDocument();
    expect(screen.getByText('Memory: 2 episode(s) this session')).toBeInTheDocument();
    unmount();
    cleanup();

    stream.events = [resultFrame('A'), memoryForget()];
    render(<TorqTerminal />);
    expect(screen.queryByText('working…')).not.toBeInTheDocument();
  });

  it('6. [RESULT, markerlessSystem] -> not busy. [RESULT, arbitrarySystem] -> not busy', () => {
    stream.events = [resultFrame('A'), markerlessSystem()];
    const { unmount } = render(<TorqTerminal />);
    expect(screen.queryByText('working…')).not.toBeInTheDocument();
    unmount();
    cleanup();

    stream.events = [resultFrame('A'), arbitrarySystem()];
    render(<TorqTerminal />);
    expect(screen.queryByText('working…')).not.toBeInTheDocument();
  });

  it('7. RC-3 raw-relay pin: [tierSelected, toolCall, arbitrarySystem] -> busy TRUE, stop PRESENT (skip-ALL, not skip-known-markers)', () => {
    stream.events = [tierSelected('A'), toolCall('A'), arbitrarySystem()];
    render(<TorqTerminal />);

    expect(screen.getByText('working…')).toBeInTheDocument();
    expect(screen.getByText('stop')).toBeInTheDocument();
  });

  it('8a. panel frames render no inline row: receiptList/receiptView/costSummary', () => {
    stream.events = [resultFrame('A'), receiptListFrame()];
    const { unmount: u1 } = render(<TorqTerminal />);
    expect(screen.queryByText('Receipts')).not.toBeInTheDocument();
    u1();
    cleanup();

    stream.events = [resultFrame('A'), receiptViewFrame(null)];
    const { unmount: u2 } = render(<TorqTerminal />);
    expect(screen.queryByText('Receipt')).not.toBeInTheDocument();
    u2();
    cleanup();

    stream.events = [resultFrame('A'), costSummaryFrame()];
    render(<TorqTerminal />);
    expect(screen.queryByText('Cost summary')).not.toBeInTheDocument();
  });

  it('8b. Done-receipt renders the ReceiptCard (rendered content present)', () => {
    stream.events = [tierSelected('A'), toolCall('A'), resultFrame('A'), doneReceipt('A')];
    render(<TorqTerminal />);

    expect(screen.getByText('Done')).toBeInTheDocument();
  });

  it('8c. memory renders its message row', () => {
    stream.events = [resultFrame('A'), memoryShow()];
    render(<TorqTerminal />);

    expect(screen.getByText('Memory: 2 episode(s) this session')).toBeInTheDocument();
  });

  it('9. empty remainder per type: each frame type ALONE -> not busy, no crash (table-driven)', () => {
    const cases: Array<[string, () => GatewayEvent]> = [
      ['doneReceipt', doneReceipt],
      ['memoryShow', memoryShow],
      ['memoryForget', memoryForget],
      ['receiptListFrame', receiptListFrame],
      ['receiptViewFrame', () => receiptViewFrame(null)],
      ['costSummaryFrame', costSummaryFrame],
      ['previewFrame', previewFrame],
      ['markerlessSystem', markerlessSystem],
      ['arbitrarySystem', arbitrarySystem],
    ];
    for (const [, build] of cases) {
      stream.events = [build()];
      const { unmount } = render(<TorqTerminal />);
      expect(screen.queryByText('working…')).not.toBeInTheDocument();
      expect(screen.queryByText('stop')).not.toBeInTheDocument();
      unmount();
      cleanup();
    }
  });

  it('10. PENDING_APPROVAL unchanged: not busy, no stop (mirrors the live-affordances pin; no regression)', () => {
    stream.events = [tierSelected('A'), ev({ type: 'PENDING_APPROVAL', requestId: 'A', metadata: { approvalId: 'a1' } })];
    render(<TorqTerminal />);

    expect(screen.queryByText('working…')).not.toBeInTheDocument();
    expect(screen.queryByText('stop')).not.toBeInTheDocument();
  });

  it('mid-task memory case: [tierSelected, toolCall, memoryShow] -> busy TRUE (the scan lands on TOOL_CALL)', () => {
    stream.events = [tierSelected('A'), toolCall('A'), memoryShow()];
    render(<TorqTerminal />);

    expect(screen.getByText('working…')).toBeInTheDocument();
  });
});
