// @vitest-environment jsdom
/**
 * PRD-007 S4-Members — console label tests for the REAL LIST_CHANNEL_MEMBERS
 * response (server-sourced `{principalId, displayName, role, kind}`), as
 * distinct from tests/channels-panel.test.tsx's pre-existing S5 roster tests
 * (which cover the OLDER client-side timeline replay -- now the fallback
 * path while this command is in flight, deliberately UNCHANGED and not
 * duplicated here).
 *
 * Covers:
 *   - selecting a channel dispatches LIST_CHANNEL_MEMBERS (channelId only --
 *     no working/since-shaped param exists on the wire command at all).
 *   - a `collabMembers` response frame renders honest labels: `You` for the
 *     self-disclosed CONNECTED principal, `Owner` for role='owner', `Agent`
 *     for role='agent' -- server facts, never a client guess.
 *   - a resolved (even EMPTY) server response is authoritative and is never
 *     overridden by the older client-side replay, even when the replay
 *     would otherwise show real (non-empty) data from timeline events.
 *   - loading / error (sendFailed, timeout) states are distinct and honest.
 *   - malformed collabMembers frames (members not an array) are skipped,
 *     never crash, never rendered as a valid empty snapshot.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { GatewayEvent } from '@torqclaw/contracts';
import ChannelsPanel from '../apps/console/src/components/ChannelsPanel.js';

afterEach(cleanup);

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

function channelListFrame(channels: unknown): GatewayEvent {
  return ev({ type: 'SYSTEM', metadata: { collabChannels: true, channels } });
}

function channelRow(overrides: Record<string, unknown> = {}) {
  return {
    channelId: 'chan-1',
    name: 'general',
    state: 'active',
    role: 'owner',
    externalExportPolicy: 'local_only',
    lastAcknowledgedCursor: '0',
    ...overrides,
  };
}

function membersFrame(channelId: string, members: unknown): GatewayEvent {
  return ev({ type: 'SYSTEM', metadata: { collabMembers: true, channelId, members } });
}

function serverMember(overrides: Record<string, unknown> = {}) {
  return {
    principalId: 'principal-owner001',
    displayName: 'Operator',
    role: 'owner',
    kind: 'human',
    working: false,
    since: null,
    ...overrides,
  };
}

function presenceFrame(overrides: Record<string, unknown> = {}): GatewayEvent {
  return ev({
    type: 'SYSTEM',
    metadata: {
      collabPresence: true,
      channelId: 'chan-1',
      principalId: 'principal-agent0001',
      working: true,
      since: '2026-08-23T00:00:00.000Z',
      ...overrides,
    },
  });
}

function connectedFrame(principalId?: string): GatewayEvent {
  return ev({
    type: 'CONNECTED',
    metadata: {
      sessionId: 'sess-members-1',
      resumed: true,
      ...(principalId !== undefined ? { principalId } : {}),
    },
  });
}

function renderPanel(events: GatewayEvent[], sc = vi.fn(() => true), onClose = vi.fn()) {
  return render(<ChannelsPanel events={events} sendCommand={sc} onClose={onClose} />);
}

function selectGeneral(sc = vi.fn(() => true)) {
  const frame = channelListFrame([channelRow()]);
  const result = renderPanel([frame], sc);
  fireEvent.click(screen.getByText('general'));
  return { ...result, sc, frame };
}

describe('ChannelsPanel — S4-Members (real LIST_CHANNEL_MEMBERS wire command)', () => {
  it('selecting a channel dispatches LIST_CHANNEL_MEMBERS with exactly {action, channelId} -- no working/since-shaped field', () => {
    const sc = vi.fn(() => true);
    selectGeneral(sc);
    const call = sc.mock.calls.find((c) => (c[0] as any).action === 'LIST_CHANNEL_MEMBERS');
    expect(call, 'expected a LIST_CHANNEL_MEMBERS dispatch on channel select').toBeTruthy();
    expect(call![0]).toEqual({ action: 'LIST_CHANNEL_MEMBERS', channelId: 'chan-1' });
  });

  it('LIST_CHANNEL_MEMBERS is dispatched BEFORE GET_CHANNEL_TIMELINE so the timeline read stays the LAST dispatched command on select (preserves the pre-existing read-path wire contract)', () => {
    const sc = vi.fn(() => true);
    selectGeneral(sc);
    expect(sc).toHaveBeenLastCalledWith({ action: 'GET_CHANNEL_TIMELINE', channelId: 'chan-1', cursor: '0', limit: 50 });
  });

  it('a resolved collabMembers frame renders honest role-derived labels: Owner and Agent, never a flat "member"', () => {
    const sc = vi.fn(() => true);
    const { rerender, frame } = selectGeneral(sc);
    const members = membersFrame('chan-1', [
      serverMember({ principalId: 'principal-owner001', displayName: 'Op', role: 'owner', kind: 'human' }),
      serverMember({ principalId: 'principal-agent0001', displayName: 'Botty', role: 'agent', kind: 'agent' }),
    ]);
    rerender(<ChannelsPanel events={[frame, members]} sendCommand={sc} onClose={vi.fn()} />);

    expect(screen.getByText('Members')).toBeInTheDocument();
    expect(screen.getByText(/Owner · Op/)).toBeInTheDocument();
    expect(screen.getByText(/Agent · Botty/)).toBeInTheDocument();
    // Never the older replay's flat vocabulary for a server-sourced row.
    expect(screen.queryByText(/^member$/i)).not.toBeInTheDocument();
  });

  it('the self-disclosed CONNECTED principal renders "You", beating its own role label', () => {
    const sc = vi.fn(() => true);
    const { rerender, frame } = selectGeneral(sc);
    const selfConnected = connectedFrame('principal-owner001');
    const members = membersFrame('chan-1', [
      serverMember({ principalId: 'principal-owner001', displayName: 'Op', role: 'owner', kind: 'human' }),
      serverMember({ principalId: 'principal-agent0001', displayName: 'Botty', role: 'agent', kind: 'agent' }),
    ]);
    rerender(<ChannelsPanel events={[frame, selfConnected, members]} sendCommand={sc} onClose={vi.fn()} />);

    expect(screen.getByText(/You · Op/)).toBeInTheDocument();
    expect(screen.getByText(/Agent · Botty/)).toBeInTheDocument();
    expect(screen.queryByText(/Owner · Op/)).not.toBeInTheDocument();
  });

  it('without a matching CONNECTED principal disclosure, the owner renders "Owner", never "You"', () => {
    const sc = vi.fn(() => true);
    const { rerender, frame } = selectGeneral(sc);
    const members = membersFrame('chan-1', [
      serverMember({ principalId: 'principal-owner001', displayName: 'Op', role: 'owner', kind: 'human' }),
    ]);
    rerender(<ChannelsPanel events={[frame, members]} sendCommand={sc} onClose={vi.fn()} />);

    expect(screen.getByText(/Owner · Op/)).toBeInTheDocument();
    expect(screen.queryByText(/You/)).not.toBeInTheDocument();
  });

  it('a resolved EMPTY server response ("No members seen yet.") is authoritative and is never overridden by the older client-side replay, even when the replay has real data from loaded timeline events', () => {
    const sc = vi.fn(() => true);
    const { rerender, frame } = selectGeneral(sc);
    // A timeline WITH a member_added event -- if the replay fallback were
    // still consulted after a real (even empty) server response landed,
    // this principal's chip would incorrectly appear.
    const timelineEventRow = {
      cursor: '1', id: 'ev-add', kind: 'member_added', actorPrincipalId: 'principal-replay01',
      occurredAt: '2026-08-17T00:00:00.000Z', payload: { channelId: 'chan-1', principalId: 'principal-replay01', membershipEpoch: 1 },
    };
    const timeline = ev({
      type: 'SYSTEM',
      metadata: { collabTimeline: true, channelId: 'chan-1', events: [timelineEventRow], cursor: '1', hasMore: false },
    });
    const emptyMembers = membersFrame('chan-1', []);
    rerender(<ChannelsPanel events={[frame, timeline, emptyMembers]} sendCommand={sc} onClose={vi.fn()} />);

    const rosterHeading = screen.getByText('Members');
    const rosterBlock = rosterHeading.parentElement!;
    expect(within(rosterBlock).getByText('No members seen yet.')).toBeInTheDocument();
    // Scoped to the ROSTER block only -- the timeline itself legitimately
    // still renders member_added as its own system-event row elsewhere on
    // the page (TimelineEventRow), which is unrelated to this assertion.
    expect(within(rosterBlock).queryByText('principa')).not.toBeInTheDocument();
  });

  it('key-set/shape sweep: a rendered member row never leaks a raw principalId as the primary label when displayName is present', () => {
    const sc = vi.fn(() => true);
    const { rerender, frame } = selectGeneral(sc);
    const members = membersFrame('chan-1', [
      serverMember({ principalId: 'principal-longid-should-not-render-bare', displayName: 'Readable Name', role: 'owner', kind: 'human' }),
    ]);
    rerender(<ChannelsPanel events={[frame, members]} sendCommand={sc} onClose={vi.fn()} />);
    expect(screen.getByText(/Readable Name/)).toBeInTheDocument();
    expect(screen.queryByText('principal-longid-should-not-render-bare')).not.toBeInTheDocument();
  });

  it('sendFailed: LIST_CHANNEL_MEMBERS dispatch failure shows an honest reconnecting message, not a fabricated empty roster', () => {
    const scFail = vi.fn(() => false);
    const frame = channelListFrame([channelRow()]);
    renderPanel([frame], scFail);
    fireEvent.click(screen.getByText('general'));
    expect(screen.getByText(/couldn't request members — connection may be reconnecting/)).toBeInTheDocument();
  });

  it('timeout: no response within the timeout window shows a retry-oriented message', async () => {
    vi.useFakeTimers();
    try {
      const sc = vi.fn(() => true);
      const frame = channelListFrame([channelRow()]);
      renderPanel([frame], sc);
      fireEvent.click(screen.getByText('general'));
      await act(async () => {
        vi.advanceTimersByTime(5000);
      });
      // Both the members fetch AND the timeline fetch time out at the same
      // 5000ms boundary in this fixture (neither ever receives a response),
      // so the retry copy legitimately renders twice on the page -- once
      // inside the Members roster block, once for the timeline. Scope to
      // the roster block to assert THIS command's honest failure state.
      const rosterHeading = screen.getByText('Members');
      const rosterBlock = rosterHeading.parentElement!;
      expect(within(rosterBlock).getByText('No response — refresh to try again.')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('malformed-frame resilience: a collabMembers frame with members not-an-array is skipped, falls back to the replay path, never crashes', () => {
    const sc = vi.fn(() => true);
    const { rerender, frame } = selectGeneral(sc);
    const malformed = ev({ type: 'SYSTEM', metadata: { collabMembers: true, channelId: 'chan-1', members: 'nope' } });
    expect(() => {
      rerender(<ChannelsPanel events={[frame, malformed]} sendCommand={sc} onClose={vi.fn()} />);
    }).not.toThrow();
    // Falls back to the (here still-loading) replay path -- no crash, no
    // fabricated roster from the malformed frame.
    expect(screen.queryByText(/Owner ·/)).not.toBeInTheDocument();
  });

  it('a collabMembers frame for a DIFFERENT channelId is ignored -- no cross-channel roster leakage', () => {
    const sc = vi.fn(() => true);
    const { rerender, frame } = selectGeneral(sc);
    const otherChannelMembers = membersFrame('chan-OTHER', [
      serverMember({ principalId: 'principal-other001', displayName: 'Other Op', role: 'owner', kind: 'human' }),
    ]);
    rerender(<ChannelsPanel events={[frame, otherChannelMembers]} sendCommand={sc} onClose={vi.fn()} />);
    expect(screen.queryByText(/Other Op/)).not.toBeInTheDocument();
  });

  // Authorized 2026-08-24 (G1D channels-agent-UX packet, Amendment 1 Item
  // D): this test's ORIGINAL premise -- zero buttons anywhere in the
  // Members section -- predates Item D's deliberate, narrow widening of A5
  // (RosterSection's "UPDATED STRUCTURAL SAFETY BOUNDARY" doc comment,
  // apps/console/src/components/ChannelsPanel.tsx). The Members roster now
  // legitimately carries EXACTLY ONE control per AGENT (non-owner) member
  // row -- a remove affordance (REMOVE_CHANNEL_MEMBER) -- while the owner
  // row and the separate "Working now (agents)" presence section remain
  // 100% control-free, matching A5's original rule exactly where it still
  // applies. This is not a relaxation of T-11's spirit: it still proves the
  // boundary is exactly what the packet specifies, not wider.
  it('T-11 structural (updated boundary): the Members roster carries EXACTLY one remove control per agent member, zero for the owner row, zero links anywhere', () => {
    const sc = vi.fn(() => true);
    const { rerender, frame } = selectGeneral(sc);
    const members = membersFrame('chan-1', [
      serverMember({ principalId: 'principal-owner001', displayName: 'Op', role: 'owner', kind: 'human' }),
      serverMember({ principalId: 'principal-agent0001', displayName: 'Botty', role: 'agent', kind: 'agent' }),
    ]);
    rerender(<ChannelsPanel events={[frame, members]} sendCommand={sc} onClose={vi.fn()} />);

    const rosterHeading = screen.getByText('Members');
    const rosterList = rosterHeading.parentElement!.querySelector('ul')!;
    // Exactly one control: the agent row's remove button. The owner row
    // (role='owner') never gets one -- the store itself independently
    // refuses an owner-role removal regardless of what this UI renders, but
    // the UI must not even offer the affordance for it.
    const buttons = within(rosterList).queryAllByRole('button');
    expect(buttons.length).toBe(1);
    expect(buttons[0]).toHaveAccessibleName('Remove Botty');
    expect(within(rosterList).queryAllByRole('link').length).toBe(0);
  });
});

describe('ChannelsPanel — S4 presence overlay ("Working now (agents)", OQ-2 GRANTED 2026-08-23)', () => {
  it('a member with working=true renders in "Working now (agents)", separately from Members', () => {
    const sc = vi.fn(() => true);
    const { rerender, frame } = selectGeneral(sc);
    const members = membersFrame('chan-1', [
      serverMember({ principalId: 'principal-owner001', displayName: 'Op', role: 'owner', kind: 'human', working: false, since: null }),
      serverMember({ principalId: 'principal-agent0001', displayName: 'Botty', role: 'agent', kind: 'agent', working: true, since: '2026-08-23T00:00:00.000Z' }),
    ]);
    rerender(<ChannelsPanel events={[frame, members]} sendCommand={sc} onClose={vi.fn()} />);

    expect(screen.getByText('Working now (agents)')).toBeInTheDocument();
    const workingHeading = screen.getByText('Working now (agents)');
    const workingBlock = workingHeading.parentElement!;
    expect(within(workingBlock).getByText(/Botty/)).toBeInTheDocument();
    // The idle owner must NOT appear in the working-now section.
    expect(within(workingBlock).queryByText(/Op\b/)).not.toBeInTheDocument();
    // And the Members section is untouched -- both still render, from the
    // SAME serverMembers array, never merged into one list.
    const membersHeading = screen.getByText('Members');
    const membersBlock = membersHeading.parentElement!;
    expect(within(membersBlock).getByText(/Op\b/)).toBeInTheDocument();
    expect(within(membersBlock).getByText(/Botty/)).toBeInTheDocument();
  });

  it('empty state: no agents working renders an honest "No agents working right now."', () => {
    const sc = vi.fn(() => true);
    const { rerender, frame } = selectGeneral(sc);
    const members = membersFrame('chan-1', [
      serverMember({ principalId: 'principal-owner001', displayName: 'Op', role: 'owner', kind: 'human', working: false, since: null }),
    ]);
    rerender(<ChannelsPanel events={[frame, members]} sendCommand={sc} onClose={vi.fn()} />);

    const workingHeading = screen.getByText('Working now (agents)');
    const workingBlock = workingHeading.parentElement!;
    expect(within(workingBlock).getByText('No agents working right now.')).toBeInTheDocument();
  });

  it('before any LIST_CHANNEL_MEMBERS response has resolved, the working-now section shows "Not available yet." rather than an empty list', () => {
    // RosterSection's own early-return (`!haveServerMembers &&
    // !membersFetchFailed && members === null && workingNow === null`)
    // renders NOTHING at all while no response, no failure, no replay
    // data, and no own-task presence exist yet -- there being no roster
    // section at all is itself honest (there's nothing to show). To
    // observe the Working-now block's OWN "Not available yet." branch
    // (haveServerMembers still false), this uses the sendFailed scenario,
    // which flips `membersFetchFailed` true and makes RosterSection render
    // while serverMembers is still null.
    const scFail = vi.fn(() => false);
    const frame = channelListFrame([channelRow()]);
    renderPanel([frame], scFail);
    fireEvent.click(screen.getByText('general'));
    const workingHeading = screen.getByText('Working now (agents)');
    const workingBlock = workingHeading.parentElement!;
    expect(within(workingBlock).getByText('Not available yet.')).toBeInTheDocument();
  });

  it('a live collabPresence frame flips a member from idle to working WITHOUT a new LIST_CHANNEL_MEMBERS response', () => {
    const sc = vi.fn(() => true);
    const { rerender, frame } = selectGeneral(sc);
    const members = membersFrame('chan-1', [
      serverMember({ principalId: 'principal-owner001', displayName: 'Op', role: 'owner', kind: 'human', working: false, since: null }),
      serverMember({ principalId: 'principal-agent0001', displayName: 'Botty', role: 'agent', kind: 'agent', working: false, since: null }),
    ]);
    rerender(<ChannelsPanel events={[frame, members]} sendCommand={sc} onClose={vi.fn()} />);

    // Before the live frame: Botty is idle, not in "Working now".
    let workingBlock = screen.getByText('Working now (agents)').parentElement!;
    expect(within(workingBlock).queryByText(/Botty/)).not.toBeInTheDocument();

    const live = presenceFrame({ channelId: 'chan-1', principalId: 'principal-agent0001', working: true, since: '2026-08-23T01:00:00.000Z' });
    rerender(<ChannelsPanel events={[frame, members, live]} sendCommand={sc} onClose={vi.fn()} />);

    workingBlock = screen.getByText('Working now (agents)').parentElement!;
    expect(within(workingBlock).getByText(/Botty/)).toBeInTheDocument();
  });

  it('a live collabPresence frame flips a member from working back to idle (resolve)', () => {
    const sc = vi.fn(() => true);
    const { rerender, frame } = selectGeneral(sc);
    const members = membersFrame('chan-1', [
      serverMember({ principalId: 'principal-agent0001', displayName: 'Botty', role: 'agent', kind: 'agent', working: true, since: '2026-08-23T00:00:00.000Z' }),
    ]);
    rerender(<ChannelsPanel events={[frame, members]} sendCommand={sc} onClose={vi.fn()} />);
    expect(within(screen.getByText('Working now (agents)').parentElement!).getByText(/Botty/)).toBeInTheDocument();

    const resolvedFrame = presenceFrame({ channelId: 'chan-1', principalId: 'principal-agent0001', working: false, since: null });
    rerender(<ChannelsPanel events={[frame, members, resolvedFrame]} sendCommand={sc} onClose={vi.fn()} />);

    const workingBlock = screen.getByText('Working now (agents)').parentElement!;
    expect(within(workingBlock).queryByText(/Botty/)).not.toBeInTheDocument();
    expect(within(workingBlock).getByText('No agents working right now.')).toBeInTheDocument();
  });

  it('a collabPresence frame naming a principal NOT in the loaded roster is ignored (never synthesizes a new row)', () => {
    const sc = vi.fn(() => true);
    const { rerender, frame } = selectGeneral(sc);
    const members = membersFrame('chan-1', [
      serverMember({ principalId: 'principal-owner001', displayName: 'Op', role: 'owner', kind: 'human', working: false, since: null }),
    ]);
    rerender(<ChannelsPanel events={[frame, members]} sendCommand={sc} onClose={vi.fn()} />);

    const unknownPresence = presenceFrame({ channelId: 'chan-1', principalId: 'principal-unknown999', working: true, since: '2026-08-23T02:00:00.000Z' });
    expect(() => {
      rerender(<ChannelsPanel events={[frame, members, unknownPresence]} sendCommand={sc} onClose={vi.fn()} />);
    }).not.toThrow();

    const workingBlock = screen.getByText('Working now (agents)').parentElement!;
    expect(within(workingBlock).getByText('No agents working right now.')).toBeInTheDocument();
    expect(within(workingBlock).queryByText(/principal-unknown999/)).not.toBeInTheDocument();
  });

  it('a collabPresence frame for a DIFFERENT channelId is ignored -- no cross-channel presence leakage', () => {
    const sc = vi.fn(() => true);
    const { rerender, frame } = selectGeneral(sc);
    const members = membersFrame('chan-1', [
      serverMember({ principalId: 'principal-agent0001', displayName: 'Botty', role: 'agent', kind: 'agent', working: false, since: null }),
    ]);
    rerender(<ChannelsPanel events={[frame, members]} sendCommand={sc} onClose={vi.fn()} />);

    const otherChannelPresence = presenceFrame({ channelId: 'chan-OTHER', principalId: 'principal-agent0001', working: true, since: '2026-08-23T03:00:00.000Z' });
    rerender(<ChannelsPanel events={[frame, members, otherChannelPresence]} sendCommand={sc} onClose={vi.fn()} />);

    const workingBlock = screen.getByText('Working now (agents)').parentElement!;
    expect(within(workingBlock).getByText('No agents working right now.')).toBeInTheDocument();
  });

  it('structural: the "Working now (agents)" section renders zero buttons/links (presence is information, never a control)', () => {
    const sc = vi.fn(() => true);
    const { rerender, frame } = selectGeneral(sc);
    const members = membersFrame('chan-1', [
      serverMember({ principalId: 'principal-agent0001', displayName: 'Botty', role: 'agent', kind: 'agent', working: true, since: '2026-08-23T00:00:00.000Z' }),
    ]);
    rerender(<ChannelsPanel events={[frame, members]} sendCommand={sc} onClose={vi.fn()} />);

    const workingHeading = screen.getByText('Working now (agents)');
    const workingList = workingHeading.parentElement!.querySelector('ul')!;
    expect(within(workingList).queryAllByRole('button').length).toBe(0);
    expect(within(workingList).queryAllByRole('link').length).toBe(0);
  });
});
