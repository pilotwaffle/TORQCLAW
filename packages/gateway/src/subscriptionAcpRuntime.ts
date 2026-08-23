import type { ProcessSummary, SubscriptionProcessConnection, SubscriptionProcessDriver } from './safeSubscriptionProcess.js';
import { assertSubscriptionPrivateEnvironment, nodeSubscriptionProcessDriver } from './safeSubscriptionProcess.js';
import {
  resolveSubscriptionAcpServer,
  type SubscriptionPrivateEnvironmentProfileId,
} from './subscriptionRuntimeCatalog.js';

const SECRET = /(?:authorization|cookie|credential|password|secret|token|api[_-]?key|Bearer\s+\S+)/i;
export type AcpAdmissionStage = 'probe' | 'spawn' | 'session' | 'model' | 'preprompt';
export type AcpLiveAdmission = (stage: AcpAdmissionStage) => boolean | Promise<boolean>;

let processDriverForTest: SubscriptionProcessDriver | null = null;

/** Test-only dependency injection at the provider process boundary. */
export function setSubscriptionProcessDriverForTest(driver: SubscriptionProcessDriver | null): void {
  processDriverForTest = driver;
}

function selectedProcessDriver(driver?: SubscriptionProcessDriver): SubscriptionProcessDriver {
  return driver ?? processDriverForTest ?? nodeSubscriptionProcessDriver;
}

export interface AcpProbeResult {
  providerId: string;
  modelId: string;
  exactModelId: string | null;
  runtimeFingerprint: string | null;
  status: 'connected' | 'missing' | 'unavailable';
}

type AcpFrame = Record<string, unknown>;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function parseStrictAcpFrame(line: string): AcpFrame {
  if (line.length > 65_536 || SECRET.test(line)) throw new Error('ACP_UNSAFE_FRAME');
  let value: unknown;
  try { value = JSON.parse(line); } catch { throw new Error('ACP_MALFORMED_FRAME'); }
  const frame = record(value);
  if (!frame || frame.jsonrpc !== '2.0') throw new Error('ACP_MALFORMED_FRAME');
  if (typeof frame.method === 'string') {
    if (frame.id !== undefined || frame.method !== 'session/update' || !record(frame.params)) {
      throw new Error('ACP_PROVIDER_REVERSE_REQUEST');
    }
    return frame;
  }
  if (typeof frame.id !== 'string' || (frame.error === undefined && !record(frame.result))) {
    throw new Error('ACP_MALFORMED_FRAME');
  }
  if (frame.error !== undefined) throw new Error('ACP_PROVIDER_FAILED');
  return frame;
}

function summaryOk(summary: ProcessSummary): boolean {
  return summary.exitCode === 0 && !summary.timedOut && !summary.outputLimitExceeded
    && !summary.cancelled && !summary.terminationUnconfirmed && summary.spawnError === null;
}

function initializeRequest(): AcpFrame {
  return {
    jsonrpc: '2.0', id: 'initialize', method: 'initialize',
    params: { protocolVersion: 1, clientInfo: { name: 'torqclaw', version: '1' }, clientCapabilities: {} },
  };
}

async function send(connection: SubscriptionProcessConnection, frame: AcpFrame): Promise<void> {
  await connection.writeJsonLine(JSON.stringify(frame));
}

async function response(
  connection: SubscriptionProcessConnection,
  id: string,
  onUpdate?: (frame: AcpFrame) => void,
): Promise<Record<string, unknown>> {
  for (;;) {
    const frame = parseStrictAcpFrame(await connection.readLine());
    if (frame.method === 'session/update') {
      if (!onUpdate) throw new Error('ACP_UNKNOWN_FRAME');
      onUpdate(frame);
      continue;
    }
    if (frame.id !== id) throw new Error('ACP_UNKNOWN_FRAME');
    return record(frame.result)!;
  }
}

type ModelConfig = { id: string; currentValue: string };

