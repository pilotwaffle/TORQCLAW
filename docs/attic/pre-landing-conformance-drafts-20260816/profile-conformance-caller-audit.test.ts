import { describe, expect, it } from 'vitest';
import {
  auditSourceSnippet,
  inventoryProductionCalls,
  type ResolvedCall,
} from './helpers/profile-conformance.js';

function identity(call: ResolvedCall): string {
  return `${call.importedName}:${call.file}`;
}

describe('AC-10A TypeScript compiler-API production caller audit', () => {
  it('inventories every resolved executeTool caller and proves effectiveProfile forwarding', () => {
    const calls = inventoryProductionCalls(['executeTool']).filter((call) => call.importedName === 'executeTool');
    expect(calls.map(identity)).toEqual([
      'executeTool:packages/inference/src/ollama.ts',
    ]);
    expect(calls.every((call) => call.resolved)).toBe(true);
    expect(calls[0]!.argumentTexts).toEqual(['realName', 'toolArgs', 'req.effectiveProfile']);
  });

  it('inventories the two assertResolvedProfile ingress calls', () => {
    const calls = inventoryProductionCalls(['assertResolvedProfile'])
      .filter((call) => call.importedName === 'assertResolvedProfile');
    expect(calls.map(identity)).toEqual([
      'assertResolvedProfile:packages/gateway/src/preview.ts',
      'assertResolvedProfile:packages/gateway/src/server.ts',
    ]);
    expect(calls.every((call) => call.resolved && call.argumentTexts[0] === 'request')).toBe(true);
  });

  it('fails closed for added, aliased, property, unresolved, and nonforwarding call shapes', () => {
    const direct = auditSourceSnippet(
      "import { executeTool } from './registry.js'; executeTool(name, args, profile);",
      'executeTool',
    );
    const aliased = auditSourceSnippet(
      "import { executeTool as run } from './registry.js'; run(name, args, profile);",
      'executeTool',
    );
    const property = auditSourceSnippet(
      "import * as registry from './registry.js'; registry.executeTool(name, args, profile);",
      'executeTool',
    );
    const unresolved = auditSourceSnippet('executeTool(name, args, profile);', 'executeTool');
    const nonforwarding = auditSourceSnippet(
      "import { executeTool } from './registry.js'; executeTool(name, args);",
      'executeTool',
    );
    expect(direct).toHaveLength(1);
    expect(aliased).toMatchObject([{ importedName: 'executeTool', localExpression: 'run', resolved: true }]);
    expect(property).toMatchObject([{ importedName: 'executeTool', localExpression: 'registry.executeTool', resolved: true }]);
    expect(unresolved).toMatchObject([{ importedName: 'executeTool', resolved: false }]);
    expect(nonforwarding[0]!.argumentTexts).toHaveLength(2);

    const production = inventoryProductionCalls(['executeTool']).filter((call) => call.importedName === 'executeTool');
    expect([...production.map(identity), 'executeTool:packages/new-caller.ts'])
      .not.toEqual(['executeTool:packages/inference/src/ollama.ts']);
  });
});
