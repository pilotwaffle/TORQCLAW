// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within, fireEvent, act } from '@testing-library/react';
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
  cleanup(); // LOAD-BEARING (G1R RC-4): root config has no globals:true.
  stream.events = [];
  stream.sendCommand.mockClear();
  stream.sendCommand.mockImplementation(() => true);
  vi.useRealTimers();
  // TorqTerminal persists `controls` to sessionStorage (torqclaw.controls);
  // jsdom's sessionStorage otherwise leaks control state (e.g. the "fast"
  // checkbox toggled in a staleness test) across test cases in this file.
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

function tierSelected(requestId: string, diag: object): GatewayEvent {
  return ev({ type: 'TIER_SELECTED', requestId, tier: (diag as any).tier ?? 'OLLAMA_LOCAL', message: 'routed', metadata: diag });
}
function toolCall(requestId: string): GatewayEvent {
  return ev({ type: 'TOOL_CALL', requestId, message: 'Executing filesystem__read_file' });
}
function terminal(type: 'RESULT' | 'ERROR', requestId: string): GatewayEvent {
  return ev({ type, requestId, message: type === 'RESULT' ? 'done' : 'failed' });
}

const diagA = { score: 10, reason: 'a', tier: 'OLLAMA_LOCAL', ruleId: 'LOCAL_INTENT', overridable: false };

function previewResultFrame(nonce: string, overrides: Partial<Record<string, unknown>> = {}): GatewayEvent {
  return ev({
    type: 'SYSTEM',
    requestId: null,
    tier: null,
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
      ...overrides,
    },
  });
}

function previewDroppedFrame(nonce: string): GatewayEvent {
  return ev({
    type: 'SYSTEM',
    requestId: null,
    tier: null,
    message: 'Route preview dropped — another preview is in flight',
    metadata: { routePreview: true, previewOf: nonce, dropped: 'in_flight' },
  });
}

const CAVEAT = 'Preview only. Enrichment and route may change when you submit.';
const INPUT_LABEL = 'Describe your task';

function getInput(): HTMLElement {
  return screen.getByLabelText(INPUT_LABEL);
}
function getButton(): HTMLElement {
  return screen.getByRole('button', { name: 'simulate route' });
}
/** The preview panel is identified by the caveat text's closest container
 *  div — a stable text marker (no test ids in this codebase's convention). */
function getPanel(): HTMLElement {
  return screen.getByText(CAVEAT).closest('div')!;
}
function queryPanel(): HTMLElement | null {
  const caveat = screen.queryByText(CAVEAT);
  return caveat ? caveat.closest('div') : null;
}
function lastSentNonce(): string {
  const calls = stream.sendCommand.mock.calls;
  const call = calls[calls.length - 1][0] as any;
  return call.previewOf;
}

