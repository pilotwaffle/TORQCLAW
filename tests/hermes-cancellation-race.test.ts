import { describe, expect, it, vi } from 'vitest';
import {
  executeHermesTask,
  HermesCancelledError,
  type HermesTaskClient,
} from '../packages/bridge/src/hermes.js';
import type { GatewayRequest } from '@torqclaw/contracts';

const request = (id: string): GatewayRequest => ({ id, constraints: {} } as GatewayRequest);
const mcp = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const noWait = async () => {};

describe('Hermes cancellation submission race', () => {
  it('does not submit provider work when cancellation wins before submission', async () => {
    const controller = new AbortController();
    controller.abort();
    const client: HermesTaskClient = { callTool: vi.fn() };

    await expect(executeHermesTask(request('pre-submit'), vi.fn(), {
      signal: controller.signal, client, sleep: noWait, pollIntervalMs: 0,
    })).rejects.toBeInstanceOf(HermesCancelledError);
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it('relays one cancellation when it arrives while submit_task is in flight', async () => {
    const controller = new AbortController();
    let resolveSubmit!: (value: unknown) => void;
    const client: HermesTaskClient = {
      callTool: vi.fn(({ name }: { name: string }) => {
        if (name === 'submit_task') return new Promise((resolve) => { resolveSubmit = resolve; });
        if (name === 'cancel_task') return Promise.resolve(mcp({ status: 'cancelled' }));
        throw new Error(`unexpected tool ${name}`);
      }),
    };
    const emit = vi.fn();
    const run = executeHermesTask(request('in-flight-submit'), emit, {
      signal: controller.signal, client, sleep: noWait, pollIntervalMs: 0,
    });

    await vi.waitFor(() => expect(client.callTool).toHaveBeenCalledTimes(1));
    controller.abort();
    resolveSubmit(mcp({ task_id: 'engine-in-flight' }));

    await expect(run).rejects.toMatchObject({ message: 'Task cancelled: USER_CANCELLED' });
    expect(client.callTool).toHaveBeenCalledTimes(2);
    expect(client.callTool).toHaveBeenLastCalledWith({
      name: 'cancel_task', arguments: { task_id: 'engine-in-flight', reason: 'USER_CANCELLED' },
    });
    expect(emit).not.toHaveBeenCalledWith('RESULT', expect.anything(), expect.anything());
  });

  it.each(['noop', 'unknown'] as const)(
    'never publishes success when the just-submitted engine task is already %s',
    async (terminalStatus) => {
      const controller = new AbortController();
      let resolveSubmit!: (value: unknown) => void;
      const client: HermesTaskClient = {
        callTool: vi.fn(({ name }: { name: string }) => {
          if (name === 'submit_task') return new Promise((resolve) => { resolveSubmit = resolve; });
          if (name === 'cancel_task') return Promise.resolve(mcp({ status: terminalStatus }));
          throw new Error(`unexpected tool ${name}`);
        }),
      };
      const emit = vi.fn();
      const run = executeHermesTask(request(`terminal-${terminalStatus}`), emit, {
        signal: controller.signal, client, sleep: noWait, pollIntervalMs: 0,
      });

      await vi.waitFor(() => expect(client.callTool).toHaveBeenCalledTimes(1));
      controller.abort();
      resolveSubmit(mcp({ task_id: `engine-${terminalStatus}` }));

      await expect(run).rejects.toMatchObject({
        message: 'Task cancellation could not be confirmed',
        telemetry: { cancelled: true, cancellationUncertain: true },
      });
      expect(emit).not.toHaveBeenCalledWith('RESULT', expect.anything(), expect.anything());
    },
  );

  it('suppresses a completed poll if cancellation wins while that poll is in flight', async () => {
    const controller = new AbortController();
    const client: HermesTaskClient = {
      callTool: vi.fn(({ name }: { name: string }) => {
        if (name === 'submit_task') return Promise.resolve(mcp({ task_id: 'engine-poll-race' }));
        if (name === 'get_task_status') {
          controller.abort();
          return Promise.resolve(mcp({ state: 'completed', result: 'must not publish', telemetry: {} }));
        }
        if (name === 'cancel_task') return Promise.resolve(mcp({ status: 'noop' }));
        throw new Error(`unexpected tool ${name}`);
      }),
    };
    const emit = vi.fn();

    await expect(executeHermesTask(request('poll-race'), emit, {
      signal: controller.signal, client, sleep: noWait, pollIntervalMs: 0,
    })).rejects.toMatchObject({
      message: 'Task cancellation could not be confirmed',
      telemetry: { cancelled: true, cancellationUncertain: true },
    });
    expect(emit).not.toHaveBeenCalledWith('RESULT', 'must not publish', expect.anything());
  });
});
