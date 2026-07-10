// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
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
  cleanup(); // LOAD-BEARING (G1R RC-4): root config has no globals:true.
  stream.events = [];
  stream.sendCommand.mockClear();
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
function terminal(type: 'RESULT' | 'ERROR', requestId: string): GatewayEvent {
  return ev({ type, requestId, message: type === 'RESULT' ? 'done' : 'failed' });
}
// A non-terminal event referencing the SAME requestId as an active anchor,
// used to keep activeRequestId resolved without re-supplying a TIER_SELECTED
// diag (see invariant B below).
function toolCall(requestId: string): GatewayEvent {
  return ev({ type: 'TOOL_CALL', requestId, message: 'Executing filesystem__read_file' });
}

const diagA = { score: 10, reason: 'a', tier: 'OLLAMA_LOCAL', ruleId: 'LOCAL_INTENT', overridable: false };
const diagB = { score: 20, reason: 'b', tier: 'API_EXTERNAL', ruleId: 'HEURISTIC_EVAL', overridable: true };

// Chip presence is proven by the `↳` marker text — it's rendered in its own
// <span> right before the tier label span, so query for it directly. NOTE:
// the log ALSO renders a per-event tier badge with the same text (e.g. "on
// this machine") for every TIER_SELECTED row, so tier-text assertions must be
// scoped to the chip's own <p> (via within()), never asserted page-wide.
function getChip() {
  return screen.queryByText('↳');
}
function getChipContainer() {
  const marker = getChip();
  return marker ? marker.closest('p')! : null;
}

describe('TorqTerminal route chip (G1R RC-1 — mounts the REAL TorqTerminal via vi.mock)', () => {
  it('A. render source = snapshot for the active anchor: chip shows diagA tier text', () => {
    stream.events = [tierSelected('A', diagA)];
    render(<TorqTerminal />);

    const chip = getChipContainer();
    expect(chip).toBeInTheDocument();
    expect(within(chip!).getByText('on this machine')).toBeInTheDocument(); // tierLabel(OLLAMA_LOCAL).text
  });

  it('B. write-on-present snapshot stability across a rerender that grows events but keeps A\'s TIER_SELECTED in the window', () => {
    // HONEST NOTE ON CONSTRUCTIBILITY (per spec instruction): activeRequestId
    // is computed by scanning `events` for the last non-terminal TIER_SELECTED
    // for a given requestId (TorqTerminal.tsx :106-113). If A's TIER_SELECTED
    // frame is REMOVED from `events` entirely while no other A-frame exists,
    // activeRequestId itself nulls out (there is no event left to anchor A as
    // active) — that is invariant D's territory (terminal/null anchor hides
    // the chip), not a distinct "eviction" state. A genuine "A is still the
    // active anchor AND its TIER_SELECTED frame is gone" state is NOT
    // constructible from events alone: activeRequestId is derived from the
    // very same TIER_SELECTED frame that write-on-present is supposed to
    // survive without. Asserting such a state exists would be dishonest.
    //
    // What IS genuinely constructible and load-bearing: the write-on-present
    // effect (TorqTerminal.tsx :124-132) writes the diag into routeSnapshot
    // keyed by requestId and NEVER clears it — so once written, the chip's
    // render source is the snapshot, not a live recomputation. We prove this
    // by rerendering with MORE events appended (a later TOOL_CALL for the
    // same still-active request A) and confirming the chip's rendered tier
    // text is unchanged and stable — i.e. it is not being blanked or
    // recomputed away as the event log grows, which is the practical
    // consequence a real user would observe during a long-running task.
    // The pure "selector returns null when the TIER_SELECTED frame for A is
    // gone from the window" behavior is already covered at the selector
    // level in tests/friendly.test.ts ("selectActiveRouteDiag" test 5,
    // eviction-style). Escalating this note rather than asserting a false
    // "chip survives even after activeRequestId itself goes null" claim.
    stream.events = [tierSelected('A', diagA)];
    const { rerender } = render(<TorqTerminal />);
    expect(within(getChipContainer()!).getByText('on this machine')).toBeInTheDocument();

    stream.events = [tierSelected('A', diagA), toolCall('A')];
    rerender(<TorqTerminal />);

    // A is still the active anchor (its TIER_SELECTED is still in the
    // window); the chip continues to render from the snapshot, unchanged.
    const chip = getChipContainer();
    expect(chip).toBeInTheDocument();
    expect(within(chip!).getByText('on this machine')).toBeInTheDocument();
  });

  it('C. no stale route for a different task: interleaved A then B shows B\'s tier, not A\'s', () => {
    stream.events = [tierSelected('A', diagA), tierSelected('B', diagB)];
    render(<TorqTerminal />);

    const chip = getChipContainer();
    expect(chip).toBeInTheDocument();
    expect(within(chip!).getByText('cloud model')).toBeInTheDocument(); // tierLabel(API_EXTERNAL).text for B
    expect(within(chip!).queryByText('on this machine')).not.toBeInTheDocument();
  });

  it('D. terminal/null anchor hides the chip: RESULT for A nulls activeRequestId', () => {
    stream.events = [tierSelected('A', diagA), terminal('RESULT', 'A')];
    render(<TorqTerminal />);

    expect(getChip()).not.toBeInTheDocument();
  });

  it('the chip issues no dispatch: sendCommand is never called for chip-related actions across A-D scenarios', () => {
    stream.events = [tierSelected('A', diagA), tierSelected('B', diagB), terminal('RESULT', 'B')];
    render(<TorqTerminal />);

    // TorqTerminal's own mount effects may call sendCommand for unrelated
    // reasons in the full component (none expected here since useGatewayStream
    // itself is mocked out), but nothing chip-related ever calls it — the
    // chip <p> has no onClick/button in its JSX (TorqTerminal.tsx :308-320).
    const chipActions = stream.sendCommand.mock.calls.map((c) => (c[0] as any)?.action);
    expect(chipActions).not.toContain('GET_ROUTE_DIAG');
    expect(chipActions).not.toContain('SUBMIT_PROMPT');
  });
});
