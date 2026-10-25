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

it('route_chip_third_state_reads_cloud_ok', () => {
  render(<TorqTerminal />);
  const pinTitle = 'where this task may run — click to cycle auto → local → cloud';
  expect(screen.getByRole('button', { name: 'route: auto ▾' })).toHaveAttribute('title', pinTitle);
  fireEvent.click(screen.getByRole('button', { name: 'route: auto ▾' }));
  const localChip = screen.getByRole('button', { name: 'route: local ▾' });
  expect(localChip).toHaveAttribute('title', pinTitle);
  expect(localChip).not.toHaveAttribute('title', 'cloud permitted; the router still decides');
  fireEvent.click(localChip);
  const chip = screen.getByRole('button', { name: 'route: cloud ok ▾' });
  expect(chip).toHaveAttribute('title', 'cloud permitted; the router still decides');
  fireEvent.click(chip);
  expect(screen.getByRole('button', { name: 'route: auto ▾' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'route: auto ▾' })).toHaveAttribute('title', pinTitle);
});
it('resend_cloud_still_sends_CLOUD_OK', () => {
  stream.events = [ev({ type: 'ERROR', requestId: 'r1', metadata: { recovery: ['RETRY_CLOUD'], prompt: 'try again' } })];
  render(<TorqTerminal />);
  fireEvent.click(screen.getByText('run on cloud (faster)'));
  expect(stream.sendCommand).toHaveBeenCalledTimes(1);
  expect(stream.sendCommand).toHaveBeenCalledWith(expect.objectContaining({ action: 'SUBMIT_PROMPT', prompt: 'try again', executionMode: 'CLOUD_OK' }));
});
