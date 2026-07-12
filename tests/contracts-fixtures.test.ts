import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import type { z } from 'zod';
import {
  ClientCommandSchema,
  GatewayRequestSchema,
  GatewayEventSchema,
  ConnectFrameSchema,
} from '@torqclaw/contracts';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, 'fixtures');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, name), 'utf8'));
}

function assertParses(schema: z.ZodType, fixtureName: string): void {
  const data = loadFixture(fixtureName);
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new Error(
      `Fixture "${fixtureName}" failed schema validation:\n` +
        JSON.stringify(result.error.issues, null, 2),
    );
  }
  expect(result.success).toBe(true);
}

describe('golden fixtures validate against @torqclaw/contracts schemas', () => {
  it('client-command.submit-prompt.json parses as ClientCommand', () => {
    assertParses(ClientCommandSchema, 'client-command.submit-prompt.json');
  });

  it('client-command.approve-skill.json parses as ClientCommand', () => {
    assertParses(ClientCommandSchema, 'client-command.approve-skill.json');
  });

  it('client-command.get-skill-draft.json parses as ClientCommand', () => {
    assertParses(ClientCommandSchema, 'client-command.get-skill-draft.json');
  });

  it('client-command.approve-tool.json parses as ClientCommand', () => {
    assertParses(ClientCommandSchema, 'client-command.approve-tool.json');
  });

  it('client-command.cancel-task.json parses as ClientCommand', () => {
    assertParses(ClientCommandSchema, 'client-command.cancel-task.json');
  });

  it('client-command.memory.json parses as ClientCommand', () => {
    assertParses(ClientCommandSchema, 'client-command.memory.json');
  });

  it('client-command.list-receipts.json parses as ClientCommand', () => {
    assertParses(ClientCommandSchema, 'client-command.list-receipts.json');
  });

  it('client-command.get-receipt.json parses as ClientCommand', () => {
    assertParses(ClientCommandSchema, 'client-command.get-receipt.json');
  });

  it('client-command.get-cost-summary.json parses as ClientCommand', () => {
    assertParses(ClientCommandSchema, 'client-command.get-cost-summary.json');
  });

  it('client-command.preview-route.json parses as ClientCommand', () => {
    assertParses(ClientCommandSchema, 'client-command.preview-route.json');
  });

  it('client-command.list-approvals.json parses as ClientCommand', () => {
    assertParses(ClientCommandSchema, 'client-command.list-approvals.json');
  });

  it('client-command.safe-export.json parses as ClientCommand', () => {
    assertParses(ClientCommandSchema, 'client-command.safe-export.json');
  });

  it('gateway-request.json parses as GatewayRequest', () => {
    assertParses(GatewayRequestSchema, 'gateway-request.json');
  });

  it('gateway-event.json parses as GatewayEvent', () => {
    assertParses(GatewayEventSchema, 'gateway-event.json');
  });

  it('connect-frame.json parses as ConnectFrame', () => {
    assertParses(ConnectFrameSchema, 'connect-frame.json');
  });
});

describe('PREVIEW_ROUTE (TCLAW-2D-1) — schema-level contract behavior', () => {
  it('valid minimal PREVIEW_ROUTE parses with defaults materialized', () => {
    const result = ClientCommandSchema.safeParse({
      action: 'PREVIEW_ROUTE',
      previewOf: 'draft-1',
      prompt: 'summarize this text',
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual({
      action: 'PREVIEW_ROUTE',
      previewOf: 'draft-1',
      prompt: 'summarize this text',
      sensitive: false,
      urgent: false,
      executionMode: 'AUTO',
      useMemory: true,
    });
  });

  it('missing previewOf is rejected', () => {
    const result = ClientCommandSchema.safeParse({
      action: 'PREVIEW_ROUTE',
      prompt: 'summarize this text',
    });
    expect(result.success).toBe(false);
  });

  it('missing prompt is rejected', () => {
    const result = ClientCommandSchema.safeParse({
      action: 'PREVIEW_ROUTE',
      previewOf: 'draft-1',
    });
    expect(result.success).toBe(false);
  });

  it('extra sessionId is silently stripped (mirrors LIST_RECEIPTS/GET_COST_SUMMARY convention — no sessionId field exists on this action, client cannot smuggle one in)', () => {
    const result = ClientCommandSchema.safeParse({
      action: 'PREVIEW_ROUTE',
      previewOf: 'draft-1',
      prompt: 'summarize this text',
      sessionId: 'should-be-dropped',
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect('sessionId' in result.data).toBe(false);
  });
});
