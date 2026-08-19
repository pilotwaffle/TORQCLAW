import { timingSafeEqual } from 'node:crypto';
import type { ConnectFrame } from '@torqclaw/contracts';
import type { PrincipalBinding } from './principalBridge.js';
import type { Role } from './authz.js';

export type AuthClass =
  | 'legacy_gateway'
  | 'operator_surface'
  | 'agent_surface'
  | 'automation_surface'
  | 'channel_service';

/** Authority established by server-owned credential state, never by frame.role. */
export interface AuthenticatedCaller {
  readonly authClass: AuthClass;
  readonly role: Role;
  readonly binding: PrincipalBinding | null;
}

export interface ConnectionAuthDependencies {
  readonly legacyGatewayToken: string;
  readonly channelServiceToken: string;
  readonly production: boolean;
  readonly allowTokenlessLegacy: boolean;
  readonly resolveSurface: (credential: string) => AuthenticatedCaller | null;
}

function tokenMatches(presented: string | undefined, expected: string): boolean {
  // An omitted server credential disables the deprecated path. Tokenless
  // startup must never make an empty frame an operator credential.
  if (!expected) return false;
  const received = Buffer.from(presented ?? '');
  const wanted = Buffer.from(expected);
  return received.length === wanted.length && timingSafeEqual(received, wanted);
}

export function isProductionRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TORQCLAW_RUNTIME_MODE === 'production' || env.NODE_ENV === 'production';
}

export function assertProductionLegacyTokenDisabled(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (isProductionRuntime(env) && String(env.TORQCLAW_GATEWAY_TOKEN ?? '').trim()) {
    throw new Error(
      'TORQCLAW_GATEWAY_TOKEN is deprecated and forbidden in production; ' +
      'use a server-owned surface or channel credential',
    );
  }
}

/**
 * Authenticate one connection and return its fixed server-derived authority.
 * Legacy role/token fields remain parseable during Phase 1, but neither can
 * choose the returned role.
 */
export function authenticateConnection(
  frame: ConnectFrame,
  deps: ConnectionAuthDependencies,
): AuthenticatedCaller | null {
  if (frame.auth?.kind === 'surface') {
    return deps.resolveSurface(frame.auth.credential);
  }

  if (frame.auth?.kind === 'channel_service') {
    if (!deps.channelServiceToken) return null;
    if (!tokenMatches(frame.auth.credential, deps.channelServiceToken)) return null;
    return {
      authClass: 'channel_service',
      role: 'channel',
      binding: { principalId: 'service:channel-http', surfaceId: 'service:channel-http' },
    };
  }

  if (deps.production) return null;
  if (!deps.legacyGatewayToken && deps.allowTokenlessLegacy) {
    return { authClass: 'legacy_gateway', role: 'operator', binding: null };
  }
  if (!tokenMatches(frame.token, deps.legacyGatewayToken)) return null;
  return { authClass: 'legacy_gateway', role: 'operator', binding: null };
}

/** role/expectedRole are compatibility assertions only; absence is accepted. */
export function assertedRoleMatches(
  frame: Pick<ConnectFrame, 'role' | 'expectedRole'>,
  derivedRole: Role,
): boolean {
  return (frame.role === undefined || frame.role === derivedRole) &&
    (frame.expectedRole === undefined || frame.expectedRole === derivedRole);
}
