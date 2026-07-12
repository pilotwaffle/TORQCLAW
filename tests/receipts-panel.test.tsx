// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { GatewayEvent } from '@torqclaw/contracts';
import ReceiptsPanel from '../apps/console/src/components/ReceiptsPanel.js';
import { renderSafeExportMarkdown, type SafeExportLike } from '../apps/console/src/components/friendly.js';

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
// drill-down; GET_SAFE_EXPORT (TCLAW-5B-2) is legitimate for the
// prepare-safe-export click; nothing else may be dispatched from anywhere in
// this tree.
const READ_ONLY_ALLOWLIST = new Set(['LIST_RECEIPTS', 'GET_RECEIPT', 'GET_SAFE_EXPORT']);

// ── TCLAW-5B-2 fixtures ──────────────────────────────────────────────────

function safeExportFrame(meta: Record<string, unknown>): GatewayEvent {
  return ev({ type: 'SYSTEM', message: 'Safe export', metadata: { safeExportView: true, ...meta } });
}

const fixtureSafeExport: SafeExportLike = {
  torqclawSafeExport: true,
  exportVersion: 1,
  redactorVersion: 1,
  projectionVersion: 3,
  taskId: 'tX',
  sessionId: 's',
  sourceChannel: 'cli',
  selectedTier: 'OLLAMA_LOCAL',
  state: 'terminal',
  resultState: 'completed',
  cancelled: false,
  blockedOn: null,
  route: {
    tier: 'OLLAMA_LOCAL',
    ruleId: 'LOCAL_INTENT',
    score: 10,
    overridable: false,
    safetyLock: null,
    profile: null,
    reason: 'a plain reason',
    humanReason: null,
    blockedAlternatives: null,
    routerReason: null,
  },
  cost: {
    budgetLimit: null,
    budgetSource: null,
    costUsd: 0,
    costSource: null,
    costEnforceable: null,
  },
  execution: {
    elapsedMs: 500,
    iterations: 1,
    memoryUsed: false,
    contextChars: null,
  },
  toolsCalled: ['filesystem__read_file'],
  approvals: [],
  evidence: { startSeq: 1, endSeq: 5 },
  errorClass: null,
  error: null,
  redactionReport: {
    redactorVersion: 1,
    patternsHit: { 'api-key': 2, path: 1 },
    fieldsOmitted: ['taskPrompt', 'assembledContext', 'events', 'toolCallArgs', 'results', 'approvalArgs'],
    // VARIED notice (not the real production string) to catch client-side
    // hard-coding of the notice text (spec's anti-vacuous fixture design).
    notice: 'TEST-FIXTURE-NOTICE: some shapes removed, no completeness claim made here.',
  },
};

