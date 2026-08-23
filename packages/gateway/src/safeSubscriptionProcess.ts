import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type {
  SubscriptionPrivateEnvironmentProfileId,
  SubscriptionProviderId,
} from './subscriptionRuntimeCatalog.js';
import { validateSubscriptionProviderModel } from './subscriptionRuntimeCatalog.js';

export type SubscriptionProbeStatus = 'connected' | 'available' | 'missing' | 'unavailable';

export interface SubscriptionProbeResult {
  providerId: SubscriptionProviderId;
  status: SubscriptionProbeStatus;
}

export interface ProcessSummary {
  exitCode: number | null;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  /**
   * Sanitized spawn failure class. Never carries OS text, paths, or child output.
   * - `not_found`: the executable does not resolve (ENOENT).
   * - `unspawnable_shim`: the command resolved to a `.cmd`/`.bat` shim, which Node refuses to
   *   spawn with `shell:false` (EINVAL, CVE-2024-27980 hardening). The driver rewrites known
   *   npm shims to `node <entry>` before spawning; this surfaces only when that rewrite failed.
   * - `failed`: any other spawn-level error.
   */
  spawnError: 'not_found' | 'unspawnable_shim' | 'failed' | null;
  cancelled?: boolean;
  terminationUnconfirmed?: boolean;
}

export interface ProbePlan {
  command: string;
  args: readonly string[];
  timeoutMs: number;
  successStatus: Extract<SubscriptionProbeStatus, 'connected' | 'available'>;
}

export interface InvocationPlan {
  command: string;
  args: readonly string[];
  stdinJsonLine: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  privateEnvironmentProfileId?: SubscriptionPrivateEnvironmentProfileId;
}

export type InteractiveInvocationPlan = Omit<InvocationPlan, 'stdinJsonLine'>;

export interface SubscriptionProcessConnection {
  writeJsonLine(line: string): Promise<void>;
  readLine(): Promise<string>;
  stop(): Promise<ProcessSummary>;
}

export interface SubscriptionProcessDriver {
  probe(plan: ProbePlan): Promise<ProcessSummary>;
  invoke(plan: InvocationPlan, onStdoutLine: (line: string) => void): Promise<ProcessSummary>;
  open(plan: InteractiveInvocationPlan): Promise<SubscriptionProcessConnection>;
}

export type SanitizedInvocationEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'result'; text: string }
  | { type: 'status'; status: 'starting' | 'running' | 'completed' | 'failed' }
  | { type: 'tool_call'; id: string; name: string };

export interface SanitizedInvocationResult extends ProcessSummary {
  events: SanitizedInvocationEvent[];
}

const SAFE_ENV_NAMES = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'ComSpec',
  'HOME',
  'USERPROFILE',
  'LOCALAPPDATA',
  'APPDATA',
  'TEMP',
  'TMP',
] as const;

const SENSITIVE_KEY = /(?:^|[_-])(authorization|cookie|credential|password|secret|token|api[_-]?key)(?:$|[_-])/i;
/** Exported alias of SENSITIVE_KEY for subscriptionAcpRuntime.ts's consumed-result key scan --
 * a JSON field literally NAMED e.g. `token`/`apiKey` is scanned by key, independent of whether
 * its string value happens to match CREDENTIAL_TEXT's shape. Distinct from CREDENTIAL_TEXT (which
 * scans a string's own SHAPE, not the key that holds it): a benign prose value under a sensitive
 * key still trips this, which is intentional for consumed JSON-RPC results/errors -- unlike
 * agent_message_chunk / available_commands_update prose, those are structured provider protocol
 * payloads with no legitimate reason to carry a field named `token`/`secret`/etc. */
