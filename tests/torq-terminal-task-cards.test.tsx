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

    // Prompt is the header line, weight 600. getAllByText: the sidebar
    // session-title line (§3) ALSO echoes the first USER_PROMPT verbatim, so
    // assert the CARD's own prompt span by its font-semibold class among all
    // matches — the sidebar copy is plain text-ink (no weight class).
    const prompts = screen.getAllByText('summarize this');
    const cardPrompt = prompts.find((el) => el.className.includes('font-semibold'));
    expect(cardPrompt).toBeDefined();

    // Route chip: local renders green per tokens (never red — red is reserved).
    // Card head chip text is the short 'local' label (§4b); the longer
    // 'on this machine' copy now lives only on the loose 2C route-explainer
    // line below the stream, which carries no color class of its own.
    const chip = screen.getByText('local');
    expect(chip.className).toContain('text-good');

    // ONE VISIBLE <time> for the whole task: the card header's own <time> is
    // the only one outside the collapsed-plumbing wrapper. The plumbing rows
    // (§4c) are always mounted with hideTimestamp=false — collapse is done
    // via a max-height CSS clip (for the 320ms expand transition), not
    // conditional unmount — so their <time> elements exist in the DOM but
    // are visually clipped inside the max-h-0 wrapper. Assert the header's
    // time is the only one OUTSIDE that clipped wrapper.
    const allTimes = Array.from(container.querySelectorAll('time'));
    const visibleTimes = allTimes.filter((t) => !t.closest('.max-h-0'));
    expect(visibleTimes).toHaveLength(1);
    expect(allTimes.length).toBeGreaterThan(1); // sanity: plumbing rows really do carry hidden clocks
  });

  it('cloud route chip renders cyan, never red', () => {
    stream.events = [userPrompt('r1', 'deep research'), tierSelected('r1', 'API_EXTERNAL'), toolCall('r1')];
    render(<TorqTerminal />);
    // Card head chip text is the short 'cloud' label (§4b).
    const cardChip = screen.getByText('cloud');
    expect(cardChip.className).toContain('text-cloud');
    expect(cardChip.className).not.toContain('#E24B4A');
  });

  it('plumbing collapses to "N STEPS", default collapsed; expanding reveals the rows', () => {
    stream.events = [userPrompt('r1', 'do it'), tierSelected('r1', 'OLLAMA_LOCAL'), toolCall('r1')];
    render(<TorqTerminal />);

    // Two plumbing events (TIER_SELECTED + TOOL_CALL), collapsed by default.
    // The toggle row is "▶ 2 steps · hermes kernel" (spec §4c); the chevron
    // is a single glyph that ROTATES via a CSS class on open rather than
    // swapping to a different character — pin the row by its stable text.
    //
    // Mechanism change from the pre-redesign component: the plumbing body is
    // now ALWAYS mounted (never conditionally rendered) and collapse is done
    // via a max-height CSS clip so the 320ms expand transition (§4c) has
    // something to animate — so the row's text is present in the DOM even
    // while collapsed. The real collapse signal is the wrapper's max-height
    // class and the toggle's aria-expanded flag; assert those instead of
    // DOM presence/absence of the row text.
    const toggle = screen.getByText(/2 steps · hermes kernel/);
    const toggleButton = toggle.closest('button')!;
    const body = screen.getByText('Using read file (filesystem)').closest('.overflow-hidden')!;
    expect(toggleButton).toHaveAttribute('aria-expanded', 'false');
    expect(body.className).toContain('max-h-0');

    fireEvent.click(toggle);
    expect(toggleButton).toHaveAttribute('aria-expanded', 'true');
    expect(body.className).toContain('max-h-[400px]');
    expect(screen.getByText('Using read file (filesystem)')).toBeInTheDocument();
  });

  it('the answer renders as the hero with the ANSWER eyebrow', () => {
    stream.events = [userPrompt('r1', 'question'), tierSelected('r1', 'OLLAMA_LOCAL'), result('r1', 'the final answer')];
    render(<TorqTerminal />);

    // Eyebrow's DOM text is title-case "Answer" — CSS applies the ALL-CAPS
    // display (uppercase + letter-spacing per §4d), the text node itself is
    // never mutated to literal caps.
    expect(screen.getByText('Answer')).toBeInTheDocument();
    expect(screen.getByText('the final answer')).toBeInTheDocument();
  });

  it('receipt renders as a chip row: done + cost + latency', () => {
    stream.events = [
      userPrompt('r1', 'question'), tierSelected('r1', 'API_EXTERNAL'),
      toolCall('r1'), result('r1', 'answer'), doneReceipt('r1'),
    ];
    render(<TorqTerminal />);

    // §4f: the good chip pairs an SVG checkmark glyph with lowercase text
    // "done" — the DOM text node is 'done', never 'Done' (no CSS transform
    // applied to this chip; the spec's "✓ done" glyph is the SVG check icon
    // preceding the text, not a literal ✓ character).
    expect(screen.getByText('done')).toBeInTheDocument();
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
    const toggle = screen.getByText(/2 steps · hermes kernel/);
    expect(toggle.closest('button')).toHaveAttribute('aria-expanded', 'false');
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