describe('TorqTerminal route preview composer (TCLAW-2D-2)', () => {
  it('1. button click sends exactly one PREVIEW_ROUTE with the full field-parity shape + fresh nonce per click', () => {
    stream.events = [];
    render(<TorqTerminal />);

    fireEvent.change(getInput(), { target: { value: 'summarize this' } });
    fireEvent.click(getButton());

    expect(stream.sendCommand).toHaveBeenCalledTimes(1);
    const cmd = stream.sendCommand.mock.calls[0][0] as any;
    expect(cmd.action).toBe('PREVIEW_ROUTE');
    expect(cmd.prompt).toBe('summarize this');
    expect(cmd.sensitive).toBe(false);
    expect(cmd.urgent).toBe(false);
    expect(cmd.executionMode).toBe('AUTO');
    expect(cmd.useMemory).toBe(true);
    expect(typeof cmd.previewOf).toBe('string');
    expect(cmd.previewOf.length).toBeGreaterThanOrEqual(1);
    expect(cmd.previewOf.length).toBeLessThanOrEqual(128);
    expect(cmd).not.toHaveProperty('attachmentIds');

    const firstNonce = cmd.previewOf;

    fireEvent.click(getButton());
    expect(stream.sendCommand).toHaveBeenCalledTimes(2);
    const cmd2 = stream.sendCommand.mock.calls[1][0] as any;
    expect(cmd2.previewOf).not.toBe(firstNonce);
  });

  it('2. empty input: button disabled, no PREVIEW_ROUTE dispatched', () => {
    stream.events = [];
    render(<TorqTerminal />);

    const btn = getButton();
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(stream.sendCommand).not.toHaveBeenCalled();
  });

  it('3. frame render: lock state + fidelity fallback + exact caveat pin; "will route" never appears', () => {
    stream.events = [];
    const { rerender } = render(<TorqTerminal />);
    fireEvent.change(getInput(), { target: { value: 'do the thing' } });
    fireEvent.click(getButton());
    const nonce = lastSentNonce();

    stream.events = [
      previewResultFrame(nonce, {
        diagnostics: {
          score: 10, reason: 'a', tier: 'API_EXTERNAL', ruleId: 'HEURISTIC_EVAL',
          overridable: true, humanReason: 'Routed by complexity score',
          blockedAlternatives: [{ tier: 'OLLAMA_LOCAL', why: 'needed several tools' }],
        },
        enrichment: { classifierUsed: 'KEYWORD_FALLBACK', classifierConfidence: 0.4, classifierLatencyMs: 2, estimatedTokens: 50, memoryUsed: true },
      }),
    ];
    rerender(<TorqTerminal />);

    const panel = getPanel();
    expect(within(panel).getByText(/cloud model/i)).toBeInTheDocument(); // tierLabel(API_EXTERNAL).text
    expect(within(panel).getByText(/Router preference — can be overridden/i)).toBeInTheDocument(); // formatLockState output
    expect(within(panel).getByText(/would have used OLLAMA_LOCAL, but: needed several tools/i)).toBeInTheDocument(); // blocked alt row
    expect(within(panel).getByText(/classified by keyword fallback — lower confidence/i)).toBeInTheDocument(); // fallback fidelity label
    expect(within(panel).getByText(CAVEAT)).toBeInTheDocument(); // exact caveat pin
    expect(screen.queryByText(/will route/i)).not.toBeInTheDocument();
  });

  it('4. LOCAL_LLM classifier: NO fallback fidelity row, headline still present (G1R S2)', () => {
    stream.events = [];
    const { rerender } = render(<TorqTerminal />);
    fireEvent.change(getInput(), { target: { value: 'do the thing' } });
    fireEvent.click(getButton());
    const nonce = lastSentNonce();

    stream.events = [previewResultFrame(nonce)]; // default enrichment.classifierUsed = 'LOCAL_LLM'
    rerender(<TorqTerminal />);

    const panel = getPanel();
    expect(within(panel).getByText(/on this machine/i)).toBeInTheDocument(); // headline present (tierLabel OLLAMA_LOCAL)
    expect(within(panel).queryByText(/keyword fallback/i)).not.toBeInTheDocument();
    expect(within(panel).queryByText(/default classification/i)).not.toBeInTheDocument();
  });

  it('5. stale nonce ignored: a frame for a different previewOf is never rendered as the result', () => {
    stream.events = [];
    const { rerender } = render(<TorqTerminal />);
    fireEvent.change(getInput(), { target: { value: 'do the thing' } });
    fireEvent.click(getButton());

    stream.events = [previewResultFrame('other-nonce-entirely')];
    rerender(<TorqTerminal />);

    // Still pending — its result never rendered (nonce mismatch).
    expect(screen.getByText('previewing…')).toBeInTheDocument();
  });

  it('6. dropped honesty (G1R S1): notice-and-done, no tier/why rows, never "no routing record", caveat still present', () => {
    stream.events = [];
    const { rerender } = render(<TorqTerminal />);
    fireEvent.change(getInput(), { target: { value: 'do the thing' } });
    fireEvent.click(getButton());
    const nonce = lastSentNonce();

    stream.events = [previewDroppedFrame(nonce)];
    rerender(<TorqTerminal />);

    const panel = getPanel();
    expect(within(panel).getByText(/Another preview is still running — try again in a moment\./i)).toBeInTheDocument();
    expect(within(panel).queryByText(/no routing record/i)).not.toBeInTheDocument(); // proves formatRouteExplanation(null) never reached
    expect(within(panel).queryByText(/^why:/i)).not.toBeInTheDocument();
    expect(within(panel).getByText(CAVEAT)).toBeInTheDocument();
  });

  it('7. timeout (RC-2, named fake-timer steps): pending -> still pending at 499ms -> "No preview available" at 5000ms total', () => {
    vi.useFakeTimers();
    stream.events = [];
    render(<TorqTerminal />);
    fireEvent.change(getInput(), { target: { value: 'do the thing' } });
    fireEvent.click(getButton());

    expect(screen.getByText('previewing…')).toBeInTheDocument();

    // Step 1: 499ms — the 500ms privacy-hint debounce has not yet fired; harmless, still pending.
    act(() => { vi.advanceTimersByTime(499); });
    expect(screen.getByText('previewing…')).toBeInTheDocument();

    // Step 2: +4501ms (total 5000ms) — the 5s preview timeout fires.
    act(() => { vi.advanceTimersByTime(4501); });
    expect(screen.getByText('No preview available — try again.')).toBeInTheDocument();
  });

  it('8. RC-1 busy: (a) idle w/ preview frame -> no working/stop; (b) mid-task w/ preview frame -> working present; (c) EMPTY-REMAINDER: preview frame ALONE -> no working, no stop', () => {
    // (a) idle: last non-preview event is RESULT -> not busy.
    stream.events = [terminal('RESULT', 'A'), previewResultFrame('n1')];
    const { unmount: unmountA } = render(<TorqTerminal />);
    expect(screen.queryByText('working…')).not.toBeInTheDocument();
    expect(screen.queryByText('stop')).not.toBeInTheDocument();
    unmountA();
    cleanup();

    // (b) mid-task: last non-preview event is TOOL_CALL -> busy.
    stream.events = [tierSelected('A', diagA), toolCall('A'), previewResultFrame('n1')];
    const { unmount: unmountB } = render(<TorqTerminal />);
    expect(screen.getByText('working…')).toBeInTheDocument();
    unmountB();
    cleanup();

    // (c) EMPTY-REMAINDER: the ONLY event is a preview frame (fresh console
    // whose first action is a preview) -> busy must be false, not crash/true.
    stream.events = [previewResultFrame('n1')];
    render(<TorqTerminal />);
    expect(screen.queryByText('working…')).not.toBeInTheDocument();
    expect(screen.queryByText('stop')).not.toBeInTheDocument();
  });

  it('9. suppression: a routePreview SYSTEM frame never renders an inline log row', () => {
    stream.events = [previewResultFrame('n1')];
    render(<TorqTerminal />);

    expect(screen.queryByText('Route preview')).not.toBeInTheDocument();
  });

  it('10. RC-4 display-only: within(panel) has ZERO buttons/links; rendering never calls sendCommand', () => {
    stream.events = [];
    const { rerender } = render(<TorqTerminal />);
    fireEvent.change(getInput(), { target: { value: 'do the thing' } });
    fireEvent.click(getButton());
    const nonce = lastSentNonce();
    stream.sendCommand.mockClear();

    stream.events = [previewResultFrame(nonce)];
    rerender(<TorqTerminal />);

    const panel = getPanel();
    expect(within(panel).queryAllByRole('button')).toHaveLength(0);
    expect(within(panel).queryAllByRole('link')).toHaveLength(0);
    expect(stream.sendCommand).not.toHaveBeenCalled();
  });

  it('11a. staleness trigger — input edit clears a shown result independently', () => {
    stream.events = [];
    const { rerender } = render(<TorqTerminal />);
    fireEvent.change(getInput(), { target: { value: 'do the thing' } });
    fireEvent.click(getButton());
    const nonce = lastSentNonce();
    stream.events = [previewResultFrame(nonce)];
    rerender(<TorqTerminal />);
    expect(queryPanel()).not.toBeNull();

    fireEvent.change(getInput(), { target: { value: 'do the thing, edited' } });
    expect(queryPanel()).toBeNull();
  });

  it('11b. staleness trigger — toggling a control clears a shown result independently', () => {
    stream.events = [];
    const { rerender } = render(<TorqTerminal />);
    fireEvent.change(getInput(), { target: { value: 'do the thing' } });
    fireEvent.click(getButton());
    const nonce = lastSentNonce();
    stream.events = [previewResultFrame(nonce)];
    rerender(<TorqTerminal />);
    expect(queryPanel()).not.toBeNull();

    const fastCheckbox = screen.getByRole('checkbox', { name: /fast/i });
    fireEvent.click(fastCheckbox);
    expect(queryPanel()).toBeNull();
  });

  it('11c. staleness trigger — a new simulate click replaces the old result with a fresh pending + new nonce', () => {
    stream.events = [];
    const { rerender } = render(<TorqTerminal />);
    fireEvent.change(getInput(), { target: { value: 'do the thing' } });
    fireEvent.click(getButton());
    const nonce1 = lastSentNonce();
    stream.events = [previewResultFrame(nonce1)];
    rerender(<TorqTerminal />);
    expect(queryPanel()).not.toBeNull();

    fireEvent.click(getButton());
    const nonce2 = lastSentNonce();
    expect(nonce2).not.toBe(nonce1);
    expect(screen.getByText('previewing…')).toBeInTheDocument();
  });

  it('12. sendFailed: immediate honest message, timer never armed', () => {
    stream.sendCommand.mockImplementationOnce(() => false);
    stream.events = [];
    render(<TorqTerminal />);
    fireEvent.change(getInput(), { target: { value: 'do the thing' } });
    fireEvent.click(getButton());

    expect(screen.getByText(/couldn.t send preview — connection may be reconnecting; try again/i)).toBeInTheDocument();
  });
});