export const SENSITIVE_RESULT_KEY = SENSITIVE_KEY;
/**
 * Credential-SHAPED text: a known secret prefix (Bearer token, sk-/ghp-/xox*-/AIza- style API
 * keys) or a `key|token|secret|...` label immediately followed by `:`/`=` and a value. Deliberately
 * narrower than a bare keyword match (e.g. `SECRET` in subscriptionAcpRuntime.ts before PRD-007
 * Item B correction 2) -- prose that merely mentions "token" (a real
 * `available_commands_update` frame's slash-command listing, usage_update field names like
 * `inputTokens`) must not match this pattern. Exported so subscriptionAcpRuntime.ts's targeted,
 * consumed-value-only credential scan uses the exact same definition as sanitizeAcpJsonLine below,
 * rather than a second hand-maintained copy.
 */
export const CREDENTIAL_TEXT =
  /(?:\bBearer\s+[A-Za-z0-9._~+\/-]{8,}|\b(?:sk|ghp|github_pat|xox[baprs]|AIza)[-_A-Za-z0-9]{8,}|(?:api[_ -]?key|authorization|cookie|credential|password|secret|token)\s*[:=]\s*\S+)/i;

const PROBE_PLANS: Record<SubscriptionProviderId, readonly ProbePlan[]> = {
  'grok-subscription': [
    { command: 'grok', args: ['agent', '--always-approve', 'stdio'], timeoutMs: 4_000, successStatus: 'connected' },
  ],
  'kimi-subscription': [
    { command: 'kimi', args: ['acp'], timeoutMs: 4_000, successStatus: 'connected' },
  ],
  'qwen-subscription': [
    { command: 'qwen', args: ['--acp', '-m', 'qwen3.8-max-preview'], timeoutMs: 4_000, successStatus: 'connected' },
  ],
  'zai-subscription': [
    // claude-agent-acp cold-starts in ~4s on Windows (measured 3.9s, 2026-08-22); 4s left no margin.
    { command: 'claude-agent-acp', args: [], timeoutMs: 8_000, successStatus: 'available' },
  ],
};

/**
 * Root of the gateway-owned private-runtime scratch space for subscription adapters that read
 * user-level Claude Code config (e.g. `~/.claude/settings.json`) from their own HOME/USERPROFILE.
 * Read live (never cached at import) so tests can repoint it via `TORQCLAW_DATA_DIR`, matching
 * the pattern in storage.ts.
 */
function subscriptionRuntimeDataDir(source: NodeJS.ProcessEnv): string {
  return source.TORQCLAW_DATA_DIR || path.join(homedir(), '.torqclaw');
}

/**
 * The zai profile's isolated `CLAUDE_CONFIG_DIR`: a gateway-owned directory created empty at
 * call time and never written to. `claude-agent-acp` resolves `CLAUDE_CONFIG_DIR` (or falls back
 * to `os.homedir()`) for `settingSources: ["user","project","local"]`; pointing it at an empty,
 * gateway-owned directory keeps any operator-machine `~/.claude/settings.json` model override
 * (e.g. `claude-opus-4-8`) from ever being read by this child, without touching the real HOME.
 */
export function zaiPrivateClaudeConfigDir(source: NodeJS.ProcessEnv = process.env): string {
  return path.join(
    subscriptionRuntimeDataDir(source),
    'subscription-runtimes', 'zai-anthropic-glm-5.3-v1', 'claude-config',
  );
}

/**
 * The zai profile's explicit spawn `cwd`: a sibling gateway-owned empty directory with no
 * `.claude/` of its own, so `settingSources: ["...","project","local"]` cannot pick up a
 * project/local settings file placed in whatever directory the gateway process happens to be
 * running from.
 */
export function zaiPrivateSpawnCwd(source: NodeJS.ProcessEnv = process.env): string {
  return path.join(subscriptionRuntimeDataDir(source), 'subscription-runtimes', 'zai-anthropic-glm-5.3-v1', 'cwd');
}

