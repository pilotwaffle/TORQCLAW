// @vitest-environment jsdom
// T-TCLAW-LOCAL-LANE-01-S2: one click on "simulate route" adopts the armed
// automatic estimate (same draft + controls) instead of racing it into the
// gateway's single-flight latch. Mounts the REAL TorqTerminal via the standard
// mocked useGatewayStream pattern (tests/torq-terminal-cost.test.tsx arms the
// estimate through the 500 ms debounce with fake timers;
// tests/torq-terminal-preview.test.tsx supplies the button/panel accessors).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { GatewayEvent } from '@torqclaw/contracts';

if (typeof Element !== 'undefined' && !Element.prototype.scrollTo) {
  Element.prototype.scrollTo = function scrollTo() {};
}

const stream: {
  events: GatewayEvent[];
  isConnected: boolean;
  sendCommand: ReturnType<typeof vi.fn>;
  reconnect: ReturnType<typeof vi.fn>;
} = {
  events: [],
  isConnected: true,
  sendCommand: vi.fn(() => true),
  reconnect: vi.fn(),
};
vi.mock('../apps/console/src/components/useGatewayStream.js', () => ({
  useGatewayStream: () => stream,
}));

import TorqTerminal from '../apps/console/src/components/TorqTerminal.js';

const INPUT_LABEL = 'Describe your task';
const CAVEAT = 'Preview only. Enrichment and route may change when you submit.';
const PENDING = 'previewing…';
const TIMEOUT_TEXT = 'No preview available — try again.';
const DROPPED_RE = /Another preview is still running — try again in a moment\./i;
// 500 ms = the setDebouncedInput debounce in TorqTerminal.tsx (the estimate
// effect keys on debouncedInput). Advancing exactly this far arms the estimate.
const DEBOUNCE_MS = 500;
const PREVIEW_TIMEOUT_MS = 5000;

