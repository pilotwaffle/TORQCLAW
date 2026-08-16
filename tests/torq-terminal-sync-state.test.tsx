// @vitest-environment jsdom
// Runtime-true sync state (PRD-UI-1 §2/§5): the connection element reads
// CONNECTED (good) when fresh, and a 'stale · reconnecting…' badge REPLACES it
// when data is >30s unrefreshed or the socket is down (stale must be VISIBLE;
// the badge stays actionable). The header budget meter carries the sync dot,
// SESSION BUDGET label, gradient meter, $X.XX / $Y.YY value, a manual refresh
// (GET_COST_SUMMARY only), and 'synced M:SS'. Absent frame renders '—', never
// a fabricated $0. Mounts the REAL TorqTerminal via the mocked stream.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { GatewayEvent } from '@torqclaw/contracts';
import { STALE_AFTER_MS } from '../apps/console/src/components/presence.js';

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

const BASE = Date.parse('2026-01-01T00:00:00.000Z');

afterEach(() => {
  cleanup();
  stream.events = [];
  stream.isConnected = true;
  stream.sendCommand.mockClear();
  stream.reconnect.mockClear();
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

describe('TorqTerminal — connection element (PRD §2)', () => {
  it('green CONNECTED when connected and data is fresh', () => {
    vi.useFakeTimers();
    stream.events = [ev({ type: 'RESULT', requestId: 'r1' })];
    vi.setSystemTime(BASE + 5_000);
    render(<TorqTerminal />);

    expect(screen.getByText('CONNECTED')).toBeInTheDocument();
    expect(screen.queryByText(/stale · reconnecting/)).not.toBeInTheDocument();
  });

  it('stale >30s -> the badge REPLACES CONNECTED and stays actionable', () => {
    vi.useFakeTimers();
    stream.events = [
      ev({ type: 'TIER_SELECTED', requestId: 'r1', tier: 'OLLAMA_LOCAL', message: 'routed' }),
      ev({ type: 'TOOL_CALL', requestId: 'r1', message: 'Executing filesystem__read_file' }),
    ];
    vi.setSystemTime(BASE + STALE_AFTER_MS + 5_000);
    render(<TorqTerminal />);

    expect(screen.queryByText('CONNECTED')).not.toBeInTheDocument();
    const badge = screen.getByText(/stale · reconnecting/).closest('button')!;
    fireEvent.click(badge);
    expect(stream.reconnect).toHaveBeenCalledTimes(1);
  });

  it('disconnected -> the badge replaces CONNECTED (error state, no green lie)', () => {
    stream.isConnected = false;
    stream.events = [ev({ type: 'RESULT', requestId: 'r1' })];
    render(<TorqTerminal />);

    expect(screen.queryByText('CONNECTED')).not.toBeInTheDocument();
    expect(screen.getByText(/stale · reconnecting/)).toBeInTheDocument();
  });
});

describe('TorqTerminal — header budget meter (PRD §2)', () => {
  it('shows SESSION BUDGET label, dash value before any frame, and a working refresh', () => {
    render(<TorqTerminal />);

    expect(screen.getByText('Session budget')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText(/session \$/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByTitle('refresh from runtime'));
    expect(stream.sendCommand).toHaveBeenCalledWith({ action: 'GET_COST_SUMMARY', recentLimit: 20 });
  });

  it('renders kernel-recorded totals as $X.XX / $Y.YY once a frame lands', () => {
    stream.events = [ev({
      type: 'SYSTEM', message: 'Cost summary',
      metadata: { costSummary: true, sessionTotal: 0.03, sessionCap: 1, sessionRemaining: 0.97 },
    })];
    const { rerender } = render(<TorqTerminal />);
    rerender(<TorqTerminal />);

    expect(screen.getByText('$0.03')).toBeInTheDocument();
    expect(screen.getByText('/ $1.00')).toBeInTheDocument();
  });

  it('synced readout uses M:SS', () => {
    vi.useFakeTimers();
    stream.events = [ev({ type: 'RESULT', requestId: 'r1' })];
    vi.setSystemTime(BASE + 65_000); // 65s -> 1:05
    render(<TorqTerminal />);

    expect(screen.getByText(/synced 1:05/)).toBeInTheDocument();
  });
});