/**
 * Resolves the `cwd` a subscription child process should spawn in. Only the zai profile gets an
 * explicit, gateway-owned, `.claude/`-free directory (created at call time); every other profile
 * keeps the prior behavior of inheriting the gateway process's own cwd (`undefined` to `spawn`).
 *
 * `source` must be the SAME env object passed to `buildSafeChildEnv` for this same spawn --
 * `zaiPrivateSpawnCwd` resolves `TORQCLAW_DATA_DIR` from it, exactly as `zaiPrivateClaudeConfigDir`
 * does inside `buildSafeChildEnv`. Before this fix the two calls could resolve against different
 * roots (this always defaulted to `process.env` regardless of what env the caller was building),
 * so a test repointing `TORQCLAW_DATA_DIR` would isolate `CLAUDE_CONFIG_DIR` but not `cwd`.
 */
function resolveSubscriptionSpawnCwd(
  privateEnvironmentProfileId: SubscriptionPrivateEnvironmentProfileId | undefined,
  source: NodeJS.ProcessEnv,
): string | undefined {
  if (privateEnvironmentProfileId !== 'zai-anthropic-glm-5.3-v1') return undefined;
  const cwd = zaiPrivateSpawnCwd(source);
  mkdirSync(cwd, { recursive: true });
  return cwd;
}

export function buildSafeChildEnv(
  source: NodeJS.ProcessEnv = process.env,
  privateEnvironmentProfileId?: SubscriptionPrivateEnvironmentProfileId,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of SAFE_ENV_NAMES) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  if (privateEnvironmentProfileId === 'zai-anthropic-glm-5.3-v1') {
    const key = source.GLM_API_KEY;
    if (!key?.trim()) throw new Error('ZAI_GLM_API_KEY_REQUIRED');
    env.ANTHROPIC_AUTH_TOKEN = key;
    env.ANTHROPIC_BASE_URL = 'https://api.z.ai/api/anthropic';
    env.ANTHROPIC_MODEL = 'glm-5.3';
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'glm-5.3';
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'glm-5.3';
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'glm-5.3';
    const configDir = zaiPrivateClaudeConfigDir(source);
    mkdirSync(configDir, { recursive: true });
    env.CLAUDE_CONFIG_DIR = configDir;
  }
  return env;
}

export function assertSubscriptionPrivateEnvironment(
  privateEnvironmentProfileId?: SubscriptionPrivateEnvironmentProfileId,
  source: NodeJS.ProcessEnv = process.env,
): void {
  buildSafeChildEnv(source, privateEnvironmentProfileId);
}

export function getSubscriptionProbePlans(providerId: SubscriptionProviderId): ProbePlan[] {
  return PROBE_PLANS[providerId].map((plan) => ({ ...plan, args: [...plan.args] }));
}

export async function probeSubscriptionRuntime(
  providerId: SubscriptionProviderId,
  driver: SubscriptionProcessDriver = nodeSubscriptionProcessDriver,
): Promise<SubscriptionProbeResult> {
  const plans = PROBE_PLANS[providerId];
  for (const plan of plans) {
    const result = await driver.probe(plan);
    if (result.exitCode === 0 && !result.timedOut && !result.outputLimitExceeded) {
      return { providerId, status: plan.successStatus };
    }
    if (result.spawnError !== 'not_found') {
      return { providerId, status: 'unavailable' };
    }
  }
  return { providerId, status: 'missing' };
}

export async function probeAllSubscriptionRuntimes(
  driver: SubscriptionProcessDriver = nodeSubscriptionProcessDriver,
): Promise<SubscriptionProbeResult[]> {
  const providerIds: SubscriptionProviderId[] = [
    'grok-subscription',
    'kimi-subscription',
    'qwen-subscription',
    'zai-subscription',
  ];
  return Promise.all(providerIds.map((providerId) => probeSubscriptionRuntime(providerId, driver)));
}