afterEach(() => {
  cleanup();
  stream.events = [];
  stream.sendCommand.mockClear();
  stream.sendCommand.mockImplementation(() => true);
  vi.useRealTimers();
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
function previewResultFrame(nonce: string): GatewayEvent {
  return ev({
    type: 'SYSTEM',
    message: 'Route preview',
    metadata: {
      routePreview: true,
      previewOf: nonce,
      diagnostics: { score: 10, reason: 'a', tier: 'OLLAMA_LOCAL', ruleId: 'LOCAL_INTENT', overridable: false, humanReason: 'Recognized as a local-machine task' },
      taskType: 'SUMMARIZATION',
      requiredTools: [],
      contextSize: 42,
      enrichment: { classifierUsed: 'LOCAL_LLM', classifierConfidence: 0.9, classifierLatencyMs: 5, estimatedTokens: 100, memoryUsed: true },
      prompt: 'hello',
    },
  });
}
// The gateway single-flight latch's drop frame (packages/gateway/src/preview.ts).
function previewDroppedFrame(nonce: string): GatewayEvent {
  return ev({
    type: 'SYSTEM',
    message: 'Route preview dropped',
    metadata: { routePreview: true, previewOf: nonce, dropped: 'in_flight' },
  });
}
function previewCalls(): Array<{ previewOf: string; prompt: string }> {
  return stream.sendCommand.mock.calls
    .map(([c]) => c)
    .filter((c: any) => c.action === 'PREVIEW_ROUTE');
}
function getInput(): HTMLElement {
  return screen.getByLabelText(INPUT_LABEL);
}
function getButton(): HTMLElement {
  return screen.getByRole('button', { name: 'simulate route' });
}
function getPanel(): HTMLElement {
  return screen.getByText(CAVEAT).closest('div')!;
}
function getFastCheckbox(): HTMLElement {
  return screen.getByRole('checkbox', { name: /fast/i });
}

describe('TorqTerminal — simulate route adopts the armed estimate (T-TCLAW-LOCAL-LANE-01-S2)', () => {
  it('simulate_adopts_in_flight_estimate_without_second_command', () => {
    vi.useFakeTimers();
    const { rerender } = render(<TorqTerminal />);

    // Draft settles -> the automatic estimate sends exactly one PREVIEW_ROUTE.
    fireEvent.change(getInput(), { target: { value: 'summarize this file' } });
    act(() => { vi.advanceTimersByTime(DEBOUNCE_MS); });
    expect(previewCalls()).toHaveLength(1);
    const estimateNonce = previewCalls()[0]!.previewOf;

    // Click while the estimate is in flight: NO second PREVIEW_ROUTE; the
    // manual panel is pending on the adopted nonce.
    fireEvent.click(getButton());
    expect(previewCalls()).toHaveLength(1);
    expect(screen.getByText(PENDING)).toBeInTheDocument();

    // The estimate frame (previewOf = the estimate nonce) resolves the manual
    // panel to a result — not a drop, not a timeout.
    stream.events = [previewResultFrame(estimateNonce)];
    rerender(<TorqTerminal />);
    const panel = getPanel();
    expect(within(panel).getByText(/on this machine/i)).toBeInTheDocument();
    expect(within(panel).queryByText(DROPPED_RE)).not.toBeInTheDocument();
    expect(screen.queryByText(TIMEOUT_TEXT)).not.toBeInTheDocument();

    // The 5 s timer was cleared by the frame: advancing past it never flips
    // the resolved panel to "No preview available".
    act(() => { vi.advanceTimersByTime(PREVIEW_TIMEOUT_MS); });
    expect(screen.queryByText(TIMEOUT_TEXT)).not.toBeInTheDocument();
    expect(within(getPanel()).getByText(/on this machine/i)).toBeInTheDocument();

    // Clarification A: a repeat click while the same estimate is still armed
    // adopts the same nonce again, sends nothing, and the panel still shows
    // the estimate's result (never stuck pending, never a timeout).
    fireEvent.click(getButton());
    expect(previewCalls()).toHaveLength(1);
    expect(screen.queryByText(PENDING)).not.toBeInTheDocument();
    expect(within(getPanel()).getByText(/on this machine/i)).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(PREVIEW_TIMEOUT_MS); });
    expect(screen.queryByText(TIMEOUT_TEXT)).not.toBeInTheDocument();
  });

  it('simulate_sends_when_no_estimate_armed', () => {
    // (a) click BEFORE the debounce settles: no estimate armed -> the click
    // sends its own PREVIEW_ROUTE, exactly as before this slice.
    vi.useFakeTimers();
    const first = render(<TorqTerminal />);
    fireEvent.change(getInput(), { target: { value: 'summarize this file' } });
    act(() => { vi.advanceTimersByTime(DEBOUNCE_MS - 1); });
    expect(previewCalls()).toHaveLength(0);
    fireEvent.click(getButton());
    expect(previewCalls()).toHaveLength(1);
    expect(typeof previewCalls()[0]!.previewOf).toBe('string');
    expect(screen.getByText(PENDING)).toBeInTheDocument();
    first.unmount();
    cleanup();
    stream.sendCommand.mockClear();

    // (b) the estimate's own send was dropped (sendCommand returned false):
    // nothing is armed -> the click sends its own PREVIEW_ROUTE with a nonce
    // different from the estimate's attempted nonce.
    render(<TorqTerminal />);
    fireEvent.change(getInput(), { target: { value: 'summarize this file' } });
    stream.sendCommand.mockImplementationOnce(() => false); // consumed by the estimate send
    act(() => { vi.advanceTimersByTime(DEBOUNCE_MS); });
    expect(previewCalls()).toHaveLength(1); // the estimate was attempted and dropped
    const attemptedEstimateNonce = previewCalls()[0]!.previewOf;
    fireEvent.click(getButton());
    expect(previewCalls()).toHaveLength(2);
    expect(previewCalls()[1]!.previewOf).not.toBe(attemptedEstimateNonce);
    expect(screen.getByText(PENDING)).toBeInTheDocument();
  });

  it('simulate_after_draft_change_sends_fresh_command', () => {
    vi.useFakeTimers();
    const { rerender } = render(<TorqTerminal />);

    // Estimate armed and adopted by the first click (one PREVIEW_ROUTE total).
    fireEvent.change(getInput(), { target: { value: 'first draft' } });
    act(() => { vi.advanceTimersByTime(DEBOUNCE_MS); });
    expect(previewCalls()).toHaveLength(1);
    const estimateNonce = previewCalls()[0]!.previewOf;
    fireEvent.click(getButton());
    expect(previewCalls()).toHaveLength(1);

    // Type again and click immediately (debounce not settled): the edited
    // draft has no estimate, so the click sends a fresh PREVIEW_ROUTE.
    fireEvent.change(getInput(), { target: { value: 'first draft, but longer' } });
    fireEvent.click(getButton());
    expect(previewCalls()).toHaveLength(2);
    const freshNonce = previewCalls()[1]!.previewOf;
    expect(freshNonce).not.toBe(estimateNonce);
    expect(screen.getByText(PENDING)).toBeInTheDocument();

    // The OLD estimate frame is never rendered in the panel: it belongs to a
    // draft that is no longer in the box.
    stream.events = [previewResultFrame(estimateNonce)];
    rerender(<TorqTerminal />);
    expect(within(getPanel()).getByText(PENDING)).toBeInTheDocument();
    expect(within(getPanel()).queryByText(/on this machine/i)).not.toBeInTheDocument();

    // The fresh frame resolves it.
    stream.events = [previewResultFrame(estimateNonce), previewResultFrame(freshNonce)];
    rerender(<TorqTerminal />);
    expect(within(getPanel()).getByText(/on this machine/i)).toBeInTheDocument();
  });

  it('simulate_resends_when_armed_estimate_was_dropped', () => {
    // PRD amendment 1 (revised Clarification B): an armed estimate whose frame
    // already came back `dropped` is NOT adoptable — the click takes the
    // no-estimate path (fresh nonce, its own PREVIEW_ROUTE) so the panel can
    // recover without the operator editing the draft.

    // (a) The PRD's literal sequence: estimate armed -> its frame arrives
    // dropped (no click yet) -> click -> one more PREVIEW_ROUTE, nonce ≠ the
    // estimate nonce, panel pending.
    vi.useFakeTimers();
    const first = render(<TorqTerminal />);
    fireEvent.change(getInput(), { target: { value: 'summarize this file' } });
    act(() => { vi.advanceTimersByTime(DEBOUNCE_MS); });
    expect(previewCalls()).toHaveLength(1);
    const droppedEstimateNonce = previewCalls()[0]!.previewOf;
    stream.events = [previewDroppedFrame(droppedEstimateNonce)];
    first.rerender(<TorqTerminal />);
    expect(screen.queryByText(DROPPED_RE)).not.toBeInTheDocument(); // no click yet: no manual panel
    fireEvent.click(getButton());
    expect(previewCalls()).toHaveLength(2);
    const freshNonceA = previewCalls()[1]!.previewOf;
    expect(freshNonceA).not.toBe(droppedEstimateNonce);
    expect(screen.getByText(PENDING)).toBeInTheDocument();
    expect(screen.queryByText(DROPPED_RE)).not.toBeInTheDocument();
    stream.events = [previewDroppedFrame(droppedEstimateNonce), previewResultFrame(freshNonceA)];
    first.rerender(<TorqTerminal />);
    expect(within(getPanel()).getByText(/on this machine/i)).toBeInTheDocument();
    first.unmount();
    cleanup();
    stream.events = [];
    stream.sendCommand.mockClear();

    // (b) The live R-1 sequence: estimate armed -> click adopts it (no second
    // send) -> the adopted frame arrives dropped -> the panel shows the honest
    // drop (Clarification B, unchanged text) -> click again -> a fresh
    // PREVIEW_ROUTE is sent, the drop text is gone, the panel is pending, and
    // the fresh frame resolves it.
    const second = render(<TorqTerminal />);
    fireEvent.change(getInput(), { target: { value: 'summarize this file' } });
    act(() => { vi.advanceTimersByTime(DEBOUNCE_MS); });
    expect(previewCalls()).toHaveLength(1);
    const adoptedNonce = previewCalls()[0]!.previewOf;
    fireEvent.click(getButton());
    expect(previewCalls()).toHaveLength(1); // adopted, nothing sent
    expect(screen.getByText(PENDING)).toBeInTheDocument();
    stream.events = [previewDroppedFrame(adoptedNonce)];
    second.rerender(<TorqTerminal />);
    expect(within(getPanel()).getByText(DROPPED_RE)).toBeInTheDocument();
    expect(screen.queryByText(PENDING)).not.toBeInTheDocument();
    fireEvent.click(getButton());
    expect(previewCalls()).toHaveLength(2);
    const freshNonceB = previewCalls()[1]!.previewOf;
    expect(freshNonceB).not.toBe(adoptedNonce);
    expect(screen.getByText(PENDING)).toBeInTheDocument();
    expect(screen.queryByText(DROPPED_RE)).not.toBeInTheDocument();
    stream.events = [previewDroppedFrame(adoptedNonce), previewResultFrame(freshNonceB)];
    second.rerender(<TorqTerminal />);
    expect(within(getPanel()).getByText(/on this machine/i)).toBeInTheDocument();
    expect(within(getPanel()).queryByText(DROPPED_RE)).not.toBeInTheDocument();
  });

  it('simulate_after_controls_change_with_failed_reestimate_sends_fresh', () => {
    // G1R blocker #1: a controls change makes the estimate effect attempt a
    // replacement PREVIEW_ROUTE for the new controls. If that send fails, the
    // OLD estimate (sized for the previous controls) must not stay armed, so
    // the click must send its own fresh command rather than adopting it.
    vi.useFakeTimers();
    const { rerender } = render(<TorqTerminal />);

    // Estimate A armed for the settled draft with the default controls.
    fireEvent.change(getInput(), { target: { value: 'summarize this file' } });
    act(() => { vi.advanceTimersByTime(DEBOUNCE_MS); });
    expect(previewCalls()).toHaveLength(1);
    const estimateA = previewCalls()[0]!.previewOf;

    // Controls change (toggle "fast"): the replacement estimate B is attempted
    // and its send fails.
    stream.sendCommand.mockImplementationOnce(() => false); // consumed by the re-estimate send
    fireEvent.click(getFastCheckbox());
    expect(previewCalls()).toHaveLength(2);
    const estimateB = previewCalls()[1]!.previewOf;
    expect(estimateB).not.toBe(estimateA);

    // Click: nothing adoptable (A is for the old controls, B was never sent)
    // -> a fresh PREVIEW_ROUTE with its own nonce, panel pending.
    fireEvent.click(getButton());
    expect(previewCalls()).toHaveLength(3);
    const freshNonce = previewCalls()[2]!.previewOf;
    expect(freshNonce).not.toBe(estimateA);
    expect(freshNonce).not.toBe(estimateB);
    expect(screen.getByText(PENDING)).toBeInTheDocument();

    // A's frame (old controls) is never rendered in the panel.
    stream.events = [previewResultFrame(estimateA)];
    rerender(<TorqTerminal />);
    expect(within(getPanel()).getByText(PENDING)).toBeInTheDocument();
    expect(within(getPanel()).queryByText(/on this machine/i)).not.toBeInTheDocument();

    // The fresh frame resolves it.
    stream.events = [previewResultFrame(estimateA), previewResultFrame(freshNonce)];
    rerender(<TorqTerminal />);
    expect(within(getPanel()).getByText(/on this machine/i)).toBeInTheDocument();
  });

  it('simulate_uses_current_draft_after_control_change_during_debounce', () => {
    vi.useFakeTimers();
    const { rerender } = render(<TorqTerminal />);
    fireEvent.change(getInput(), { target: { value: 'old draft' } });
    act(() => { vi.advanceTimersByTime(DEBOUNCE_MS); });
    fireEvent.change(getInput(), { target: { value: 'current draft' } });
    fireEvent.click(getFastCheckbox());
    // The control effect can send an estimate for the previous debounced text.
    expect(previewCalls()).toHaveLength(2);
    expect(previewCalls()[1]!.prompt).toBe('old draft');
    const staleNonce = previewCalls()[1]!.previewOf;
    fireEvent.click(getButton());
    expect(previewCalls()).toHaveLength(3);
    expect(previewCalls()[2]!.prompt).toBe('current draft');
    const freshNonce = previewCalls()[2]!.previewOf;
    expect(freshNonce).not.toBe(staleNonce);
    stream.events = [previewResultFrame(staleNonce)];
    rerender(<TorqTerminal />);
    expect(within(getPanel()).getByText(PENDING)).toBeInTheDocument();
    stream.events = [...stream.events, previewResultFrame(freshNonce)];
    rerender(<TorqTerminal />);
    expect(within(getPanel()).getByText(/on this machine/i)).toBeInTheDocument();
  });

  it('simulate_retries_with_fresh_nonce_after_adopted_estimate_timeout', () => {
    vi.useFakeTimers();
    const { rerender } = render(<TorqTerminal />);
    fireEvent.change(getInput(), { target: { value: 'summarize this file' } });
    act(() => { vi.advanceTimersByTime(DEBOUNCE_MS); });
    const estimateNonce = previewCalls()[0]!.previewOf;
    fireEvent.click(getButton());
    expect(previewCalls()).toHaveLength(1);
    act(() => { vi.advanceTimersByTime(PREVIEW_TIMEOUT_MS); });
    expect(screen.getByText(TIMEOUT_TEXT)).toBeInTheDocument();
    fireEvent.click(getButton());
    expect(previewCalls()).toHaveLength(2);
    const freshNonce = previewCalls()[1]!.previewOf;
    expect(freshNonce).not.toBe(estimateNonce);
    stream.events = [previewResultFrame(estimateNonce)];
    rerender(<TorqTerminal />);
    expect(within(getPanel()).getByText(PENDING)).toBeInTheDocument();
    stream.events = [...stream.events, previewResultFrame(freshNonce)];
    rerender(<TorqTerminal />);
    expect(within(getPanel()).getByText(/on this machine/i)).toBeInTheDocument();
  });
});
