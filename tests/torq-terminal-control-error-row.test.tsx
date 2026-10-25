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

it('control_error_line_does_not_flip_busy_or_anchor', () => {
  const running = [
    ev({ type: 'TIER_SELECTED', requestId: 'r1', tier: 'OLLAMA_LOCAL', metadata: {
      tier: 'OLLAMA_LOCAL', score: 10, reason: 'local', ruleId: 'LOCAL_INTENT', overridable: false,
    } }),
    ev({ type: 'TOOL_CALL', requestId: 'r1', message: 'Executing filesystem__read_file' }),
  ];
  stream.events = running;
  const { rerender } = render(<TorqTerminal />);
  expect(screen.getByRole('button', { name: 'stop' })).toBeInTheDocument();
  const route = screen.getByText('↳').closest('p')!.textContent;
  stream.events = [...running, ev({ type: 'ERROR', message: 'Gateway rejected the command (X)', metadata: { gatewayControlError: true } })];
  rerender(<TorqTerminal />);
  expect.soft(screen.queryByRole('button', { name: 'stop' })).toBeInTheDocument();
  expect(screen.getByText('↳').closest('p')!.textContent).toBe(route);
  fireEvent.click(screen.getByRole('button', { name: 'stop' }));
  expect(stream.sendCommand).toHaveBeenLastCalledWith({ action: 'CANCEL_TASK', taskId: 'r1' });
  // Negative controls: absent or merely truthy markers are still terminal.
  for (const metadata of [undefined, { gatewayControlError: 'true' }, { gatewayControlError: false }]) {
    stream.events = [...running, ev({ type: 'ERROR', message: 'real error', metadata })];
    rerender(<TorqTerminal />);
    expect(screen.queryByRole('button', { name: 'stop' })).not.toBeInTheDocument();
  }
});
