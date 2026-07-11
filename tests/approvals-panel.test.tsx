// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { GatewayEvent } from '@torqclaw/contracts';
import ApprovalHistoryPanel from '../apps/console/src/components/ApprovalHistoryPanel.js';

afterEach(cleanup); // LOAD-BEARING: root config has no globals:true, so RTL
                    // auto-cleanup is off; without this a second render leaks
                    // and corrupts getAllByRole('button') counts (G1R RC-4).

// local event factory (mirror tests/friendly.test.ts:30-41)
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

function approvalListFrame(approvals: unknown): GatewayEvent {
  return ev({ type: 'SYSTEM', metadata: { approvalList: true, approvals } });
}

function approvalRow(overrides: Record<string, unknown> = {}) {
  return {
    approvalId: 'appr-1',
    requestId: 'req-1',
    toolName: 'filesystem__write_file',
    status: 'pending',
    createdAt: '2026-01-01 00:00:00',
    decidedAt: null,
    ...overrides,
  };
}

// skill approval PENDING_APPROVAL shape (queueId, no approvalId) — must never
// synthesize a history row (P15/invariant 1/A17).
function skillApprovalEvent(): GatewayEvent {
  return ev({
    type: 'PENDING_APPROVAL',
    message: 'Learned a new skill',
    metadata: { queueId: 'queue-1', skillName: 'do-thing' },
  });
}

const READ_ONLY_ALLOWLIST = new Set(['LIST_APPROVALS']);
const DANGEROUS_ACTIONS = new Set(['SUBMIT_PROMPT', 'CANCEL_TASK', 'APPROVE_TOOL', 'APPROVE_SKILL']);

function renderPanel(events: GatewayEvent[], sc = vi.fn(() => true), decidedCount = 0, onClose = vi.fn()) {
  return render(<ApprovalHistoryPanel events={events} sendCommand={sc} onClose={onClose} decidedCount={decidedCount} />);
}

