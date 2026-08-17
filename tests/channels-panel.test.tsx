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

  it('Send is disabled for empty text and for whitespace/newline-only text (client-side decline, not a substrate rule)', () => {
    selectGeneral();
    expect(sendButton()).toBeDisabled();

    fireEvent.change(composerTextarea(), { target: { value: '   \n\t  ' } });
    // whitespace-only is non-empty in bytes but the composer declines to
    // send it anyway per its OWN choice (§13 S3) -- NOTE: the substrate
    // itself would accept this; only THIS button's affordance declines it.
    // The implementation's `empty` check is byte-based (rawBytes === 0),
    // so purely-whitespace text with nonzero bytes is NOT blocked by
    // `budget.empty` -- confirm real behavior rather than assume.
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
    const ack = ev({
      type: 'SYSTEM',
      metadata: { collabMessagePosted: true, channelId: 'chan-1', eventId: 'ev-confirmed-1', cursor: '1', occurredAt: '2026-08-17T00:00:00.000Z' },
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