// Selects task 'tX' via the list, mirroring every other test's flow: render
// with a list frame, click the row, which dispatches GET_RECEIPT + the row
// becomes selectedTaskId — then rerender with the receiptView frame so the
// detail tree (and its Safe-export section) actually mounts.
function selectAndOpenTX(sc: ReturnType<typeof vi.fn>) {
  const listFrame = receiptListFrame([{ taskId: 'tX', resultState: 'completed', costUsd: 1 }]);
  const viewFrame = receiptViewFrame({
    taskId: 'tX',
    receipt: minimalReceipt('tX'),
    taskPrompt: 'do the thing',
    events: [],
  });
  const { rerender } = render(<ReceiptsPanel events={[listFrame]} sendCommand={sc} onClose={vi.fn()} />);
  fireEvent.click(screen.getByText('tX'));
  rerender(<ReceiptsPanel events={[listFrame, viewFrame]} sendCommand={sc} onClose={vi.fn()} />);
  return { listFrame, viewFrame, rerender };
}

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
    // as historical/inert text in the replay tree — so the "no button"
    // assertions below cannot pass merely because nothing rendered.
    const historicalError = screen.getByText(/historical — replay only, no retry/);
    expect(historicalError).toBeInTheDocument();
    expect(screen.getAllByText(/\(historical/).length).toBeGreaterThanOrEqual(1);

    // STRUCTURAL TEETH (G2A finding #1 fix): the replay SUBTREE — the
    // container that actually holds the replayed rows — must contain ZERO
    // buttons. This is the real invariant (ReplayEventRow has no dispatch
    // surface, ReceiptsPanel.tsx:343-361) and is UN-BYPASSABLE: it does not
    // depend on button labels (a dangerous button named "proceed" would still
    // be counted) and cannot be defeated by click-ordering / unmount-on-nav
    // (the earlier click-every-button loop was — a navigating button unmounted
    // the replay tree before the loop reached a dangerous row). We locate the
    // replay container as the nearest ancestor of the replayed rows that is
    // scoped to the replay content (not the tab bar above it): the shared
    // ancestor of the historical-error row and the "(historical" approval
    // rows. Asserting zero buttons there proves no replayed PENDING_APPROVAL
    // (APPROVE_TOOL/APPROVE_SKILL) or ERROR (SUBMIT_PROMPT/retry) row can ever
    // dispatch, regardless of label.
    const replayContainer = historicalError.closest('div.space-y-1') as HTMLElement | null;
    expect(replayContainer).not.toBeNull();
    expect(within(replayContainer!).queryAllByRole('button')).toHaveLength(0);

    // Secondary (whole-panel) guard: clicking every button the panel exposes
    // (close, tabs, list row) only ever dispatches read-only reads. This is a
    // subset check on the NON-replay affordances; the replay subtree's inertness
    // is guaranteed structurally by the zero-button assertion above.
    for (const b of screen.getAllByRole('button')) fireEvent.click(b);
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

// ── TCLAW-5B-2: Safe-export section ─────────────────────────────────────
describe('ReceiptsPanel — Safe export section', () => {
  it('T1 [op#1] dispatch exact {action:GET_SAFE_EXPORT, taskId} on the prepare click', () => {
    const sc = vi.fn(() => true);
    selectAndOpenTX(sc);

    fireEvent.click(screen.getByText('prepare safe export'));

    expect(sc).toHaveBeenCalledWith({ action: 'GET_SAFE_EXPORT', taskId: 'tX' });
  });

  it('T2 [op#2] NO prefetch: opening a receipt row dispatches GET_RECEIPT only — no GET_SAFE_EXPORT until the prepare click', () => {
    const sc = vi.fn(() => true);
    selectAndOpenTX(sc);

    const actions = sc.mock.calls.map((c) => (c[0] as any).action);
    expect(actions).not.toContain('GET_SAFE_EXPORT');
    expect(actions).toContain('GET_RECEIPT');
  });

  it('T3 [op#3] pending disables: two rapid clicks -> dispatch count === 1', () => {
    const sc = vi.fn(() => true);
    selectAndOpenTX(sc);

    const btn = screen.getByText('prepare safe export');
    fireEvent.click(btn);
    // Button must now be disabled ("preparing…") — a second click on the
    // SAME element (already unmounted/replaced by the disabled button) must
    // not add a second dispatch.
    const disabledBtn = screen.getByText('preparing…');
    expect(disabledBtn).toBeDisabled();
    fireEvent.click(disabledBtn);

    const calls = sc.mock.calls.filter((c) => (c[0] as any).action === 'GET_SAFE_EXPORT');
    expect(calls.length).toBe(1);
  });

  it('T4 [op#4] ready renders the report ABOVE the copy buttons (DOM-order), stamps line exact, removed rows, never-included row, notice from fixture', () => {
    const sc = vi.fn(() => true);
    const { listFrame, viewFrame, rerender } = selectAndOpenTX(sc);
    fireEvent.click(screen.getByText('prepare safe export'));

    const frame = safeExportFrame({ taskId: 'tX', safeExport: fixtureSafeExport });
    rerender(<ReceiptsPanel events={[listFrame, viewFrame, frame]} sendCommand={sc} onClose={vi.fn()} />);

    // Positive presence first (anti-vacuous).
    expect(screen.getByText('Redaction report')).toBeInTheDocument();
    expect(screen.getByText('copy JSON')).toBeInTheDocument();
    expect(screen.getByText('copy Markdown')).toBeInTheDocument();

    // DOM-order: the report heading must precede the copy buttons in
    // document order.
    const reportHeading = screen.getByText('Redaction report');
    const copyJsonBtn = screen.getByText('copy JSON');
    const position = reportHeading.compareDocumentPosition(copyJsonBtn);
    // DOCUMENT_POSITION_FOLLOWING (4) means copyJsonBtn comes AFTER reportHeading.
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Stamps line exact.
    expect(screen.getByText('export v1 · redactor v1 · projection v3')).toBeInTheDocument();

    // "{n} removed" rows in payload order.
    expect(screen.getByText('api-key')).toBeInTheDocument();
    expect(screen.getByText('2 removed')).toBeInTheDocument();
    expect(screen.getByText('path')).toBeInTheDocument();
    expect(screen.getByText('1 removed')).toBeInTheDocument();

    // "never included" row.
    expect(screen.getByText('never included')).toBeInTheDocument();
    expect(screen.getByText('taskPrompt, assembledContext, events, toolCallArgs, results, approvalArgs')).toBeInTheDocument();

    // notice rendered FROM the payload — the fixture uses a VARIED notice
    // string specifically to catch client-side hard-coding.
    expect(screen.getByText(fixtureSafeExport.redactionReport!.notice!)).toBeInTheDocument();
  });

  it('T5 [op#5,6] copy JSON: writeText called with EXACTLY JSON.stringify(fixture.safeExport, null, 2); parsed first key === torqclawSafeExport', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const sc = vi.fn(() => true);
    const { listFrame, viewFrame, rerender } = selectAndOpenTX(sc);
    fireEvent.click(screen.getByText('prepare safe export'));
    const frame = safeExportFrame({ taskId: 'tX', safeExport: fixtureSafeExport });
    rerender(<ReceiptsPanel events={[listFrame, viewFrame, frame]} sendCommand={sc} onClose={vi.fn()} />);

    await act(async () => {
      fireEvent.click(screen.getByText('copy JSON'));
    });

    const expected = JSON.stringify(fixtureSafeExport, null, 2);
    expect(writeText).toHaveBeenCalledWith(expected);
    const parsed = JSON.parse(writeText.mock.calls[0][0] as string);
    expect(Object.keys(parsed)[0]).toBe('torqclawSafeExport');

    // @ts-expect-error test cleanup of a test-local stub
    delete (navigator as any).clipboard;
  });

  it('T6 [op#7,8] copy Markdown: writeText called with EXACTLY renderSafeExportMarkdown(fixture.safeExport)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const sc = vi.fn(() => true);
    const { listFrame, viewFrame, rerender } = selectAndOpenTX(sc);
    fireEvent.click(screen.getByText('prepare safe export'));
    const frame = safeExportFrame({ taskId: 'tX', safeExport: fixtureSafeExport });
    rerender(<ReceiptsPanel events={[listFrame, viewFrame, frame]} sendCommand={sc} onClose={vi.fn()} />);

    await act(async () => {
      fireEvent.click(screen.getByText('copy Markdown'));
    });

    expect(writeText).toHaveBeenCalledWith(renderSafeExportMarkdown(fixtureSafeExport));

    // @ts-expect-error test cleanup of a test-local stub
    delete (navigator as any).clipboard;
  });

  it('T7 [op#12] export_failed: pinned no-fallback copy present; NO receipt-field text and NO copy/raw button in the section', () => {
    const sc = vi.fn(() => true);
    const { listFrame, viewFrame, rerender } = selectAndOpenTX(sc);
    fireEvent.click(screen.getByText('prepare safe export'));
    const frame = safeExportFrame({ taskId: 'tX', safeExport: null, error: 'export_failed' });
    rerender(<ReceiptsPanel events={[listFrame, viewFrame, frame]} sendCommand={sc} onClose={vi.fn()} />);

    expect(
      screen.getByText('safe export failed on the gateway — nothing to copy. This panel never falls back to raw data.'),
    ).toBeInTheDocument();

    const sectionHeading = screen.getByText('Safe export');
    const section = sectionHeading.closest('section')!;
    expect(within(section).queryByText('copy JSON')).not.toBeInTheDocument();
    expect(within(section).queryByText('copy Markdown')).not.toBeInTheDocument();
    // Sentinel-in-receipt: the taskPrompt text must not leak into this section.
    expect(within(section).queryByText(/do the thing/)).not.toBeInTheDocument();
  });

  it('T8 [op#13] all five failure/edge states render distinct copy; distinguishing text absent in other states', () => {
    // not-found
    {
      const sc = vi.fn(() => true);
      const { listFrame, viewFrame, rerender } = selectAndOpenTX(sc);
      fireEvent.click(screen.getByText('prepare safe export'));
      const frame = safeExportFrame({ taskId: 'tX', safeExport: null });
      rerender(<ReceiptsPanel events={[listFrame, viewFrame, frame]} sendCommand={sc} onClose={vi.fn()} />);
      expect(screen.getByText('No receipt for this task — nothing to export.')).toBeInTheDocument();
      expect(screen.queryByText(/exceeds the frame size limit/)).not.toBeInTheDocument();
      expect(screen.queryByText(/nothing to copy/)).not.toBeInTheDocument();
      cleanup();
    }

    // too_large
    {
      const sc = vi.fn(() => true);
      const { listFrame, viewFrame, rerender } = selectAndOpenTX(sc);
      fireEvent.click(screen.getByText('prepare safe export'));
      const frame = safeExportFrame({ taskId: 'tX', safeExport: null, exportOmitted: { reason: 'too_large' } });
      rerender(<ReceiptsPanel events={[listFrame, viewFrame, frame]} sendCommand={sc} onClose={vi.fn()} />);
      expect(screen.getByText('export exceeds the frame size limit — not available')).toBeInTheDocument();
      expect(screen.queryByText('No receipt for this task — nothing to export.')).not.toBeInTheDocument();
      expect(screen.queryByText(/nothing to copy/)).not.toBeInTheDocument();
      cleanup();
    }

    // export_failed
    {
      const sc = vi.fn(() => true);
      const { listFrame, viewFrame, rerender } = selectAndOpenTX(sc);
      fireEvent.click(screen.getByText('prepare safe export'));
      const frame = safeExportFrame({ taskId: 'tX', safeExport: null, error: 'export_failed' });
      rerender(<ReceiptsPanel events={[listFrame, viewFrame, frame]} sendCommand={sc} onClose={vi.fn()} />);
      expect(
        screen.getByText('safe export failed on the gateway — nothing to copy. This panel never falls back to raw data.'),
      ).toBeInTheDocument();
      expect(screen.queryByText('No receipt for this task — nothing to export.')).not.toBeInTheDocument();
      expect(screen.queryByText(/exceeds the frame size limit/)).not.toBeInTheDocument();
      cleanup();
    }

    // sendFailed — sendCommand returns false for the prepare click specifically.
    {
      const listFrame = receiptListFrame([{ taskId: 'tX', resultState: 'completed', costUsd: 1 }]);
      const viewFrame = receiptViewFrame({ taskId: 'tX', receipt: minimalReceipt('tX'), taskPrompt: 'do the thing', events: [] });
      const sc = vi.fn(() => true).mockReturnValueOnce(true); // GET_RECEIPT succeeds
      const { rerender } = render(<ReceiptsPanel events={[listFrame]} sendCommand={sc} onClose={vi.fn()} />);
      fireEvent.click(screen.getByText('tX'));
      rerender(<ReceiptsPanel events={[listFrame, viewFrame]} sendCommand={sc} onClose={vi.fn()} />);
      sc.mockReturnValueOnce(false); // GET_SAFE_EXPORT send fails
      fireEvent.click(screen.getByText('prepare safe export'));
      expect(screen.getByText(/couldn.t request the safe export/)).toBeInTheDocument();
      cleanup();
    }

    // timeout
    {
      vi.useFakeTimers();
      const scTimeout = vi.fn(() => true);
      const { rerender } = selectAndOpenTX(scTimeout);
      fireEvent.click(screen.getByText('prepare safe export'));
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(
        screen.getByText((_content, node) => node?.textContent === 'No response — try again.'),
      ).toBeInTheDocument();
      vi.useRealTimers();
      cleanup();
      void rerender; // keep destructure symmetry with other blocks
    }
  });

  it('T9 [op#14] row switch clears: ready for task A -> select row B -> section back to idle, A report gone', () => {
    const sc = vi.fn(() => true);
    const listFrame = receiptListFrame([
      { taskId: 'tA', resultState: 'completed', costUsd: 1 },
      { taskId: 'tB', resultState: 'completed', costUsd: 1 },
    ]);
    const viewFrameA = receiptViewFrame({ taskId: 'tA', receipt: minimalReceipt('tA'), taskPrompt: 'a', events: [] });
    const viewFrameB = receiptViewFrame({ taskId: 'tB', receipt: minimalReceipt('tB'), taskPrompt: 'b', events: [] });

    const { rerender } = render(<ReceiptsPanel events={[listFrame]} sendCommand={sc} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('tA'));
    rerender(<ReceiptsPanel events={[listFrame, viewFrameA]} sendCommand={sc} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('prepare safe export'));
    const frameA = safeExportFrame({ taskId: 'tA', safeExport: { ...fixtureSafeExport, taskId: 'tA' } });
    rerender(<ReceiptsPanel events={[listFrame, viewFrameA, frameA]} sendCommand={sc} onClose={vi.fn()} />);
    expect(screen.getByText('Redaction report')).toBeInTheDocument();

    // Switch to row B.
    fireEvent.click(screen.getByText('tB'));
    rerender(<ReceiptsPanel events={[listFrame, viewFrameA, frameA, viewFrameB]} sendCommand={sc} onClose={vi.fn()} />);

    expect(screen.queryByText('Redaction report')).not.toBeInTheDocument();
    expect(screen.getByText('prepare safe export')).toBeInTheDocument();
  });

  it('T10 eviction survival + stale-frame last-wins: frame ready -> events emptied -> still ready; second fresh frame overwrites; refreshing indicator shows mid-refresh', () => {
    const sc = vi.fn(() => true);
    const { listFrame, viewFrame, rerender } = selectAndOpenTX(sc);
    fireEvent.click(screen.getByText('prepare safe export'));
    const frame1 = safeExportFrame({ taskId: 'tX', safeExport: fixtureSafeExport });
    rerender(<ReceiptsPanel events={[listFrame, viewFrame, frame1]} sendCommand={sc} onClose={vi.fn()} />);
    expect(screen.getByText('Redaction report')).toBeInTheDocument();

    // EVICT: rerender WITHOUT the safe-export frame — snapshot must survive.
    rerender(<ReceiptsPanel events={[listFrame, viewFrame]} sendCommand={sc} onClose={vi.fn()} />);
    expect(screen.getByText('Redaction report')).toBeInTheDocument();

    // Click refresh (a genuinely fresh request) — while in flight,
    // "refreshing…" shows because a snapshot already exists.
    fireEvent.click(screen.getByText('refresh'));
    expect(screen.getByText('refreshing…')).toBeInTheDocument();

    // Second, fresher frame lands with a DIFFERENT approvals array —
    // overwrites (pinned).
    const fixtureSafeExport2: SafeExportLike = {
      ...fixtureSafeExport,
      approvals: [{ toolName: 'filesystem__write_file', status: 'approved', decidedAt: '2026-01-01 00:00:00' }],
    };
    const frame2 = safeExportFrame({ taskId: 'tX', safeExport: fixtureSafeExport2 });
    rerender(<ReceiptsPanel events={[listFrame, viewFrame, frame2]} sendCommand={sc} onClose={vi.fn()} />);

    expect(screen.queryByText('refreshing…')).not.toBeInTheDocument();
    expect(screen.getByText('Redaction report')).toBeInTheDocument();
  });

  it('T11 clipboard rejection -> no "copied" flash, honest failure copy [R9]', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.assign(navigator, { clipboard: { writeText } });

    const sc = vi.fn(() => true);
    const { listFrame, viewFrame, rerender } = selectAndOpenTX(sc);
    fireEvent.click(screen.getByText('prepare safe export'));
    const frame = safeExportFrame({ taskId: 'tX', safeExport: fixtureSafeExport });
    rerender(<ReceiptsPanel events={[listFrame, viewFrame, frame]} sendCommand={sc} onClose={vi.fn()} />);

    await act(async () => {
      fireEvent.click(screen.getByText('copy JSON'));
    });

    expect(screen.queryByText('copied')).not.toBeInTheDocument();
    expect(screen.getByText('copy JSON')).toBeInTheDocument(); // reverted to the honest un-flashed label

    // @ts-expect-error test cleanup of a test-local stub
    delete (navigator as any).clipboard;
  });

  it('T12 [op#21,22,23] click-everything allowlist subset check + empty-hits line pin', () => {
    const sc = vi.fn(() => true);
    const { listFrame, viewFrame, rerender } = selectAndOpenTX(sc);
    fireEvent.click(screen.getByText('prepare safe export'));

    const emptyHitsExport: SafeExportLike = { ...fixtureSafeExport, redactionReport: { ...fixtureSafeExport.redactionReport!, patternsHit: {} } };
    const frame = safeExportFrame({ taskId: 'tX', safeExport: emptyHitsExport });
    rerender(<ReceiptsPanel events={[listFrame, viewFrame, frame]} sendCommand={sc} onClose={vi.fn()} />);

    expect(
      screen.getByText('no known secret shapes found — known shapes only; this is not a guarantee'),
    ).toBeInTheDocument();

    for (const b of screen.getAllByRole('button')) fireEvent.click(b);
    const actions = sc.mock.calls.map((c) => (c[0] as any).action);
    expect(actions.length).toBeGreaterThan(0);
    for (const a of actions) expect(READ_ONLY_ALLOWLIST.has(a)).toBe(true);
    expect(actions).not.toContain('APPROVE_TOOL');
  });
});
