// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { GatewayEvent } from '@torqclaw/contracts';
import CostPanel from '../apps/console/src/components/CostPanel.js';

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

function costFrame(meta: Record<string, unknown>): GatewayEvent {
  return ev({ type: 'SYSTEM', metadata: { costSummary: true, ...meta } });
}

// A complete, honest summary object — every required field present so the
// component renders its full tree (used as a base for most tests).
function fullSummary(overrides: Record<string, unknown> = {}) {
  return {
    sessionCap: 5,
    dailyCap: 20,
    sessionCapEnvVar: 'TORQCLAW_SESSION_CAP_USD',
    dailyCapEnvVar: 'TORQCLAW_DAILY_CAP_USD',
    sessionTotal: 1.5,
    dailyTotal: 3,
    sessionRemaining: 3.5,
    dailyRemaining: 17,
    breach: null,
    attributionCounts: {},
    cloudTaskCount: 2,
    providerSummary: [],
    recentLedger: [],
    ...overrides,
  };
}

// Actions a read-only cost panel is allowed to dispatch. Any button click
// producing an action outside this set is a safety regression (G1R RC-3).
const READ_ONLY_ALLOWLIST = new Set(['GET_COST_SUMMARY']);
const DANGEROUS_ACTIONS = new Set(['SUBMIT_PROMPT', 'CANCEL_TASK', 'APPROVE_TOOL', 'APPROVE_SKILL']);

describe('CostPanel', () => {
  it('1. Loading + mount dispatch: shows Loading… and dispatches GET_COST_SUMMARY exactly once, no dangerous action', () => {
    const sc = vi.fn(() => true);
    render(<CostPanel events={[]} sendCommand={sc} onClose={vi.fn()} />);

    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(sc).toHaveBeenCalledTimes(1);
    expect(sc).toHaveBeenCalledWith({ action: 'GET_COST_SUMMARY', recentLimit: 20 });
    expect(sc.mock.calls.some((c) => DANGEROUS_ACTIONS.has((c[0] as any).action))).toBe(false);
  });

  it('2. Unlimited caps (G1R RC-2 fix): getAllByText("No cap (unlimited)") has length 2', () => {
    const frame = costFrame(
      fullSummary({
        sessionCap: null,
        dailyCap: null,
        sessionTotal: 0,
        dailyTotal: 0,
        sessionRemaining: null,
        dailyRemaining: null,
      }),
    );
    render(<CostPanel events={[frame]} sendCommand={vi.fn(() => true)} onClose={vi.fn()} />);

    // formatCap renders for BOTH sessionCap and dailyCap -> 2 nodes.
    // getByText would throw here — this is the required fix.
    const nodes = screen.getAllByText('No cap (unlimited)');
    expect(nodes).toHaveLength(2);
  });

  it('3. unavailable ledger row never shows $0.00', () => {
    const frame = costFrame(
      fullSummary({
        recentLedger: [
          {
            taskId: 't-unavail',
            costUsd: null,
            attribution: 'unavailable',
            provider: 'openai',
            sourceChannel: 'cli',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    );
    render(<CostPanel events={[frame]} sendCommand={vi.fn(() => true)} onClose={vi.fn()} />);

    // Scope to the ledger row itself. Within this one row, "not recorded"
    // legitimately appears TWICE: once for the cost (formatLedgerCost) and
    // once for the "unavailable" attribution label (formatAttribution) —
    // both honest renders of the same row, not the bug under test here.
    const ledgerHeading = screen.getByText('Recent ledger');
    const ledgerSection = ledgerHeading.closest('section')!;
    expect(within(ledgerSection).getAllByText('not recorded').length).toBeGreaterThanOrEqual(1);
    expect(within(ledgerSection).queryByText('$0.00')).not.toBeInTheDocument();
  });

  it('4. account_delta attribution label renders estimated/account-level/conservative', () => {
    const frame = costFrame(fullSummary({ attributionCounts: { account_delta: 3 } }));
    render(<CostPanel events={[frame]} sendCommand={vi.fn(() => true)} onClose={vi.fn()} />);

    expect(screen.getByText(/estimated/i)).toBeInTheDocument();
    expect(screen.getByText(/account-level/i)).toBeInTheDocument();
    expect(screen.getByText(/conservative/i)).toBeInTheDocument();
  });

  it('5. provider caveat renders "(N unrecorded)"', () => {
    const frame = costFrame(
      fullSummary({
        providerSummary: [{ provider: 'openai', recordedUsd: 2, unrecordedCount: 1, totalCount: 2 }],
      }),
    );
    render(<CostPanel events={[frame]} sendCommand={vi.fn(() => true)} onClose={vi.fn()} />);

    expect(screen.getByText('(1 unrecorded)')).toBeInTheDocument();
  });

  it('6. Breach hint text renders and Cap-state section has NO button', () => {
    const frame = costFrame(
      fullSummary({
        breach: { cap: 'session', total: 5, limit: 5, envVar: 'TORQCLAW_SESSION_CAP_USD' },
      }),
    );
    render(<CostPanel events={[frame]} sendCommand={vi.fn(() => true)} onClose={vi.fn()} />);

    expect(screen.getByText(/Raise the cap by setting TORQCLAW_SESSION_CAP_USD/)).toBeInTheDocument();

    const capStateHeading = screen.getByText('Cap state');
    const section = capStateHeading.closest('section')!;
    expect(within(section).queryByRole('button')).not.toBeInTheDocument();
  });

  it('7. button enumeration + no-dispatch teeth: every button clicked stays within {GET_COST_SUMMARY}', () => {
    const sc = vi.fn(() => true);
    const frame = costFrame(
      fullSummary({
        breach: { cap: 'session', total: 5, limit: 5, envVar: 'TORQCLAW_SESSION_CAP_USD' },
        attributionCounts: { exact: 1, account_delta: 2, unavailable: 1 },
        providerSummary: [{ provider: 'openai', recordedUsd: 2, unrecordedCount: 1, totalCount: 2 }],
        recentLedger: [
          {
            taskId: 't1',
            costUsd: 1.23,
            attribution: 'exact',
            provider: 'openai',
            sourceChannel: 'cli',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    );
    render(<CostPanel events={[frame]} sendCommand={sc} onClose={vi.fn()} />);

    // Positive presence (anti-vacuous): the summary actually rendered.
    expect(screen.getByText('Cost Control Center')).toBeInTheDocument();

    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) fireEvent.click(b);

    // Every dispatched action (mount + all clicks) is a SUBSET of the
    // read-only allowlist — proves no button wires SUBMIT_PROMPT/retry/cap-edit.
    const actions = sc.mock.calls.map((c) => (c[0] as any).action);
    expect(actions.length).toBeGreaterThan(0);
    for (const a of actions) expect(READ_ONLY_ALLOWLIST.has(a)).toBe(true);
  });

  it('8. Close button calls onClose', () => {
    const onClose = vi.fn();
    render(<CostPanel events={[]} sendCommand={vi.fn(() => true)} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('Close cost panel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