export async function invokeSanitizedSubscription(
  request: {
    providerId: string;
    modelId: string;
    probeSatisfied?: boolean;
    command: string;
    args: readonly string[];
    payload: unknown;
    timeoutMs?: number;
    maxOutputBytes?: number;
  },
  driver: SubscriptionProcessDriver = nodeSubscriptionProcessDriver,
): Promise<SanitizedInvocationResult> {
  const validation = validateSubscriptionProviderModel(request.providerId, request.modelId, {
    probeSatisfied: request.probeSatisfied,
  });
  if (!validation.ok) throw new Error(validation.code);
  assertSafeExecutable(request.command, request.args);
  if (containsSensitiveKey(request.payload)) throw new Error('SENSITIVE_INPUT_REJECTED');

  const plan: InvocationPlan = {
    command: request.command,
    args: [...request.args],
    stdinJsonLine: `${JSON.stringify(request.payload)}\n`,
    timeoutMs: clampInteger(request.timeoutMs ?? 120_000, 1_000, 300_000),
    maxOutputBytes: clampInteger(request.maxOutputBytes ?? 1_048_576, 4_096, 4_194_304),
  };
  const events: SanitizedInvocationEvent[] = [];
  const summary = await driver.invoke(plan, (line) => {
    if (events.length >= 256 || line.length > 65_536) return;
    const event = sanitizeAcpJsonLine(line);
    if (event) events.push(event);
  });
  return { ...summary, events };
}

export function sanitizeAcpJsonLine(line: string): SanitizedInvocationEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value) || containsSensitiveKey(value)) return null;
  if (value.type === 'text_delta' || value.type === 'result') {
    if (typeof value.text !== 'string' || value.text.length > 32_768 || CREDENTIAL_TEXT.test(value.text)) return null;
    return { type: value.type, text: value.text };
  }
  if (value.type === 'status') {
    if (!['starting', 'running', 'completed', 'failed'].includes(String(value.status))) return null;
    return { type: 'status', status: value.status as SanitizedInvocationEvent & never } as SanitizedInvocationEvent;
  }
  if (value.type === 'tool_call') {
    if (typeof value.id !== 'string' || typeof value.name !== 'string') return null;
    if (value.id.length > 128 || value.name.length > 128) return null;
    return { type: 'tool_call', id: value.id, name: value.name };
  }
  return null;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function containsSensitiveKey(value: unknown, depth = 0): boolean {
  if (depth > 12) return true;
  if (Array.isArray(value)) return value.some((entry) => containsSensitiveKey(entry, depth + 1));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([key, entry]) => SENSITIVE_KEY.test(key) || containsSensitiveKey(entry, depth + 1),
  );
}

function assertSafeExecutable(command: string, args: readonly string[]): void {
  if (!command || command.length > 512 || /[\0\r\n]/.test(command)) throw new Error('INVALID_EXECUTABLE');
  if (args.length > 64 || args.some((arg) => arg.length > 8_192 || /\0/.test(arg))) {
    throw new Error('INVALID_ARGUMENTS');
  }
}

function summarizeSpawnError(error: unknown): ProcessSummary['spawnError'] {
  if (isRecord(error) && error.code === 'ENOENT') return 'not_found';
  if (isRecord(error) && error.code === 'EINVAL') return 'unspawnable_shim';
  return 'failed';
}

export interface SpawnTarget {
  command: string;
  args: string[];
}

export interface SpawnTargetResolverEnv {
  platform: NodeJS.Platform;
  pathEnv: string | undefined;
  execPath: string;
  exists: (file: string) => boolean;
  readText: (file: string) => string;
}

const WINDOWS_NPM_SHIM_TARGET = /"%dp0%\\(node_modules\\[^"\r\n]+\.[cm]?js)"/;

/**
 * Windows executable resolution for `shell:false` spawns.
 *
 * `CreateProcess` resolves only `.exe`/`.com` — it never applies PATHEXT — so a bare npm bin
 * name (`claude-agent-acp`) is ENOENT. The `.cmd` shim cannot be used either: Node refuses to
 * spawn `.cmd`/`.bat` without `shell:true` (EINVAL). The only `shell:false` path is the shim's
 * own target: `node <dir>\node_modules\<pkg>\...\index.js`. This reads the npm-generated `.cmd`
 * on PATH, extracts that target, and rewrites the plan to `[execPath, entry, ...args]`.
 *
 * The rewrite is only applied when every step is unambiguous: bare name (no separators, no
 * extension), a `.cmd` found on PATH, a target matching npm's shim template, and the target
 * file existing. Otherwise the plan is returned unchanged and the OS error surfaces as-is.
 * A sibling `.exe` wins (CreateProcess would find it).
 */
