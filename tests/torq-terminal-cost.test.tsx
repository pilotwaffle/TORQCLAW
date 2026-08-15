// @vitest-environment jsdom
// Live cost layer (redesign 4/7): the composer pre-flight estimate chip (the
// kernel's real sizing pass via debounced PREVIEW_ROUTE), the working-card
// cost panel reading the SAME snapshotted estimate, and the header session
// budget meter climbing with kernel-recorded spend. Honesty pins: dollars
// only where true by construction (local = free); cloud shows tokens, never
// an invented dollar figure; no live per-task tick is faked. Mounts the REAL
// TorqTerminal via the standard mocked useGatewayStream pattern.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
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

afterEach(() => {
  cleanup();
  stream.events = [];
  stream.sendCommand.mockClear();
  vi.useRealTimers();
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
function previewFrame(nonce: string, meta: Record<string, unknown>): GatewayEvent {
  return ev({ type: 'SYSTEM', message: 'Route preview', metadata: { routePreview: true, previewOf: nonce, ...meta } });
}
function tierSelected(requestId: string, tier: 'OLLAMA_LOCAL' | 'API_EXTERNAL'): GatewayEvent {
  return ev({
    type: 'TIER_SELECTED', requestId, tier, message: 'routed',
    metadata: { score: 10, reason: 'a', tier, ruleId: 'LOCAL_INTENT', overridable: false },
  });
}
function toolCall(requestId: string): GatewayEvent {
  return ev({ type: 'TOOL_CALL', requestId, message: 'Executing filesystem__read_file' });
}
function previewCalls(): Array<{ previewOf: string; prompt: string }> {
  return stream.sendCommand.mock.calls
    .map(([c]) => c)
    .filter((c: any) => c.action === 'PREVIEW_ROUTE');
}
function costSummaryCalls(): unknown[] {
  return stream.sendCommand.mock.calls
    .map(([c]) => c)
    .filter((c: any) => c.action === 'GET_COST_SUMMARY');
}

describe('TorqTerminal — pre-flight estimate chip (redesign 4/7)', () => {
  it('typing dispatches a debounced PREVIEW_ROUTE (the kernel sizing pass) and renders the local estimate', () => {
    vi.useFakeTimers();
    const { rerender } = render(<TorqTerminal />);

    fireEvent.change(screen.getByLabelText(INPUT_LABEL), { target: { value: 'summarize this file' } });
    // Before the debounce settles, nothing is dispatched.
    expect(previewCalls()).toHaveLength(0);
    act(() => {
      vi.advanceTimersByTime(500);
    });

    const calls = previewCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toBe('summarize this file');

    // Frame lands: local route -> '$0.00 · local' (free by construction).
    stream.events = [previewFrame(calls[0]!.previewOf, { diagnostics: { tier: 'OLLAMA_LOCAL' } })];
    rerender(<TorqTerminal />);
    expect(screen.getByText('$0.00 · local')).toBeInTheDocument();
  });

  it('cloud estimate shows the kernel token figure — never a fabricated dollar amount', () => {
    vi.useFakeTimers();
    const { rerender } = render(<TorqTerminal />);

    fireEvent.change(screen.getByLabelText(INPUT_LABEL), { target: { value: 'deep research task' } });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    const nonce = previewCalls()[0]!.previewOf;

    stream.events = [previewFrame(nonce, {
      diagnostics: { tier: 'API_EXTERNAL' },
      enrichment: { estimatedTokens: 4821 },
    })];
    rerender(<TorqTerminal />);

    expect(screen.getByText('~4,821 tokens · cloud')).toBeInTheDocument();
    // No dollar figure anywhere in the estimate chip.
    expect(screen.queryByText(/\$.*cloud/)).not.toBeInTheDocument();
  });

  it('editing the draft clears the stale estimate immediately', () => {
    vi.useFakeTimers();
    const { rerender } = render(<TorqTerminal />);

    const input = screen.getByLabelText(INPUT_LABEL);
    fireEvent.change(input, { target: { value: 'first draft' } });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    const nonce = previewCalls()[0]!.previewOf;
    stream.events = [previewFrame(nonce, { diagnostics: { tier: 'OLLAMA_LOCAL' } })];
    rerender(<TorqTerminal />);
    expect(screen.getByText('$0.00 · local')).toBeInTheDocument();

    // New keystroke: the number sized for the OLD text must vanish at once —
    // never linger while the draft differs from what was sized.
    fireEvent.change(input, { target: { value: 'first draft, but longer' } });
    expect(screen.queryByText('$0.00 · local')).not.toBeInTheDocument();
  });
});

describe('TorqTerminal — working-card cost panel + header meter (redesign 4/7)', () => {
  it('the working panel reads the SAME estimate the composer showed (snapshot, never recomputed)', () => {
    vi.useFakeTimers();
    const { rerender } = render(<TorqTerminal />);

    // 1) Size the draft via the kernel pass.
    fireEvent.change(screen.getByLabelText(INPUT_LABEL), { target: { value: 'cloud task please' } });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    const nonce = previewCalls()[0]!.previewOf;
    stream.events = [previewFrame(nonce, {
      diagnostics: { tier: 'API_EXTERNAL' },
      enrichment: { estimatedTokens: 4821 },
    })];
    rerender(<TorqTerminal />);
    expect(screen.getByText('~4,821 tokens · cloud')).toBeInTheDocument();

    // 2) Submit-equivalent: the task starts (TIER_SELECTED anchors the id).
    stream.events = [
      ...stream.events,
      tierSelected('r1', 'API_EXTERNAL'),
      toolCall('r1'),
    ];
    rerender(<TorqTerminal />);

    // est cap = the SAME number, now on the working panel.
    expect(screen.getAllByText('~4,821 tokens · cloud').length).toBeGreaterThanOrEqual(2);
    // Honesty note: no mid-task usage stream exists on the wire.
    expect(screen.getByText(/task cost records on completion/)).toBeInTheDocument();
  });

  it('header meter shows kernel-recorded session spend; never a fabricated $0 when no frame has landed', () => {
    const { rerender } = render(<TorqTerminal />);
    expect(screen.queryByText(/session \$/)).not.toBeInTheDocument();

    stream.events = [ev({
      type: 'SYSTEM', message: 'Cost summary',
      metadata: { costSummary: true, sessionTotal: 0.03, sessionCap: 1, sessionRemaining: 0.97 },
    })];
    rerender(<TorqTerminal />);
    expect(screen.getByText(/session \$0\.03/)).toBeInTheDocument();
    expect(screen.getByText(/\$1\.00/)).toBeInTheDocument();
  });

  it('polls GET_COST_SUMMARY every 5s while a task is in flight (and never while idle)', () => {
    vi.useFakeTimers();
    stream.events = [tierSelected('r1', 'API_EXTERNAL'), toolCall('r1')];
    const { unmount } = render(<TorqTerminal />);

    expect(costSummaryCalls()).toHaveLength(0); // event-driven, no mount fetch
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(costSummaryCalls()).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(costSummaryCalls()).toHaveLength(2);
    unmount();
    cleanup();

    // Idle console: no poll (no new spend can land while idle). Fresh counts.
    stream.sendCommand.mockClear();
    stream.events = [ev({ type: 'RESULT', requestId: 'r1' })];
    render(<TorqTerminal />);
    act(() => {
      vi.advanceTimersByTime(15000);
    });
    expect(costSummaryCalls()).toHaveLength(0);
  });
});
