// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { GatewayEvent } from '@torqclaw/contracts';
import ChannelsPanel, { parseRoomListRows } from '../apps/console/src/components/ChannelsPanel.js';

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
});

let eventId = 0;
function event(overrides: Partial<GatewayEvent>): GatewayEvent {
  eventId++;
  return {
    id: `rooms-${eventId}`,
    requestId: null,
    sessionId: 'session-1',
    tier: null,
    type: 'SYSTEM',
    message: '',
    timestamp: '2026-08-24T00:00:00.000Z',
    ...overrides,
  } as GatewayEvent;
}

function listFrame(channels: unknown[]): GatewayEvent {
  return event({ type: 'SYSTEM', metadata: { collabChannels: true, channels } });
}

function roomRow(overrides: Record<string, unknown> = {}) {
  return {
    channelId: 'room-a',
    name: 'Incident Alpha',
    state: 'active',
    role: 'owner',
    lastAcknowledgedCursor: '88',
    externalExportPolicy: 'local_only',
    ...overrides,
  };
}

function roomJobListFrame(channelId: string, jobs: unknown[], canCreate = false): GatewayEvent {
  return event({
    metadata: { roomJob: { version: 1, kind: 'list', channelId, jobs, nextCursor: '0', hasMore: false, capabilities: { canCreate } } },
  });
}

function roomJobRow(overrides: Record<string, unknown> = {}) {
  return {
    jobId: '00000000-0000-4000-8000-000000000011',
    channelId: 'room-a',
    state: 'created',
    revision: 1,
    createdAt: '2026-10-02T00:00:00.000Z',
    cancelledAt: null,
    briefByteLength: 18,
    capabilities: { canCreate: true, canCancel: true },
    ...overrides,
  };
}

function roomJobDetailFrame(job: Record<string, unknown>): GatewayEvent {
  return event({
    metadata: { roomJob: { version: 1, kind: 'detail', job: { ...job, lifecycle: [{ jobSeq: 1, kind: 'created', state: 'created', revision: 1, occurredAt: '2026-10-02T00:00:00.000Z' }], artifacts: [] } } },
  });
}

function roomProps(events: GatewayEvent[], sendCommand = vi.fn(() => true), isConnected = true, isStale = false) {
  return {
    mode: 'rooms' as const,
    events,
    sendCommand,
    isConnected,
    isStale,
    onClose: vi.fn(),
    onOpenAgents: vi.fn(),
    onOpenApprovals: vi.fn(),
    onOpenReceipts: vi.fn(),
    onOpenCost: vi.fn(),
    onOpenMemory: vi.fn(),
    onOpenTaskStream: vi.fn(),
  };
}

describe('Rooms list runtime boundary', () => {
  it('keeps only non-empty channelId/name/state and drops authority-bearing fields', () => {
    const parsed = parseRoomListRows([
      roomRow(),
      roomRow({ channelId: 'room-b', name: '   ' }),
      roomRow({ channelId: 'room-c', state: '' }),
      { channelId: 'room-d', name: 'Missing state' },
      null,
    ]);

    expect(parsed).toEqual({
      rows: [{ channelId: 'room-a', name: 'Incident Alpha', state: 'active' }],
      malformedRows: 4,
      duplicateIds: 0,
      resultClass: 'partial',
    });
    expect(Object.keys(parsed.rows[0]!)).toEqual(['channelId', 'name', 'state']);
  });

  it('suppresses every occurrence of a duplicated id, even with a malformed sibling', () => {
    const parsed = parseRoomListRows([
      roomRow(),
      roomRow({ name: '' }),
      roomRow({ channelId: 'room-b', name: 'Beta' }),
    ]);

    expect(parsed.rows).toEqual([{ channelId: 'room-b', name: 'Beta', state: 'active' }]);
    expect(parsed.malformedRows).toBe(1);
    expect(parsed.duplicateIds).toBe(1);
    expect(parsed.resultClass).toBe('partial');
  });

  it('distinguishes an empty successful list from an all-suppressed list', () => {
    expect(parseRoomListRows([]).resultClass).toBe('empty');
    expect(parseRoomListRows([{ channelId: '', name: '', state: '' }]).resultClass).toBe('all-suppressed');
  });
});

