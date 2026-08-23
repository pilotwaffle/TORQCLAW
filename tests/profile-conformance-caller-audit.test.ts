import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  auditSourceSnippet,
  inventoryProductionCalls,
  resolveAuditTsconfig,
  REPO_ROOT,
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
    // The fourth and fifth positions are gateway-owned metadata, never model
    // arguments. The fifth binds the immutable turn identity and exact local
    // execution profile used by the atomic agent-turn resolution writer.
    expect(calls[0]!.argumentTexts.slice(0, 4)).toEqual([
      'realName', 'toolArgs', 'req.effectiveProfile', 'req.payload.callerCollabPrincipalId',
    ]);
    expect(calls[0]!.argumentTexts).toHaveLength(5);
    expect(calls[0]!.argumentTexts[4]).toBe('buildManagedAgentToolContext(req)');
    const source = readFileSync(join(REPO_ROOT, 'packages', 'inference', 'src', 'ollama.ts'), 'utf8');
    expect(source).toContain('personaEnvelope: req.payload.agentPersonaEnvelope!');
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

  it('anchors compiler options in-tree and never consumes a tsconfig outside the repository', () => {
    expect(resolveAuditTsconfig(REPO_ROOT)).toBe(join(REPO_ROOT, 'tsconfig.base.json'));
    expect(() => resolveAuditTsconfig(REPO_ROOT, join('..', 'tsconfig.json')))
      .toThrow(/OUTSIDE the repository/);
    expect(() => resolveAuditTsconfig(join(REPO_ROOT, 'tests'), 'tsconfig.base.json'))
      .toThrow(/in-tree tsconfig is absent/);
  });

  it('anchors the vite/tsconfck transform layer inside the repository for the test tree', () => {
    const anchorPath = join(REPO_ROOT, 'tests', 'tsconfig.json');
    const anchor = JSON.parse(readFileSync(anchorPath, 'utf8')) as Record<string, unknown>;
    expect(anchor.extends).toBe('../tsconfig.base.json');
    expect(resolveAuditTsconfig(REPO_ROOT, join('tests', anchor.extends as string)))
      .toBe(join(REPO_ROOT, 'tsconfig.base.json'));
    expect(anchor).not.toHaveProperty('references');

    const shadows: string[] = [];
    const scan = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const absolute = join(dir, entry.name);
        if (entry.isDirectory()) scan(absolute);
        else if (/^tsconfig.*\.json$/.test(entry.name)) shadows.push(relative(REPO_ROOT, absolute));
      }
    };
    scan(join(REPO_ROOT, 'tests'));
    expect(shadows).toEqual([join('tests', 'tsconfig.json')]);
  });
});
