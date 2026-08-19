import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inventoryProductionCalls } from './helpers/profile-conformance.js';

/**
 * M3 — EXPORT-LEVEL DORMANCY. The gap that let the delegation defect exist.
 *
 * ops/reachability.mjs is FILE-level and only flags modules of at least
 * MIN_LINES (150). A dead EXPORT inside a live file is structurally invisible
 * to it: packages/gateway/src/surfaceSecurity.ts is amply reachable via
 * server.ts -> collabIdentity.ts -> surfaceGate.ts, so the gate is satisfied
 * while `grantProfileDelegation` -- the ONLY writer of
 * gateway_profile_delegations -- has zero production callers.
 *
 * The consequence was not cosmetic. With no writer, three production readers
 * take their empty branch unconditionally, so server.ts's `carriesGrant` is
 * always false and the LOCAL_EDGE exact-action admission fence returns
 * {ok:true} without ever calling admitToolCall. There is ZERO observable
 * difference between "this works and nothing is delegated" and "this is
 * completely broken" -- the repo's signature defect class, sitting on the
 * approval path.
 *
 * THIS GATE IS BIDIRECTIONAL, and that is the whole design:
 *   - a DECLARED-dormant export that GAINS a production caller fails, because
 *     the declaration is now a lie and the reader who trusted it is wrong;
 *   - a declaration whose RESERVED-BY-DEFECT rationale has been stripped from
 *     the source fails, because an undocumented dormancy is exactly the
 *     invisible switch this exists to prevent.
 *
 * WHY IT CANNOT BECOME A PRIVILEGE-ESCALATION PUMP (the failure mode that
 * killed naive versions of this idea, and the reason profile.ts:181-187's
 * RESERVED half exists): the cheap way to go green here is to ADD a
 * declaration -- a documented, reviewable, behavior-free act. Making it green
 * by WIRING the export instead requires a real production call site, which is
 * a material change to approval semantics and cannot pass unnoticed. Reserving
 * is deliberately cheaper than granting.
 */

const REPO_ROOT = join(import.meta.dirname, '..');

interface DormantExport {
  readonly file: string;
  readonly exportName: string;
  /** Must appear in the source, so the rationale cannot be silently deleted. */
  readonly declarationMarker: string;
  readonly reason: string;
}

/**
 * Exports that production deliberately does not call. Adding an entry is a
 * DECISION and must carry a reason; it is not a way to silence this gate.
 */
const DORMANT_EXPORTS: readonly DormantExport[] = [
  {
    file: 'packages/gateway/src/surfaceSecurity.ts',
    exportName: 'grantProfileDelegation',
    declarationMarker: 'RESERVED-BY-DEFECT: THIS FUNCTION HAS ZERO PRODUCTION CALLERS, BY DECISION.',
    reason:
      'Sole writer of gateway_profile_delegations. Staged, not live: wiring it makes ordinary ' +
      'operator traffic mint C2 grants and traverse the LOCAL_EDGE exact-action fence for the ' +
      'first time, which needs its own gate review rather than arriving as a side effect.',
  },
];

describe('M3 — dormant production exports are declared, not merely absent', () => {
  it('every declared-dormant export still has ZERO production callers', () => {
    const watched = DORMANT_EXPORTS.map((entry) => entry.exportName);
    const calls = inventoryProductionCalls(watched);

    const violations = calls.map(
      (call) => `${call.importedName} is called from production at ${call.file}:${call.line}`,
    );

    expect(
      violations,
      'A declared-dormant export gained a production caller. That is not necessarily a bug -- ' +
      'it may be the intended wiring finally landing -- but the declaration is now FALSE and ' +
      'anyone reading it is being misled. Remove the DORMANT_EXPORTS entry (and the ' +
      'RESERVED-BY-DEFECT block in the source) in the same change that wires it, so the two ' +
      'never disagree.',
    ).toEqual([]);
  });

  it('every declaration carries its rationale IN THE SOURCE, not only in this table', () => {
    // A dormancy recorded only in a test file is a switch the next reader of
    // surfaceSecurity.ts cannot see -- which is precisely how this defect was
    // introduced. The reason must live where the code lives.
    for (const entry of DORMANT_EXPORTS) {
      const source = readFileSync(join(REPO_ROOT, entry.file), 'utf8');

      expect(
        source,
        `${entry.file} must contain the dormancy declaration for ${entry.exportName}`,
      ).toContain(entry.declarationMarker);

      expect(
        source,
        `${entry.file} must still export ${entry.exportName}; if it was deleted, remove its ` +
        'DORMANT_EXPORTS entry too rather than leaving a declaration pointing at nothing.',
      ).toContain(`export function ${entry.exportName}`);
    }
  });

  it('POSITIVE CONTROL: the caller inventory can actually find production calls', () => {
    // Without this, the first test passes against an inventoryProductionCalls
    // that returns [] for everything -- i.e. against no gate at all. This
    // watches a function that IS production-wired (surfaceRevocation.ts and
    // collabIdentity.ts call it), so an empty result here means the detector
    // is broken, not that the tree is clean.
    const calls = inventoryProductionCalls(['activateSurfaceProjection']);

    expect(
      calls.length,
      'activateSurfaceProjection IS production-wired; finding zero callers means the ' +
      'TypeScript-compiler caller inventory is broken and the assertion above proves nothing.',
    ).toBeGreaterThan(0);
  });
});
