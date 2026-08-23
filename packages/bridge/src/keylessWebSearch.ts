import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export const WEB_SEARCH_SERVER_ID = 'research';
export const WEB_SEARCH_TOOL_CAPABILITIES: Record<string, 'read'> = { web_search: 'read' };

const MAX_RESULTS = 10;
const MAX_OUTPUT_BYTES = 256_000;
const TIMEOUT_MS = 20_000;

type WebHit = { title: string; url: string; description: string; position: number };
type SearchResult =
  | { success: true; backendUsed: 'ddgs_cli' | 'searxng'; data: { web: WebHit[] } }
  | { success: false; backendUsed: null; error: string; attempts: Array<{ backend: string; status: string }> };

function ddgsExecutable(): string {
  const configured = process.env.DDGS_CLI_PATH?.trim();
  if (configured) return configured;
  const candidates = process.platform === 'win32'
    ? [resolve(process.cwd(), 'engines/hermes_kernel/.venv/Scripts/ddgs.exe')]
    : [resolve(process.cwd(), 'engines/hermes_kernel/.venv/bin/ddgs')];
  return candidates.find(existsSync) ?? 'ddgs';
}

function boundedRows(rows: unknown[], limit: number): WebHit[] {
  return rows.slice(0, limit).flatMap((value, index) => {
    if (!value || typeof value !== 'object') return [];
    const row = value as Record<string, unknown>;
    return [{
      title: String(row.title ?? '').slice(0, 500),
      url: String(row.href ?? row.url ?? '').slice(0, 2048),
      description: String(row.body ?? row.description ?? row.content ?? '').slice(0, 2000),
      position: index + 1,
    }];
  });
}

function parseDdgs(stdout: string, limit: number): WebHit[] | null {
  try {
    const decoded: unknown = JSON.parse(stdout);
    return boundedRows(Array.isArray(decoded) ? decoded : [decoded], limit);
  } catch {
    try {
      return boundedRows(
        stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as unknown),
        limit,
      );
    } catch {
      return null;
    }
  }
}

async function searchDdgsCli(query: string, limit: number): Promise<WebHit[] | null> {
  return new Promise((resolveResult) => {
    execFile(
      ddgsExecutable(),
      ['text', '-q', query, '-m', String(limit), '-o', 'json', '--no-color'],
      { encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true },
      (error, stdout) => {
        if (error) return resolveResult(null);
        resolveResult(parseDdgs(stdout, limit));
      },
    );
  });
}

function searxngBaseUrl(): URL | null {
  const raw = process.env.SEARXNG_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

async function searchSearxng(query: string, limit: number): Promise<WebHit[] | null> {
  const base = searxngBaseUrl();
  if (!base) return null;
  const url = new URL('/search', base);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('pageno', '1');
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = await response.json() as { results?: unknown[] };
    return boundedRows(Array.isArray(body.results) ? body.results : [], limit);
  } catch {
    return null;
  }
}

export async function searchKeylessWeb(query: string, limit: number): Promise<SearchResult> {
  const cli = await searchDdgsCli(query, limit);
  if (cli !== null) return { success: true, backendUsed: 'ddgs_cli', data: { web: cli } };

  const hasSearxng = searxngBaseUrl() !== null;
  const fallback = hasSearxng ? await searchSearxng(query, limit) : null;
  if (fallback !== null) return { success: true, backendUsed: 'searxng', data: { web: fallback } };

  return {
    success: false,
    backendUsed: null,
    error: 'Keyless web search is temporarily unavailable.',
    attempts: [
      { backend: 'ddgs_cli', status: 'failed' },
      { backend: 'searxng', status: hasSearxng ? 'failed' : 'not_configured' },
    ],
  };
}

export function buildKeylessWebSearchMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'torqclaw-keyless-web-search', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  server.registerTool(
    'web_search',
    {
      title: 'Search the web',
      description: 'Search-only web research through DDGS with optional SearXNG fallback. No API key.',
      inputSchema: {
        query: z.string().trim().min(1).max(500),
        limit: z.number().int().min(1).max(MAX_RESULTS).default(5),
      },
    },
    async ({ query, limit }) => {
      const result = await searchKeylessWeb(query, limit);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );
  return server;
}
