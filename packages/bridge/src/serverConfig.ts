import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import type { ServerConfig } from './registry.js';

/** ~/.torqclaw/servers.json — user-managed MCP server roster.
 *  Validated like every other boundary; a malformed entry names itself
 *  instead of crashing boot. */
const TransportSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
  }),
  z.object({
    type: z.literal('streamable-http'),
    url: z.string().url(),
    token: z.string().optional(),
  }),
]);

const ServerEntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/, 'lowercase alphanumeric + underscore (becomes the tool namespace prefix)'),
  transport: TransportSchema,
  /** Regex strings; matching tool names require human approval on LOCAL_EDGE.
   *  Omit to use the default write/delete/push/create/update/send/exec set. */
  approvalPatterns: z.array(z.string()).optional(),
  /** P5: filesystem scope. deny always wins; empty read/write = unconstrained.
   *  Paths are resolved (~ and .. normalized) before matching. */
  paths: z.object({
    read: z.array(z.string()).optional(),
    write: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
  }).optional(),
  /** P5: which tool-arg keys hold path-like values (precise scope enforcement). */
  pathArgKeys: z.array(z.string()).optional(),
  /** Optional raw-tool-name allowlist. When set, ONLY these tools are registered
   *  from this server — the rest are dropped. Essential for big servers (e.g. a
   *  TradingView MCP with 80+ tools) whose full schema set would overflow the
   *  local 8K context window. Names are the server's own (un-namespaced) tool
   *  names. Omit to register everything. */
  tools: z.array(z.string()).optional(),
  enabled: z.boolean().default(true),
});

const ServersFileSchema = z.object({ servers: z.array(ServerEntrySchema) });

export function loadServerConfigs(): ServerConfig[] {
  const dir = process.env.TORQCLAW_DATA_DIR || join(homedir(), '.torqclaw');
  const file = join(dir, 'servers.json');
  if (!existsSync(file)) return [];

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e: any) {
    console.warn(`[bridge] ${file} is not valid JSON (${e.message}) — skipping external servers`);
    return [];
  }

  const parsed = ServersFileSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn(`[bridge] ${file} failed validation — skipping external servers`);
    for (const issue of parsed.error.issues.slice(0, 5)) {
      console.warn(`  - ${issue.path.join('.')}: ${issue.message}`);
    }
    return [];
  }

  return parsed.data.servers
    .filter((s) => s.enabled)
    .map((s) => ({
      id: s.id,
      transport: s.transport.type === 'stdio'
        ? { type: 'stdio' as const, command: s.transport.command, args: s.transport.args }
        : { type: 'streamable-http' as const, url: s.transport.url, token: s.transport.token },
      approvalPatterns: s.approvalPatterns?.map((p) => new RegExp(p, 'i')),
      paths: s.paths,
      pathArgKeys: s.pathArgKeys,
      tools: s.tools,
    }));
}