describe('ApprovalHistoryPanel', () => {
  it('P1. mount dispatch: exactly once, exact shape {action: LIST_APPROVALS, limit: 20}', () => {
    const sc = vi.fn(() => true);
    renderPanel([], sc);
    expect(sc).toHaveBeenCalledTimes(1);
    expect(sc).toHaveBeenCalledWith({ action: 'LIST_APPROVALS', limit: 20 });
  });

  it('P2. positive foundation: one frame with pending+approved+rejected rows all visible', () => {
    const frame = approvalListFrame([
      approvalRow({ approvalId: 'a1', toolName: 'tool_pending', status: 'pending' }),
      approvalRow({ approvalId: 'a2', toolName: 'tool_approved', status: 'approved', decidedAt: '2026-01-01 00:05:00' }),
      approvalRow({ approvalId: 'a3', toolName: 'tool_rejected', status: 'rejected', decidedAt: '2026-01-01 00:06:00' }),
    ]);
    renderPanel([frame]);

    expect(screen.getByText('tool_pending')).toBeInTheDocument();
    expect(screen.getByText('tool_approved')).toBeInTheDocument();
    expect(screen.getByText('tool_rejected')).toBeInTheDocument();
    expect(screen.getByText('pending')).toBeInTheDocument();
    expect(screen.getByText('approved')).toBeInTheDocument();
    expect(screen.getByText('denied')).toBeInTheDocument();
  });

  it('P3. denied copy pin: visible "denied" present, visible "rejected" absent (raw allowed only in title)', () => {
    const frame = approvalListFrame([
      approvalRow({ approvalId: 'a3', toolName: 'tool_rejected', status: 'rejected', decidedAt: '2026-01-01 00:06:00' }),
    ]);
    renderPanel([frame]);

    const statusNode = screen.getByText('denied');
    expect(statusNode).toBeInTheDocument();
    expect(screen.queryByText('rejected')).not.toBeInTheDocument();
    // raw value IS allowed via title tooltip (Q10 house convention).
    expect(statusNode.getAttribute('title')).toBe('rejected');
  });

  it('P4. structural inertness: per-row zero buttons AND zero links, INCLUDING a pending row (anti-vacuous)', () => {
    const frame = approvalListFrame([
      approvalRow({ approvalId: 'a1', toolName: 'tool_pending', status: 'pending' }),
      approvalRow({ approvalId: 'a2', toolName: 'tool_approved', status: 'approved', decidedAt: '2026-01-01 00:05:00' }),
    ]);
    renderPanel([frame]);

    // Positive presence FIRST (anti-vacuous): the pending row actually rendered.
    const pendingToolNode = screen.getByText('tool_pending');
    expect(pendingToolNode).toBeInTheDocument();

    const pendingRow = pendingToolNode.closest('li')!;
    expect(within(pendingRow).queryAllByRole('button')).toHaveLength(0);
    expect(within(pendingRow).queryAllByRole('link')).toHaveLength(0);

    const approvedRow = screen.getByText('tool_approved').closest('li')!;
    expect(within(approvedRow).queryAllByRole('button')).toHaveLength(0);
    expect(within(approvedRow).queryAllByRole('link')).toHaveLength(0);
  });

  it('P5. click-everything: every button in the panel clicked; dispatched actions subset of {LIST_APPROVALS}', () => {
    const sc = vi.fn(() => true);
    const frame = approvalListFrame([approvalRow()]);
    const onClose = vi.fn();
    renderPanel([frame], sc, 0, onClose);

    // Positive presence.
    expect(screen.getByText('Approval History')).toBeInTheDocument();

    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) fireEvent.click(b);

    const actions = sc.mock.calls.map((c) => (c[0] as any).action);
    expect(actions.length).toBeGreaterThan(0);
    for (const a of actions) expect(READ_ONLY_ALLOWLIST.has(a)).toBe(true);
    for (const a of actions) expect(DANGEROUS_ACTIONS.has(a)).toBe(false);
  });

  it('P6. no actor/decided-by/expire/ttl text after positive row presence', () => {
    const frame = approvalListFrame([
      approvalRow({ status: 'approved', decidedAt: '2026-01-01 00:05:00' }),
    ]);
    renderPanel([frame]);

    expect(screen.getByText('filesystem__write_file')).toBeInTheDocument();
    expect(screen.queryByText(/actor/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/decided by/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/expire/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/ttl/i)).not.toBeInTheDocument();
  });

  it('P7. history not gated by decided map: a row still renders even though decidedCount > 0', () => {
    const frame = approvalListFrame([approvalRow({ status: 'approved', decidedAt: '2026-01-01 00:05:00' })]);
    renderPanel([frame], vi.fn(() => true), 1);
    expect(screen.getByText('filesystem__write_file')).toBeInTheDocument();
  });

  it('P8. loading(null) !== empty([]): no frame -> Loading present, empty-copy absent; [] frame -> empty-copy exact, loading absent', () => {
    const { unmount } = renderPanel([]);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByText('No tool approval requests in this session yet.')).not.toBeInTheDocument();
    unmount();
    cleanup();

    const frame = approvalListFrame([]);
    renderPanel([frame]);
    expect(screen.getByText('No tool approval requests in this session yet.')).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });

  it('P9. malformed frames: good-then-malformed keeps good rows; malformed-alone stays loading, no crash; missing toolName -> (unknown)', () => {
    const good = approvalListFrame([approvalRow({ toolName: 'good_tool' })]);
    const malformed = ev({ type: 'SYSTEM', metadata: { approvalList: true, approvals: 'nope' } });
    const { rerender, unmount } = renderPanel([good]);
    expect(screen.getByText('good_tool')).toBeInTheDocument();

    rerender(<ApprovalHistoryPanel events={[good, malformed]} sendCommand={vi.fn(() => true)} onClose={vi.fn()} decidedCount={0} />);
    expect(screen.getByText('good_tool')).toBeInTheDocument();
    unmount();
    cleanup();

    expect(() => renderPanel([malformed])).not.toThrow();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    unmount();
    cleanup();

    const missingName = approvalListFrame([approvalRow({ toolName: undefined })]);
    renderPanel([missingName]);
    expect(screen.getByText('(unknown)')).toBeInTheDocument();
  });

  it('P10. unknown status: literal "expired" rendered; "denied" absent; no pending styling/wording', () => {
    const frame = approvalListFrame([approvalRow({ status: 'expired' })]);
    renderPanel([frame]);

    const statusNode = screen.getByText('expired');
    expect(statusNode).toBeInTheDocument();
    expect(screen.queryByText('denied')).not.toBeInTheDocument();
    expect(screen.queryByText('pending')).not.toBeInTheDocument();
    // neutral tone, not the amber pending class.
    expect(statusNode.className).not.toMatch(/amber/);
  });

  it('P11. last-wins + refresh re-query: frame A (1 row) then frame B (2 rows) -> B wins; refresh -> total calls = 2', () => {
    const sc = vi.fn(() => true);
    const frameA = approvalListFrame([approvalRow({ approvalId: 'aX', toolName: 'only_a' })]);
    const frameB = approvalListFrame([
      approvalRow({ approvalId: 'b1', toolName: 'b_one' }),
      approvalRow({ approvalId: 'b2', toolName: 'b_two' }),
    ]);
    const { rerender } = renderPanel([frameA], sc);
    expect(screen.getByText('only_a')).toBeInTheDocument();

    rerender(<ApprovalHistoryPanel events={[frameA, frameB]} sendCommand={sc} onClose={vi.fn()} decidedCount={0} />);
    expect(screen.queryByText('only_a')).not.toBeInTheDocument();
    expect(screen.getByText('b_one')).toBeInTheDocument();
    expect(screen.getByText('b_two')).toBeInTheDocument();

    fireEvent.click(screen.getByText('refresh'));
    expect(sc).toHaveBeenCalledTimes(2);
  });

  it('P12. eviction survival: rerender with events=[] -> rows persist, no Loading regression', () => {
    const sc = vi.fn(() => true);
    const frame = approvalListFrame([approvalRow({ toolName: 'sticky_tool' })]);
    const { rerender } = renderPanel([frame], sc);
    expect(screen.getByText('sticky_tool')).toBeInTheDocument();

    rerender(<ApprovalHistoryPanel events={[]} sendCommand={sc} onClose={vi.fn()} decidedCount={0} />);
    expect(screen.getByText('sticky_tool')).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });

  it('P13. staleness: decidedCount 0->1 while open -> second LIST_APPROVALS; RC-4 seam pin: same count on rerender does NOT grow calls', () => {
    const sc = vi.fn(() => true);
    const frame = approvalListFrame([approvalRow()]);
    const { rerender } = renderPanel([frame], sc, 0);
    expect(sc).toHaveBeenCalledTimes(1);

    rerender(<ApprovalHistoryPanel events={[frame]} sendCommand={sc} onClose={vi.fn()} decidedCount={1} />);
    expect(sc).toHaveBeenCalledTimes(2);
    expect(sc).toHaveBeenNthCalledWith(2, { action: 'LIST_APPROVALS', limit: 20 });

    // RC-4 seam: rerendering with the SAME count must not re-dispatch. This
    // is the reason the effect is keyed on a monotonic NUMBER, not the
    // `decided` map object — a map's per-render identity changes even when
    // its contents don't, which would loop this effect forever if it were
    // wired to the map instead of Object.keys(decided).length.
    rerender(<ApprovalHistoryPanel events={[frame]} sendCommand={sc} onClose={vi.fn()} decidedCount={1} />);
    expect(sc).toHaveBeenCalledTimes(2);
  });

  it('P14. timestamps: SQLite shape renders + " UTC"; "Invalid Date" nowhere; non-matching shape verbatim, no suffix', () => {
    const frame = approvalListFrame([
      approvalRow({ approvalId: 'a1', createdAt: '2026-01-01 00:00:00', decidedAt: null }),
      approvalRow({ approvalId: 'a2', toolName: 'other_tool', createdAt: 'garbage-shape', decidedAt: null }),
    ]);
    renderPanel([frame]);

    expect(screen.getByText(/requested 2026-01-01 00:00:00 UTC/)).toBeInTheDocument();
    expect(screen.queryByText(/Invalid Date/)).not.toBeInTheDocument();
    expect(screen.getByText(/requested garbage-shape/)).toBeInTheDocument();
    expect(screen.queryByText(/garbage-shape UTC/)).not.toBeInTheDocument();
  });

  it('P15. skill PENDING_APPROVAL (queueId) in events -> zero derived rows', () => {
    const frame = approvalListFrame([]);
    renderPanel([frame, skillApprovalEvent()]);
    expect(screen.getByText('No tool approval requests in this session yet.')).toBeInTheDocument();
    expect(screen.queryByText('do-thing')).not.toBeInTheDocument();
  });

  it('P16. close calls onClose; send-failed shows S2 copy; timeout shows S3; S6/S7 refresh-over-data', async () => {
    const onClose = vi.fn();
    const { unmount } = renderPanel([], vi.fn(() => true), 0, onClose);
    fireEvent.click(screen.getByLabelText('Close approvals panel'));
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    cleanup();

    // S2: sendCommand returns false -> sendFailed copy, no timer armed.
    const scFail = vi.fn(() => false);
    renderPanel([], scFail);
    expect(screen.getByText(/couldn't request the approval list — connection may be reconnecting; try again/)).toBeInTheDocument();
    cleanup();

    // S3: timeout with no data ever received.
    vi.useFakeTimers();
    try {
      const scTimeout = vi.fn(() => true);
      renderPanel([], scTimeout);
      await act(async () => {
        vi.advanceTimersByTime(4999);
      });
      expect(screen.queryByText('No response — refresh to try again.')).not.toBeInTheDocument();
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(screen.getByText('No response — refresh to try again.')).toBeInTheDocument();
      cleanup();

      // S6/S7: refresh-over-data.
      const scRefresh = vi.fn(() => true);
      const frame = approvalListFrame([approvalRow({ toolName: 'still_here' })]);
      const { rerender } = renderPanel([frame], scRefresh);
      fireEvent.click(screen.getByText('refresh'));
      expect(screen.getByText('refreshing…')).toBeInTheDocument();
      expect(screen.getByText('still_here')).toBeInTheDocument(); // list stays

      await act(async () => {
        vi.advanceTimersByTime(5000);
      });
      expect(screen.getByText(/Refresh didn't return — showing the last list received\./)).toBeInTheDocument();
      expect(screen.getByText('still_here')).toBeInTheDocument();
      expect(screen.getByText('refresh')).toBeInTheDocument(); // reverted from "refreshing…"

      // Cleared on next successful snapshot.
      const frame2 = approvalListFrame([approvalRow({ toolName: 'still_here' })]);
      rerender(<ApprovalHistoryPanel events={[frame, frame2]} sendCommand={scRefresh} onClose={vi.fn()} decidedCount={0} />);
      expect(screen.queryByText(/Refresh didn't return/)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('footer permanent copy present in S4-S7 (loaded-empty case)', () => {
    const frame = approvalListFrame([]);
    renderPanel([frame]);
    expect(screen.getByText('Tool approvals only — skill approvals are not shown in this history.')).toBeInTheDocument();
    expect(screen.getByText('Read-only. Pending requests are decided from their card in the terminal, not from this list.')).toBeInTheDocument();
    expect(screen.getByText('Statuses are as of the last refresh.')).toBeInTheDocument();
  });

  it('truncation caption: exactly 20 rows -> "Showing the 20 most recent."; fewer -> caption absent', () => {
    const rows20 = Array.from({ length: 20 }, (_, i) => approvalRow({ approvalId: `a${i}`, toolName: `tool_${i}` }));
    const frame = approvalListFrame(rows20);
    const { unmount } = renderPanel([frame]);
    expect(screen.getByText('Showing the 20 most recent.')).toBeInTheDocument();
    unmount();
    cleanup();

    const frameFew = approvalListFrame([approvalRow()]);
    renderPanel([frameFew]);
    expect(screen.queryByText('Showing the 20 most recent.')).not.toBeInTheDocument();
  });
});