export function resolveSpawnTarget(
  command: string,
  args: readonly string[],
  env: SpawnTargetResolverEnv = {
    platform: process.platform, pathEnv: process.env.PATH, execPath: process.execPath,
    exists: existsSync, readText: (file) => readFileSync(file, 'utf8'),
  },
): SpawnTarget {
  const unchanged: SpawnTarget = { command, args: [...args] };
  if (env.platform !== 'win32') return unchanged;
  if (/[\\/:]/.test(command) || path.win32.extname(command) !== '') return unchanged;
  for (const dir of (env.pathEnv ?? '').split(';').map((entry) => entry.trim()).filter(Boolean)) {
    if (env.exists(path.win32.join(dir, `${command}.exe`))) return unchanged;
    const shim = path.win32.join(dir, `${command}.cmd`);
    if (!env.exists(shim)) continue;
    let text: string;
    try { text = env.readText(shim); } catch { return unchanged; }
    const match = WINDOWS_NPM_SHIM_TARGET.exec(text);
    if (!match) return unchanged;
    const entry = path.win32.join(dir, match[1]!);
    if (!entry.startsWith(path.win32.join(dir, 'node_modules') + '\\') || !env.exists(entry)) return unchanged;
    return { command: env.execPath, args: [entry, ...args] };
  }
  return unchanged;
}

async function runProbe(plan: ProbePlan): Promise<ProcessSummary> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const target = resolveSpawnTarget(plan.command, plan.args);
    const child = spawn(target.command, target.args, {
      shell: false,
      windowsHide: true,
      env: buildSafeChildEnv(),
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const finish = (summary: ProcessSummary) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(summary);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, clampInteger(plan.timeoutMs, 250, 10_000));
    child.once('error', (error) => finish({
      exitCode: null,
      timedOut,
      outputLimitExceeded: false,
      spawnError: summarizeSpawnError(error),
    }));
    child.once('close', (exitCode) => finish({
      exitCode,
      timedOut,
      outputLimitExceeded: false,
      spawnError: null,
    }));
  });
}

