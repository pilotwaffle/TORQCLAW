import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILT_IN_PROFILE_DEFINITIONS } from '../packages/contracts/src/profile.js';
import { classifyCapability, scopeModeFor } from '../packages/bridge/src/capability.js';
import {
  PINNED_BASE,
  REPO_ROOT,
  documentedProfileTable,
  expectedSideEffect,
  readGolden,
  renderProfileTable,
} from './helpers/profile-conformance.js';

describe('AC-1 declared profile manifest', () => {
  it('AC-1 exact manifest: all fields of all four definitions equal the pinned golden', () => {
    const golden = readGolden();
    expect(golden.baseCommit).toBe(PINNED_BASE);
    expect(Object.keys(golden.profiles)).toEqual([
      'read_only', 'workspace_write', 'browser_research', 'terminal_power',
    ]);
    expect(BUILT_IN_PROFILE_DEFINITIONS).toEqual(golden.profiles);
  });

  it('AC-1 documentation: the marker-delimited GFM table byte-matches the authoritative manifest', () => {
    const golden = readGolden();
    const markdown = readFileSync(join(REPO_ROOT, 'docs', 'security', 'profile-conformance.md'), 'utf8');
    expect(documentedProfileTable(markdown)).toBe(renderProfileTable(golden));
  });
});

describe('AC-2 executable classifier inventory', () => {
  it('executes every raw ID with its exact hint/config condition and expected mode', () => {
    const fixtures = readGolden().classifierFixtures;
    expect(new Set(fixtures.map((fixture) => fixture.id)).size).toBe(fixtures.length);
    for (const fixture of fixtures) {
      expect(fixture.rawToolId, `${fixture.id} raw ID`).not.toContain('__');
      const capability = classifyCapability(
        fixture.rawToolId,
        fixture.condition.annotations,
        fixture.condition.configCapability,
      );
      expect(capability, fixture.id).toBe(fixture.classifierOutput);
      expect(scopeModeFor(capability), fixture.id).toBe(fixture.scopeMode);
      const namespace = fixture.id.startsWith('browser-') ? 'browser'
        : fixture.id.startsWith('playwright-') ? 'playwright'
          : fixture.id === 'destructive-write' ? 'filesystem'
            : fixture.id === 'send-token' ? 'mailer'
              : fixture.id === 'unknown-fail-closed' ? 'unknown' : 'shell';
      expect(expectedSideEffect({ name: `${namespace}__${fixture.rawToolId}`, capability }), fixture.id)
        .toBe(fixture.sideEffect);
      expect(fixture.purpose.length).toBeGreaterThan(10);
    }
  });

  it('covers every classifier branch and all six unique capability/derived-side-effect outcomes', () => {
    const fixtures = readGolden().classifierFixtures;
    expect(fixtures.map((fixture) => fixture.id)).toEqual(expect.arrayContaining([
      'config-read', 'annotation-read', 'destructive-write', 'exec-token',
      'send-token', 'unknown-fail-closed', 'browser-mutation', 'playwright-mutation',
    ]));
    const outcomes = new Set(fixtures.map((fixture) => `${fixture.classifierOutput}:${fixture.sideEffect}`));
    expect(outcomes).toEqual(new Set([
      'read:none', 'write:filesystem_write', 'exec:process', 'send:network_send',
      'write:process', 'write:browser_mutation',
    ]));
  });

  it('P3a real classifier label: send is reachable but no built-in declares send admission', () => {
    expect(classifyCapability('send_email', undefined, undefined)).toBe('send');
    for (const definition of Object.values(BUILT_IN_PROFILE_DEFINITIONS)) {
      expect(definition.allowedCapabilities).not.toContain('send');
      expect(definition.allowedSideEffects).not.toContain('network_send');
    }
  });
});

describe('AC-9/AC-11 honest declared bounds', () => {
  it('documents TS/LOCAL_EDGE scope and refuses containment/pause claims for declarations', () => {
    const markdown = readFileSync(join(REPO_ROOT, 'docs', 'security', 'profile-conformance.md'), 'utf8');
    expect(markdown).toContain('TypeScript gateway/bridge and LOCAL_EDGE');
    expect(markdown).toContain('FRONTIER/Hermes is excluded');
    expect(markdown).toContain('declaration and hash material');
    expect(markdown).toContain('not a network containment guarantee');
    expect(markdown).toContain('not execution-pause authority');
    expect(markdown).toContain('RegisteredTool.requiresApproval');
  });
});