function exactModelConfig(result: Record<string, unknown>, exactModelId: string): ModelConfig {
  const options = Array.isArray(result.configOptions) ? result.configOptions : [];
  const models = options.map(record).filter((option): option is Record<string, unknown> => Boolean(option))
    .filter((option) => option.category === 'model' && option.type === 'select');
  if (models.length !== 1) throw new Error('ACP_MODEL_MISMATCH');
  const model = models[0]!;
  const values = (Array.isArray(model.options) ? model.options : [])
    .map(record).map((option) => option?.value)
    .filter((value): value is string => typeof value === 'string');
  if (typeof model.id !== 'string' || typeof model.currentValue !== 'string'
    || values.filter((value) => value === exactModelId).length !== 1) {
    throw new Error('ACP_MODEL_MISMATCH');
  }
  return { id: model.id, currentValue: model.currentValue };
}

async function openRuntime(
  driver: SubscriptionProcessDriver,
  command: string,
  args: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal,
  privateEnvironmentProfileId?: SubscriptionPrivateEnvironmentProfileId,
): Promise<SubscriptionProcessConnection> {
  assertSubscriptionPrivateEnvironment(privateEnvironmentProfileId);
  return driver.open({
    command, args, timeoutMs, maxOutputBytes: 1_048_576, signal, privateEnvironmentProfileId,
  });
}

async function initializeSession(connection: SubscriptionProcessConnection, cwd: string) {
  await send(connection, initializeRequest());
  await response(connection, 'initialize');
  await send(connection, {
    jsonrpc: '2.0', id: 'session', method: 'session/new', params: { cwd, mcpServers: [] },
  });
  const sessionResult = await response(connection, 'session');
  if (typeof sessionResult.sessionId !== 'string' || !sessionResult.sessionId.trim()
    || sessionResult.sessionId.length > 512) throw new Error('ACP_MALFORMED_FRAME');
  return { sessionId: sessionResult.sessionId, sessionResult };
}

async function pinExactModel(
  connection: SubscriptionProcessConnection,
  sessionId: string,
  sessionResult: Record<string, unknown>,
  exactModelId: string,
): Promise<void> {
  const advertised = exactModelConfig(sessionResult, exactModelId);
  if (advertised.currentValue === exactModelId) return;
  await send(connection, {
    jsonrpc: '2.0', id: 'model', method: 'session/set_config_option',
    params: { sessionId, configId: advertised.id, value: exactModelId },
  });
  const selected = exactModelConfig(await response(connection, 'model'), exactModelId);
  if (selected.id !== advertised.id || selected.currentValue !== exactModelId) {
    throw new Error('ACP_MODEL_MISMATCH');
  }
}

export async function probeAcpSubscriptionRuntime(
  providerId: string,
  modelId: string,
  driver?: SubscriptionProcessDriver,
  admit: AcpLiveAdmission = () => true,
  signal?: AbortSignal,
): Promise<AcpProbeResult> {
  const runtime = resolveSubscriptionAcpServer(providerId, modelId);
  if (!runtime) return { providerId, modelId, exactModelId: null, runtimeFingerprint: null, status: 'unavailable' };
  if (!await admit('probe')) return {
    providerId, modelId, exactModelId: null, runtimeFingerprint: runtime.runtimeFingerprint, status: 'unavailable',
  };
  let connection: SubscriptionProcessConnection | undefined;
  try {
    connection = await openRuntime(
      // Readiness covers spawn + initialize + session/new + set_config; claude-agent-acp alone
      // takes ~4s to answer initialize on Windows (measured 2026-08-22), so 8s was too tight.
      selectedProcessDriver(driver), runtime.command, runtime.args, Math.min(runtime.timeoutMs, 15_000), signal,
      runtime.privateEnvironmentProfileId,
    );
    const { sessionResult } = await initializeSession(connection, process.env.TEMP ?? process.env.TMP ?? process.cwd());
    const config = exactModelConfig(sessionResult, runtime.exactModelId);
    if (config.currentValue !== runtime.exactModelId) throw new Error('ACP_MODEL_MISMATCH');
    const summary = await connection.stop();
    return {
      providerId, modelId,
      exactModelId: summaryOk(summary) ? runtime.exactModelId : null,
      runtimeFingerprint: runtime.runtimeFingerprint,
      status: summaryOk(summary) ? 'connected' : summary.spawnError === 'not_found' ? 'missing' : 'unavailable',
    };
  } catch {
    const summary = connection ? await connection.stop().catch(() => null) : null;
    return {
      providerId, modelId, exactModelId: null, runtimeFingerprint: runtime.runtimeFingerprint,
      status: summary?.spawnError === 'not_found' ? 'missing' : 'unavailable',
    };
  }
}

