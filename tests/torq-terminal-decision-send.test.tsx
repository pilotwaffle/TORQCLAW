// @vitest-environment jsdom
import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { GatewayEvent } from '@torqclaw/contracts';

if (!Element.prototype.scrollTo) Element.prototype.scrollTo = function () {};
const stream = { events: [] as GatewayEvent[], isConnected: true, sendCommand: vi.fn(() => true), reconnect: vi.fn() };
vi.mock('../apps/console/src/components/useGatewayStream.js', () => ({ useGatewayStream: () => stream }));
import TorqTerminal, * as terminal from '../apps/console/src/components/TorqTerminal.js';
beforeEach(() => { sessionStorage.clear(); });
afterEach(() => {
  cleanup(); sessionStorage.clear(); stream.events = []; stream.isConnected = true;
  stream.sendCommand = vi.fn(() => true); stream.reconnect.mockClear(); vi.useRealTimers();
});
let nextId = 0;
function ev(p: Partial<GatewayEvent>): GatewayEvent {
  return { id: 'event-' + ++nextId, sessionId: 's', requestId: null, tier: null,
    type: 'SYSTEM', message: '', timestamp: new Date().toISOString(), ...p };
}

const note = "couldn't send — connection may be reconnecting; try again";
it('approval_decision_not_marked_when_send_fails', () => {
  stream.events = [ev({ type: 'PENDING_APPROVAL', requestId: 'r1',
    metadata: { approvalId: 'approval-1', toolName: 'filesystem__write_file', args: { path: '/x' } } })];
  stream.sendCommand.mockReturnValueOnce(false).mockReturnValueOnce(true);
  render(<TorqTerminal />);
  fireEvent.click(screen.getByText('Allow once'));
  expect(stream.sendCommand).toHaveBeenCalledTimes(1);
  expect(stream.sendCommand).toHaveBeenLastCalledWith({ action: 'APPROVE_TOOL', approvalId: 'approval-1', decision: 'APPROVE' });
  expect.soft(screen.queryByText('Allow once')).toBeInTheDocument();
  expect.soft(screen.queryByText('✓ approved')).not.toBeInTheDocument();
  expect.soft(screen.queryByText(note)).toBeInTheDocument();
  fireEvent.click(screen.getByText('Allow once'));
  expect(stream.sendCommand).toHaveBeenCalledTimes(2);
  expect(screen.getByText('✓ approved')).toBeInTheDocument();
  expect(screen.queryByText(note)).not.toBeInTheDocument();
});
it('skill_decision_not_marked_when_send_fails', () => {
  stream.events = [ev({ type: 'PENDING_APPROVAL', requestId: 'r1',
    metadata: { queueId: 'queue-1', skillName: 'draft', skillMarkdown: '# draft' } })];
  stream.sendCommand.mockReturnValueOnce(false).mockReturnValueOnce(true);
  render(<TorqTerminal />);
  fireEvent.click(screen.getByText('Allow'));
  expect(stream.sendCommand).toHaveBeenCalledTimes(1);
  expect(stream.sendCommand).toHaveBeenLastCalledWith({ action: 'APPROVE_SKILL', queueId: 'queue-1', decision: 'APPROVE' });
  expect.soft(screen.queryByText('Allow')).toBeInTheDocument();
  expect.soft(screen.queryByText('✓ approved')).not.toBeInTheDocument();
  expect.soft(screen.queryByText(note)).toBeInTheDocument();
  fireEvent.click(screen.getByText('Allow'));
  expect(stream.sendCommand).toHaveBeenCalledTimes(2);
  expect(screen.getByText('✓ approved')).toBeInTheDocument();
  expect(screen.queryByText(note)).not.toBeInTheDocument();
});
