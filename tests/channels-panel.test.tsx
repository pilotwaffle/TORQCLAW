// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { GatewayEvent } from '@torqclaw/contracts';
import ChannelsPanel from '../apps/console/src/components/ChannelsPanel.js';

afterEach(cleanup); // LOAD-BEARING: root config has no globals:true, so RTL
                    // auto-cleanup is off; without this a second render leaks
                    // and corrupts getAllByRole('button') counts.

// local event factory (mirrors tests/approvals-panel.test.tsx)
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
    lastAcknowledgedCursor: '0',
    ...overrides,
  };
}

function timelineFrame(channelId: string, events: unknown, cursor: string, hasMore: boolean): GatewayEvent {
  return ev({
    type: 'SYSTEM',
    metadata: { collabTimeline: true, channelId, events, cursor, hasMore },
  });
}

function timelineEvent(overrides: Record<string, unknown> = {}) {
  return {
    cursor: '1',
    id: 'ev-1',
    kind: 'message_posted',
    actorPrincipalId: 'principal-abcdef1234',
    occurredAt: '2026-08-16T23:55:12.345Z',
    payload: { channelId: 'chan-1', text: 'hello world' },
    ...overrides,
  };
}

const READ_ONLY_ALLOWLIST = new Set(['LIST_CHANNELS', 'GET_CHANNEL_TIMELINE']);
const DANGEROUS_ACTIONS = new Set([
  'SUBMIT_PROMPT',
  'CANCEL_TASK',
  'APPROVE_TOOL',
  'APPROVE_SKILL',
  'POST_CHANNEL_MESSAGE',
]);
const CURSOR_GRAMMAR = /^(0|[1-9][0-9]*)$/;

function renderPanel(events: GatewayEvent[], sc = vi.fn(() => true), onClose = vi.fn()) {
  return render(<ChannelsPanel events={events} sendCommand={sc} onClose={onClose} />);
}

