// @vitest-environment jsdom
import { it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import TorqTerminal from '../apps/console/src/components/TorqTerminal.js';

if (!Element.prototype.scrollTo) Element.prototype.scrollTo = function () {};
class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror = null;
  send = vi.fn();
  constructor(_url: string) { FakeWebSocket.instances.push(this); }
  close() { this.readyState = 3; this.onclose?.(); }
  deliver(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); sessionStorage.clear(); FakeWebSocket.instances = []; });
it('control_error_frame_renders_visible_line', () => {
  sessionStorage.clear();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  render(<TorqTerminal />);
  const socket = FakeWebSocket.instances[0];
  act(() => {
    socket.onopen?.();
    socket.deliver({ id: '6388425e-c76d-44aa-bca5-0879d657c51d', sessionId: 'f3f09de4-3e61-4ef2-bdad-37dc61e65d58',
      requestId: null, tier: null, type: 'CONNECTED', message: 'connected', seq: 41,
      metadata: { sessionId: 'f3f09de4-3e61-4ef2-bdad-37dc61e65d58' }, timestamp: new Date().toISOString() });
  });
  expect(sessionStorage.getItem('torqclaw.lastSeenSeq')).toBe('41');
  // Both a valid stored session and corrupted local storage must render safely.
  for (const [stored, code] of [['f3f09de4-3e61-4ef2-bdad-37dc61e65d58', 'UNAUTHORIZED'], ['not-a-uuid', 'DENIED']]) {
    sessionStorage.setItem('torqclaw.sessionId', stored);
    const before = document.querySelectorAll('article[title="ERROR"]').length;
    act(() => socket.deliver({ type: 'ERROR', code, detail: 'not allowed' }));
    const text = 'Something went wrong: Gateway rejected the command (' + code + '): not allowed';
    expect.soft(screen.queryAllByText(text)).toHaveLength(1);
    expect.soft(document.querySelectorAll('article[title="ERROR"]').length).toBe(before + 1);
    expect(sessionStorage.getItem('torqclaw.lastSeenSeq')).toBe('41');
    expect(warn).toHaveBeenCalledWith('Gateway command rejected', code, 'not allowed');
  }
  expect(screen.queryByText('retry')).not.toBeInTheDocument();
  expect(screen.queryByText('run on this machine')).not.toBeInTheDocument();
  expect(FakeWebSocket.instances).toHaveLength(1);
});
