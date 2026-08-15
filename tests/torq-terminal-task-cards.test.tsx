// @vitest-environment jsdom
// Task cards (redesign 3/7): the raw log stream restructured into per-task
// cards — prompt header (600 weight), token-colored route chip, ONE timestamp
// per task, plumbing collapsed into "N STEPS" (default collapsed), the answer
// as a visual hero, and a chip receipt row. Mounts the REAL TorqTerminal via
// the standard mocked useGatewayStream pattern. All pre-redesign dispatch
// affordances are pinned by the other terminal suites; this file pins the
// card structure itself.
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
function userPrompt(requestId: string, text: string): GatewayEvent {
  return ev({ type: 'USER_PROMPT', requestId, message: text });
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
function result(requestId: string, text: string): GatewayEvent {
  return ev({ type: 'RESULT', requestId, message: text });
}
function doneReceipt(requestId: string): GatewayEvent {
  return ev({
    type: 'SYSTEM', requestId, message: 'Done',
    metadata: { receipt: { taskId: requestId, tier: 'API_EXTERNAL', costUsd: 0.01, elapsedMs: 500 } },
  });
}

describe('TorqTerminal — task cards (redesign 3/7)', () => {
  it('card header: prompt (semibold), route chip, and exactly ONE timestamp for the whole task', () => {
    stream.events = [userPrompt('r1', 'summarize this'), tierSelected('r1', 'OLLAMA_LOCAL'), toolCall('r1')];
    const { container } = render(<TorqTerminal />);

    // Prompt is the header line, weight 600.
    const prompt = screen.getByText('summarize this');
    expect(prompt.className).toContain('font-semibold');

    // Route chip: local renders green per tokens (never red — red is reserved).
    // getAllByText: the standalone 2C route chip ALSO spells the tier text, so
    // assert the CARD's chip by class among all matches.
    const chips = screen.getAllByText('on this machine');
    expect(chips.some((el) => el.className.includes('text-good'))).toBe(true);

    // ONE <time> for the whole task — rows inside the card hide theirs.
    expect(container.querySelectorAll('time')).toHaveLength(1);
  });

  it('cloud route chip renders cyan, never red', () => {
    stream.events = [userPrompt('r1', 'deep research'), tierSelected('r1', 'API_EXTERNAL'), toolCall('r1')];
    render(<TorqTerminal />);
    // getAllByText: the standalone 2C route chip also spells the tier text.
    const chips = screen.getAllByText('cloud model');
    const cardChip = chips.find((el) => el.className.includes('text-cloud'));
    expect(cardChip).toBeDefined();
    expect(cardChip!.className).not.toContain('#E24B4A');
  });

  it('plumbing collapses to "N STEPS", default collapsed; expanding reveals the rows', () => {
    stream.events = [userPrompt('r1', 'do it'), tierSelected('r1', 'OLLAMA_LOCAL'), toolCall('r1')];
    render(<TorqTerminal />);

    // Two plumbing events (TIER_SELECTED + TOOL_CALL), collapsed by default.
    const toggle = screen.getByText(/2 steps ▸/);
    expect(screen.queryByText('Using read file (filesystem)')).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(screen.getByText(/2 steps ▾/)).toBeInTheDocument();
    expect(screen.getByText('Using read file (filesystem)')).toBeInTheDocument();
  });

  it('the answer renders as the hero with the ANSWER eyebrow', () => {
    stream.events = [userPrompt('r1', 'question'), tierSelected('r1', 'OLLAMA_LOCAL'), result('r1', 'the final answer')];
    render(<TorqTerminal />);

    expect(screen.getByText('ANSWER')).toBeInTheDocument();
    expect(screen.getByText('the final answer')).toBeInTheDocument();
  });

  it('receipt renders as a chip row: Done + cost + latency', () => {
    stream.events = [
      userPrompt('r1', 'question'), tierSelected('r1', 'API_EXTERNAL'),
      toolCall('r1'), result('r1', 'answer'), doneReceipt('r1'),
    ];
    render(<TorqTerminal />);

    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.getByText('$0.01')).toBeInTheDocument();
    expect(screen.getByText('0.5s')).toBeInTheDocument();
  });

  it('approvals stay visible while plumbing is collapsed — action surfaces never hide', () => {
    stream.events = [
      userPrompt('r1', 'write it'), tierSelected('r1', 'OLLAMA_LOCAL'), toolCall('r1'),
      ev({
        type: 'PENDING_APPROVAL', requestId: 'r1',
        message: 'Tool filesystem__write_file requires approval',
        metadata: { approvalId: 'a1', toolName: 'filesystem__write_file', args: { path: '/x' } },
      }),
    ];
    render(<TorqTerminal />);

    // Steps collapsed by default, yet the approval card's buttons are live.
    expect(screen.getByText(/2 steps ▸/)).toBeInTheDocument();
    expect(screen.getByText('Allow once')).toBeInTheDocument();
    expect(screen.getByText('Deny')).toBeInTheDocument();
  });

  it('errors stay visible with their recovery chips', () => {
    stream.events = [
      userPrompt('r1', 'do it'), tierSelected('r1', 'API_EXTERNAL'),
      ev({
        type: 'ERROR', requestId: 'r1', message: 'Task failed',
        metadata: { recovery: ['RETRY', 'COPY_DIAGNOSTIC'], prompt: 'do it' },
      }),
    ];
    render(<TorqTerminal />);

    expect(screen.getByText(/Something went wrong/)).toBeInTheDocument();
    expect(screen.getByText('retry')).toBeInTheDocument();
  });

  it('session-level frames (no requestId) render outside any card, unchanged', () => {
    stream.events = [
      result('r0', 'earlier'),
      ev({ type: 'SYSTEM', message: 'Memory: 2 episode(s) this session', metadata: { memory: 'SHOW', episodes: [] } }),
    ];
    render(<TorqTerminal />);
    expect(screen.getByText('Memory: 2 episode(s) this session')).toBeInTheDocument();
  });
});
