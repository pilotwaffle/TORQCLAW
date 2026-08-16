import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { EffectiveProfile } from '@torqclaw/contracts';

import { type PathScope, checkPath, extractPaths } from './pathScope.js';
import { type Capability, classifyCapability, isWriteClass, scopeModeFor } from './capability.js';

export interface RegisteredTool {
  /** Namespaced: `${serverId}__${toolName}` */
  name: string;
  description: string;
  inputSchema: object;
  sourceServerId: string;
  rawName: string;
  /** Policy gate: write-capable tools pause LOCAL_EDGE execution for a human. */
  requiresApproval: boolean;
  /** TCLAW-0C: behavior-based classification (read/write/exec/send). Drives
   *  path-scope mode; requiresApproval is derived from it (isWriteClass) but
   *  can still be widened by approvalPatterns. */
  capability: Capability;
  /** P5: per-server filesystem scope (deny/read/write) inherited from config. */
  pathScope?: PathScope;
  /** P5: which arg keys hold path-like values for this server's tools. */
  pathArgKeys?: string[];
}

export interface ServerConfig {
  id: string;
  transport:
    | { type: 'streamable-http'; url: string; token?: string }
    | { type: 'stdio'; command: string; args: string[] };
  /** Tool rawName patterns that need human approval (e.g. /write|push|delete/i). */
  approvalPatterns?: RegExp[];
  /** P5: filesystem scope — deny always wins; empty read/write = unconstrained. */
  paths?: PathScope;
  /** P5: arg keys holding path-like values (hint for scope enforcement). */
  pathArgKeys?: string[];
  /** Raw-tool-name allowlist. When set, only these tools register (the rest are
   *  dropped) — keeps a large server from overflowing the local context window. */
  tools?: string[];
  /** TCLAW-0C: per-tool capability override (P1 — beats every other signal). */
  capabilities?: Record<string, Capability>;
}

const clients = new Map<string, Client>();
let registry: RegisteredTool[] = [];

const DEFAULT_WRITE_PATTERNS = [/write/i, /delete/i, /push/i, /create/i, /update/i, /send/i, /exec/i];

// Deferred hermes connection (B-1 fix). When the engine is unreachable at boot
// we keep retrying in the background with capped exponential backoff (reset on
// success) and notify registered waiters the first time it connects, so boot
// work that needs the engine (failover recovery) runs as soon as the engine is
// up instead of waiting for a gateway restart. Pattern: hermes-agent's
// reconnect watcher re-running recovery on connect + buzz's capped backoff.
type HermesReadyCallback = () => void | Promise<void>;
const hermesReadyCallbacks: HermesReadyCallback[] = [];
let hermesReconnectConfig: ServerConfig | null = null;
let hermesReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let hermesReconnectAttempt = 0;
const HERMES_RECONNECT_INITIAL_MS = 1_000;
const HERMES_RECONNECT_CAP_MS = 30_000;
// Bounded effort: after this many failed attempts we stop retrying and surface
// it loudly rather than retrying invisibly forever (hermes MAX_ATTEMPTS idea).
const HERMES_RECONNECT_MAX_ATTEMPTS = 24;

/** Register work to run once the hermes engine is (or becomes) connected. If
 *  the engine is already connected the callback fires immediately. Used by the
 *  gateway to defer failover recovery until the engine is reachable. */
export function onHermesReady(cb: HermesReadyCallback): void {
  if (clients.has('hermes')) {
    void Promise.resolve().then(() => cb()).catch((error) => {
      console.warn(`[bridge] hermes-ready callback failed: ${(error as Error)?.message ?? error}`);
    });
    return;
  }
  hermesReadyCallbacks.push(cb);
}

async function fireHermesReady(): Promise<void> {
  const cbs = hermesReadyCallbacks.splice(0);
  for (const cb of cbs) {
    try {
      await cb();
    } catch (error) {
      console.warn(`[bridge] hermes-ready callback failed: ${(error as Error)?.message ?? error}`);
    }
  }
}

function scheduleHermesReconnect(): void {
  if (hermesReconnectTimer !== null || hermesReconnectConfig === null) return;
  if (clients.has('hermes')) return;
  if (hermesReconnectAttempt >= HERMES_RECONNECT_MAX_ATTEMPTS) {
    console.error(`[bridge] hermes engine unreachable after ${HERMES_RECONNECT_MAX_ATTEMPTS} reconnect attempts — FRONTIER stays degraded until gateway restart`);
    return;
  }
  const delay = Math.min(HERMES_RECONNECT_INITIAL_MS * 2 ** hermesReconnectAttempt, HERMES_RECONNECT_CAP_MS);
  hermesReconnectAttempt += 1;
  hermesReconnectTimer = setTimeout(() => {
    hermesReconnectTimer = null;
    void attemptHermesReconnect();
  }, delay);
  // Never keep the event loop alive just to retry the engine.
  hermesReconnectTimer.unref?.();
}

async function attemptHermesReconnect(): Promise<void> {
  const cfg = hermesReconnectConfig;
  if (cfg === null || clients.has('hermes')) return;
  try {
    await connectServer(cfg);
    hermesReconnectAttempt = 0; // reset backoff on success (buzz run_subscriber)
    console.log('[bridge] hermes engine connected (deferred reconnect)');
    await fireHermesReady();
  } catch (error) {
    console.warn(`[bridge] hermes reconnect attempt ${hermesReconnectAttempt} failed (${(error as Error)?.message ?? error})`);
    scheduleHermesReconnect();
  }
}

