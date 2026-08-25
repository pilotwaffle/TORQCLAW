// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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

afterEach(() => {
  cleanup();
  stream.events = [];
  stream.isConnected = true;
  stream.sendCommand.mockClear();
  sessionStorage.clear();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function loadTerminal(collab: string, rooms: string) {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_COLLAB_UI', collab);
  vi.stubEnv('NEXT_PUBLIC_ROOMS_UI', rooms);
  const module = await import('../apps/console/src/components/TorqTerminal.js');
  return module.default;
}

let idCounter = 0;
function ev(p: Partial<GatewayEvent>): GatewayEvent {
  idCounter++;
  return {
    id: `rooms-id-${idCounter}`,
    requestId: null,
    sessionId: 'rooms-session',
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

function tierSelected(requestId: string): GatewayEvent {
  return ev({
    type: 'TIER_SELECTED',
    requestId,
    tier: 'API_EXTERNAL',
    message: 'routed',
    metadata: { score: 75, reason: 'a', tier: 'API_EXTERNAL', ruleId: 'LOW_CLASSIFIER_CONFIDENCE', overridable: true },
  });
}

function toolCall(requestId: string): GatewayEvent {
  return ev({ type: 'TOOL_CALL', requestId, message: 'Executing filesystem__write_file' });
}

describe('TorqTerminal Rooms feature matrix', () => {
  it.each([
    { collab: '', rooms: '', expected: null },
    { collab: '', rooms: '1', expected: null },
    { collab: '1', rooms: '', expected: 'Channels' },
    { collab: '1', rooms: '1', expected: 'Rooms' },
  ])('collab=$collab rooms=$rooms renders $expected', async ({ collab, rooms, expected }) => {
    const TorqTerminal = await loadTerminal(collab, rooms);
    render(<TorqTerminal />);

    if (expected === null) {
      expect(screen.queryByRole('button', { name: 'Channels' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Rooms' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Agents' })).not.toBeInTheDocument();
      return;
    }

    const collaborationButton = screen.getByRole('button', { name: expected });
    expect(collaborationButton).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: expected === 'Rooms' ? 'Channels' : 'Rooms' })).not.toBeInTheDocument();
    fireEvent.click(collaborationButton);

    const actions = stream.sendCommand.mock.calls.map(([command]) => command.action);
    expect(actions).toEqual(expected === 'Rooms' ? ['LIST_CHANNELS'] : ['LIST_CHANNELS', 'LIST_AGENTS']);
    if (expected === 'Rooms') {
      expect(screen.getByRole('heading', { name: 'Rooms' })).toBeInTheDocument();
      expect(screen.queryByPlaceholderText(/Message this channel/i)).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Describe your task')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'RUN ⏎' })).not.toBeInTheDocument();
    } else {
      expect(screen.getByRole('heading', { name: 'Channels' })).toBeInTheDocument();
    }
  });

  it('keeps Rooms mounted during disconnect but preserves legacy connected-only Channels', async () => {
    stream.isConnected = false;
    const RoomsTerminal = await loadTerminal('1', '1');
    const { unmount } = render(<RoomsTerminal />);
    fireEvent.click(screen.getByRole('button', { name: 'Rooms' }));
    expect(screen.getByRole('heading', { name: 'Rooms' })).toBeInTheDocument();
    expect(screen.getByText('Disconnected. Room list unavailable/incomplete.')).toBeInTheDocument();
    expect(stream.sendCommand).not.toHaveBeenCalled();
    unmount();
    cleanup();

    stream.sendCommand.mockClear();
    const ChannelsTerminal = await loadTerminal('1', '');
    render(<ChannelsTerminal />);
    fireEvent.click(screen.getByRole('button', { name: 'Channels' }));
    expect(screen.queryByRole('heading', { name: 'Channels' })).not.toBeInTheDocument();
    expect(stream.sendCommand).not.toHaveBeenCalled();
  });

  it('provides a Rooms-only compact global navigation control', async () => {
    const TorqTerminal = await loadTerminal('1', '1');
    render(<TorqTerminal />);

    const openRooms = screen.getByRole('button', { name: 'Open Rooms' });
    expect(openRooms).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(openRooms);

    expect(screen.getByRole('heading', { name: 'Rooms' })).toBeInTheDocument();
    expect(openRooms).toHaveAttribute('aria-pressed', 'true');
    expect(stream.sendCommand.mock.calls.map(([command]) => command.action)).toEqual(['LIST_CHANNELS']);
  });
});

describe('TorqTerminal Rooms destination ownership', () => {
  it.each([
    { control: 'Open Agents', heading: 'Agents', actions: ['LIST_AGENTS', 'LIST_AGENT_PROVIDERS', 'LIST_CHANNELS'] },
    { control: 'Approvals', heading: 'Approval History', actions: ['LIST_APPROVALS'] },
    { control: 'Receipts', heading: 'Receipts', actions: ['LIST_RECEIPTS'] },
    { control: 'Cost', heading: 'Cost Control Center', actions: ['GET_COST_SUMMARY'] },
    { control: 'Memory', heading: 'Memory', actions: ['MEMORY'] },
  ])('navigates to $heading before that destination owns reads', async ({ control, heading, actions }) => {
    const TorqTerminal = await loadTerminal('1', '1');
    render(<TorqTerminal />);
    fireEvent.click(screen.getByRole('button', { name: 'Rooms' }));
    expect(stream.sendCommand.mock.calls.map(([command]) => command.action)).toEqual(['LIST_CHANNELS']);

    const controlRail = screen.getByRole('complementary', { name: 'Control Rail' });
    fireEvent.click(within(controlRail).getByRole('button', { name: control }));

    expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
    expect(stream.sendCommand.mock.calls.map(([command]) => command.action)).toEqual(['LIST_CHANNELS', ...actions]);
  });

  it('commits Task Stream ownership without dispatching a Room-owned destination command', async () => {
    const TorqTerminal = await loadTerminal('1', '1');
    render(<TorqTerminal />);
    fireEvent.click(screen.getByRole('button', { name: 'Rooms' }));
    expect(stream.sendCommand.mock.calls.map(([command]) => command.action)).toEqual(['LIST_CHANNELS']);

    fireEvent.click(screen.getByRole('button', { name: 'Active, blocked, complete' }));

    expect(screen.queryByRole('heading', { name: 'Rooms' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Describe your task')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'RUN ⏎' })).toBeInTheDocument();
    expect(stream.sendCommand.mock.calls.map(([command]) => command.action)).toEqual(['LIST_CHANNELS']);
  });

  it('does not mount hostile task controls while Rooms owns the view', async () => {
    vi.useFakeTimers();
    stream.events = [
      userPrompt('r-hostile', 'write and recover this task'),
      tierSelected('r-hostile'),
      ev({
        type: 'PENDING_APPROVAL',
        requestId: 'r-hostile',
        message: 'Tool filesystem__write_file requires approval',
        metadata: { approvalId: 'a-hostile', toolName: 'filesystem__write_file', args: { path: '/tmp/out' } },
      }),
      ev({
        type: 'ERROR',
        requestId: 'r-hostile',
        message: 'Task failed',
        metadata: { recovery: ['RETRY', 'COPY_SAFE_EXPORT', 'COPY_DIAGNOSTIC'], prompt: 'write and recover this task' },
      }),
      userPrompt('r-active', 'keep this active task running'),
      tierSelected('r-active'),
      toolCall('r-active'),
    ];
    const TorqTerminal = await loadTerminal('1', '1');
    render(<TorqTerminal />);
    fireEvent.change(screen.getByLabelText('Describe your task'), {
      target: { value: 'sk-1234567890abcdef1234567890abcdef' },
    });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(screen.getByText(/This looks like it may contain an API key/i)).toBeInTheDocument();
    stream.sendCommand.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Rooms' }));

    expect(screen.getByRole('heading', { name: 'Rooms' })).toBeInTheDocument();
    expect(screen.queryByText(/This looks like it may contain an API key/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Something went wrong: Task failed/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Wants to write file/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Describe your task')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'RUN ⏎' })).not.toBeInTheDocument();
    expect(screen.queryByText('Allow once')).not.toBeInTheDocument();
    expect(screen.queryByText('Deny')).not.toBeInTheDocument();
    expect(screen.queryByText(/retry/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /copy safe export/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /diagnostic/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /stop/i })).not.toBeInTheDocument();
    expect(stream.sendCommand.mock.calls.map(([command]) => command.action)).toEqual(['LIST_CHANNELS']);

    fireEvent.click(screen.getByRole('button', { name: 'Active, blocked, complete' }));

    expect(screen.queryByRole('heading', { name: 'Rooms' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Describe your task')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'RUN ⏎' })).toBeInTheDocument();
    expect(screen.getByText(/Something went wrong: Task failed/i)).toBeInTheDocument();
    expect(screen.getByText(/Wants to write file/i)).toBeInTheDocument();
    expect(screen.getByText('Allow once')).toBeInTheDocument();
    expect(screen.getByText('Deny')).toBeInTheDocument();
    expect(screen.getByText('retry')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'copy safe export' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'copy raw diagnostic (local, unredacted)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'stop' })).toBeInTheDocument();
  });

  it('does not dispatch a pending composer preview after Rooms takes ownership', async () => {
    vi.useFakeTimers();
    const TorqTerminal = await loadTerminal('1', '1');
    render(<TorqTerminal />);

    fireEvent.change(screen.getByLabelText('Describe your task'), {
      target: { value: 'summarize the active incident' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Rooms' }));
    act(() => {
      vi.advanceTimersByTime(600);
    });

    expect(screen.getByRole('heading', { name: 'Rooms' })).toBeInTheDocument();
    expect(stream.sendCommand.mock.calls.map(([command]) => command.action)).toEqual(['LIST_CHANNELS']);
  });
});
