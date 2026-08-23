import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('AgentsPanel mutation correlation ordering', () => {
  it('does not consume an unrelated mutation before the matching result arrives', () => {
    const source = readFileSync(
      join(process.cwd(), 'apps', 'console', 'src', 'components', 'AgentsPanel.tsx'),
      'utf8',
    );
    const terminalCheck = source.indexOf('metadata.agentMutationTerminal === true');
    const operationCheck = source.indexOf('metadata.operation === pendingMutation.operation');
    const idempotencyCheck = source.indexOf('metadata.idempotencyKey === pendingMutation.idempotencyKey');
    const markHandled = source.indexOf('handledMutationId.current = mutation.id;');

    expect(terminalCheck).toBeGreaterThan(-1);
    expect(operationCheck).toBeGreaterThan(terminalCheck);
    expect(idempotencyCheck).toBeGreaterThan(-1);
    expect(idempotencyCheck).toBeGreaterThan(operationCheck);
    expect(markHandled).toBeGreaterThan(idempotencyCheck);
  });
});
