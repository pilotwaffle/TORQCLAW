/**
 * C1-3 — cross-database surface revocation/provisioning coordinator.
 * PRD-TCLAW-COLLAB-GATEWAY-004 §2.5, §1.4, §6.6.
 *
 * `state.db` and `collab.db` are separate SQLite databases with separate
 * WALs. This program claims NO cross-database atomic transaction. What it
 * guarantees instead is ORDERING, chosen so that every interruption leaves
 * the system in a safe state:
 *
 *   REVOCATION / NARROWING = DENY-FIRST
 *     gateway deny + epoch bump + authority revocation COMMIT FIRST;
 *     the collab-side surface/credential cascade commits second.
 *     Interrupted between the two -> the gateway is already denying, and
 *     the surface cannot act. Recovery may finish the collab-side
 *     bookkeeping. It must NEVER roll the epoch back or recreate authority.
 *
 *   PROVISIONING / WIDENING = GRANT-LAST
 *     collab-side configured identity commits FIRST; the gateway
 *     projection activates LAST.
 *     Interrupted between the two -> the surface exists in configuration
 *     but has no live projection, so it is inert. Recovery must NEVER
 *     complete a partial grant on its own.
 *
 * Both orderings fail toward LESS authority, which is the property §6.6
 * requires of rollback ("MUST only reduce or preserve authority").
 */

import type Database from 'better-sqlite3';
import { revokeSurface as revokeSurfaceInCollab } from '@torqclaw/collab';
import {
  activateSurfaceProjection,
  revokeSurfaceProjection,
  type ActivateSurfaceParams,
} from './surfaceSecurity.js';

export interface RevokeSurfaceOutcome {
  /** True once the gateway deny has COMMITTED — the security-critical half. */
  gatewayDenied: boolean;
  authoritiesRevoked: number;
  newAuthEpoch: number | null;
  /** False when the collab-side bookkeeping did not complete (recoverable). */
  collabRecorded: boolean;
  credentialsRevoked: number;
  /** Set when the second phase failed; the deny still stands. */
  collabError?: string;
}

/**
 * REVOKE_SURFACE across both databases, deny-first.
 *
 * The collab-side failure is caught rather than rethrown: rethrowing would
 * invite a caller to treat the whole operation as "failed" and retry it as
 * though nothing had happened, when in fact the security-critical half has
 * already committed. The outcome object reports both halves so the caller
 * (and the runbook) can act on the real state: denied, bookkeeping owed.
 */
export function revokeSurfaceEverywhere(
  stateDb: Database.Database,
  collabDb: Database.Database,
  surfaceId: string,
  now: Date = new Date(),
): RevokeSurfaceOutcome {
  // Phase 1 — gateway deny FIRST. If this throws, nothing has changed
  // anywhere and the caller may retry safely.
  const denied = revokeSurfaceProjection(stateDb, surfaceId, now);

  // Phase 2 — collab bookkeeping second.
  try {
    const collab = revokeSurfaceInCollab(collabDb, surfaceId, now);
    return {
      gatewayDenied: true,
      authoritiesRevoked: denied.authoritiesRevoked,
      newAuthEpoch: denied.newAuthEpoch,
      collabRecorded: true,
      credentialsRevoked: collab.credentialsRevoked,
    };
  } catch (err) {
    return {
      gatewayDenied: true,
      authoritiesRevoked: denied.authoritiesRevoked,
      newAuthEpoch: denied.newAuthEpoch,
      collabRecorded: false,
      credentialsRevoked: 0,
      collabError: String(err),
    };
  }
}

/**
 * Finish the collab-side bookkeeping of an interrupted revocation.
 *
 * This is the ONLY recovery action §2.5/§6.6 permit after a deny has
 * committed. It deliberately offers no inverse: there is no
 * "unrevoke"/"restore epoch" entry point in this module at all, so a
 * recovery path cannot reverse a committed deny even by mistake.
 */
export function completeRevocationBookkeeping(
  collabDb: Database.Database,
  surfaceId: string,
  now: Date = new Date(),
): { credentialsRevoked: number } {
  const result = revokeSurfaceInCollab(collabDb, surfaceId, now);
  return { credentialsRevoked: result.credentialsRevoked };
}

/**
 * Provision a surface's enforcement projection, grant-last.
 *
 * The caller must have ALREADY committed the collab-side configured
 * identity (`createSurface`). This activates the gateway projection as the
 * final step, so an interruption before it leaves the surface inert rather
 * than authorized.
 */
export function activateProvisionedSurface(
  stateDb: Database.Database,
  params: ActivateSurfaceParams,
  now: Date = new Date(),
): void {
  activateSurfaceProjection(stateDb, params, now);
}
