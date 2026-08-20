// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { GatewayEvent } from '@torqclaw/contracts';
import ChannelsPanel, { selectChannelMembers, selectWorkingNow } from '../apps/console/src/components/ChannelsPanel.js';

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

// §14 T-11: "For S3, the composer's post is the only addition to the
// allowlist." READ_ONLY_ALLOWLIST below is therefore renamed in spirit but
// kept as the base read-only set for the T-10/T-12 read-path tests (which
// never click the composer's Send button); a SEPARATE allowlist including
// POST_CHANNEL_MESSAGE is used by the T-11 test that also exercises Send.
const READ_ONLY_ALLOWLIST = new Set(['LIST_CHANNELS', 'GET_CHANNEL_TIMELINE']);
const S3_ALLOWLIST = new Set(['LIST_CHANNELS', 'GET_CHANNEL_TIMELINE', 'POST_CHANNEL_MESSAGE']);
const DANGEROUS_ACTIONS = new Set([
  'SUBMIT_PROMPT',
  'CANCEL_TASK',
  'APPROVE_TOOL',
  'APPROVE_SKILL',
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

  it('T-11: structural inertness (read-only path) — clicking every control with an EMPTY composer dispatches only LIST_CHANNELS/GET_CHANNEL_TIMELINE (Send stays disabled on empty text)', () => {
    const sc = vi.fn(() => true);
    const frame = channelListFrame([channelRow()]);
    const timeline = timelineFrame('chan-1', [timelineEvent()], '1', false);
    renderPanel([frame, timeline], sc);

    // Positive presence first (anti-vacuous).
    expect(screen.getByText('general')).toBeInTheDocument();

    // Click every button repeatedly (covers channel select + refresh + close
    // + any load-older that appears once a channel is selected, + the
    // composer's Send button — which stays DISABLED with no text typed, so
    // this exercises the disabled-Send case, not the successful-post case).
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

  it('timeline paging: selecting a channel dispatches GET_CHANNEL_TIMELINE with cursor "0"; Load more uses the returned cursor; hasMore=false hides it', () => {
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

    // hasMore:false -> no "Load more" control.
    // NOTE (B-2 remediation): the control was relabelled from "Load older"
    // to "Load more" — the wire pages forward only (channel_seq ascending),
    // so the old label described a direction the wire cannot page in.
    const timelineDone = timelineFrame('chan-1', [timelineEvent()], '1', false);
    rerender(<ChannelsPanel events={[frame, timelineDone]} sendCommand={sc} onClose={vi.fn()} />);
    expect(screen.queryByText('Load more')).not.toBeInTheDocument();
  });

  it('timeline paging: hasMore=true shows Load more, which dispatches GET_CHANNEL_TIMELINE with the returned cursor', () => {
    const sc = vi.fn(() => true);
    const frame = channelListFrame([channelRow()]);
    const timelineMore = timelineFrame('chan-1', [timelineEvent()], '7', true);
    const { rerender } = renderPanel([frame], sc);

    fireEvent.click(screen.getByText('general'));
    rerender(<ChannelsPanel events={[frame, timelineMore]} sendCommand={sc} onClose={vi.fn()} />);

    // NOTE (B-2 remediation): relabelled from "Load older" to "Load more".
    const loadMore = screen.getByText('Load more');
    fireEvent.click(loadMore);
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

  it('B-1: non-message event kinds render with their kind label, not the message font, and "(no text)" appears nowhere in the DOM', () => {
    const sc = vi.fn(() => true);
    const frame = channelListFrame([channelRow()]);
    const timeline = timelineFrame(
      'chan-1',
      [
        timelineEvent({
          id: 'ev-created',
          cursor: '1',
          kind: 'channel_created',
          payload: { channelId: 'chan-1', name: 'general' },
        }),
        timelineEvent({
          id: 'ev-member',
          cursor: '2',
          kind: 'member_added',
          payload: { channelId: 'chan-1', principalId: 'principal-newbie1', membershipEpoch: 1 },
        }),
        timelineEvent({
          id: 'ev-msg',
          cursor: '3',
          kind: 'message_posted',
          payload: { channelId: 'chan-1', text: 'real message' },
        }),
      ],
      '3',
      false
    );
    const { rerender, container } = renderPanel([frame], sc);
    fireEvent.click(screen.getByText('general'));
    rerender(<ChannelsPanel events={[frame, timeline]} sendCommand={sc} onClose={vi.fn()} />);

    // "(no text)" must appear nowhere in the DOM.
    expect(container.textContent).not.toContain('(no text)');

    // Kind labels are rendered for the two system events.
    expect(screen.getByText(/channel created/i)).toBeInTheDocument();
    expect(screen.getByText(/member added/i)).toBeInTheDocument();

    // The real message still renders normally.
    expect(screen.getByText('real message')).toBeInTheDocument();

    // System-event rows are NOT in the message-body font (font-reading);
    // they use font-mono instead.
    const createdLabel = screen.getByText(/channel created/i);
    const createdRow = createdLabel.closest('li')!;
    const createdBody = createdRow.querySelector('p.font-reading');
    expect(createdBody).toBeNull();
    expect(createdRow.querySelector('p.font-mono')).not.toBeNull();

    const memberLabel = screen.getByText(/member added/i);
    const memberRow = memberLabel.closest('li')!;
    expect(memberRow.querySelector('p.font-reading')).toBeNull();
    expect(memberRow.querySelector('p.font-mono')).not.toBeNull();

    // The real message row DOES use font-reading.
    const msgRow = screen.getByText('real message').closest('li')!;
    expect(msgRow.querySelector('p.font-reading')).not.toBeNull();
  });

  it('B-1: an unknown/future event kind degrades honestly — kind label rendered, never "(no text)", never crashes', () => {
    const sc = vi.fn(() => true);
    const frame = channelListFrame([channelRow()]);
    const timeline = timelineFrame(
      'chan-1',
      [
        timelineEvent({
          id: 'ev-unknown',
          cursor: '1',
          kind: 'some_future_kind',
          payload: { channelId: 'chan-1', somethingNew: true },
        }),
      ],
      '1',
      false
    );
    const { rerender, container } = renderPanel([frame], sc);
    expect(() => {
      fireEvent.click(screen.getByText('general'));
      rerender(<ChannelsPanel events={[frame, timeline]} sendCommand={sc} onClose={vi.fn()} />);
    }).not.toThrow();

    expect(container.textContent).not.toContain('(no text)');
    expect(screen.getByText('some_future_kind')).toBeInTheDocument();
  });

  it('B-2: paging accumulates — after "Load more" both page 1 and page 2 content are visible, in ascending channel_seq order', () => {
    const sc = vi.fn(() => true);
    const frame = channelListFrame([channelRow()]);
    const page1 = timelineFrame(
      'chan-1',
      [timelineEvent({ id: 'ev-p1', cursor: '1', payload: { channelId: 'chan-1', text: 'page one msg' } })],
      '1',
      true
    );
    const { rerender } = renderPanel([frame], sc);
    fireEvent.click(screen.getByText('general'));
    rerender(<ChannelsPanel events={[frame, page1]} sendCommand={sc} onClose={vi.fn()} />);

    expect(screen.getByText('page one msg')).toBeInTheDocument();
    const loadMore = screen.getByText('Load more');
    expect(screen.queryByText('Load older')).not.toBeInTheDocument(); // relabelled, not just aliased

    fireEvent.click(loadMore);
    expect(sc).toHaveBeenLastCalledWith({ action: 'GET_CHANNEL_TIMELINE', channelId: 'chan-1', cursor: '1', limit: 50 });

    const page2 = timelineFrame(
      'chan-1',
      [timelineEvent({ id: 'ev-p2', cursor: '2', payload: { channelId: 'chan-1', text: 'page two msg' } })],
      '2',
      false
    );
    rerender(<ChannelsPanel events={[frame, page1, page2]} sendCommand={sc} onClose={vi.fn()} />);

    // BOTH pages' content must still be visible.
    expect(screen.getByText('page one msg')).toBeInTheDocument();
    expect(screen.getByText('page two msg')).toBeInTheDocument();

    // Ascending channel_seq (cursor) order in the DOM.
    const items = screen.getAllByRole('listitem').filter((li) => li.textContent?.includes('page'));
    const texts = items.map((li) => li.textContent);
    const p1Index = texts.findIndex((t) => t?.includes('page one msg'));
    const p2Index = texts.findIndex((t) => t?.includes('page two msg'));
    expect(p1Index).toBeGreaterThanOrEqual(0);
    expect(p2Index).toBeGreaterThan(p1Index);
  });

  it('B-2: every cursor dispatched via GET_CHANNEL_TIMELINE matches the wire grammar ^(0|[1-9][0-9]*)$', () => {
    const sc = vi.fn(() => true);
    const frame = channelListFrame([channelRow()]);
    const page1 = timelineFrame(
      'chan-1',
      [timelineEvent({ id: 'ev-p1', cursor: '1', payload: { channelId: 'chan-1', text: 'page one msg' } })],
      '1',
      true
    );
    const { rerender } = renderPanel([frame], sc);
    fireEvent.click(screen.getByText('general'));
    rerender(<ChannelsPanel events={[frame, page1]} sendCommand={sc} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('Load more'));

    const timelineCalls = sc.mock.calls.filter((c) => (c[0] as any).action === 'GET_CHANNEL_TIMELINE');
    expect(timelineCalls.length).toBeGreaterThan(0);
    for (const call of timelineCalls) {
      const cursor = (call[0] as any).cursor;
      expect(CURSOR_GRAMMAR.test(cursor)).toBe(true);
    }
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

// ---------------------------------------------------------------------------
// S3 — composer (human posting)
// ---------------------------------------------------------------------------
describe('ChannelsPanel — S3 composer', () => {
  function selectGeneral(sc = vi.fn(() => true)) {
    const frame = channelListFrame([channelRow()]);
    const result = renderPanel([frame], sc);
    fireEvent.click(screen.getByText('general'));
    return { ...result, sc, frame };
  }

  function composerTextarea(): HTMLTextAreaElement {
    return screen.getByPlaceholderText('Message this channel…') as HTMLTextAreaElement;
  }

  function sendButton(): HTMLElement {
    return screen.getByRole('button', { name: 'Send' });
  }

  it('typing text and clicking Send dispatches EXACTLY {action: POST_CHANNEL_MESSAGE, channelId, text, idempotencyKey: <uuid>}', () => {
    const { sc } = selectGeneral();
    fireEvent.change(composerTextarea(), { target: { value: 'hello there' } });
    fireEvent.click(sendButton());

    const postCalls = sc.mock.calls.filter((c) => (c[0] as any).action === 'POST_CHANNEL_MESSAGE');
    expect(postCalls.length).toBe(1);
    const data = postCalls[0]![0] as any;
    expect(data).toEqual({
      action: 'POST_CHANNEL_MESSAGE',
      channelId: 'chan-1',
      text: 'hello there',
      idempotencyKey: expect.any(String),
    });
    // canonical UUID shape (matches ClientCommandSchema's z.uuid()).
    expect(data.idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  // G2A NB-1: this test was previously titled "...and for whitespace/newline-only
  // text" but asserted NOTHING about whitespace -- it set the value, wrote a
  // comment saying "confirm real behavior rather than assume", and ended. The
  // title claimed a guarantee the body never checked. Retitled to the REAL
  // behavior and both branches now asserted.
  it('Send is disabled for EMPTY text (rawBytes === 0) and ENABLED for whitespace-only text, which the substrate accepts byte-identically (no trim)', () => {
    selectGeneral();
    expect(sendButton()).toBeDisabled();

    // Whitespace-only is non-empty IN BYTES. The composer's `empty` check is
    // byte-based (`rawBytes === 0`, ChannelsPanel.tsx:134) and the substrate
    // has NO trim step for message text (text.ts:105 -- all-LF and
    // leading/trailing-space messages are ACCEPTED and persisted
    // byte-identical). So this must be SENDABLE; declining it here would be
    // the console inventing a rule the substrate does not have.
    fireEvent.change(composerTextarea(), { target: { value: '   \n\t  ' } });
    expect(
      sendButton(),
      'whitespace-only text has nonzero bytes and the substrate accepts it '
      + '(no trim, text.ts:105) -- the composer must not invent a decline rule',
    ).toBeEnabled();

    // And back to genuinely empty -> disabled again.
    fireEvent.change(composerTextarea(), { target: { value: '' } });
    expect(sendButton()).toBeDisabled();
  });

  it('the composer NFC-normalizes and counts UTF-8 bytes (not string.length) live against the 16,384 cap', () => {
    selectGeneral();
    // A CJK string: each character is 3 UTF-8 bytes, so 100 chars = 300 bytes,
    // proving the counter reads bytes, not .length.
    const cjk = '你'.repeat(100);
    fireEvent.change(composerTextarea(), { target: { value: cjk } });
    expect(screen.getByText(/300 \/ 16,384 bytes/)).toBeInTheDocument();
  });

  it('A8: an over-cap multi-byte (emoji) message cannot be sent — Send is disabled and no POST_CHANNEL_MESSAGE is dispatched', () => {
    const { sc } = selectGeneral();
    // Each of these emoji is 4 UTF-8 bytes; 5000 * 4 = 20,000 > 16,384.
    const overCapEmoji = '😀'.repeat(5000);
    fireEvent.change(composerTextarea(), { target: { value: overCapEmoji } });
    expect(screen.getByText(/over limit/)).toBeInTheDocument();
    expect(sendButton()).toBeDisabled();

    fireEvent.click(sendButton());
    const postCalls = sc.mock.calls.filter((c) => (c[0] as any).action === 'POST_CHANNEL_MESSAGE');
    expect(postCalls.length).toBe(0);
  });

  it('T-9/residue: 16,384 newlines pass the raw-byte bound but fail the JSON-encoded-byte bound — the composer surfaces this as over-cap and blocks Send', () => {
    const { sc } = selectGeneral();
    const manyNewlines = '\n'.repeat(16384);
    fireEvent.change(composerTextarea(), { target: { value: manyNewlines } });
    // Raw UTF-8 bytes: 16384 (exactly at the raw cap, would pass alone).
    // JSON-encoded bytes: 32768 (each \n -> "\\n", 2 bytes) -- over cap.
    expect(screen.getByText(/over limit/)).toBeInTheDocument();
    expect(sendButton()).toBeDisabled();
    fireEvent.click(sendButton());
    expect(sc.mock.calls.filter((c) => (c[0] as any).action === 'POST_CHANNEL_MESSAGE').length).toBe(0);
  });

  it('boundary exactness: exactly 16384 raw ASCII bytes is accepted (Send enabled); 16385 is rejected (Send disabled)', () => {
    selectGeneral();
    fireEvent.change(composerTextarea(), { target: { value: 'a'.repeat(16384) } });
    expect(screen.getByText(/16,384 \/ 16,384 bytes/)).toBeInTheDocument();
    expect(sendButton()).not.toBeDisabled();

    fireEvent.change(composerTextarea(), { target: { value: 'a'.repeat(16385) } });
    expect(screen.getByText(/over limit/)).toBeInTheDocument();
    expect(sendButton()).toBeDisabled();
  });

  it('boundary exactness: 0 bytes (empty draft) is rejected (Send disabled)', () => {
    selectGeneral();
    expect(composerTextarea().value).toBe('');
    expect(sendButton()).toBeDisabled();
  });

  it('NFC normalization changes the byte count the composer reports: a decomposed form (NFD) normalizes to a shorter NFC byte count', () => {
    selectGeneral();
    // 'é' as NFD (e + combining acute, U+0065 U+0301) is 1+2=3 raw bytes;
    // NFC-normalized to U+00E9 it is 2 bytes. The composer counts the
    // NFC-normalized form (text.ts:115 runs NFC BEFORE either bound).
    const nfd = 'é'; // decomposed é
    fireEvent.change(composerTextarea(), { target: { value: nfd } });
    // NFC('é') === 'é', which is 2 UTF-8 bytes.
    expect(screen.getByText(/2 \/ 16,384 bytes/)).toBeInTheDocument();
  });

  it('send failure (socket closed) is surfaced explicitly, never a silent drop, and the composer offers retry', () => {
    const scFail = vi.fn(() => false);
    selectGeneral(scFail);
    fireEvent.change(composerTextarea(), { target: { value: 'will not send' } });
    fireEvent.click(sendButton());

    expect(screen.getByText("didn't send")).toBeInTheDocument();
    // The pending strip shows the failed text AND the textarea keeps the
    // draft (send failure never clears what the user typed) -- two
    // occurrences is correct, not a duplication bug.
    expect(screen.getAllByText('will not send').length).toBe(2);
    expect(composerTextarea().value).toBe('will not send');
    expect(screen.getByText('retry')).toBeInTheDocument();
  });

  it('retry after a send failure reuses the SAME idempotencyKey (B-3) — not a new one', () => {
    const scFail = vi.fn(() => false);
    selectGeneral(scFail);
    fireEvent.change(composerTextarea(), { target: { value: 'retry me' } });
    fireEvent.click(sendButton());
    const firstCall = scFail.mock.calls.find((c) => (c[0] as any).action === 'POST_CHANNEL_MESSAGE')![0] as any;

    fireEvent.click(screen.getByText('retry'));
    const secondCall = scFail.mock.calls
      .filter((c) => (c[0] as any).action === 'POST_CHANNEL_MESSAGE')
      .map((c) => c[0] as any)
      .at(-1)!;

    expect(secondCall.idempotencyKey).toBe(firstCall.idempotencyKey);
    expect(secondCall.text).toBe(firstCall.text);
  });

  it('a NEW message (typed after a successful send) gets a NEW idempotencyKey — never derived from text', () => {
    const sc = vi.fn(() => true);
    selectGeneral(sc);
    fireEvent.change(composerTextarea(), { target: { value: 'first message' } });
    fireEvent.click(sendButton());
    const firstKey = (sc.mock.calls.find((c) => (c[0] as any).action === 'POST_CHANNEL_MESSAGE')![0] as any).idempotencyKey;

    fireEvent.change(composerTextarea(), { target: { value: 'second message' } });
    fireEvent.click(sendButton());
    const postCalls = sc.mock.calls.filter((c) => (c[0] as any).action === 'POST_CHANNEL_MESSAGE');
    const secondKey = (postCalls.at(-1)![0] as any).idempotencyKey;

    expect(secondKey).not.toBe(firstKey);
  });

  it('OPTIMISTIC ECHO IS FORBIDDEN: after Send, the message text is NOT rendered as a persisted (font-reading) message row before a matching GET_CHANNEL_TIMELINE re-read returns it', () => {
    const sc = vi.fn(() => true);
    const { rerender } = selectGeneral(sc);
    fireEvent.change(composerTextarea(), { target: { value: 'not yet confirmed' } });
    fireEvent.click(sendButton());

    // Pending strip shows the text, but NOT as a real timeline row (no
    // font-reading persisted-message rendering for it yet).
    expect(screen.getByText('not yet confirmed')).toBeInTheDocument();
    const pendingRow = screen.getByText('not yet confirmed').closest('li')!;
    expect(pendingRow.className).toMatch(/border-dashed/); // pending strip's visual marker

    // No GET_CHANNEL_TIMELINE re-read frame has arrived yet -- the message
    // must not appear via TimelineEventRow's rendering path at all yet
    // beyond the one pending row found above.
    expect(screen.getAllByText('not yet confirmed').length).toBe(1);
  });

  it('OPTIMISTIC ECHO IS FORBIDDEN: the message renders as SENT only after the store commit ack triggers a re-read AND that re-read actually contains it', () => {
    const sc = vi.fn(() => true);
    const { rerender } = selectGeneral(sc);
    fireEvent.change(composerTextarea(), { target: { value: 'now confirmed' } });
    fireEvent.click(sendButton());

    const listFrame = channelListFrame([channelRow()]);
    const initialTimeline = timelineFrame('chan-1', [], '0', false);

    // Post ack arrives (server confirmed commit) -- this alone must NOT
    // render the message; it only TRIGGERS a re-read.
    // G2A D-1: the ack must carry the idempotencyKey of the send it acks.
    // Read the real key out of the dispatched command rather than inventing
    // one -- an ack with a foreign or absent key is now (correctly) ignored.
    const sentKey = (sc.mock.calls.find(
      (c: any[]) => c[0]?.action === 'POST_CHANNEL_MESSAGE',
    )![0] as any).idempotencyKey as string;
    const ack = ev({
      type: 'SYSTEM',
      metadata: { collabMessagePosted: true, channelId: 'chan-1', idempotencyKey: sentKey, eventId: 'ev-confirmed-1', cursor: '1', occurredAt: '2026-08-17T00:00:00.000Z' },
    });
    rerender(<ChannelsPanel events={[listFrame, initialTimeline, ack]} sendCommand={sc} onClose={vi.fn()} />);

    // Still pending -- no matching timeline snapshot contains the eventId yet.
    expect(screen.getByText('now confirmed')).toBeInTheDocument();
    const pendingRowStillThere = screen.getByText('now confirmed').closest('li')!;
    expect(pendingRowStillThere.className).toMatch(/border-dashed/);

    // The re-read (triggered by the ack effect) returns, now containing the
    // confirmed message as a REAL timeline event.
    const confirmingTimeline = timelineFrame(
      'chan-1',
      [timelineEvent({ id: 'ev-confirmed-1', cursor: '1', payload: { channelId: 'chan-1', text: 'now confirmed' } })],
      '1',
      false,
    );
    rerender(<ChannelsPanel events={[listFrame, initialTimeline, ack, confirmingTimeline]} sendCommand={sc} onClose={vi.fn()} />);

    // Now rendered as a real, persisted message row (font-reading), and the
    // pending strip entry is gone (exactly one occurrence of the text).
    expect(screen.getAllByText('now confirmed').length).toBe(1);
    const confirmedRow = screen.getByText('now confirmed').closest('li')!;
    expect(confirmedRow.querySelector('p.font-reading') ?? confirmedRow.classList.contains('font-reading')).toBeTruthy();
    expect(confirmedRow.className).not.toMatch(/border-dashed/);
  });

  it("G2A D-1: an ack for send A must NOT clear a DIFFERENT in-flight send B (no silent drop)", () => {
    const sc = vi.fn(() => true);
    const { rerender } = selectGeneral(sc);

    // Two sends in flight on the SAME channel, back to back.
    fireEvent.change(composerTextarea(), { target: { value: 'message A' } });
    fireEvent.click(sendButton());
    fireEvent.change(composerTextarea(), { target: { value: 'message B' } });
    fireEvent.click(sendButton());

    const posts = sc.mock.calls
      .filter((c: any[]) => c[0]?.action === 'POST_CHANNEL_MESSAGE')
      .map((c: any[]) => c[0] as any);
    expect(posts.length).toBe(2);
    const keyA = posts.find((p) => p.text === 'message A')!.idempotencyKey as string;

    // Only A commits. B is REJECTED server-side -- realistically by a pasted
    // control char: the composer checks byte bounds only, the contract
    // admits it, the substrate rejects it, and the ERROR frame never reaches
    // the console (CO-S3-1). So B gets NO frame at all, ever.
    const listFrame = channelListFrame([channelRow()]);
    const ackA = ev({
      type: 'SYSTEM',
      metadata: { collabMessagePosted: true, channelId: 'chan-1', idempotencyKey: keyA, eventId: 'ev-A', cursor: '1', occurredAt: '2026-08-17T00:00:00.000Z' },
    });
    // The re-read A's ack triggers returns, containing ONLY A.
    const timelineWithAOnly = timelineFrame(
      'chan-1',
      [timelineEvent({ id: 'ev-A', cursor: '1', payload: { channelId: 'chan-1', text: 'message A' } })],
      '1',
      false,
    );
    rerender(<ChannelsPanel events={[listFrame, ackA, timelineWithAOnly]} sendCommand={sc} onClose={vi.fn()} />);

    // A is now a real committed row.
    expect(screen.getAllByText('message A').length).toBe(1);

    // THE ASSERTION. Before the fix, the ack effect matched on
    // channelId + phase==='sending' and stamped BOTH entries with A's
    // eventId; the confirm effect then found ev-A in the snapshot and
    // dropped B's pending row too -- B vanished with no failure state and
    // no retry, the user's draft gone. B must still be visible and pending.
    expect(
      screen.queryByText('message B'),
      'G2A D-1 REGRESSION: a rejected/unacked sibling send was cleared by ANOTHER '
      + "send's ack. That is a silent drop -- forbidden by §13 S3 and A8. The ack "
      + 'must be correlated to its own send by idempotencyKey.',
    ).toBeInTheDocument();
    const bRow = screen.getByText('message B').closest('li')!;
    expect(bRow.className, 'B must remain visibly PENDING, never rendered as sent')
      .toMatch(/border-dashed/);
  });

  it('T-11 (S3 addition): typing + Send dispatches ONLY LIST_CHANNELS / GET_CHANNEL_TIMELINE / POST_CHANNEL_MESSAGE, disjoint from every other dangerous action', () => {
    const sc = vi.fn(() => true);
    selectGeneral(sc);
    fireEvent.change(composerTextarea(), { target: { value: 'inertness check' } });
    fireEvent.click(sendButton());

    const actions = sc.mock.calls.map((c) => (c[0] as any).action);
    expect(actions).toContain('POST_CHANNEL_MESSAGE');
    for (const a of actions) expect(S3_ALLOWLIST.has(a)).toBe(true);
    for (const a of actions) expect(DANGEROUS_ACTIONS.has(a)).toBe(false);
  });

  it('the composer is not rendered when no channel is selected (no posting affordance without a channel)', () => {
    const sc = vi.fn(() => true);
    renderPanel([], sc);
    expect(screen.queryByPlaceholderText('Message this channel…')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// S4 — live delivery as hint-then-refetch (§4 S4 / A4 / T-6).
//
// WHERE THE HINT COMES FROM: the SAME collabMessagePosted publishOnly frame
// S3 already emits (collabSurface.ts:353-361) -- these tests build that
// frame with a hintFrame() helper below and never invent a new wire shape.
// No new wire command means A6/T-9 do not apply to this file (see the
// module doc header). CONNECTED reconnect frames use the SAME `ev()`
// factory as every other test in this file (type: 'CONNECTED').
//
// NO DELIVERY GUARANTEE: none of these tests assert that a hint frame WILL
// arrive, is retried, or is queued if missed. Every test drives the panel
// with a hint frame ALREADY PRESENT in `events` (exactly like every other
// test in this file drives it with a channel-list/timeline frame already
// present) and asserts the RESULTING re-read behavior -- contiguity,
// coalescing call counts, and reconnect recovery. This is deliberately the
// same "frame observed in props" test shape used throughout this file; it
// is not a claim about socket delivery semantics, which this file does not
// control and does not test.
// ---------------------------------------------------------------------------
describe('ChannelsPanel — S4 hint-then-refetch', () => {
  function hintFrame(overrides: Record<string, unknown> = {}): GatewayEvent {
    return ev({
      type: 'SYSTEM',
      metadata: {
        collabMessagePosted: true,
        channelId: 'chan-1',
        idempotencyKey: 'irrelevant-to-s4-00000000-0000-0000-0000-000000000000',
        eventId: 'hint-ev-1',
        cursor: '1',
        occurredAt: '2026-08-17T00:00:00.000Z',
        ...overrides,
      },
    });
  }

  function connectedFrame(sessionId = 'sess-reconnect-1'): GatewayEvent {
    return ev({ type: 'CONNECTED', metadata: { sessionId, resumed: true } });
  }

  function selectGeneral(sc = vi.fn(() => true)) {
    const frame = channelListFrame([channelRow()]);
    const result = renderPanel([frame], sc);
    fireEvent.click(screen.getByText('general'));
    return { ...result, sc, frame };
  }

  // Local copies of the S3 block's composer accessors -- the V-1 tests below
  // must drive a REAL send to get a real idempotencyKey (the whole point: a
  // foreign key makes the ack effect return early, which is why the defect
  // stayed invisible to 82 tests).
  function composerTextarea(): HTMLTextAreaElement {
    return screen.getByPlaceholderText('Message this channel…') as HTMLTextAreaElement;
  }
  function sendButton(): HTMLElement {
    return screen.getByRole('button', { name: 'Send' });
  }

  it('G1R V-1: a SELF-SEND ack fires exactly ONE re-read, not two (the ack effect must honour the coalescing guard)', () => {
    const sc = vi.fn(() => true);
    const { rerender, frame } = selectGeneral(sc);

    const initialTimeline = timelineFrame('chan-1', [], '0', false);
    rerender(<ChannelsPanel events={[frame, initialTimeline]} sendCommand={sc} onClose={vi.fn()} />);

    // Send a real message so a pendingSends entry EXISTS with a real key.
    // Every other S4 test uses hintFrame()'s foreign 'irrelevant-to-s4-...'
    // key, so the ack effect returns early and this path is never driven --
    // which is exactly why 82/82 stayed green with the defect present.
    fireEvent.change(composerTextarea(), { target: { value: 'self send' } });
    fireEvent.click(sendButton());
    const sentKey = (sc.mock.calls.find(
      (c: any[]) => c[0]?.action === 'POST_CHANNEL_MESSAGE',
    )![0] as any).idempotencyKey as string;
    sc.mockClear();

    // ONE ack for OUR OWN send. It satisfies selectLatestPostAck (key
    // matches) AND selectLatestHintEventId (key-agnostic by design), and
    // both effects share [events, selectedChannelId] deps -- so one frame
    // runs both in the same commit. They keep SEPARATE dedup ledgers, so
    // neither suppresses the other.
    const selfAck = hintFrame({ eventId: 'ev-self-1', idempotencyKey: sentKey, cursor: '1' });
    rerender(<ChannelsPanel events={[frame, initialTimeline, selfAck]} sendCommand={sc} onClose={vi.fn()} />);

    const reads = sc.mock.calls.filter((c) => (c[0] as any).action === 'GET_CHANNEL_TIMELINE');
    expect(
      reads.length,
      'V-1 REGRESSION: one ack produced more than one GET_CHANNEL_TIMELINE. The '
      + 'hint effect armed the in-flight guard and the ack effect ignored it, '
      + 'firing a second CONCURRENT read at the same cursor -- one extra read per '
      + 'ack, unbounded, in exactly the busy-channel burst §4 S4 coalescing exists '
      + 'to prevent. It also stomps the shared timelineTimer, so a hung first read '
      + 'has its timeout silently disarmed.',
    ).toBe(1);
  });

  it('G1R V-1: N self-sends produce N re-reads, not 2N — the leak does not grow with post count', () => {
    const sc = vi.fn(() => true);
    const { rerender, frame } = selectGeneral(sc);
    let events: GatewayEvent[] = [frame, timelineFrame('chan-1', [], '0', false)];
    rerender(<ChannelsPanel events={events} sendCommand={sc} onClose={vi.fn()} />);

    // Four sends, each acked in its own render batch, each followed by a
    // response frame so the in-flight guard clears between rounds. Measured
    // 1,2,3,4 extra reads (i.e. 8 total) before the fix -- linear, no ceiling.
    for (let i = 1; i <= 4; i++) {
      fireEvent.change(composerTextarea(), { target: { value: `burst ${i}` } });
      fireEvent.click(sendButton());
      const key = (sc.mock.calls.filter(
        (c: any[]) => c[0]?.action === 'POST_CHANNEL_MESSAGE',
      ).at(-1)![0] as any).idempotencyKey as string;
      events = [...events, hintFrame({ eventId: `ev-burst-${i}`, idempotencyKey: key, cursor: String(i) })];
      rerender(<ChannelsPanel events={events} sendCommand={sc} onClose={vi.fn()} />);
      // Land the response so the next round starts from a clean guard.
      events = [...events, timelineFrame('chan-1', [], String(i), false)];
      rerender(<ChannelsPanel events={events} sendCommand={sc} onClose={vi.fn()} />);
    }

    const reads = sc.mock.calls.filter((c) => (c[0] as any).action === 'GET_CHANNEL_TIMELINE');
    // MEASURED, not guessed: with the V-1 guard removed this sequence issues
    // 9 reads; with the guard it issues 6. The 6 are legitimate -- each round
    // lands a response frame, which flushes the coalesced follow-up the guard
    // deliberately owes. The bound is set to the measured post-fix value so
    // any REGROWTH fails, rather than to a round number that would pass
    // whatever the code happens to do.
    expect(
      reads.length,
      'V-1 REGRESSION (unbounded): read count grew beyond the measured post-fix '
      + 'value of 6 for four acks (the defect produced 9 and scaled linearly with '
      + 'post count). §4 S4 budgets one read per advance.',
    ).toBeLessThanOrEqual(6);
  });

  it('A4: a hint frame for the selected channel triggers a GET_CHANNEL_TIMELINE re-read from the current cursor — event visible without a manual refresh', () => {
    const sc = vi.fn(() => true);
    const { rerender, frame } = selectGeneral(sc);

    // Initial select already dispatched cursor '0'; land its response first
    // so the panel has a known cursor to re-read from.
    const initialTimeline = timelineFrame('chan-1', [], '0', false);
    rerender(<ChannelsPanel events={[frame, initialTimeline]} sendCommand={sc} onClose={vi.fn()} />);
    sc.mockClear();

    // A hint arrives for THIS channel — no matching pendingSends entry
    // exists (nobody in THIS panel instance sent anything). Under the S3-only
    // ack effect this would be silently ignored; S4 must still re-read.
    const hint = hintFrame({ eventId: 'hint-ev-A' });
    rerender(<ChannelsPanel events={[frame, initialTimeline, hint]} sendCommand={sc} onClose={vi.fn()} />);

    const timelineCalls = sc.mock.calls.filter((c) => (c[0] as any).action === 'GET_CHANNEL_TIMELINE');
    expect(timelineCalls.length).toBe(1);
    expect(timelineCalls[0]![0]).toEqual({ action: 'GET_CHANNEL_TIMELINE', channelId: 'chan-1', cursor: '0', limit: 50 });

    // The re-read lands, contiguous with the prior page (cursor '0' -> '1'),
    // and the new event is now visible with no user-initiated refresh click.
    const afterHint = timelineFrame(
      'chan-1',
      [timelineEvent({ id: 'ev-from-hint', cursor: '1', payload: { channelId: 'chan-1', text: 'arrived via hint' } })],
      '1',
      false,
    );
    rerender(<ChannelsPanel events={[frame, initialTimeline, hint, afterHint]} sendCommand={sc} onClose={vi.fn()} />);
    expect(screen.getByText('arrived via hint')).toBeInTheDocument();
  });

  it('A4/T-6: contiguous, prefix-consistent recovery — the re-read after a hint APPENDS onto the existing page rather than replacing or gapping it', () => {
    const sc = vi.fn(() => true);
    const { rerender, frame } = selectGeneral(sc);

    const page1 = timelineFrame(
      'chan-1',
      [timelineEvent({ id: 'ev-1', cursor: '1', payload: { channelId: 'chan-1', text: 'first' } })],
      '1',
      false,
    );
    rerender(<ChannelsPanel events={[frame, page1]} sendCommand={sc} onClose={vi.fn()} />);
    expect(screen.getByText('first')).toBeInTheDocument();

    const hint = hintFrame({ eventId: 'hint-ev-B', cursor: '2' });
    rerender(<ChannelsPanel events={[frame, page1, hint]} sendCommand={sc} onClose={vi.fn()} />);

    const page2 = timelineFrame(
      'chan-1',
      [timelineEvent({ id: 'ev-2', cursor: '2', payload: { channelId: 'chan-1', text: 'second' } })],
      '2',
      false,
    );
    rerender(<ChannelsPanel events={[frame, page1, hint, page2]} sendCommand={sc} onClose={vi.fn()} />);

    // Both events present, in dense ascending channel_seq (cursor) order —
    // the same B-2 merge/contiguity discipline S1/S2 already prove, now
    // exercised via a hint-triggered re-read instead of "Load more".
    expect(screen.getByText('first')).toBeInTheDocument();
    expect(screen.getByText('second')).toBeInTheDocument();
    const items = screen.getAllByRole('listitem').filter((li) => /first|second/.test(li.textContent ?? ''));
    const texts = items.map((li) => li.textContent);
    expect(texts.findIndex((t) => t?.includes('first'))).toBeLessThan(texts.findIndex((t) => t?.includes('second')));
  });

  it('A4: coalescing — N hints arriving WHILE a re-read is in flight produce exactly ONE follow-up request, not N', () => {
    const sc = vi.fn(() => true);
    const { rerender, frame } = selectGeneral(sc);

    const initialTimeline = timelineFrame('chan-1', [], '0', false);
    rerender(<ChannelsPanel events={[frame, initialTimeline]} sendCommand={sc} onClose={vi.fn()} />);
    sc.mockClear();

    // First hint fires the re-read (now "in flight" — no response frame for
    // it has landed yet).
    const hint1 = hintFrame({ eventId: 'hint-ev-1' });
    rerender(<ChannelsPanel events={[frame, initialTimeline, hint1]} sendCommand={sc} onClose={vi.fn()} />);
    expect(sc.mock.calls.filter((c) => (c[0] as any).action === 'GET_CHANNEL_TIMELINE').length).toBe(1);

    // THREE more distinct hints arrive before that request resolves. Each
    // has a DIFFERENT eventId (a real "new hint" by this file's own dedup
    // rule), so a non-coalescing implementation would fire three more
    // requests here. None of these may dispatch a new GET_CHANNEL_TIMELINE —
    // the call count must stay pinned at 1 until the in-flight read resolves.
    const hint2 = hintFrame({ eventId: 'hint-ev-2' });
    const hint3 = hintFrame({ eventId: 'hint-ev-3' });
    const hint4 = hintFrame({ eventId: 'hint-ev-4' });
    rerender(<ChannelsPanel events={[frame, initialTimeline, hint1, hint2]} sendCommand={sc} onClose={vi.fn()} />);
    rerender(<ChannelsPanel events={[frame, initialTimeline, hint1, hint2, hint3]} sendCommand={sc} onClose={vi.fn()} />);
    rerender(<ChannelsPanel events={[frame, initialTimeline, hint1, hint2, hint3, hint4]} sendCommand={sc} onClose={vi.fn()} />);
    expect(
      sc.mock.calls.filter((c) => (c[0] as any).action === 'GET_CHANNEL_TIMELINE').length,
      'COALESCING VIOLATION: hints arriving while a re-read is in flight must NOT each fire their own request.',
    ).toBe(1);

    // The in-flight read's response now lands. Because it was marked dirty
    // by hints 2-4, EXACTLY ONE follow-up must fire now — not zero (the
    // dirty hints would be silently lost) and not three (one per hint).
    const resolved = timelineFrame('chan-1', [], '0', false);
    rerender(<ChannelsPanel events={[frame, initialTimeline, hint1, hint2, hint3, hint4, resolved]} sendCommand={sc} onClose={vi.fn()} />);
    expect(
      sc.mock.calls.filter((c) => (c[0] as any).action === 'GET_CHANNEL_TIMELINE').length,
      'exactly ONE coalesced follow-up must fire once the in-flight read resolves, not zero and not one-per-hint.',
    ).toBe(2);

    // And that follow-up resolving must NOT trigger yet another request —
    // proving the dirty flag was consumed exactly once, not left sticky.
    const resolvedAgain = timelineFrame('chan-1', [], '0', false);
    rerender(<ChannelsPanel events={[frame, initialTimeline, hint1, hint2, hint3, hint4, resolved, resolvedAgain]} sendCommand={sc} onClose={vi.fn()} />);
    expect(sc.mock.calls.filter((c) => (c[0] as any).action === 'GET_CHANNEL_TIMELINE').length).toBe(2);
  });

  it('A4: a hint with an eventId already reacted to does NOT fire a duplicate re-read (dedup by eventId, not just presence)', () => {
    const sc = vi.fn(() => true);
    const { rerender, frame } = selectGeneral(sc);
    const initialTimeline = timelineFrame('chan-1', [], '0', false);
    rerender(<ChannelsPanel events={[frame, initialTimeline]} sendCommand={sc} onClose={vi.fn()} />);
    sc.mockClear();

    const hint = hintFrame({ eventId: 'hint-ev-same' });
    rerender(<ChannelsPanel events={[frame, initialTimeline, hint]} sendCommand={sc} onClose={vi.fn()} />);
    expect(sc.mock.calls.filter((c) => (c[0] as any).action === 'GET_CHANNEL_TIMELINE').length).toBe(1);

    const resolved = timelineFrame('chan-1', [], '0', false);
    rerender(<ChannelsPanel events={[frame, initialTimeline, hint, resolved]} sendCommand={sc} onClose={vi.fn()} />);
    // Re-render with the SAME hint (same eventId) still the newest one —
    // must NOT fire again.
    rerender(<ChannelsPanel events={[frame, initialTimeline, hint, resolved]} sendCommand={sc} onClose={vi.fn()} />);
    expect(sc.mock.calls.filter((c) => (c[0] as any).action === 'GET_CHANNEL_TIMELINE').length).toBe(1);
  });

  it('A4/T-6: a NEW CONNECTED frame (reconnect/resume) re-reads the selected channel from cursor "0" and recovers a contiguous timeline', () => {
    const sc = vi.fn(() => true);
    const { rerender, frame } = selectGeneral(sc);
    const beforeDisconnect = timelineFrame(
      'chan-1',
      [timelineEvent({ id: 'ev-before', cursor: '1', payload: { channelId: 'chan-1', text: 'before disconnect' } })],
      '1',
      false,
    );
    rerender(<ChannelsPanel events={[frame, beforeDisconnect]} sendCommand={sc} onClose={vi.fn()} />);
    expect(screen.getByText('before disconnect')).toBeInTheDocument();
    sc.mockClear();

    // Socket dropped and reconnected — a fresh CONNECTED frame lands (never
    // seen before by this panel instance).
    const reconnected = connectedFrame('sess-after-reconnect');
    rerender(<ChannelsPanel events={[frame, beforeDisconnect, reconnected]} sendCommand={sc} onClose={vi.fn()} />);

    const timelineCalls = sc.mock.calls.filter((c) => (c[0] as any).action === 'GET_CHANNEL_TIMELINE');
    expect(timelineCalls.length).toBe(1);
    expect(timelineCalls[0]![0]).toEqual({ action: 'GET_CHANNEL_TIMELINE', channelId: 'chan-1', cursor: '0', limit: 50 });

    // The store-backed re-read from '0' returns the FULL contiguous history
    // (the store, not the socket, is the source of truth — §4 S4).
    const recovered = timelineFrame(
      'chan-1',
      [
        timelineEvent({ id: 'ev-before', cursor: '1', payload: { channelId: 'chan-1', text: 'before disconnect' } }),
        timelineEvent({ id: 'ev-missed', cursor: '2', payload: { channelId: 'chan-1', text: 'missed while down' } }),
      ],
      '2',
      false,
    );
    rerender(<ChannelsPanel events={[frame, beforeDisconnect, reconnected, recovered]} sendCommand={sc} onClose={vi.fn()} />);
    expect(screen.getByText('before disconnect')).toBeInTheDocument();
    expect(screen.getByText('missed while down')).toBeInTheDocument();
  });

  it('a repeated CONNECTED frame with the SAME id (re-render, not a new connect) does not re-fire the reconnect re-read', () => {
    const sc = vi.fn(() => true);
    const { rerender, frame } = selectGeneral(sc);
    const initialTimeline = timelineFrame('chan-1', [], '0', false);
    rerender(<ChannelsPanel events={[frame, initialTimeline]} sendCommand={sc} onClose={vi.fn()} />);
    sc.mockClear();

    const reconnected = connectedFrame();
    rerender(<ChannelsPanel events={[frame, initialTimeline, reconnected]} sendCommand={sc} onClose={vi.fn()} />);
    expect(sc.mock.calls.filter((c) => (c[0] as any).action === 'GET_CHANNEL_TIMELINE').length).toBe(1);

    const resolved = timelineFrame('chan-1', [], '0', false);
    rerender(<ChannelsPanel events={[frame, initialTimeline, reconnected, resolved]} sendCommand={sc} onClose={vi.fn()} />);
    // Same events array reference content (same CONNECTED id) re-rendered —
    // must not dispatch a second reconnect re-read.
    rerender(<ChannelsPanel events={[frame, initialTimeline, reconnected, resolved]} sendCommand={sc} onClose={vi.fn()} />);
    expect(sc.mock.calls.filter((c) => (c[0] as any).action === 'GET_CHANNEL_TIMELINE').length).toBe(1);
  });

  it('T-11 (S4 addition): a hint-triggered re-read dispatches ONLY GET_CHANNEL_TIMELINE — no new action added to the allowlist by this slice', () => {
    const sc = vi.fn(() => true);
    const { rerender, frame } = selectGeneral(sc);
    const initialTimeline = timelineFrame('chan-1', [], '0', false);
    rerender(<ChannelsPanel events={[frame, initialTimeline]} sendCommand={sc} onClose={vi.fn()} />);
    sc.mockClear();

    const hint = hintFrame({ eventId: 'hint-inertness' });
    rerender(<ChannelsPanel events={[frame, initialTimeline, hint]} sendCommand={sc} onClose={vi.fn()} />);

    const actions = sc.mock.calls.map((c) => (c[0] as any).action);
    expect(actions.length).toBeGreaterThan(0);
    for (const a of actions) expect(S3_ALLOWLIST.has(a)).toBe(true);
    for (const a of actions) expect(DANGEROUS_ACTIONS.has(a)).toBe(false);
  });

  it('no-delivery-language sweep: this panel never renders "delivered", "live", or a checkmark-style delivery claim anywhere', () => {
    const sc = vi.fn(() => true);
    const { rerender, frame, container } = selectGeneral(sc);
    const timeline = timelineFrame(
      'chan-1',
      [timelineEvent({ id: 'ev-x', cursor: '1', payload: { channelId: 'chan-1', text: 'plain message' } })],
      '1',
      false,
    );
    rerender(<ChannelsPanel events={[frame, timeline]} sendCommand={sc} onClose={vi.fn()} />);
    expect(container.textContent).not.toMatch(/delivered/i);
    expect(container.textContent).not.toMatch(/\blive\b/i);
    expect(container.textContent).not.toContain('✓');
  });
});

// ---------------------------------------------------------------------------
// S5 — agent co-presence roster (§4 S5 / A5 / A9 / T-9 n/a / T-10 / T-11).
//
// A6/T-9 NOT APPLICABLE: this slice adds no new sendCommand action and no new
// wire command (see the S5 module-doc block in ChannelsPanel.tsx). Every test
// below drives the SAME `events` prop shape every other describe block in
// this file already uses; there is no new GatewayEvent field to grammar-test.
// ---------------------------------------------------------------------------
describe('ChannelsPanel — S5 selectors (pure, no render)', () => {
  it('selectChannelMembers: replays member_added -> current member', () => {
    const added = timelineEvent({
      id: 'ev-add', cursor: '1', kind: 'member_added',
      payload: { channelId: 'chan-1', principalId: 'principal-agent0001', membershipEpoch: 1 },
    });
    const members = selectChannelMembers([added] as any);
    expect(members).toEqual([{ principalId: 'principal-agent0001', role: 'member', since: added.occurredAt }]);
  });

  it('selectChannelMembers: a later member_removed for the same principal nets to REMOVED (not a member)', () => {
    const added = timelineEvent({
      id: 'ev-add', cursor: '1', kind: 'member_added',
      payload: { channelId: 'chan-1', principalId: 'principal-agent0001', membershipEpoch: 1 },
    });
    const removed = timelineEvent({
      id: 'ev-rm', cursor: '2', kind: 'member_removed',
      payload: { channelId: 'chan-1', principalId: 'principal-agent0001', membershipEpoch: 2 },
    });
    // Order in the array must not matter -- reduce is by cursor, not position.
    expect(selectChannelMembers([removed, added] as any)).toEqual([]);
    expect(selectChannelMembers([added, removed] as any)).toEqual([]);
  });

  it('selectChannelMembers: add -> remove -> re-add nets to MEMBER (latest cursor wins)', () => {
    const p = 'principal-agent0002';
    const events = [
      timelineEvent({ id: 'e1', cursor: '1', kind: 'member_added', payload: { channelId: 'c', principalId: p, membershipEpoch: 1 } }),
      timelineEvent({ id: 'e2', cursor: '2', kind: 'member_removed', payload: { channelId: 'c', principalId: p, membershipEpoch: 2 } }),
      timelineEvent({ id: 'e3', cursor: '3', kind: 'member_added', payload: { channelId: 'c', principalId: p, membershipEpoch: 3 } }),
    ];
    const members = selectChannelMembers(events as any);
    expect(members.map((m) => m.principalId)).toEqual([p]);
  });

  it('selectChannelMembers: message_posted / channel_created / other kinds never contribute a member row', () => {
    const events = [
      timelineEvent({ id: 'e1', cursor: '1', kind: 'message_posted', payload: { channelId: 'c', text: 'hi' } }),
      timelineEvent({ id: 'e2', cursor: '2', kind: 'channel_created', payload: { channelId: 'c', name: 'general' } }),
    ];
    expect(selectChannelMembers(events as any)).toEqual([]);
  });

  it('selectChannelMembers: empty timeline -> [] (real-empty, not null -- this function never returns null)', () => {
    expect(selectChannelMembers([])).toEqual([]);
  });

  it('selectWorkingNow: no active task -> null', () => {
    expect(selectWorkingNow([])).toBeNull();
    expect(selectWorkingNow([ev({ type: 'RESULT', requestId: 'r1' })])).toBeNull();
  });

  it('selectWorkingNow: an in-flight task (TIER_SELECTED, no terminal yet) is reported with its requestId, anchor, and phase', () => {
    const events = [
      ev({ type: 'TIER_SELECTED', requestId: 'r1', timestamp: '2026-01-01T00:00:05.000Z' }),
      ev({ type: 'TOOL_CALL', requestId: 'r1', message: 'Executing filesystem__read_file', timestamp: '2026-01-01T00:00:06.000Z' }),
    ];
    const working = selectWorkingNow(events);
    expect(working).not.toBeNull();
    expect(working!.requestId).toBe('r1');
    expect(working!.turnStartMs).toBe(Date.parse('2026-01-01T00:00:05.000Z'));
    expect(working!.phaseText).toBe('Using read file (filesystem)');
  });

  it('selectWorkingNow: a RESULT/ERROR for the active request clears it back to null', () => {
    const events = [
      ev({ type: 'TIER_SELECTED', requestId: 'r1' }),
      ev({ type: 'RESULT', requestId: 'r1' }),
    ];
    expect(selectWorkingNow(events)).toBeNull();
  });
});

describe('ChannelsPanel — S5 roster (render)', () => {
  function selectGeneral(sc = vi.fn(() => true)) {
    const frame = channelListFrame([channelRow()]);
    const result = renderPanel([frame], sc);
    fireEvent.click(screen.getByText('general'));
    return { ...result, sc, frame };
  }

  it('T-10: no timeline loaded yet -> Members section renders nothing extra (no premature roster claim)', () => {
    selectGeneral();
    // Only the timeline's own "Loading..." should be present; no member
    // chips can exist before any timeline frame has ever landed.
    expect(screen.queryByText('Members')).not.toBeInTheDocument();
  });

  it('T-10 / A9: an empty-but-loaded timeline renders "Members" (real-empty) distinct from not-yet-loaded', () => {
    const sc = vi.fn(() => true);
    const { rerender, frame } = selectGeneral(sc);
    const emptyTimeline = timelineFrame('chan-1', [], '0', false);
    rerender(<ChannelsPanel events={[frame, emptyTimeline]} sendCommand={sc} onClose={vi.fn()} />);

    expect(screen.getByText('Members')).toBeInTheDocument();
    expect(screen.getByText('No members seen yet.')).toBeInTheDocument();
  });

  it('A9: Members and Working now render as two separately-labeled sections', () => {
    const sc = vi.fn(() => true);
    const { rerender, frame } = selectGeneral(sc);
    const timeline = timelineFrame(
      'chan-1',
      [timelineEvent({
        id: 'ev-add', cursor: '1', kind: 'member_added',
        payload: { channelId: 'chan-1', principalId: 'principal-member01', membershipEpoch: 1 },
      })],
      '1',
      false,
    );
    rerender(<ChannelsPanel events={[frame, timeline]} sendCommand={sc} onClose={vi.fn()} />);

    expect(screen.getByText('Members')).toBeInTheDocument();
    // G2A C-S5-2: label scoped from "Working now" (which read as a roster of
    // everyone) to what one session can actually know. A rename tracked here,
    // not a weakened assertion -- getByText still throws if absent.
    expect(screen.getByText("This console's task")).toBeInTheDocument();
    // 'principal-member01'.slice(0,8) === 'principa' -- appears TWICE: once
    // as the roster's member chip, once as the timeline's own member_added
    // system-event row detail (systemEventDetail already renders it there;
    // both are correct, independent renderings of the same wire fact).
    expect(screen.getAllByText('principa').length).toBe(2);
    expect(screen.getByText('Nothing running in this console.')).toBeInTheDocument();
  });

  it('A9: a fixture with a WORKING NON-MEMBER proves presence never implies membership -- the working row renders unconditionally, never filtered by the member list', () => {
    const sc = vi.fn(() => true);
    const frame = channelListFrame([channelRow()]);
    const emptyTimeline = timelineFrame('chan-1', [], '0', false); // zero members
    // A task is actively running (a TIER_SELECTED with no terminal event) --
    // this principal-less "working now" row has NO membership claim at all,
    // and must render in full even though the Members section is real-empty.
    const workingEvents: GatewayEvent[] = [
      frame,
      emptyTimeline,
      ev({ type: 'TIER_SELECTED', requestId: 'r-nonmember', timestamp: '2026-01-01T00:00:05.000Z' }),
      ev({ type: 'TOOL_CALL', requestId: 'r-nonmember', message: 'Executing filesystem__read_file', timestamp: '2026-01-01T00:00:06.000Z' }),
    ];
    const { rerender } = renderPanel([frame], sc);
    fireEvent.click(screen.getByText('general'));
    rerender(<ChannelsPanel events={workingEvents} sendCommand={sc} onClose={vi.fn()} />);

    // Members: real-empty, zero members.
    expect(screen.getByText('No members seen yet.')).toBeInTheDocument();
    // Working now: renders in full regardless -- proving no implicit
    // membership gate exists on the "working now" path.
    expect(screen.getByText('Using read file (filesystem)')).toBeInTheDocument();
    expect(screen.getByText(/turn r-nonmem/)).toBeInTheDocument();
    expect(screen.queryByText('Nothing running in this console.')).not.toBeInTheDocument();
  });

  it('elapsed is EPOCH-ANCHORED across a simulated remount -- unmount/remount does not reset the clock to 0:00', () => {
    const sc = vi.fn(() => true);
    const frame = channelListFrame([channelRow()]);
    const emptyTimeline = timelineFrame('chan-1', [], '0', false);
    const events: GatewayEvent[] = [
      frame,
      emptyTimeline,
      ev({ type: 'TIER_SELECTED', requestId: 'r-anchor', timestamp: '2026-01-01T00:00:00.000Z' }),
      ev({ type: 'TOOL_CALL', requestId: 'r-anchor', message: 'Executing filesystem__read_file', timestamp: '2026-01-01T00:00:05.000Z' }),
    ];

    const originalNow = Date.now;
    try {
      Date.now = () => Date.parse('2026-01-01T00:00:30.000Z'); // 30s after the anchor
      const first = render(<ChannelsPanel events={[frame]} sendCommand={sc} onClose={vi.fn()} />);
      fireEvent.click(screen.getByText('general'));
      first.rerender(<ChannelsPanel events={events} sendCommand={sc} onClose={vi.fn()} />);
      expect(screen.getByText('0:30')).toBeInTheDocument();
      first.unmount();
      cleanup();

      // SIMULATED REMOUNT: a fresh mount, same events (same anchor), later
      // wall clock. If the anchor were a mount-time counter this would read
      // 0:00 again; because it is selectTurnStartMs (an epoch from the real
      // event timestamps), the SAME events array must recompute the SAME
      // real elapsed at the new "now".
      Date.now = () => Date.parse('2026-01-01T00:01:00.000Z'); // 60s after the anchor
      const second = render(<ChannelsPanel events={[frame]} sendCommand={sc} onClose={vi.fn()} />);
      fireEvent.click(screen.getByText('general'));
      second.rerender(<ChannelsPanel events={events} sendCommand={sc} onClose={vi.fn()} />);
      expect(screen.getByText('1:00')).toBeInTheDocument();
      expect(screen.queryByText('0:00')).not.toBeInTheDocument();
    } finally {
      Date.now = originalNow;
    }
  });

  it('T-11: the roster renders zero buttons/links and clicking anywhere in it dispatches nothing beyond the ordinary read-only allowlist', () => {
    const sc = vi.fn(() => true);
    const { rerender, frame } = selectGeneral(sc);
    const timeline = timelineFrame(
      'chan-1',
      [timelineEvent({
        id: 'ev-add', cursor: '1', kind: 'member_added',
        payload: { channelId: 'chan-1', principalId: 'principal-inert001', membershipEpoch: 1 },
      })],
      '1',
      false,
    );
    // G2A C-S5-1: the fixture previously carried a member_added event ONLY, so
    // the Working-now branch NEVER RENDERED and this test could not see a rogue
    // affordance on the one row that names a live task. G2A injected a button
    // there and 62/62 stayed green -- the fourth instance this session of a
    // suite passing identically with and without its guard (after V-1, RC-1,
    // B-1). An in-flight TIER_SELECTED with no terminal populates that branch.
    const liveTask = ev({
      type: 'TIER_SELECTED', requestId: 'r-roster-live',
      timestamp: '2026-01-01T00:00:05.000Z',
    });
    rerender(
      <ChannelsPanel events={[frame, timeline, liveTask]} sendCommand={sc} onClose={vi.fn()} />,
    );

    const rosterHeading = screen.getByText('Members');
    const rosterSection = rosterHeading.closest('div')!.parentElement!;

    // Anti-vacuity: the Working-now branch MUST actually be populated, or the
    // affordance assertions below sweep an empty region and prove nothing.
    expect(
      within(rosterSection).queryByText('Nothing running in this console.'),
      'C-S5-1: the T-11 fixture must render a LIVE Working-now row -- an empty '
      + 'branch makes the zero-affordance assertions vacuous on exactly the row '
      + 'that names a running task.',
    ).not.toBeInTheDocument();

    // No button/link/onClick affordance anywhere inside the roster block --
    // now covering BOTH the Members chips and the populated Working-now row.
    expect(within(rosterSection).queryAllByRole('button').length).toBe(0);
    expect(within(rosterSection).queryAllByRole('link').length).toBe(0);

    sc.mockClear();
    fireEvent.click(rosterHeading);
    fireEvent.click(within(rosterSection).getByText('principa')); // the member chip, scoped
    fireEvent.click(within(rosterSection).getByText("This console's task")); // the live section
    const actions = sc.mock.calls.map((c) => (c[0] as any).action);
    for (const a of actions) expect(READ_ONLY_ALLOWLIST.has(a)).toBe(true);
    for (const a of actions) expect(DANGEROUS_ACTIONS.has(a)).toBe(false);
  });

  it('T-12: no-fabrication -- a member row shows only the principal id, never an invented role/display-name/online-status field', () => {
    const sc = vi.fn(() => true);
    const { rerender, frame } = selectGeneral(sc);
    const timeline = timelineFrame(
      'chan-1',
      [timelineEvent({
        id: 'ev-add', cursor: '1', kind: 'member_added',
        payload: { channelId: 'chan-1', principalId: 'principal-nofab0001', membershipEpoch: 1 },
      })],
      '1',
      false,
    );
    rerender(<ChannelsPanel events={[frame, timeline]} sendCommand={sc} onClose={vi.fn()} />);

    // 'principal-nofab0001'.slice(0,8) === 'principa' -- renders twice (the
    // roster chip and the timeline's own member_added system row); both are
    // legitimate independent renderings of the same wire fact.
    expect(screen.getAllByText('principa').length).toBe(2);
    expect(screen.queryByText(/online/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/offline/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/away/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/idle/i)).not.toBeInTheDocument();
  });

  it('malformed-frame resilience: a member_added event missing principalId is skipped, never crashes, never renders "undefined"', () => {
    const sc = vi.fn(() => true);
    const { rerender, frame } = selectGeneral(sc);
    const timeline = timelineFrame(
      'chan-1',
      [timelineEvent({ id: 'ev-bad', cursor: '1', kind: 'member_added', payload: { channelId: 'chan-1' } })],
      '1',
      false,
    );
    expect(() => {
      rerender(<ChannelsPanel events={[frame, timeline]} sendCommand={sc} onClose={vi.fn()} />);
    }).not.toThrow();
    expect(screen.getByText('No members seen yet.')).toBeInTheDocument();
    expect(screen.queryByText('undefined')).not.toBeInTheDocument();
  });

  it('no roster row is rendered without a selected channel (no presence affordance with no channel context)', () => {
    const sc = vi.fn(() => true);
    renderPanel([], sc);
    expect(screen.queryByText('Members')).not.toBeInTheDocument();
    expect(screen.queryByText("This console's task")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// S5b self-principal: the CONNECTED frame may carry a SELF-ONLY
// `metadata.principalId` (the connection's OWN resolved collab principal,
// self-disclosed by the server; omitted entirely for legacy/flag-off/channel-
// service connections). The panel surfaces it ONLY as a "you" annotation on
// an ALREADY-LOADED member row -- never as a fabricated membership claim.
// These tests drive the panel with frames already present in `events`, the
// same shape as every other block in this file; they assert nothing about
// socket delivery semantics.
// ---------------------------------------------------------------------------
describe('ChannelsPanel — S5b self-principal', () => {
  function connectedFrame(principalId?: string): GatewayEvent {
    return ev({
      type: 'CONNECTED',
      metadata: {
        sessionId: 'sess-s5b-1',
        resumed: true,
        ...(principalId !== undefined ? { principalId } : {}),
      },
    });
  }

  function selectGeneral(sc = vi.fn(() => true)) {
    const frame = channelListFrame([channelRow()]);
    const result = renderPanel([frame], sc);
    fireEvent.click(screen.getByText('general'));
    return { ...result, sc, frame };
  }

  function memberTimeline(principalId: string): GatewayEvent {
    return timelineFrame(
      'chan-1',
      [timelineEvent({
        id: 'ev-add', cursor: '1', kind: 'member_added',
        payload: { channelId: 'chan-1', principalId, membershipEpoch: 1 },
      })],
      '1',
      false,
    );
  }

  function rosterSection(): HTMLElement {
    return screen.getByText('Members').closest('div')!.parentElement!;
  }

  it('S5b: a CONNECTED self-principalId matching a loaded member renders "you: principa" and marks that member chip\'s tooltip with "· you"', () => {
    const sc = vi.fn(() => true);
    const { rerender, frame } = selectGeneral(sc);
    const timeline = memberTimeline('principal-member01');
    const connected = connectedFrame('principal-member01');
    rerender(<ChannelsPanel events={[frame, timeline, connected]} sendCommand={sc} onClose={vi.fn()} />);

    // 'principal-member01'.slice(0,8) === 'principa' -- the caption is the
    // self-annotation; the visible chip text is unchanged (the roster chip
    // plus the timeline's own member_added system row still render 'principa').
    expect(screen.getByText('you: principa')).toBeInTheDocument();
    expect(screen.getAllByText('principa').length).toBe(2);

    const chip = within(rosterSection()).getByText('principa');
    expect(chip.textContent).toBe('principa'); // visible text NOT annotated inline
    const title = chip.getAttribute('title') ?? '';
    expect(title).toContain('principal-member01');
    expect(title).toContain('· you');
  });

  it('S5b: a CONNECTED principalId NOT present in the loaded members renders no "you:" caption and marks no chip (no membership fabrication)', () => {
    const sc = vi.fn(() => true);
    const { rerender, frame } = selectGeneral(sc);
    const timeline = memberTimeline('principal-member01');
    const connected = connectedFrame('principal-ghost999'); // not a member of the loaded roster
    rerender(<ChannelsPanel events={[frame, timeline, connected]} sendCommand={sc} onClose={vi.fn()} />);

    // Anti-vacuity: the member roster really did load and render.
    expect(screen.getByText('Members')).toBeInTheDocument();
    expect(within(rosterSection()).getByText('principa')).toBeInTheDocument();

    // The foreign principalId is disclosed, but it matches NO loaded member,
    // so no self-annotation may appear anywhere.
    expect(screen.queryByText(/^you: /)).not.toBeInTheDocument();
    const chip = within(rosterSection()).getByText('principa');
    expect(chip.getAttribute('title') ?? '').not.toContain('· you');
    // And no member row was fabricated for the disclosed principal: still
    // exactly the one real member chip plus the timeline's system row.
    expect(screen.getAllByText('principa').length).toBe(2);
    expect(within(rosterSection()).getAllByRole('listitem').length).toBe(1);
  });

  it('S5b: a CONNECTED frame with no principalId (legacy/flag-off) renders no "you:" caption and marks no chip', () => {
    const sc = vi.fn(() => true);
    const { rerender, frame } = selectGeneral(sc);
    const timeline = memberTimeline('principal-member01');
    const connected = connectedFrame(); // sessionId/resumed only -- the pre-S5b wire shape
    rerender(<ChannelsPanel events={[frame, timeline, connected]} sendCommand={sc} onClose={vi.fn()} />);

    // Anti-vacuity: members loaded and rendered as before.
    expect(screen.getByText('Members')).toBeInTheDocument();
    const chip = within(rosterSection()).getByText('principa');
    expect(chip).toBeInTheDocument();

    expect(screen.queryByText(/^you: /)).not.toBeInTheDocument();
    expect(chip.getAttribute('title') ?? '').not.toContain('· you');
  });
});
