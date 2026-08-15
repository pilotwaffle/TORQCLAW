// @vitest-environment jsdom
// Tiered approvals (redesign 6/7): severity tiers derived MECHANICALLY from
// the kernel's gate facts (buildGateFacts) — green read tier (one-click),
// amber spend tier (budget context inline), red destructive tier (risk list +
// type DELETE to arm, checkpoint truth stated). Gates absent on the wire keep
// the exact pre-redesign card. Mounts the REAL TorqTerminal via the standard
// mocked useGatewayStream pattern.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
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

afterEach(() => {
  cleanup();
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
function approval(gate: unknown, extra: Record<string, unknown> = {}): GatewayEvent {
  const metadata: Record<string, unknown> = {
    approvalId: 'appr-1',
    toolName: 'filesystem__write_file',
    args: { path: '/x' },
    ...extra,
  };
  if (gate !== undefined) metadata.gate = gate;
  return ev({
    type: 'PENDING_APPROVAL', requestId: 'r1',
    message: 'Tool filesystem__write_file requires approval', metadata,
  });
}
function cardOf(): HTMLElement {
  return screen.getByText('Allow once').closest('div.rounded') as HTMLElement;
}

describe('TorqTerminal — tiered approvals (redesign 6/7)', () => {
  it('read tier: green edge, one-click approve dispatches immediately', () => {
    stream.events = [approval({ capability: 'read', rule: 'approval-pattern', targets: [], targetsSource: 'path-heuristic' })];
    render(<TorqTerminal />);

    const card = cardOf();
    expect(card.className).toContain('border-good');

    const allow = screen.getByText('Allow once') as HTMLButtonElement;
    expect(allow.disabled).toBe(false);
    fireEvent.click(allow);
    expect(stream.sendCommand).toHaveBeenCalledWith({
      action: 'APPROVE_TOOL', approvalId: 'appr-1', decision: 'APPROVE',
    });
  });

  it('spend tier: amber edge + recorded budget context inline; approve stays one-click', () => {
    stream.events = [
      approval({ capability: 'write', rule: 'write-class-capability', targets: ['/x'], targetsSource: 'path-heuristic' }),
      ev({ type: 'SYSTEM', message: 'Cost summary', metadata: { costSummary: true, sessionRemaining: 4.75, sessionCap: 5 } }),
    ];
    render(<TorqTerminal />);

    const card = cardOf();
    expect(card.className).toContain('border-torque');
    expect(screen.getByText(/budget: \$4\.75 remaining of \$5\.00 session cap/)).toBeInTheDocument();

    const allow = screen.getByText('Allow once') as HTMLButtonElement;
    expect(allow.disabled).toBe(false);
  });

  it('spend tier without a costSummary frame: no budget line, never a fabricated figure', () => {
    stream.events = [approval({ capability: 'write', rule: 'write-class-capability', targets: [], targetsSource: 'path-heuristic' })];
    render(<TorqTerminal />);
    expect(screen.queryByText(/budget:/)).not.toBeInTheDocument();
  });

  it('destructive tier (exec): red edge, risk list, checkpoint truth, DELETE-to-arm', () => {
    stream.events = [approval({ capability: 'exec', rule: 'write-class-capability', targets: [], targetsSource: 'path-heuristic' })];
    render(<TorqTerminal />);

    const card = cardOf();
    expect(card.className).toContain('border-bad');
    expect(screen.getByText(/runs code with this machine/)).toBeInTheDocument();
    expect(screen.getByText(/not covered by any checkpoint/)).toBeInTheDocument();

    // Disarmed until the operator types DELETE.
    const allow = screen.getByText('Allow once') as HTMLButtonElement;
    expect(allow.disabled).toBe(true);
    fireEvent.click(allow);
    expect(stream.sendCommand).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('type DELETE to arm approve'), { target: { value: 'DELETE' } });
    expect((screen.getByText('Allow once') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByText('Allow once'));
    expect(stream.sendCommand).toHaveBeenCalledWith({
      action: 'APPROVE_TOOL', approvalId: 'appr-1', decision: 'APPROVE',
    });
  });

  it('destructive tier (send): outbound risk line renders', () => {
    stream.events = [approval({ capability: 'send', rule: 'write-class-capability', targets: [], targetsSource: 'path-heuristic' })];
    render(<TorqTerminal />);
    expect(screen.getByText(/sends data off this machine/)).toBeInTheDocument();
  });

  it('registry miss and engine hook are destructive (fail-closed) — unknown never means read', () => {
    // Registry miss: gate present, no capability, no rule.
    stream.events = [approval({ targets: ['/x'], targetsSource: 'path-heuristic' })];
    const { unmount } = render(<TorqTerminal />);
    expect(cardOf().className).toContain('border-bad');
    expect(screen.getByText(/could not classify/)).toBeInTheDocument();
    expect((screen.getByText('Allow once') as HTMLButtonElement).disabled).toBe(true);
    unmount();
    cleanup();

    // Frontier engine hook: the facts row names it; risk stays consequence-only,
    // never the word "unclassified" (F5 pin).
    stream.events = [approval({ targets: ['/x'], targetsSource: 'path-heuristic', rule: 'engine-approval-hook' })];
    render(<TorqTerminal />);
    expect(cardOf().className).toContain('border-bad');
    expect(screen.getByText('engine approval hook (frontier tier)')).toBeInTheDocument();
    expect(screen.getByText(/could not classify/)).toBeInTheDocument();
    expect(screen.queryByText(/unclassified/)).not.toBeInTheDocument();
  });

  it('gate ABSENT (pre-5A-1 backlog): unchanged card — no tier edge, no confirm gate', () => {
    stream.events = [approval(undefined)];
    render(<TorqTerminal />);

    const card = cardOf();
    expect(card.className).not.toContain('border-good');
    expect(card.className).not.toContain('border-torque');
    expect(card.className).not.toContain('border-bad');
    expect(screen.queryByLabelText('type DELETE to arm approve')).not.toBeInTheDocument();
    const allow = screen.getByText('Allow once') as HTMLButtonElement;
    expect(allow.disabled).toBe(false);
    fireEvent.click(allow);
    expect(stream.sendCommand).toHaveBeenCalledWith({
      action: 'APPROVE_TOOL', approvalId: 'appr-1', decision: 'APPROVE',
    });
  });

  it('Deny is never gated by the tier', () => {
    stream.events = [approval({ capability: 'exec', rule: 'write-class-capability', targets: [], targetsSource: 'path-heuristic' })];
    render(<TorqTerminal />);
    const deny = screen.getByText('Deny') as HTMLButtonElement;
    expect(deny.disabled).toBe(false);
    fireEvent.click(deny);
    expect(stream.sendCommand).toHaveBeenCalledWith({
      action: 'APPROVE_TOOL', approvalId: 'appr-1', decision: 'REJECT',
    });
  });
});