describe('ChannelsPanel', () => {
  it('mount dispatch: exactly once, exact shape {action: LIST_CHANNELS, limit: 50}', () => {
    const sc = vi.fn(() => true);
    renderPanel([], sc);
    expect(sc).toHaveBeenCalledTimes(1);
    expect(sc).toHaveBeenCalledWith({ action: 'LIST_CHANNELS', limit: 50 });
  });

  it('T-10: loading(null) !== empty([]) for the channel list', () => {
    const { unmount } = renderPanel([]);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByText('No channels yet')).not.toBeInTheDocument();
    unmount();
    cleanup();

    const frame = channelListFrame([]);
    renderPanel([frame]);
    expect(screen.getByText('No channels yet')).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });

  it('T-10: sendFailed shows retry affordance and never arms the timeout timer', async () => {
    vi.useFakeTimers();
    try {
      const scFail = vi.fn(() => false);
      renderPanel([], scFail);
      expect(
        screen.getByText(/couldn't request the channel list — connection may be reconnecting/)
      ).toBeInTheDocument();

      // Advance well past TIMEOUT_MS — if the timer had been armed despite
      // the failed send, phase would flip to 'timeout' and swap the copy.
      await act(async () => {
        vi.advanceTimersByTime(10_000);
      });
      expect(
        screen.getByText(/couldn't request the channel list — connection may be reconnecting/)
      ).toBeInTheDocument();
      expect(screen.queryByText('No response — refresh to try again.')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('T-10: timeout fires at exactly the 5000ms boundary, not before', async () => {
    vi.useFakeTimers();
    try {
      const sc = vi.fn(() => true);
      renderPanel([], sc);
      await act(async () => {
        vi.advanceTimersByTime(4999);
      });
      expect(screen.queryByText('No response — refresh to try again.')).not.toBeInTheDocument();
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(screen.getByText('No response — refresh to try again.')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('malformed-frame resilience: good-then-malformed keeps good rows, never crashes; malformed-only stays Loading', () => {
    const good = channelListFrame([channelRow({ name: 'good_channel' })]);
    const malformed = ev({ type: 'SYSTEM', metadata: { collabChannels: true, channels: 'nope' } });
    const { rerender, unmount } = renderPanel([good]);
    expect(screen.getByText('good_channel')).toBeInTheDocument();

    rerender(<ChannelsPanel events={[good, malformed]} sendCommand={vi.fn(() => true)} onClose={vi.fn()} />);
    expect(screen.getByText('good_channel')).toBeInTheDocument();
    unmount();
    cleanup();

    expect(() => renderPanel([malformed])).not.toThrow();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('T-11: structural inertness — clicking every control dispatches only LIST_CHANNELS/GET_CHANNEL_TIMELINE, disjoint from dangerous actions', () => {
    const sc = vi.fn(() => true);
    const frame = channelListFrame([channelRow()]);
    const timeline = timelineFrame('chan-1', [timelineEvent()], '1', false);
    renderPanel([frame, timeline], sc);

    // Positive presence first (anti-vacuous).
    expect(screen.getByText('general')).toBeInTheDocument();

    // Click every button repeatedly (covers channel select + refresh + close
    // + any load-older that appears once a channel is selected).
    let buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) fireEvent.click(b);
    buttons = screen.getAllByRole('button');
    for (const b of buttons) fireEvent.click(b);

    const actions = sc.mock.calls.map((c) => (c[0] as any).action);
    expect(actions.length).toBeGreaterThan(0);
    for (const a of actions) expect(READ_ONLY_ALLOWLIST.has(a)).toBe(true);
    for (const a of actions) expect(DANGEROUS_ACTIONS.has(a)).toBe(false);
  });

  it('T-12: no-fabrication sweep — channel list renders no last-message preview, no member count, no numeric unread badge', () => {
    const frame = channelListFrame([
      channelRow({ channelId: 'chan-1', name: 'general', role: 'owner', lastAcknowledgedCursor: '3' }),
    ]);
    renderPanel([frame]);

    expect(screen.getByText('general')).toBeInTheDocument();
    // No numeric badge anywhere (a bare digit rendered as a pill/badge).
    expect(screen.queryByText(/^\d+$/)).not.toBeInTheDocument();
    // No last-message preview / member-count vocabulary.
    expect(screen.queryByText(/member/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/unread/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/last message/i)).not.toBeInTheDocument();
  });

  it('timeline paging: selecting a channel dispatches GET_CHANNEL_TIMELINE with cursor "0"; Load older uses the returned cursor; hasMore=false hides it', () => {
    const sc = vi.fn(() => true);
    const frame = channelListFrame([channelRow()]);
    const { rerender } = renderPanel([frame], sc);

    fireEvent.click(screen.getByText('general'));
    expect(sc).toHaveBeenLastCalledWith({ action: 'GET_CHANNEL_TIMELINE', channelId: 'chan-1', cursor: '0', limit: 50 });

    // Every dispatched cursor must match the wire grammar.
    for (const call of sc.mock.calls) {
      const data = call[0] as any;
      if (data.action === 'GET_CHANNEL_TIMELINE') {
        expect(CURSOR_GRAMMAR.test(data.cursor)).toBe(true);
      }
    }

    // hasMore:false -> no "Load older" control.
    const timelineDone = timelineFrame('chan-1', [timelineEvent()], '1', false);
    rerender(<ChannelsPanel events={[frame, timelineDone]} sendCommand={sc} onClose={vi.fn()} />);
    expect(screen.queryByText('Load older')).not.toBeInTheDocument();
  });

  it('timeline paging: hasMore=true shows Load older, which dispatches GET_CHANNEL_TIMELINE with the returned cursor', () => {
    const sc = vi.fn(() => true);
    const frame = channelListFrame([channelRow()]);
    const timelineMore = timelineFrame('chan-1', [timelineEvent()], '7', true);
    const { rerender } = renderPanel([frame], sc);

    fireEvent.click(screen.getByText('general'));
    rerender(<ChannelsPanel events={[frame, timelineMore]} sendCommand={sc} onClose={vi.fn()} />);

    const loadOlder = screen.getByText('Load older');
    fireEvent.click(loadOlder);
    expect(sc).toHaveBeenLastCalledWith({ action: 'GET_CHANNEL_TIMELINE', channelId: 'chan-1', cursor: '7', limit: 50 });
  });

  it('flag-off equivalent: this panel is never mounted without a channel selected -> zero collab commands beyond the list mount', () => {
    // ChannelsPanel itself has no internal flag check (the flag lives at the
    // TorqTerminal call site, tested by not rendering ChannelsPanel at all).
    // Absent a selection, only the mount-time LIST_CHANNELS fires.
    const sc = vi.fn(() => true);
    renderPanel([], sc);
    const actions = sc.mock.calls.map((c) => (c[0] as any).action);
    expect(actions).toEqual(['LIST_CHANNELS']);
  });

  it('timestamps: ISO-8601 occurredAt renders with a UTC suffix; malformed occurredAt renders verbatim; "Invalid Date" never in the DOM', () => {
    const sc = vi.fn(() => true);
    const frame = channelListFrame([channelRow()]);
    const timeline = timelineFrame('chan-1', [
      timelineEvent({ id: 'ev-good', occurredAt: '2026-08-16T23:55:12.345Z', payload: { text: 'good ts' } }),
      timelineEvent({ id: 'ev-bad', occurredAt: 'not-a-date', payload: { text: 'bad ts' } }),
    ], '2', false);
    const { rerender } = renderPanel([frame], sc);
    fireEvent.click(screen.getByText('general'));
    rerender(<ChannelsPanel events={[frame, timeline]} sendCommand={sc} onClose={vi.fn()} />);

    expect(screen.getByText(/2026-08-16 23:55:12.345 UTC/)).toBeInTheDocument();
    expect(screen.getByText('not-a-date')).toBeInTheDocument();
    expect(screen.queryByText(/Invalid Date/)).not.toBeInTheDocument();
  });

  it('message body renders payload.text; author renders a truncated principal id (no display name field on the wire)', () => {
    const sc = vi.fn(() => true);
    const frame = channelListFrame([channelRow()]);
    const timeline = timelineFrame('chan-1', [
      timelineEvent({ actorPrincipalId: 'principal-abcdef1234', payload: { text: 'hello world' } }),
    ], '1', false);
    const { rerender } = renderPanel([frame], sc);
    fireEvent.click(screen.getByText('general'));
    rerender(<ChannelsPanel events={[frame, timeline]} sendCommand={sc} onClose={vi.fn()} />);

    expect(screen.getByText('hello world')).toBeInTheDocument();
    expect(screen.getByText('principa')).toBeInTheDocument(); // 'principal-abcdef1234'.slice(0,8)
  });

  it('close calls onClose', () => {
    const onClose = vi.fn();
    renderPanel([], vi.fn(() => true), onClose);
    fireEvent.click(screen.getByLabelText('Close channels panel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('empty timeline: real-empty ([] events) renders the dashed empty card, distinguishable from Loading', () => {
    const sc = vi.fn(() => true);
    const frame = channelListFrame([channelRow()]);
    const emptyTimeline = timelineFrame('chan-1', [], '0', false);
    const { rerender } = renderPanel([frame], sc);
    fireEvent.click(screen.getByText('general'));
    expect(screen.getAllByText('Loading…').length).toBeGreaterThan(0);

    rerender(<ChannelsPanel events={[frame, emptyTimeline]} sendCommand={sc} onClose={vi.fn()} />);
    expect(screen.getByText('No messages yet')).toBeInTheDocument();
  });

  it('eviction survival: rerender with events=[] keeps the last known channel list visible', () => {
    const sc = vi.fn(() => true);
    const frame = channelListFrame([channelRow({ name: 'sticky_channel' })]);
    const { rerender } = renderPanel([frame], sc);
    expect(screen.getByText('sticky_channel')).toBeInTheDocument();

    rerender(<ChannelsPanel events={[]} sendCommand={sc} onClose={vi.fn()} />);
    expect(screen.getByText('sticky_channel')).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });
});
