// @vitest-environment jsdom
// Global liveness chip (redesign 2/7): persistent header indicator for the
// in-flight task — phase text from the freshest kernel event, GlyphSpinner,
// LiveDuration sharing the SAME turnStartMs anchor as the in-stream presence
// block (one epoch, two readers), 30s stuck warning, turn-id tag, and
// click-to-scroll. Mounts the REAL TorqTerminal via the standard mocked
// useGatewayStream pattern.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { GatewayEvent } from '@torqclaw/contracts';

// Track scrollTo calls — jsdom does not implement it (and the chip's click
// contract IS "scroll the stream to the running task").
const scrollToSpy = vi.fn();
if (typeof Element !== 'undefined') {
  Element.prototype.scrollTo = function scrollTo(...args: unknown[]) {
    scrollToSpy(...args);
  } as unknown as typeof Element.prototype.scrollTo;
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
import { STALE_AFTER_MS } from '../apps/console/src/components/presence.js';

const BASE = Date.parse('2026-01-01T00:00:00.000Z');

afterEach(() => {
  cleanup();
  stream.events = [];
  stream.isConnected = true;
  stream.sendCommand.mockClear();
  scrollToSpy.mockClear();
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
    timestamp: new Date(BASE).toISOString(),
    ...p,
  } as GatewayEvent;
}
function tierSelected(requestId: string): GatewayEvent {
  return ev({
    type: 'TIER_SELECTED', requestId, tier: 'OLLAMA_LOCAL', message: 'routed',
    metadata: { score: 10, reason: 'a', tier: 'OLLAMA_LOCAL', ruleId: 'LOCAL_INTENT', overridable: false },
  });
}
function toolCall(requestId: string, atMs = BASE): GatewayEvent {
  return ev({ type: 'TOOL_CALL', requestId, message: 'Executing filesystem__read_file', timestamp: new Date(atMs).toISOString() });
}

describe('TorqTerminal — global liveness chip', () => {
  it('renders while a task is in flight: phase text, turn tag, anchored elapsed', () => {
    vi.useFakeTimers();
    // 30s into the task — elapsed must read wall-clock, not mount-time.
    vi.setSystemTime(BASE + 30_000);
    stream.events = [tierSelected('r1'), toolCall('r1')];
    render(<TorqTerminal />);

    // Phase = the freshest task event's humanized message (the wire has no
    // ACTION_STATUS type — never an invented label). Since redesign 3/7 the
    // TOOL_CALL row lives collapsed inside the task card, so the chip is the
    // guaranteed-visible reader of the phase — exactly its purpose.
    expect(screen.getAllByText('Using read file (filesystem)').length).toBeGreaterThanOrEqual(1);
    // Turn tag for debuggability (unique to the chip).
    expect(screen.getByText('turn r1')).toBeInTheDocument();
    // Spinner present (role=status) — the chip is the kernel-status surface.
    expect(screen.getAllByRole('status').length).toBeGreaterThanOrEqual(1);
    // Elapsed reads 0:30 from the epoch anchor.
    expect(screen.getAllByText('0:30').length).toBeGreaterThanOrEqual(1);
  });

  it('EPOCH PARITY: the chip and the in-stream presence block render the SAME elapsed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE + 30_000);
    stream.events = [tierSelected('r1'), toolCall('r1')];
    render(<TorqTerminal />);

    // One anchor, several readers: the chip's LiveDuration, the in-stream
    // working-line LiveDuration, and PresenceCard's LiveDuration all render
    // from the SAME turnStartMs. Every reader must agree on wall-clock — they
    // can never disagree because none keeps its own counter.
    const readers = screen.getAllByText('0:30');
    expect(readers.length).toBeGreaterThanOrEqual(2);
  });

  it('no chip when idle (no task in flight)', () => {
    stream.events = [ev({ type: 'RESULT', requestId: 'r1' })];
    render(<TorqTerminal />);
    expect(screen.queryByText(/^turn /)).not.toBeInTheDocument();
  });

  it('stays visible while the task waits on approval — and is NEVER flagged stuck', () => {
    vi.useFakeTimers();
    stream.events = [
      tierSelected('r1'),
      ev({
        type: 'PENDING_APPROVAL', requestId: 'r1',
        message: 'Tool filesystem__write_file requires approval',
        metadata: { approvalId: 'a1', toolName: 'filesystem__write_file', args: { path: '/x' } },
      }),
    ];
    // 40s quiet — would be stuck for a running task, but the bottleneck here
    // is the OPERATOR; the chip shows the wait, not a false kernel-stall alarm.
    vi.setSystemTime(BASE + STALE_AFTER_MS + 10_000);
    render(<TorqTerminal />);

    // Chip + stream row both humanize the same event — allow both readers.
    expect(screen.getAllByText('Wants to write file — needs your OK').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/no output for 30s\+/)).not.toBeInTheDocument();
  });

  it('flips to the stuck warning after 30s of silence on the task stream', () => {
    vi.useFakeTimers();
    stream.events = [tierSelected('r1'), toolCall('r1')];
    vi.setSystemTime(BASE + STALE_AFTER_MS + 5_000); // 35s quiet
    render(<TorqTerminal />);

    // The chip renders the bold keyword in its own <b>, followed by a
    // trailing text node with the phase (` · <phase>`) inside the same
    // <span> — RTL's default text matcher returns only the innermost node
    // whose OWN text matches, i.e. the <b>, so assert the bold keyword there
    // and confirm the phase text is concatenated onto it via the parent span.
    const keyword = screen.getByText('no output for 30s+');
    expect(keyword.tagName).toBe('B');
    expect(keyword.parentElement?.textContent).toBe(
      'no output for 30s+ · Using read file (filesystem)',
    );
  });

  it('clicking the chip scrolls the stream to the running task', () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE + 5_000);
    stream.events = [tierSelected('r1'), toolCall('r1')];
    render(<TorqTerminal />);

    // The turn tag is unique to the chip — anchor there and climb to its button.
    const chip = screen.getByText('turn r1').closest('button')!;
    fireEvent.click(chip);
    expect(scrollToSpy).toHaveBeenCalled();
  });
});
