// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { GatewayEvent } from '@torqclaw/contracts';
import ReceiptsPanel from '../apps/console/src/components/ReceiptsPanel.js';

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

function receiptListFrame(receipts: Record<string, unknown>[]): GatewayEvent {
  return ev({ type: 'SYSTEM', metadata: { receiptList: true, receipts } });
}

function receiptViewFrame(meta: Record<string, unknown>): GatewayEvent {
  return ev({ type: 'SYSTEM', metadata: { receiptView: true, ...meta } });
}

// The dangerous shapes: exactly what the LIVE EventRow in TorqTerminal would
// turn into Allow/Deny/retry buttons (see TorqTerminal.tsx EventRow — a
// PENDING_APPROVAL with metadata.approvalId or metadata.queueId, or an ERROR
// with metadata.recovery). Fed into replay to prove ReplayEventRow renders
// them as INERT text only.
function toolApprovalEvent(seq: number): GatewayEvent {
  return ev({
    seq,
    type: 'PENDING_APPROVAL',
    message: 'Wants to run a tool',
    metadata: { approvalId: 'appr-1', toolName: 'filesystem__read_file' },
  });
}
function skillApprovalEvent(seq: number): GatewayEvent {
  return ev({
    seq,
    type: 'PENDING_APPROVAL',
    message: 'Learned a new skill',
    metadata: { queueId: 'queue-1', skillName: 'do-thing' },
  });
}
function errorWithRecoveryEvent(seq: number): GatewayEvent {
  return ev({
    seq,
    type: 'ERROR',
    message: 'Task failed',
    metadata: { recovery: ['RETRY'], prompt: 'do it again' },
  });
}

const minimalReceipt = (taskId: string) => ({
  taskId,
  sessionId: 's',
  sourceChannel: 'cli',
  selectedTier: 'OLLAMA_LOCAL',
  resultState: 'completed',
  costUsd: 1,
});

// Read-only allowlist for this panel — GET_RECEIPT is legitimate for
// drill-down; nothing else may be dispatched from anywhere in this tree.
const READ_ONLY_ALLOWLIST = new Set(['LIST_RECEIPTS', 'GET_RECEIPT']);