describe('ChannelsPanel Rooms mode', () => {
  it('mounts with exactly LIST_CHANNELS and renders only validated list name/state facts', () => {
    const sendCommand = vi.fn(() => true);
    const hostileEvents = [
      listFrame([roomRow({ role: 'backend_owner_role', externalExportPolicy: 'operator_confirmed_non_sensitive' })]),
      event({ metadata: { collabTimeline: true, channelId: 'room-a', events: [{ payload: { text: 'secret timeline text' } }], cursor: '9', hasMore: false } }),
      event({ metadata: { collabMembers: true, channelId: 'room-a', members: [{ displayName: 'Owner Name' }] } }),
      event({ metadata: { collabAgents: true, agents: [{ displayName: 'Cached Agent' }] } }),
    ];

    render(<ChannelsPanel {...roomProps(hostileEvents, sendCommand)} />);

    expect(sendCommand.mock.calls.map(([command]) => command)).toEqual([{ action: 'LIST_CHANNELS', limit: 50 }]);
    expect(screen.getByText('Incident Alpha')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.queryByText('local_only')).not.toBeInTheDocument();
    expect(screen.queryByText('operator_confirmed_non_sensitive')).not.toBeInTheDocument();
    expect(screen.queryByText('backend_owner_role')).not.toBeInTheDocument();
    expect(screen.queryByText('88')).not.toBeInTheDocument();
    expect(screen.queryByText('secret timeline text')).not.toBeInTheDocument();
    expect(screen.queryByText('Owner Name')).not.toBeInTheDocument();
    expect(screen.queryByText('Cached Agent')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/Message this channel/i)).not.toBeInTheDocument();
    expect(screen.getByText('not enforced at Room scope yet')).toBeInTheDocument();
    expect(screen.getByText('unknown/not loaded')).toBeInTheDocument();
  });

  it('local highlight dispatches only selected Room-job reads and preserved global navigation', () => {
    const sendCommand = vi.fn(() => true);
    const props = roomProps(
      [listFrame([roomRow(), roomRow({ channelId: 'room-b', name: 'Release Beta' })])],
      sendCommand,
    );
    render(<ChannelsPanel {...props} />);
    sendCommand.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /Incident Alpha/i }));
    expect(screen.getByText('List row state: active')).toBeInTheDocument();
    expect(screen.getByText('Selected Room details unavailable under the current wire.')).toBeInTheDocument();

    for (const button of screen.getAllByRole('button')) fireEvent.click(button);

    const actions = sendCommand.mock.calls.map(([command]) => command.action);
    expect(actions.length).toBeGreaterThan(0);
    expect(new Set(actions)).toEqual(new Set(['LIST_CHANNELS', 'LIST_ROOM_JOBS']));
    expect(props.onOpenAgents).toHaveBeenCalled();
    expect(props.onOpenApprovals).toHaveBeenCalled();
    expect(props.onOpenReceipts).toHaveBeenCalled();
    expect(props.onOpenCost).toHaveBeenCalled();
    expect(props.onOpenMemory).toHaveBeenCalled();
    expect(props.onOpenTaskStream).toHaveBeenCalled();
  });

  it('keeps current-session evidence passive even when receipt/export-looking frames exist', () => {
    const sendCommand = vi.fn(() => true);
    const props = roomProps([
      listFrame([roomRow()]),
      event({ metadata: { safeExportAvailable: true, taskId: 'task-1', channelId: 'room-a' } }),
      event({ metadata: { receiptId: 'receipt-1', taskId: 'task-1', channelId: 'room-a' } }),
      event({ metadata: { approvalId: 'approval-1', state: 'pending', channelId: 'room-a' } }),
    ], sendCommand);

    render(<ChannelsPanel {...props} />);
    sendCommand.mockClear();

    expect(screen.getByText('Current-session evidence')).toBeInTheDocument();
    expect(screen.getByText('Session-scoped. Room attribution not recorded.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Active, blocked, complete' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Awaiting approval' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Receipt state' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /safe export/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /download/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /resume/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Receipt state' }));
    fireEvent.click(screen.getByRole('button', { name: 'Active, blocked, complete' }));

    expect(sendCommand).not.toHaveBeenCalled();
    expect(props.onOpenReceipts).toHaveBeenCalledTimes(1);
    expect(props.onOpenTaskStream).toHaveBeenCalledTimes(1);
  });

  it('renders only typed selected job evidence and gates controls on fresh capabilities', () => {
    const sendCommand = vi.fn(() => true);
    const roomList = listFrame([roomRow()]);
    const props = roomProps([roomList], sendCommand);
    const { rerender } = render(<ChannelsPanel {...props} />);

    fireEvent.click(screen.getByRole('button', { name: /Incident Alpha/i }));
    expect(sendCommand.mock.calls.map(([command]) => command.action)).toContain('LIST_ROOM_JOBS');

    const job = roomJobRow();
    rerender(<ChannelsPanel {...props} events={[roomList, roomJobListFrame('room-a', [job], true)]} />);
    expect(screen.getByText(/Job 00000000-0000-4000-8000-000000000011/)).toBeInTheDocument();
    expect(screen.queryByText('secret brief text')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Client brief'), { target: { value: 'A bounded client brief' } });
    expect(screen.getByRole('button', { name: 'Create proposal job' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: /Job 00000000-0000-4000-8000-000000000011/ }));
    expect(sendCommand.mock.calls.map(([command]) => command.action)).toContain('GET_ROOM_JOB');
    rerender(<ChannelsPanel {...props} events={[roomList, roomJobListFrame('room-a', [job], true), roomJobDetailFrame(job)]} />);
    expect(screen.getByText('Recorded - no live worker is wired.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /download|preview|safe export|retry|resume/i })).not.toBeInTheDocument();

    rerender(<ChannelsPanel {...props} events={[roomList, roomJobListFrame('room-a', [job], true), roomJobDetailFrame(job)]} isStale />);
    expect(screen.getByRole('button', { name: 'Create proposal job' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel job' })).toBeDisabled();
  });

  it('drains batched selected list/detail frames in order and ignores an unrelated later frame', () => {
    const sendCommand = vi.fn(() => true);
    const rooms = listFrame([roomRow(), roomRow({ channelId: 'room-b', name: 'Release Beta' })]);
    const props = roomProps([rooms], sendCommand);
    const { rerender } = render(<ChannelsPanel {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /Incident Alpha/i }));
    const job = roomJobRow();
    const selectedList = roomJobListFrame('room-a', [job], true);
    const unrelatedList = roomJobListFrame('room-b', [], false);

    rerender(<ChannelsPanel {...props} events={[rooms, selectedList, unrelatedList]} />);
    expect(screen.getByText(/Job 00000000-0000-4000-8000-000000000011/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Job 00000000-0000-4000-8000-000000000011/ }));
    const selectedDetail = roomJobDetailFrame(job);
    rerender(<ChannelsPanel {...props} events={[rooms, selectedList, selectedDetail, unrelatedList]} />);
    expect(screen.getByText('Recorded - no live worker is wired.')).toBeInTheDocument();
  });

  it('shows typed create/cancel pending states and an unconfirmed refresh state on mutation send failure', () => {
    const sendCommand = vi.fn((command: { action: string }) => command.action !== 'CREATE_ROOM_JOB' && command.action !== 'CANCEL_ROOM_JOB');
    const rooms = listFrame([roomRow()]);
    const props = roomProps([rooms], sendCommand);
    const { rerender } = render(<ChannelsPanel {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /Incident Alpha/i }));
    const job = roomJobRow();
    const jobs = roomJobListFrame('room-a', [job], true);
    rerender(<ChannelsPanel {...props} events={[rooms, jobs]} />);
    fireEvent.change(screen.getByLabelText('Client brief'), { target: { value: 'Brief' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create proposal job' }));
    expect(screen.getByText('Request not confirmed.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh from the gateway.' })).toBeInTheDocument();
    expect(screen.queryByText('Cancellation request pending confirmation.')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Job 00000000-0000-4000-8000-000000000011/ }));
    rerender(<ChannelsPanel {...props} events={[rooms, jobs, roomJobDetailFrame(job)]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel job' }));
    expect(screen.getByText('Request not confirmed.')).toBeInTheDocument();
    expect(sendCommand.mock.calls.map(([command]) => command.action)).toContain('CREATE_ROOM_JOB');
    expect(sendCommand.mock.calls.map(([command]) => command.action)).toContain('CANCEL_ROOM_JOB');
  });

  it('keeps a timed-out create unconfirmed without creating a local job', () => {
    vi.useFakeTimers();
    try {
      const sendCommand = vi.fn(() => true);
      const rooms = listFrame([roomRow()]);
      const props = roomProps([rooms], sendCommand);
      const { rerender } = render(<ChannelsPanel {...props} />);
      fireEvent.click(screen.getByRole('button', { name: /Incident Alpha/i }));
      rerender(<ChannelsPanel {...props} events={[rooms, roomJobListFrame('room-a', [], true)]} />);
      fireEvent.change(screen.getByLabelText('Client brief'), { target: { value: 'Brief' } });
      fireEvent.click(screen.getByRole('button', { name: 'Create proposal job' }));
      expect(screen.getByText('Creation request pending confirmation.')).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(5000));
      expect(screen.getByText('Request not confirmed.')).toBeInTheDocument();
      expect(screen.getByText('No Room jobs recorded.')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders neutral empty, malformed, duplicate, and all-suppressed states', () => {
    const { rerender } = render(<ChannelsPanel {...roomProps([listFrame([])])} />);
    expect(screen.getByText('No Rooms loaded')).toBeInTheDocument();
    expect(screen.getAllByText('Room list unavailable/incomplete.').length).toBeGreaterThan(0);

    rerender(<ChannelsPanel {...roomProps([listFrame([roomRow({ name: '' })])])} />);
    expect(screen.queryByText('Incident Alpha')).not.toBeInTheDocument();
    expect(screen.getAllByText('Room list unavailable/incomplete.').length).toBeGreaterThan(0);
    expect(screen.getByText(/1 malformed row excluded/)).toBeInTheDocument();

    rerender(<ChannelsPanel {...roomProps([listFrame([roomRow(), roomRow({ name: 'Duplicate Alpha' })])])} />);
    expect(screen.queryByText('Incident Alpha')).not.toBeInTheDocument();
    expect(screen.queryByText('Duplicate Alpha')).not.toBeInTheDocument();
    expect(screen.getByText(/1 duplicate Room row id suppressed/)).toBeInTheDocument();
  });

  it('reports list send failure and timeout without manufacturing absence', () => {
    const sendFailure = vi.fn(() => false);
    const { unmount } = render(<ChannelsPanel {...roomProps([], sendFailure)} />);
    expect(sendFailure.mock.calls.map(([command]) => command.action)).toEqual(['LIST_CHANNELS']);
    expect(screen.getByText('Room list unavailable/incomplete.')).toBeInTheDocument();
    expect(screen.queryByText(/no active Rooms/i)).not.toBeInTheDocument();
    unmount();
    cleanup();

    vi.useFakeTimers();
    try {
      const sendCommand = vi.fn(() => true);
      render(<ChannelsPanel {...roomProps([], sendCommand)} />);
      act(() => vi.advanceTimersByTime(5000));
      expect(screen.getByText('Room list unavailable/incomplete.')).toBeInTheDocument();
      expect(screen.queryByText(/no active Rooms/i)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats omission, malformed envelopes, and unrelated envelopes as passive uncertainty', () => {
    const good = listFrame([roomRow()]);
    const malformedEnvelope = event({ metadata: { collabChannels: true, channels: 'not-an-array' } });
    const unrelated = event({ metadata: { collabTimeline: true, channelId: 'room-a', events: [] } });
    const props = roomProps([good]);
    const { rerender } = render(<ChannelsPanel {...props} />);
    expect(screen.getByText('Incident Alpha')).toBeInTheDocument();

    rerender(<ChannelsPanel {...props} events={[good, malformedEnvelope, unrelated]} />);
    expect(screen.getByText('Incident Alpha')).toBeInTheDocument();

    rerender(<ChannelsPanel {...props} events={[]} />);
    expect(screen.getByText('Incident Alpha')).toBeInTheDocument();
    expect(screen.getByText(/Non-authoritative for current Room details/)).toBeInTheDocument();
  });

  it('never commits delayed A-B-A timeline/member/error/global cache frames as Room content', () => {
    const sendCommand = vi.fn(() => true);
    const initial = listFrame([
      roomRow(),
      roomRow({ channelId: 'room-b', name: 'Release Beta' }),
    ]);
    const props = roomProps([initial], sendCommand);
    const { rerender } = render(<ChannelsPanel {...props} />);

    fireEvent.click(screen.getByRole('button', { name: /Incident Alpha/i }));
    fireEvent.click(screen.getByRole('button', { name: /Release Beta/i }));
    fireEvent.click(screen.getByRole('button', { name: /Incident Alpha/i }));
    sendCommand.mockClear();

    rerender(<ChannelsPanel {...props} events={[
      initial,
      event({ metadata: { collabTimeline: true, channelId: 'room-a', events: [{ payload: { text: 'delayed A text' } }], cursor: '10', hasMore: false } }),
      event({ metadata: { collabMembers: true, channelId: 'room-b', members: [{ displayName: 'Delayed B member' }] } }),
      event({ metadata: { collabPresence: true, channelId: 'room-a', displayName: 'Working Agent' } }),
      event({ metadata: { collabAgents: true, agents: [{ displayName: 'Cached Assignment' }] } }),
      event({ type: 'ERROR', message: 'scoped-looking denial', metadata: { channelId: 'room-a' } }),
      event({ metadata: { taskId: 'task-a', prompt: 'Room-looking task' } }),
      event({ metadata: { approvalId: 'approval-a', detail: 'Room-looking approval' } }),
      event({ metadata: { receiptId: 'receipt-a', detail: 'Room-looking receipt' } }),
      event({ metadata: { costSummary: true, total: '999' } }),
      event({ metadata: { memory: true, text: 'Room-looking memory' } }),
    ]} />);

    for (const leaked of [
      'delayed A text',
      'Delayed B member',
      'Working Agent',
      'Cached Assignment',
      'scoped-looking denial',
      'Room-looking task',
      'Room-looking approval',
      'Room-looking receipt',
      'Room-looking memory',
      '999',
    ]) {
      expect(screen.queryByText(leaked)).not.toBeInTheDocument();
    }
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('stays mounted while disconnected and refreshes only the list after reconnect', () => {
    const sendCommand = vi.fn(() => true);
    const frame = listFrame([roomRow()]);
    const props = roomProps([frame], sendCommand, true);
    const { rerender } = render(<ChannelsPanel {...props} />);
    expect(sendCommand).toHaveBeenCalledTimes(1);

    rerender(<ChannelsPanel {...props} isConnected={false} />);
    expect(screen.getByText(/Disconnected. Showing the last loaded Rooms list/)).toBeInTheDocument();
    expect(screen.getByText('Incident Alpha')).toBeInTheDocument();
    expect(sendCommand).toHaveBeenCalledTimes(1);

    rerender(<ChannelsPanel {...props} isConnected={true} />);
    expect(sendCommand).toHaveBeenCalledTimes(2);
    expect(sendCommand.mock.calls.map(([command]) => command.action)).toEqual(['LIST_CHANNELS', 'LIST_CHANNELS']);
    expect(screen.getByText('Selected Room details unavailable under the current wire.')).toBeInTheDocument();
  });

  it('labels the list surface stale without promoting retained rows to current details', () => {
    const sendCommand = vi.fn(() => true);
    render(<ChannelsPanel {...roomProps([listFrame([roomRow()])], sendCommand, true, true)} />);

    expect(screen.getByText('Connection is stale. Showing the last loaded Rooms list.')).toBeInTheDocument();
    expect(screen.getByText('Incident Alpha')).toBeInTheDocument();
    expect(screen.getByText('Selected Room details unavailable under the current wire.')).toBeInTheDocument();
    expect(sendCommand.mock.calls.map(([command]) => command.action)).toEqual(['LIST_CHANNELS']);
  });

  it('does not read persisted selection/cursor hints or dispatch selected reads on cold mount', () => {
    sessionStorage.setItem('torqclaw.selectedChannelId', 'room-a');
    sessionStorage.setItem('torqclaw.channelCursor', '88');
    localStorage.setItem('torqclaw.selectedRoomId', 'room-a');
    const sendCommand = vi.fn(() => true);

    render(<ChannelsPanel {...roomProps([listFrame([roomRow()])], sendCommand)} />);

    expect(screen.getByText('No Room row highlighted')).toBeInTheDocument();
    expect(sendCommand.mock.calls.map(([command]) => command.action)).toEqual(['LIST_CHANNELS']);
  });
});