async function runInvocation(
  plan: InvocationPlan,
  onStdoutLine: (line: string) => void,
): Promise<ProcessSummary> {
  if (plan.signal?.aborted) {
    return {
      exitCode: null,
      timedOut: false,
      outputLimitExceeded: false,
      spawnError: null,
      cancelled: true,
    };
  }
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let outputLimitExceeded = false;
    let cancelled = false;
    let closed = false;
    let spawnError: ProcessSummary['spawnError'] = null;
    let terminationStarted = false;
    let outputBytes = 0;
    let pending = '';
    const target = resolveSpawnTarget(plan.command, plan.args);
    // Both cwd and env MUST resolve against the identical env object -- see
    // resolveSubscriptionSpawnCwd's doc comment. Binding one local `source` (still defaulting to
    // process.env) rather than writing `process.env` at each call site independently removes the
    // possibility of the two calls silently drifting onto different roots if either is edited later.
    const source = process.env;
    const child = spawn(target.command, target.args, {
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      cwd: resolveSubscriptionSpawnCwd(plan.privateEnvironmentProfileId, source),
      env: buildSafeChildEnv(source, plan.privateEnvironmentProfileId),
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const finish = (summary: ProcessSummary) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      plan.signal?.removeEventListener('abort', abort);
      pending = '';
      resolve(summary);
    };
    const terminate = (reason: 'cancelled' | 'timeout' | 'output' | 'failed') => {
      if (settled || terminationStarted) return;
      terminationStarted = true;
      cancelled = reason === 'cancelled';
      timedOut = reason === 'timeout';
      outputLimitExceeded ||= reason === 'output';
      pending = '';
      void terminateProcessTree(child, () => closed).then((confirmed) => finish({
        exitCode: child.exitCode,
        timedOut,
        outputLimitExceeded,
        spawnError,
        ...(cancelled ? { cancelled: true } : {}),
        ...(!confirmed ? { terminationUnconfirmed: true } : {}),
      }));
    };
    const abort = () => terminate('cancelled');
    const timer = setTimeout(() => terminate('timeout'), plan.timeoutMs);
    plan.signal?.addEventListener('abort', abort, { once: true });
    if (plan.signal?.aborted) abort();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (terminationStarted || settled) return;
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > plan.maxOutputBytes) {
        outputLimitExceeded = true;
        pending = '';
        terminate('output');
        return;
      }
      pending += chunk;
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, '');
        pending = pending.slice(newline + 1);
        try {
          onStdoutLine(line);
        } catch {
          spawnError = 'failed';
          terminate('failed');
          return;
        }
        newline = pending.indexOf('\n');
      }
      if (pending.length > 65_536) {
        outputLimitExceeded = true;
        pending = '';
        terminate('output');
      }
    });
    child.once('error', (error) => {
      spawnError = summarizeSpawnError(error);
      if (terminationStarted) return;
      finish({ exitCode: null, timedOut, outputLimitExceeded, spawnError });
    });
    child.once('close', (exitCode) => {
      closed = true;
      if (terminationStarted) return;
      if (pending && !outputLimitExceeded) {
        try {
          onStdoutLine(pending.replace(/\r$/, ''));
        } catch {
          spawnError = 'failed';
        }
      }
      finish({ exitCode, timedOut, outputLimitExceeded, spawnError });
    });
    child.stdin.on('error', () => {
      if (terminationStarted || settled) return;
      spawnError = 'failed';
      terminate('failed');
    });
    child.stdin.end(plan.stdinJsonLine, 'utf8');
  });
}

