// @vitest-environment jsdom
// Runtime-true sync state (redesign 5/7): the sync dot is green when live,
// amber + pulsing when data is >30s unrefreshed (stale must be VISIBLE), red
// only when the socket is down (error); the header budget meter carries a
// manual refresh; and no surface renders a cached snapshot as live truth.
// Mounts the REAL TorqTerminal via the standard mocked useGatewayStream.
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
function getDot(): HTMLElement {
  // The dot is the aria-hidden span with a state title in the header.
  const dot =
    document.querySelector('[title="live"]') ??
    document.querySelector('[title="no gateway data for 30s+"]') ??
    document.querySelector('[title="connection lost — reconnecting"]');
  if (!dot) throw new Error('sync dot not found');
  return dot as HTMLElement;
}

describe('TorqTerminal — sync dot (redesign 5/7)', () => {
  it('green when connected and data is fresh', () => {
    vi.useFakeTimers();
    stream.events = [ev({ type: 'RESULT', requestId: 'r1' })];
    vi.setSystemTime(BASE + 5_000); // 5s after the last event — fresh
    render(<TorqTerminal />);

    const dot = getDot();
    expect(dot.title).toBe('live');
    expect(dot.className).toContain('bg-good');
    expect(dot.className).not.toContain('bg-bad');
  });

  it('amber + pulsing when data is >30s unrefreshed — stale is VISIBLE, never silent', () => {
    vi.useFakeTimers();
    stream.events = [
      ev({ type: 'TIER_SELECTED', requestId: 'r1', tier: 'OLLAMA_LOCAL', message: 'routed' }),
      ev({ type: 'TOOL_CALL', requestId: 'r1', message: 'Executing filesystem__read_file' }),
    ];
    vi.setSystemTime(BASE + STALE_AFTER_MS + 5_000); // 35s quiet
    render(<TorqTerminal />);

    const dot = getDot();
    expect(dot.title).toBe('no gateway data for 30s+');
    expect(dot.className).toContain('bg-torque');
    expect(dot.className).toContain('animate-pulse');
  });

  it('red only when the socket is down (error — the one state red may mark)', () => {
    stream.isConnected = false;
    stream.events = [ev({ type: 'RESULT', requestId: 'r1' })];
    render(<TorqTerminal />);

    const dot = getDot();
    expect(dot.title).toBe('connection lost — reconnecting');
    expect(dot.className).toContain('bg-bad');
  });
});

describe('TorqTerminal — header budget meter refresh (redesign 5/7)', () => {
  it('shows "spend n/a" before any costSummary frame — never a fabricated $0', () => {
    render(<TorqTerminal />);
    expect(screen.getByText('spend n/a')).toBeInTheDocument();
    expect(screen.queryByText(/session \$/)).not.toBeInTheDocument();
  });

  it('manual refresh re-pulls the kernel ledger (GET_COST_SUMMARY only)', () => {
    render(<TorqTerminal />);
    fireEvent.click(screen.getByTitle('re-fetch session spend from the kernel ledger'));
    expect(stream.sendCommand).toHaveBeenCalledWith({ action: 'GET_COST_SUMMARY', recentLimit: 20 });
  });
});