describe('ReceiptsPanel', () => {
  it('1. Mount dispatch: sends LIST_RECEIPTS exactly once on mount', () => {
    const sc = vi.fn(() => true);
    render(<ReceiptsPanel events={[]} sendCommand={sc} onClose={vi.fn()} />);
    expect(sc).toHaveBeenCalledTimes(1);
    expect(sc).toHaveBeenCalledWith({ action: 'LIST_RECEIPTS', limit: 20 });
  });

  it('2. Replay read-only teeth (RC-3, load-bearing): dangerous shapes render inert; every button click stays within the allowlist', () => {
    const sc = vi.fn(() => true);
    const listFrame = receiptListFrame([{ taskId: 'tX', resultState: 'completed', costUsd: 1 }]);

    const { rerender } = render(
      <ReceiptsPanel events={[listFrame]} sendCommand={sc} onClose={vi.fn()} />,
    );

    // Select the row -> dispatches GET_RECEIPT.
    fireEvent.click(screen.getByText('tX'));
    expect(sc).toHaveBeenCalledWith({ action: 'GET_RECEIPT', taskId: 'tX', includeEvents: true });

    // Feed the receiptView frame carrying the dangerous shapes.
    const viewFrame = receiptViewFrame({
      taskId: 'tX',
      receipt: minimalReceipt('tX'),
      taskPrompt: 'do the thing',
      events: [toolApprovalEvent(1), skillApprovalEvent(2), errorWithRecoveryEvent(3)],
    });
    rerender(<ReceiptsPanel events={[listFrame, viewFrame]} sendCommand={sc} onClose={vi.fn()} />);

    // Switch to the Replay tab.
    fireEvent.click(screen.getByText('Replay'));

    // Positive presence (anti-vacuous): the dangerous rows actually rendered
    // as historical/inert text in the replay tree.
    expect(screen.getByText(/historical — replay only, no retry/)).toBeInTheDocument();
    expect(screen.getAllByText(/\(historical/).length).toBeGreaterThanOrEqual(1);

    // Negative teeth: no actionable button anywhere (name-regex check).
    expect(
      screen.queryByRole('button', { name: /approve|allow|deny|reject|retry|resend|run/i }),
    ).not.toBeInTheDocument();

    // Click EVERY button rendered in the whole panel (list row, tabs, close,
    // etc.) and assert the dispatched action-set is a SUBSET of the
    // read-only allowlist. This proves no replayed row can dispatch
    // APPROVE_TOOL/APPROVE_SKILL/SUBMIT_PROMPT even if a future button
    // slipped the name-regex above.
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) fireEvent.click(b);

    const actions = sc.mock.calls.map((c) => (c[0] as any).action);
    expect(actions.length).toBeGreaterThan(0);
    for (const a of actions) expect(READ_ONLY_ALLOWLIST.has(a)).toBe(true);
  });

  it('3. Open-detail snapshot survives eviction (point 4): detail content persists after the receiptView frame is evicted from events', () => {
    const sc = vi.fn(() => true);
    const listFrame = receiptListFrame([{ taskId: 'tX', resultState: 'completed', costUsd: 1 }]);
    const viewFrame = receiptViewFrame({
      taskId: 'tX',
      receipt: minimalReceipt('tX'),
      taskPrompt: 'do the thing',
      events: [],
    });

    const { rerender } = render(
      <ReceiptsPanel events={[listFrame]} sendCommand={sc} onClose={vi.fn()} />,
    );
    fireEvent.click(screen.getByText('tX'));
    rerender(<ReceiptsPanel events={[listFrame, viewFrame]} sendCommand={sc} onClose={vi.fn()} />);

    // Detail content is showing (taskId appears in the Identity section).
    expect(screen.getAllByText('tX').length).toBeGreaterThanOrEqual(1);

    // EVICT the receiptView frame (e.g. ring buffer trimmed it) but keep the
    // panel mounted with the list frame only.
    rerender(<ReceiptsPanel events={[listFrame]} sendCommand={sc} onClose={vi.fn()} />);

    // The useState snapshot (openReceipt) must have survived — the detail
    // still shows tX's content, it did NOT clear on the frame going absent.
    expect(screen.getAllByText('tX').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });

  it('4. Oversize marker renders when events is null with eventsOmitted', () => {
    const sc = vi.fn(() => true);
    const listFrame = receiptListFrame([{ taskId: 'tX', resultState: 'completed', costUsd: 1 }]);
    const viewFrame = receiptViewFrame({
      taskId: 'tX',
      receipt: minimalReceipt('tX'),
      taskPrompt: 'do the thing',
      events: null,
      eventsOmitted: { reason: 'too_large', eventCount: 5000, evidenceStartSeq: 1, evidenceEndSeq: 5000 },
    });

    const { rerender } = render(
      <ReceiptsPanel events={[listFrame]} sendCommand={sc} onClose={vi.fn()} />,
    );
    fireEvent.click(screen.getByText('tX'));
    rerender(<ReceiptsPanel events={[listFrame, viewFrame]} sendCommand={sc} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('Replay'));

    expect(screen.getByText(/Replay too large to load/)).toBeVisible();
  });

  it('5. NULL/unavailable cost honesty: costUsd null renders "not recorded", never "$0.00"', () => {
    const sc = vi.fn(() => true);
    const listFrame = receiptListFrame([{ taskId: 'tX', resultState: 'completed', costUsd: 1 }]);
    const viewFrame = receiptViewFrame({
      taskId: 'tX',
      receipt: { ...minimalReceipt('tX'), costUsd: null },
      taskPrompt: 'do the thing',
      events: [],
    });

    const { rerender } = render(
      <ReceiptsPanel events={[listFrame]} sendCommand={sc} onClose={vi.fn()} />,
    );
    fireEvent.click(screen.getByText('tX'));
    rerender(<ReceiptsPanel events={[listFrame, viewFrame]} sendCommand={sc} onClose={vi.fn()} />);

    // Scope to the Cost section specifically — a minimal receipt with no
    // budgetLimit/budgetSource/costEnforceable also legitimately renders
    // "not recorded" for those honest-absence fields (and in Execution /
    // Evidence), which isn't the bug under test here; assert the Cost
    // section's "cost" row specifically.
    const costHeading = screen.getByText('Cost');
    const costSection = costHeading.closest('section')!;
    expect(within(costSection).getAllByText('not recorded').length).toBeGreaterThanOrEqual(1);
    expect(within(costSection).queryByText('$0.00')).not.toBeInTheDocument();
  });

  it('6. Close button calls onClose', () => {
    const onClose = vi.fn();
    render(<ReceiptsPanel events={[]} sendCommand={vi.fn(() => true)} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('Close receipts panel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
