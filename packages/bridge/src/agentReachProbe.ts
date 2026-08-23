import { execFile } from 'node:child_process';
import type { AgentReachChannel, AgentReachRouting } from '@torqclaw/contracts';
import { getClient } from './registry.js';

const CHANNELS = [
  'github', 'twitter', 'youtube', 'reddit', 'facebook', 'instagram',
  'bilibili', 'xiaohongshu', 'linkedin', 'xiaoyuzhou', 'v2ex', 'xueqiu',
  'rss', 'exa_search', 'web',
] as const satisfies readonly AgentReachChannel[];

type Snapshot = { available: Set<AgentReachChannel> };
type CacheEntry = { expiresAt: number; value: Snapshot };

const MAX_OUTPUT_BYTES = 256_000;
const PROBE_TIMEOUT_MS = 10_000;
let localCache: CacheEntry | null = null;
let frontierCache: CacheEntry | null = null;

function ttlMs(): number {
  const parsed = Number(process.env.TORQCLAW_AGENT_REACH_PROBE_TTL_MS ?? 60_000);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 10_000), 300_000) : 60_000;
}

export function parseAgentReachDoctor(value: unknown): Snapshot {
  const available = new Set<AgentReachChannel>();
  if (!value || typeof value !== 'object') return { available };
  const root = value as Record<string, unknown>;
  const records = root.channels && typeof root.channels === 'object'
    ? root.channels as Record<string, unknown>
    : root;
  for (const channel of CHANNELS) {
    const raw = records[channel];
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const active = entry.active_backend ?? entry.activeBackend;
    const explicitlyAvailable = entry.available === true;
    if (explicitlyAvailable || (entry.status === 'ok' && typeof active === 'string' && active.length > 0)) {
      available.add(channel);
    }
  }
  return { available };
}

function runLocalDoctor(): Promise<Snapshot> {
  const command = process.env.AGENT_REACH_CLI_PATH?.trim() || 'agent-reach';
  return new Promise((resolve) => {
    execFile(
      command,
      ['doctor', '--json'],
      { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true },
      (error, stdout) => {
        if (error) return resolve({ available: new Set() });
        try {
          resolve(parseAgentReachDoctor(JSON.parse(stdout)));
        } catch {
          resolve({ available: new Set() });
        }
      },
    );
  });
}

async function runFrontierDoctor(): Promise<Snapshot> {
  try {
    const result = await getClient('hermes').callTool({
      name: 'agent_reach_doctor',
      arguments: {},
    }) as {
      structuredContent?: unknown;
      content?: Array<{ type: string; text?: string }>;
    };
    if (result.structuredContent) return parseAgentReachDoctor(result.structuredContent);
    const text = result.content?.find((part) => part.type === 'text')?.text;
    return text ? parseAgentReachDoctor(JSON.parse(text)) : { available: new Set() };
  } catch {
    return { available: new Set() };
  }
}

async function cached(kind: 'local' | 'frontier'): Promise<Snapshot> {
  const current = kind === 'local' ? localCache : frontierCache;
  if (current && current.expiresAt > Date.now()) return current.value;
  const value = kind === 'local' ? await runLocalDoctor() : await runFrontierDoctor();
  const next = { value, expiresAt: Date.now() + ttlMs() };
  if (kind === 'local') localCache = next;
  else frontierCache = next;
  return value;
}

const CHANNEL_PATTERNS: ReadonlyArray<[AgentReachChannel, RegExp]> = [
  ['github', /\bgithub\b|github\.com|\brepositor(?:y|ies)\b|\bpull request\b/i],
  ['twitter', /\btwitter\b|\bx\.com\b|\btweets?\b/i],
  ['youtube', /\byoutube\b|youtu\.be|\byoutube transcript\b/i],
  ['reddit', /\breddit\b|reddit\.com/i],
  ['facebook', /\bfacebook\b|facebook\.com/i],
  ['instagram', /\binstagram\b|instagram\.com/i],
  ['bilibili', /\bbilibili\b|bilibili\.com|\bb站\b/i],
  ['xiaohongshu', /\bxiaohongshu\b|xiaohongshu\.com|\bxhs\b|小红书/i],
  ['linkedin', /\blinkedin\b|linkedin\.com/i],
  ['xiaoyuzhou', /\bxiaoyuzhou\b|小宇宙/i],
  ['v2ex', /\bv2ex\b|v2ex\.com/i],
  ['xueqiu', /\bxueqiu\b|xueqiu\.com|雪球/i],
  ['rss', /\brss\b|\batom feed\b/i],
  ['exa_search', /\bagent[ -]?reach\b|\bdeep research\b|\bcross-platform research\b/i],
  ['web', /https?:\/\/|\bread (?:this|the) (?:url|page|article)\b/i],
];

export function detectAgentReachChannels(prompt: string): AgentReachChannel[] {
  return CHANNEL_PATTERNS.filter(([, pattern]) => pattern.test(prompt)).map(([channel]) => channel);
}

const WRITE_INTENT = /\b(post|publish|comment|reply|like|follow|upload|delete|remove|send)\b/i;

export async function resolveAgentReachRouting(prompt: string): Promise<AgentReachRouting | undefined> {
  const requestedChannels = detectAgentReachChannels(prompt);
  if (requestedChannels.length === 0) return undefined;
  const [local, frontier] = await Promise.all([cached('local'), cached('frontier')]);
  const localChannels = requestedChannels.filter((channel) => local.available.has(channel));
  const frontierChannels = requestedChannels.filter((channel) => frontier.available.has(channel));
  return {
    requestedChannels,
    localChannels,
    frontierChannels,
    localSatisfies: localChannels.length === requestedChannels.length,
    frontierSatisfies: frontierChannels.length === requestedChannels.length,
    writeIntent: WRITE_INTENT.test(prompt),
  };
}

export function resetAgentReachProbeCacheForTests(): void {
  localCache = null;
  frontierCache = null;
}
