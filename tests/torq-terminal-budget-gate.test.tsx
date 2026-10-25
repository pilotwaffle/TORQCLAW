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

const problem = 'budget must be greater than $0 — use "Free (local only)" for a no-spend task';
function chooseBudget(value: string) {
  fireEvent.change(screen.getByRole('combobox', { name: /budget/i }), { target: { value: 'custom' } });
  fireEvent.change(screen.getByLabelText('Custom budget in USD'), { target: { value } });
}
it('custom_budget_zero_is_rejected_visibly', () => {
  for (const value of ['0', '0.00', '-1', '']) {
    stream.events = [ev({ type: 'ERROR', requestId: 'old', metadata: {
      recovery: ['RETRY_LOCAL', 'RETRY_CLOUD'], prompt: 'retry this',
    } })];
    render(<TorqTerminal />);
    chooseBudget(value);
    if (value === '-1') {
      const budgetInput = screen.getByLabelText('Custom budget in USD') as HTMLInputElement;
      expect(budgetInput.validity.rangeUnderflow).toBe(true);
      fireEvent.invalid(budgetInput);
      expect.soft(screen.queryByRole('alert')).toHaveTextContent(problem);
    }
    const input = screen.getByLabelText('Describe your task');
    fireEvent.change(input, { target: { value: 'do a task' } });
    fireEvent.submit(input.closest('form')!);
    expect.soft(stream.sendCommand).not.toHaveBeenCalled();
    expect.soft(screen.queryByRole('alert')).toHaveTextContent(problem);
    fireEvent.click(screen.getByText('run on this machine'));
    fireEvent.click(screen.getByText('run on cloud (faster)'));
    expect.soft(stream.sendCommand).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Custom budget in USD'), { target: { value: '0.5' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    chooseBudget('0');
    fireEvent.submit(input.closest('form')!);
    fireEvent.change(screen.getByRole('combobox', { name: /budget/i }), { target: { value: 'free' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    cleanup(); sessionStorage.clear(); stream.sendCommand.mockClear();
  }
});
it('custom_budget_positive_submits_with_maxCostUsd', () => {
  render(<TorqTerminal />);
  chooseBudget('0.5');
  const input = screen.getByLabelText('Describe your task');
  fireEvent.change(input, { target: { value: 'positive task' } });
  fireEvent.submit(input.closest('form')!);
  expect(stream.sendCommand).toHaveBeenCalledTimes(1);
  expect(stream.sendCommand).toHaveBeenCalledWith(expect.objectContaining({ action: 'SUBMIT_PROMPT', maxCostUsd: 0.5 }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
it('custom_budget_problem_is_pure', () => {
  const base = { budget: 'custom' as const, customBudget: '', mode: 'AUTO' as const, fast: false, privateMode: false, useMemory: true };
  for (const customBudget of ['0', '0.00', '-1', 'abc', '', 'Infinity', 'NaN']) {
    const controls = Object.freeze({ ...base, customBudget });
    expect(terminal.customBudgetProblem(controls)).toBe(problem);
  }
  for (const customBudget of ['0.25', '100']) expect(terminal.customBudgetProblem({ ...base, customBudget })).toBeNull();
  expect(terminal.customBudgetProblem({ ...base, budget: 'free' })).toBeNull();
});
