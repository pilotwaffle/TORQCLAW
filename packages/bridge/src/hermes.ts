import type { GatewayRequest, GatewayEventType } from '@torqclaw/contracts';
import { getClient } from './registry.js';

type Emitter = (type: GatewayEventType, message: string, metadata?: unknown) => void;

const POLL_INTERVAL_MS = 2_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseToolResult(result: any): any {
  const text = (result.content as any[])?.find((c) => c.type === 'text')?.text;
  return text ? JSON.parse(text) : {};
}

export interface HermesResult {
  text: string;
  telemetry: Record<string, unknown>;
}

/** submit_task / get_task_status — never an awaited hour-long MCP call.
 *  Incremental events relay into the same session stream the UI watches. */
export async function executeHermesTask(
  req: GatewayRequest,
  emit: Emitter,
): Promise<HermesResult> {
  const client = getClient('hermes');

  const submit = parseToolResult(
    await client.callTool({ name: 'submit_task', arguments: { payload: req } }),
  );
  const taskId: string = submit.task_id;
  emit('SYSTEM', `Hermes kernel accepted task ${taskId}`);

  let cursor = 0;
  for (;;) {
    await sleep(POLL_INTERVAL_MS);
    const status = parseToolResult(
      await client.callTool({
        name: 'get_task_status',
        arguments: { task_id: taskId, since: cursor },
      }),
    );

    for (const ev of status.events ?? []) {
      emit(ev.type ?? 'SYSTEM', ev.message ?? '', ev.metadata);
      cursor = ev.cursor ?? cursor;
    }
    if (status.state === 'completed') {
      return { text: status.result ?? '', telemetry: status.telemetry ?? {} };
    }
    if (status.state === 'failed') throw new Error(status.error ?? 'Hermes task failed');
  }
}

export async function approveSkill(queueId: string, decision: 'APPROVE' | 'REJECT') {
  const client = getClient('hermes');
  await client.callTool({
    name: 'decide_skill',
    arguments: { queue_id: queueId, decision },
  });
}
