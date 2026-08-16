// @vitest-environment jsdom
// Wires the REAL TorqTerminal (via a mocked useGatewayStream) to prove the two
// UI increments added by the three-lens slice: (a) the staleness affordance
// surfaces a "reconnect" action that actually calls the stream's reconnect,
// and (b) the current-task presence card renders honest tier/lock/budget facts
// from the wire. See docs/prd-reviews/TORQ-BUZZ-VS-TORQCLAW-COMPARISON.md §6.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
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
    // FIXED baseline timestamp; tests that need staleness set system time far
    // past this (see the stale test below).
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
const diagA = { score: 10, reason: 'a', tier: 'OLLAMA_LOCAL', ruleId: 'LOCAL_INTENT', overridable: false };

describe('TorqTerminal — staleness affordance + presence card', () => {
  describe('staleness affordance (PRD §2: badge replaces CONNECTED, stays actionable)', () => {
    it('stale while a task should be producing events -> the stale badge calls stream.reconnect', () => {
      vi.useFakeTimers();
      stream.events = [tierSelected('r1', diagA), toolCall('r1')];
      // 60s (> STALE_AFTER_MS) after the newest event, still "connected".
      vi.setSystemTime(Date.parse('2026-01-01T00:00:00.000Z') + STALE_AFTER_MS + 30_000);

      render(<TorqTerminal />);

      const badge = screen.getByText(/stale · reconnecting/).closest('button');
      expect(badge).not.toBeNull(); // an action, not decoration

      act(() => {
        fireEvent.click(badge!);
      });
      expect(stream.reconnect).toHaveBeenCalledTimes(1);
    });

    it('idle + connected + fresh -> CONNECTED, no badge, M:SS synced readout', () => {
      vi.useFakeTimers();
      const fresh = Date.UTC(2026, 0, 1, 0, 0, 2); // a RECENT event relative to now
      stream.events = [ev({ type: 'RESULT', requestId: 'r1', timestamp: new Date(fresh).toISOString() })];
      vi.setSystemTime(fresh + 5_000); // 5s after the last event -> not stale

      render(<TorqTerminal />);

      expect(screen.getByText('CONNECTED')).toBeInTheDocument();
      expect(screen.queryByText(/stale · reconnecting/)).not.toBeInTheDocument();
      expect(screen.getByText(/synced \d+:\d\d/)).toBeInTheDocument();
    });

    it('disconnected -> CONNECTED is replaced by the RECONNECTING… badge', () => {
      // PRD-UI-1 §2 splits this into two distinct copy strings: socket-down
      // reads "RECONNECTING…" (torque); connected-but-stale reads
      // "stale · reconnecting…" (a separate branch — see the sibling "stale
      // while a task should be producing events" test above, which covers
      // that case). Both stay actionable (force-reconnect button).
      stream.isConnected = false;
      stream.events = [ev({ type: 'RESULT', requestId: 'r1', timestamp: '2026-01-01T00:00:00.000Z' })];
      render(<TorqTerminal />);
      expect(screen.queryByText('CONNECTED')).not.toBeInTheDocument();
      expect(screen.queryByText(/stale · reconnecting/)).not.toBeInTheDocument();
      const badge = screen.getByText('RECONNECTING…').closest('button');
      expect(badge).not.toBeNull(); // an action, not decoration — same contract as the stale badge

      fireEvent.click(badge!);
      expect(stream.reconnect).toHaveBeenCalledTimes(1);
    });
  });

  describe('current-task presence card', () => {
    it('busy task renders tier / lock / budget-remaining from the wire', () => {
      stream.events = [
        tierSelected('r1', diagA),
        toolCall('r1'),
        ev({ type: 'SYSTEM', message: 'cost', metadata: { costSummary: true, sessionRemaining: 4.75 } }),
      ];
      render(<TorqTerminal />);

      // PRD-UI-1 §4e retired PresenceCard from the busy-task render path: the
      // working state (spinner/phase/elapsed/stop) now lives INSIDE the
      // running TaskCard once TIER_SELECTED mints it (see TorqTerminal.tsx's
      // "stream-level block now covers only the pre-card window" — commit
      // 3749e8c), and TIER_SELECTED is exactly what sets activeRequestId, so
      // PresenceCard's tier/lock/budget props (fed only from that pre-card
      // block) can never render with real data for any task that has routed.
      // The surviving reader of the SAME chipDiag facts is the "↳ tier · lock"
      // line (TorqTerminal.tsx ~985) — same tierLabel()/formatLockState()
      // source, just without the "tier:"/"lock:" prefix labels. Assert that.
      // budgetRemaining (sessionRemaining) has no reachable renderer left in
      // TorqTerminal now that PresenceCard is unreachable — the header meter
      // reads sessionTotal/sessionCap, not sessionRemaining — so that fact is
      // no longer surfaced anywhere in the live UI; not asserted here.
      // Anchor on the ↳ glyph (unique to this line) since "on this machine" /
      // "Fixed for this task" can also appear inside the collapsed TIER_SELECTED
      // plumbing row for the same task.
      const routeLine = screen.getByText('↳').closest('p')!;
      expect(routeLine).toHaveTextContent('on this machine'); // tierLabel(OLLAMA_LOCAL).text
      expect(routeLine).toHaveTextContent('Fixed for this task'); // formatLockState: overridable === false
    });

    it('no presence card when idle (no task to be present about)', () => {
      stream.events = [ev({ type: 'RESULT', requestId: 'r1' })];
      render(<TorqTerminal />);
      expect(screen.queryByText('budget left:')).not.toBeInTheDocument();
      expect(screen.queryByText(/tier:/)).not.toBeInTheDocument();
    });
  });
});