describe('TorqTerminal preview mapper byte-identity (G1R RC-3) — real dispatched SUBMIT_PROMPT, exact deep equality', () => {
  it('default controls: exact object, no maxCostUsd key', () => {
    stream.events = [];
    render(<TorqTerminal />);
    fireEvent.change(getInput(), { target: { value: 'hello world' } });
    fireEvent.submit(getInput().closest('form')!);

    expect(stream.sendCommand).toHaveBeenCalledTimes(1);
    const cmd = stream.sendCommand.mock.calls[0][0];
    expect(cmd).toEqual({
      action: 'SUBMIT_PROMPT',
      prompt: 'hello world',
      sensitive: false,
      urgent: false,
      attachmentIds: [],
      executionMode: 'AUTO',
      useMemory: true,
    });
    expect(cmd).not.toHaveProperty('maxCostUsd');
  });

  it('budget:free -> executionMode LOCAL_ONLY, exact object', () => {
    stream.events = [];
    render(<TorqTerminal />);
    const budgetSelect = screen.getByRole('combobox', { name: /budget/i });
    fireEvent.change(budgetSelect, { target: { value: 'free' } });
    fireEvent.change(getInput(), { target: { value: 'hello world' } });
    fireEvent.submit(getInput().closest('form')!);

    const cmd = stream.sendCommand.mock.calls[0][0];
    expect(cmd).toEqual({
      action: 'SUBMIT_PROMPT',
      prompt: 'hello world',
      sensitive: false,
      urgent: false,
      attachmentIds: [],
      executionMode: 'LOCAL_ONLY',
      useMemory: true,
    });
  });

  it('budget:custom + customBudget:2 -> maxCostUsd:2, exact object', () => {
    stream.events = [];
    render(<TorqTerminal />);
    const budgetSelect = screen.getByRole('combobox', { name: /budget/i });
    fireEvent.change(budgetSelect, { target: { value: 'custom' } });
    const customInput = screen.getByLabelText('Custom budget in USD');
    fireEvent.change(customInput, { target: { value: '2' } });
    fireEvent.change(getInput(), { target: { value: 'hello world' } });
    fireEvent.submit(getInput().closest('form')!);

    const cmd = stream.sendCommand.mock.calls[0][0];
    expect(cmd).toEqual({
      action: 'SUBMIT_PROMPT',
      prompt: 'hello world',
      sensitive: false,
      urgent: false,
      attachmentIds: [],
      executionMode: 'AUTO',
      useMemory: true,
      maxCostUsd: 2,
    });
  });

  it('numeric budget:5 -> maxCostUsd present, exact object', () => {
    stream.events = [];
    render(<TorqTerminal />);
    const budgetSelect = screen.getByRole('combobox', { name: /budget/i });
    fireEvent.change(budgetSelect, { target: { value: '5' } });
    fireEvent.change(getInput(), { target: { value: 'hello world' } });
    fireEvent.submit(getInput().closest('form')!);

    const cmd = stream.sendCommand.mock.calls[0][0];
    expect(cmd).toEqual({
      action: 'SUBMIT_PROMPT',
      prompt: 'hello world',
      sensitive: false,
      urgent: false,
      attachmentIds: [],
      executionMode: 'AUTO',
      useMemory: true,
      maxCostUsd: 5,
    });
  });
});