export async function executeAcpSubscriptionTurn(input: {
  providerId: string;
  modelId: string;
  runtimeFingerprint: string;
  prompt: string;
  cwd: string;
  signal?: AbortSignal;
  driver?: SubscriptionProcessDriver;
  admit?: AcpLiveAdmission;
}): Promise<{ text: string; exactModelId: string; runtimeFingerprint: string }> {
  const runtime = resolveSubscriptionAcpServer(input.providerId, input.modelId);
  if (!runtime || runtime.runtimeFingerprint !== input.runtimeFingerprint) throw new Error('ACP_RUNTIME_BINDING_MISMATCH');
  const admit = input.admit ?? (() => true);
  if (input.signal?.aborted) throw new Error('CANCELLED');
  if (!await admit('spawn')) throw new Error('ACP_LIVE_ADMISSION_REFUSED');
  const connection = await openRuntime(
    selectedProcessDriver(input.driver), runtime.command, runtime.args, runtime.timeoutMs, input.signal,
    runtime.privateEnvironmentProfileId,
  );
  try {
    if (!await admit('session')) throw new Error('ACP_LIVE_ADMISSION_REFUSED');
    const { sessionId, sessionResult } = await initializeSession(connection, input.cwd);
    if (!await admit('model')) throw new Error('ACP_LIVE_ADMISSION_REFUSED');
    await pinExactModel(connection, sessionId, sessionResult, runtime.exactModelId);
    if (!await admit('preprompt')) throw new Error('ACP_LIVE_ADMISSION_REFUSED');
    await send(connection, {
      jsonrpc: '2.0', id: 'prompt', method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: input.prompt }] },
    });
    const chunks: string[] = [];
    const promptResult = await response(connection, 'prompt', (frame) => {
      const params = record(frame.params);
      const update = record(params?.update);
      const content = record(update?.content);
      if (params?.sessionId !== sessionId || update?.sessionUpdate !== 'agent_message_chunk'
        || content?.type !== 'text' || typeof content.text !== 'string'
        || content.text.length > 32_768 || SECRET.test(content.text)) throw new Error('ACP_UNSAFE_FRAME');
      chunks.push(content.text);
    });
    if (promptResult.stopReason !== 'end_turn') throw new Error('PROVIDER_FAILED');
    const summary = await connection.stop();
    if (summary.terminationUnconfirmed) throw new Error('TERMINATION_UNCONFIRMED');
    if (summary.cancelled || input.signal?.aborted) throw new Error('CANCELLED');
    if (!summaryOk(summary)) throw new Error(summary.timedOut ? 'TIMED_OUT' : 'PROVIDER_FAILED');
    const text = chunks.join('').trim();
    if (!text || text.length > 32_768 || SECRET.test(text)) throw new Error('UNSAFE_OUTPUT');
    return { text, exactModelId: runtime.exactModelId, runtimeFingerprint: runtime.runtimeFingerprint };
  } catch (error) {
    const summary = await connection.stop().catch(() => null);
    if (summary?.terminationUnconfirmed) throw new Error('TERMINATION_UNCONFIRMED');
    if (summary?.cancelled || input.signal?.aborted) throw new Error('CANCELLED');
    throw error;
  }
}
