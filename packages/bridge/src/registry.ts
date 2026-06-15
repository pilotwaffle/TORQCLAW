import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { type PathScope, checkPath, extractPaths } from './pathScope.js';

export interface RegisteredTool {
  /** Namespaced: `${serverId}__${toolName}` */
  name: string;
  description: string;
  inputSchema: object;
  sourceServerId: string;
  rawName: string;
  /** Policy gate: write-capable tools pause LOCAL_EDGE execution for a human. */
  requiresApproval: boolean;
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
}

const clients = new Map<string, Client>();
let registry: RegisteredTool[] = [];

const DEFAULT_WRITE_PATTERNS = [/write/i, /delete/i, /push/i, /create/i, /update/i, /send/i, /exec/i];

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

  await client.connect(transport);
  clients.set(cfg.id, client);

  const { tools } = await client.listTools();
  const patterns = cfg.approvalPatterns ?? DEFAULT_WRITE_PATTERNS;
  // Optional allowlist: register only the named tools. Drops the rest so a
  // large server (80+ tools) can't overflow the local context window.
  const allow = cfg.tools ? new Set(cfg.tools) : null;
  const selected = allow ? tools.filter((t) => allow.has(t.name)) : tools;
  for (const t of selected) {
    registry.push({
      name: `${cfg.id}__${t.name}`,
      rawName: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema as object,
      sourceServerId: cfg.id,
      requiresApproval: patterns.some((p) => p.test(t.name)),
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

export async function executeTool(namespacedName: string, args: unknown): Promise<unknown> {
  const entry = registry.find((t) => t.name === namespacedName);
  if (!entry) throw new Error(`Unknown tool '${namespacedName}'`);

  // P5: enforce the server's filesystem scope BEFORE the call. Resolve every
  // path-like arg (normalizes ~ and .. so traversal can't bypass a deny) and
  // check it; deny always wins. A write-capable tool checks 'write' scope, else
  // 'read'. Throwing here surfaces as a tool error back to the model.
  if (entry.pathScope) {
    const mode = entry.requiresApproval ? 'write' : 'read';
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
  try {
    await connectServer({
      id: 'hermes',
      transport: { type: 'streamable-http', url: hermesUrl, token: hermesToken },
      approvalPatterns: [], // engine meta-tools are control-plane, not user tools
    });
  } catch (err: any) {
    console.warn(`[bridge] hermes engine unreachable (${err.message}) — FRONTIER tier degraded`);
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