async function openInteractive(
  plan: InteractiveInvocationPlan,
): Promise<SubscriptionProcessConnection> {
  if (plan.signal?.aborted) throw new Error('CANCELLED');
  const target = resolveSpawnTarget(plan.command, plan.args);
  // See runInvocation's matching comment: one local `source` (still defaulting to process.env)
  // feeds both calls so cwd and CLAUDE_CONFIG_DIR can never resolve against different roots.
  const source = process.env;
  const child = spawn(target.command, target.args, {
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
    cwd: resolveSubscriptionSpawnCwd(plan.privateEnvironmentProfileId, source),
    env: buildSafeChildEnv(source, plan.privateEnvironmentProfileId),
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let closed = false;
  let terminationStarted = false;
  let timedOut = false;
  let outputLimitExceeded = false;
  let cancelled = false;
  let spawnError: ProcessSummary['spawnError'] = null;
  let outputBytes = 0;
  let pending = '';
  const lines: string[] = [];
  const readers: Array<{ resolve: (line: string) => void; reject: (error: Error) => void }> = [];
  let resolveSummary!: (summary: ProcessSummary) => void;
  const summary = new Promise<ProcessSummary>((resolve) => { resolveSummary = resolve; });
  let summarySettled = false;
  const failReaders = (error: Error) => {
    while (readers.length > 0) readers.shift()!.reject(error);
  };
  const finish = (value: ProcessSummary) => {
    if (summarySettled) return;
    summarySettled = true;
    clearTimeout(timer);
    plan.signal?.removeEventListener('abort', abort);
    failReaders(new Error(value.cancelled ? 'CANCELLED' : 'PROVIDER_FAILED'));
    resolveSummary(value);
  };
  const terminate = (reason: 'cancelled' | 'timeout' | 'output' | 'failed') => {
    if (summarySettled || terminationStarted) return;
    terminationStarted = true;
    cancelled = reason === 'cancelled';
    timedOut = reason === 'timeout';
    outputLimitExceeded ||= reason === 'output';
    pending = '';
    failReaders(new Error(cancelled ? 'CANCELLED' : timedOut ? 'TIMED_OUT' : 'PROVIDER_FAILED'));
    void terminateProcessTree(child, () => closed).then((confirmed) => finish({
      exitCode: child.exitCode,
      timedOut,
      outputLimitExceeded,
      spawnError,
      ...(cancelled ? { cancelled: true } : {}),
      ...(!confirmed ? { terminationUnconfirmed: true } : {}),
    }));
  };
  const abort = () => terminate('cancelled');
  const timer = setTimeout(() => terminate('timeout'), plan.timeoutMs);
  plan.signal?.addEventListener('abort', abort, { once: true });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    if (terminationStarted || summarySettled) return;
    outputBytes += Buffer.byteLength(chunk);
    if (outputBytes > plan.maxOutputBytes) return terminate('output');
    pending += chunk;
    let newline = pending.indexOf('\n');
    while (newline >= 0) {
      const line = pending.slice(0, newline).replace(/\r$/, '');
      pending = pending.slice(newline + 1);
      const reader = readers.shift();
      if (reader) reader.resolve(line); else lines.push(line);
      newline = pending.indexOf('\n');
    }
    if (pending.length > 65_536) terminate('output');
  });
  child.once('error', (error) => {
    spawnError = summarizeSpawnError(error);
    finish({ exitCode: null, timedOut, outputLimitExceeded, spawnError });
  });
  child.once('close', (exitCode) => {
    closed = true;
    if (terminationStarted) return;
    if (pending) {
      const reader = readers.shift();
      if (reader) reader.resolve(pending.replace(/\r$/, '')); else lines.push(pending.replace(/\r$/, ''));
      pending = '';
    }
    finish({ exitCode, timedOut, outputLimitExceeded, spawnError });
  });
  child.stdin.on('error', () => {
    if (!terminationStarted && !summarySettled) terminate('failed');
  });
  if (plan.signal?.aborted) abort();

  return {
    async writeJsonLine(line) {
      if (terminationStarted || summarySettled || plan.signal?.aborted) throw new Error('CANCELLED');
      if (line.length > 65_536 || /[\r\n]/.test(line)) throw new Error('ACP_UNSAFE_FRAME');
      await new Promise<void>((resolve, reject) => {
        child.stdin.write(`${line}\n`, 'utf8', (error) => error ? reject(error) : resolve());
      });
    },
    async readLine() {
      const line = lines.shift();
      if (line !== undefined) return line;
      if (summarySettled) throw new Error(cancelled ? 'CANCELLED' : 'PROVIDER_FAILED');
      return new Promise<string>((resolve, reject) => readers.push({ resolve, reject }));
    },
    async stop() {
      if (!child.stdin.destroyed) child.stdin.end();
      return summary;
    },
  };
}

const TERMINATION_CONFIRMATION_MS = 2_000;

async function terminateProcessTree(child: ChildProcess, isClosed: () => boolean): Promise<boolean> {
  if (isClosed() || child.exitCode !== null || child.signalCode !== null) return true;
  const pid = child.pid;
  if (!pid) return false;
  let requested = false;
  if (process.platform === 'win32') {
    requested = await new Promise<boolean>((resolve) => {
      let settled = false;
      const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        shell: false,
        windowsHide: true,
        env: buildSafeChildEnv(),
        stdio: 'ignore',
      });
      const done = (value: boolean) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      killer.once('error', () => done(false));
      killer.once('close', (code) => done(code === 0 || isClosed()));
    });
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
      requested = true;
    } catch (error) {
      requested = isClosed()
        || (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH');
    }
  }
  if (!requested && !isClosed()) return false;
  if (isClosed()) return true;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (confirmed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('close', onClose);
      resolve(confirmed);
    };
    const onClose = () => done(true);
    const timer = setTimeout(() => done(isClosed()), TERMINATION_CONFIRMATION_MS);
    child.once('close', onClose);
    if (isClosed()) done(true);
  });
}

export const nodeSubscriptionProcessDriver: SubscriptionProcessDriver = {
  probe: runProbe,
  invoke: runInvocation,
  open: openInteractive,
};