export async function connectServer(cfg: ServerConfig): Promise<void> {
  const client = new Client(
    { name: 'torqclaw-gateway', version: '0.1.0' },
    { capabilities: {} },
  );
  const transport =
    cfg.transport.type === 'streamable-http'
      ? new StreamableHTTPClientTransport(new URL(cfg.transport.url), {
          requestInit: cfg.transport.token
            ? { headers: { Authorization: `Bearer ${cfg.transport.token}` } }
            : undefined,
        })
      : new StdioClientTransport({ command: cfg.transport.command, args: cfg.transport.args });

  try {
    await client.connect(transport);
  } catch (error) {
    // A failed (re)connect must not leak the half-open transport.
    try { await transport.close(); } catch { /* best-effort cleanup */ }
    throw error;
  }
  clients.set(cfg.id, client);

  const { tools } = await client.listTools();
  const patterns = cfg.approvalPatterns ?? DEFAULT_WRITE_PATTERNS;
  // Optional allowlist: register only the named tools. Drops the rest so a
  // large server (80+ tools) can't overflow the local context window.
  const allow = cfg.tools ? new Set(cfg.tools) : null;
  const selected = allow ? tools.filter((t) => allow.has(t.name)) : tools;
  // Idempotent re-registration: drop any prior entries for this server so a
  // reconnect never duplicates its tools in the registry.
  registry = registry.filter((entry) => entry.sourceServerId !== cfg.id);
  for (const t of selected) {
    const cap = classifyCapability(t.name, (t as any).annotations, cfg.capabilities?.[t.name]);
    registry.push({
      name: `${cfg.id}__${t.name}`,
      rawName: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema as object,
      sourceServerId: cfg.id,
      capability: cap,
      requiresApproval: isWriteClass(cap) || patterns.some((p) => p.test(t.name)),
      pathScope: cfg.paths,
      pathArgKeys: cfg.pathArgKeys,
    });
  }
  const note = allow ? ` (allowlisted from ${tools.length})` : '';
  console.log(`[bridge] ${cfg.id}: registered ${selected.length} tools${note}`);
}

export function getRegistry(): RegisteredTool[] {
  return registry;
}

export function getClient(serverId: string): Client {
  const c = clients.get(serverId);
  if (!c) throw new Error(`No MCP client connected for server '${serverId}'`);
  return c;
}

/** True if the Hermes engine connected at boot. Lets dispatch degrade a
 *  FRONTIER task gracefully instead of throwing a bare "no client" error. */
export function isHermesAvailable(): boolean {
  return clients.has('hermes');
}

export async function executeTool(
  namespacedName: string,
  args: unknown,
  effectiveProfile?: EffectiveProfile,
): Promise<unknown> {
  const entry = registry.find((t) => t.name === namespacedName);
  if (!entry) throw new Error(`Unknown tool '${namespacedName}'`);
  if (effectiveProfile) {
    const { assertOperationAllowed } = await import('./profilePolicy.js');
    assertOperationAllowed(effectiveProfile, entry);
  }

  // P5: enforce the server's filesystem scope BEFORE the call. Resolve every
  // path-like arg (normalizes ~ and .. so traversal can't bypass a deny) and
  // check it; deny always wins. A write-capable tool checks 'write' scope, else
  // 'read'. Throwing here surfaces as a tool error back to the model.
  if (effectiveProfile) {
    const profilePaths = extractPaths(args, entry.pathArgKeys);
    if (profilePaths.length > 0 && effectiveProfile.scopes.path === 'none') {
      throw new Error(`Effective profile '${effectiveProfile.profileId}' does not permit filesystem paths`);
    }
    if (profilePaths.length > 0 && effectiveProfile.scopes.path !== 'none' && !entry.pathScope) {
      throw new Error(`Tool '${entry.name}' has no configured path scope for effective profile '${effectiveProfile.profileId}'`);
    }
  }
  if (entry.pathScope) {
    const mode = scopeModeFor(entry.capability);
    for (const p of extractPaths(args, entry.pathArgKeys)) {
      const denial = checkPath(p, entry.pathScope, mode);
      if (denial) throw new Error(`Path scope ${denial}`);
    }
  }

  const result = await getClient(entry.sourceServerId).callTool({
    name: entry.rawName,
    arguments: args as Record<string, unknown>,
  });
  if (result.isError) {
    const text = (result.content as any[])?.map((c) => c.text).join('\n') ?? 'tool error';
    throw new Error(text);
  }
  return result.content;
}

/** Boot-time wiring. Engine URL/token env-driven so splitting onto a GPU box
 *  is config, not code. */
export async function connectBridge(): Promise<void> {
  const hermesUrl = process.env.HERMES_ENGINE_URL || 'http://127.0.0.1:8000/mcp';
  const hermesToken = process.env.HERMES_ENGINE_TOKEN;
  const hermesConfig: ServerConfig = {
    id: 'hermes',
    transport: { type: 'streamable-http', url: hermesUrl, token: hermesToken },
    approvalPatterns: [], // engine meta-tools are control-plane, not user tools
  };
  // Remembered so the background reconnect can retry the same endpoint (B-1).
  hermesReconnectConfig = hermesConfig;
  try {
    await connectServer(hermesConfig);
  } catch (err: any) {
    console.warn(`[bridge] hermes engine unreachable (${err.message}) — retrying in background; FRONTIER degraded until it connects`);
    scheduleHermesReconnect();
  }
  // User-managed roster: ~/.torqclaw/servers.json (validated, per-server fault isolation)
  const { loadServerConfigs } = await import('./serverConfig.js');
  for (const cfg of loadServerConfigs()) {
    try {
      await connectServer(cfg);
    } catch (err: any) {
      console.warn(`[bridge] ${cfg.id} unreachable (${err.message}) — its tools are unavailable this session`);
    }
  }
}
