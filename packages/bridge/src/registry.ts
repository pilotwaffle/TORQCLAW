import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export interface RegisteredTool {
  /** Namespaced: `${serverId}__${toolName}` */
  name: string;
  description: string;
  inputSchema: object;
  sourceServerId: string;
  rawName: string;
  /** Policy gate: write-capable tools pause LOCAL_EDGE execution for a human. */
  requiresApproval: boolean;
}

export interface ServerConfig {
  id: string;
  transport:
    | { type: 'streamable-http'; url: string; token?: string }
    | { type: 'stdio'; command: string; args: string[] };
  /** Tool rawName patterns that need human approval (e.g. /write|push|delete/i). */
  approvalPatterns?: RegExp[];
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
  for (const t of tools) {
    registry.push({
      name: `${cfg.id}__${t.name}`,
      rawName: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema as object,
      sourceServerId: cfg.id,
      requiresApproval: patterns.some((p) => p.test(t.name)),
    });
  }
  console.log(`[bridge] ${cfg.id}: registered ${tools.length} tools`);
}

export function getRegistry(): RegisteredTool[] {
  return registry;
}

export function getClient(serverId: string): Client {
  const c = clients.get(serverId);
  if (!c) throw new Error(`No MCP client connected for server '${serverId}'`);
  return c;
}

export async function executeTool(namespacedName: string, args: unknown): Promise<unknown> {
  const entry = registry.find((t) => t.name === namespacedName);
  if (!entry) throw new Error(`Unknown tool '${namespacedName}'`);
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
  // Additional servers (filesystem, github, ...) load from ~/.torqclaw/servers.json — TODO.
}
