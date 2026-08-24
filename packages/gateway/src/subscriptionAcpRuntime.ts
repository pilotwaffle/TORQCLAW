import type { ProcessSummary, SubscriptionProcessConnection, SubscriptionProcessDriver } from './safeSubscriptionProcess.js';
import {
  assertSubscriptionPrivateEnvironment,
  CREDENTIAL_TEXT,
  nodeSubscriptionProcessDriver,
  SENSITIVE_RESULT_KEY,
} from './safeSubscriptionProcess.js';
import {
  resolveSubscriptionAcpServer,
  type SubscriptionAcpServerBinding,
  type SubscriptionModelAttestation,
  type SubscriptionPrivateEnvironmentProfileId,
} from './subscriptionRuntimeCatalog.js';

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
  /**
   * What this probe (or the binding, when the probe failed before reaching the point of
   * knowing) can honestly claim about the served model. Present for every binding, not just
   * alias-bearing ones, so callers never have to special-case zai to read this field.
   */
  modelAttestation: SubscriptionModelAttestation | null;
}

type AcpFrame = Record<string, unknown>;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/**
 * Recursively scans an already-PARSED value's string leaves for credential-shaped text
 * (`CREDENTIAL_TEXT`, shared with safeSubscriptionProcess.ts's sanitizeAcpJsonLine). Depth-capped
 * defensively; frames this runtime accepts at all are already size-capped upstream.
 *
 * Callers apply this ONLY to values this runtime actually consumes (JSON-RPC results/errors it
 * reads fields from, agent_message_chunk text) -- never to the raw line and never to benign
 * `session/update` kinds that are dropped and counted without inspection (PRD-007 Item B
 * correction 2). Scanning only consumed values, with a credential-SHAPED pattern instead of a
 * bare keyword, is what lets a real `available_commands_update` frame's slash-command prose (or a
 * usage_update's `inputTokens`/`outputTokens` field names) pass, while a stray `token=abc123` or
 * `sk-...` value anywhere inside a consumed result still fails closed.
 */
function assertNoConsumedCredentialText(value: unknown, depth = 0): void {
  if (depth > 16) throw new Error('ACP_UNSAFE_FRAME');
  if (typeof value === 'string') {
    if (CREDENTIAL_TEXT.test(value)) throw new Error('ACP_UNSAFE_FRAME');
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertNoConsumedCredentialText(entry, depth + 1);
    return;
  }
  const rec = record(value);
  if (!rec) return;
  for (const [key, entry] of Object.entries(rec)) {
    // Structured JSON-RPC result/error payloads have no legitimate reason to carry a field
    // literally named `token`/`secret`/`apiKey`/etc: this is a key-based check (independent of the
    // value's own shape), unlike the prose scanned in agent_message_chunk / available_commands_update.
    if (SENSITIVE_RESULT_KEY.test(key)) throw new Error('ACP_UNSAFE_FRAME');
    assertNoConsumedCredentialText(entry, depth + 1);
  }
}

export function parseStrictAcpFrame(line: string): AcpFrame {
  if (line.length > 65_536) throw new Error('ACP_UNSAFE_FRAME');
  let value: unknown;
  try { value = JSON.parse(line); } catch { throw new Error('ACP_MALFORMED_FRAME'); }
  const frame = record(value);
  if (!frame || frame.jsonrpc !== '2.0') throw new Error('ACP_MALFORMED_FRAME');
  if (typeof frame.method === 'string') {
    if (frame.id !== undefined) {
      // An agent->client JSON-RPC REQUEST (has both `id` and `method`): session/request_permission,
      // fs/read_text_file, fs/write_text_file, terminal/* etc. This is a real, expected shape from
      // the live claude-agent-acp adapter whenever the wrapped SDK's tool loop reaches a permission
      // check or a filesystem/terminal tool -- it is not itself unsafe, so parsing does not throw
      // here. response() is the only caller with a connection to answer it, so it decides how
      // (deny permission / method-not-found for fs+terminal+anything else) -- see there for why.
      //
      // JSON-RPC 2.0 legally allows either a string or a number `id` on a request (never object,
      // array, or null -- the spec reserves `null` for "id unknown", not for a real request id).
      // `answerReverseRequest` echoes this value verbatim into the id field of its `-32601` reply
      // (and into the allow/deny result id for session/request_permission), so a non-scalar id
      // here would be echoed back onto the wire unvalidated. Failing closed on anything other than
      // string|number keeps that echo inside the JSON-RPC contract in both directions.
      if (
        (typeof frame.id !== 'string' && typeof frame.id !== 'number')
        || !record(frame.params)
      ) throw new Error('ACP_MALFORMED_FRAME');
      return frame;
    }
    if (frame.method !== 'session/update' || !record(frame.params)) {
      throw new Error('ACP_UNKNOWN_FRAME');
    }
    // NOTE: no credential scan here. This may be a benign, never-consumed session/update kind
    // (usage_update, available_commands_update, current_mode_update, agent_thought_chunk, plan);
    // the caller (response()'s onUpdate) applies a scan only to the kinds it actually reads
    // content from (agent_message_chunk), using assertNoConsumedCredentialText below.
    return frame;
  }
  if (typeof frame.id !== 'string' || (frame.error === undefined && !record(frame.result))) {
    throw new Error('ACP_MALFORMED_FRAME');
  }
  if (frame.error !== undefined) {
    // The error payload is consumed (surfaced in ACP_PROVIDER_FAILED handling / logs), so it gets
    // the same targeted scan as a successful result -- a credential-shaped value here still fails
    // closed, just as ACP_UNSAFE_FRAME rather than being allowed to propagate as provider text.
    assertNoConsumedCredentialText(frame.error);
    throw new Error('ACP_PROVIDER_FAILED');
  }
  assertNoConsumedCredentialText(frame.result);
  return frame;
}

/**
 * JSON-RPC method names the real claude-agent-acp v0.64.2 adapter uses for agent->client
 * requests (@agentclientprotocol/sdk dist/schema/index.js CLIENT_METHODS, verified against the
 * installed v0.64.2 binary 2026-08-23). `session/request_permission` is answered with a DENY
 * outcome (never auto-approved -- CLAUDE.md core invariant 5: write-capable tools require human
 * approval, and no human is attached to this unattended subscription turn). `fs/*` and
 * `terminal/*` are answered with a JSON-RPC "method not supported" error and the action is NEVER
 * performed -- this runtime has no file/terminal backing to serve them safely, and serving them
 * would hand the adapter a live filesystem/process channel with no approval gate at all.
 */
const FS_OR_TERMINAL_REVERSE_METHODS = new Set([
  'fs/read_text_file',
  'fs/write_text_file',
  'terminal/create',
  'terminal/output',
  'terminal/release',
  'terminal/wait_for_exit',
  'terminal/kill',
]);

/**
 * Closed set of optionId values that are DENY-shaped in the real claude-agent-acp v0.64.2 adapter
 * (dist/acp-agent.js:3622-3651 for `session/request_permission`'s allow/deny read; :3577-3582 for
 * ExitPlanMode's plan-mode options). The adapter decides allow-vs-deny purely by `optionId` string
 * (:3651 reads `'allow'|'allow_always'` as approvals; ExitPlanMode reads `'default'|'acceptEdits'|
 * 'auto'|'bypassPermissions'` as approvals), so an untrusted option object claiming a deny-shaped
 * `kind` (`reject_once`/`reject_always`) can still carry an ALLOW-shaped `optionId` -- e.g.
 * `{kind:'reject_once', optionId:'allow'}` -- and naively echoing that `optionId` back would make
 * this client SELECT ALLOW while believing it denied. Only an optionId in this DENY allowlist may
 * ever be echoed; anything else (including every known ALLOW id) falls back to `cancelled`.
 */
const DENY_SHAPED_OPTION_IDS = new Set(['reject', 'reject_once', 'reject_always', 'plan']);

/**
 * Builds the ACP-shaped deny response for `session/request_permission`
 * (dist/acp-agent.js:3622-3625: the adapter offers `{kind:'reject_once', optionId:'reject'}`
 * among its options and reads `response.outcome.outcome === 'selected' && optionId === 'reject'`
 * as a normal deny -- distinct from `outcome:'cancelled'`, which the adapter treats as an aborted
 * tool use rather than a considered no). Selecting the offered reject option keeps this a real
 * deny decision rather than an abort, matching how a human clicking "Deny" behaves -- but the
 * option's `optionId` is untrusted input from the child process and is validated against the
 * closed DENY allowlist above before being echoed. A `kind`-flagged reject option whose optionId
 * is NOT in that allowlist (whether it's unrecognized or, worse, one of the adapter's known ALLOW
 * ids) is never selected -- this falls back to `cancelled`, which the adapter treats as "no
 * decision", never as an approval. Never select allow.
 */
function denyPermissionResult(frame: AcpFrame): Record<string, unknown> {
  const params = record(frame.params);
  const options = Array.isArray(params?.options) ? params.options : [];
  const rejectOption = options.map(record).find((option) =>
    option?.kind === 'reject_once' || option?.kind === 'reject_always' || option?.optionId === 'reject');
  if (rejectOption && typeof rejectOption.optionId === 'string' && DENY_SHAPED_OPTION_IDS.has(rejectOption.optionId)) {
    return { outcome: { outcome: 'selected', optionId: rejectOption.optionId } };
  }
  return { outcome: { outcome: 'cancelled' } };
}

/**
 * Answers one agent->client reverse request in place on the wire and reports what kind it was,
 * for the caller to count in `ignoredKinds`. Never performs the requested action -- fs/terminal
 * requests get a JSON-RPC error, exactly like any other unrecognized request method; only
 * session/request_permission gets a considered (deny) ACP result, because that is the one method
 * with a defined "no" outcome shape the adapter understands.
 */
async function answerReverseRequest(connection: SubscriptionProcessConnection, frame: AcpFrame): Promise<string> {
  const id = frame.id;
  if (frame.method === 'session/request_permission') {
    await send(connection, { jsonrpc: '2.0', id, result: denyPermissionResult(frame) });
    return 'request_permission_denied';
  }
  const method = typeof frame.method === 'string' ? frame.method : 'unknown';
  await send(connection, {
    jsonrpc: '2.0', id,
    error: { code: -32601, message: `Method not found: ${method}`, data: { method } },
  });
  return FS_OR_TERMINAL_REVERSE_METHODS.has(method) ? `${method}_denied` : 'unknown_request_denied';
}

/**
 * `session/update` kinds the real claude-agent-acp v0.64.2 adapter is known to interleave with
 * `agent_message_chunk` during a normal turn (PRD-007 Item B correction 1). These carry no text
 * content this runtime consumes, so they are dropped and counted rather than causing the turn to
 * fail closed. Everything else -- including `tool_call` / `tool_call_update`, which must never
 * appear for a `vendorBuiltInTools:false` zai binding -- keeps throwing ACP_UNSAFE_FRAME.
 */
const BENIGN_SESSION_UPDATE_KINDS = new Set([
  'usage_update',
  'available_commands_update',
  'current_mode_update',
  'agent_thought_chunk',
  'plan',
]);

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

/**
 * Default `session/update` handling for callers (handshake / model-pin / preprompt-check) that
 * have no interest in streamed content and pass no `onUpdate` of their own. The real adapter can
 * interleave a benign, content-free notification (observed live: `available_commands_update`
 * arriving while waiting on a `session/set_config_option` echo -- 2026-08-23) at ANY point in the
 * session, not only during `session/prompt`'s stream. Before this, any `session/update` with no
 * caller-supplied `onUpdate` failed the whole turn closed via ACP_UNKNOWN_FRAME even though the
 * exact same kind is already proven benign and allowlisted for the prompt stream. Dropping the
 * already-allowlisted kinds here (and still failing closed on anything else, `tool_call` /
 * `tool_call_update` included) makes that allowlist apply everywhere a `response()` wait can
 * overlap with adapter chatter, not only inside the prompt loop.
 *
 * `sessionId` is the session this wait is scoped to, when one has already been minted (`undefined`
 * during the `initialize`/`session/new` handshake calls, before any sessionId exists to compare
 * against). When present, a benign-kind frame carrying any OTHER sessionId still fails closed with
 * ACP_UNSAFE_FRAME -- matching the scoping already enforced by the prompt-stream `onUpdate` closure
 * in `executeAcpSubscriptionTurn`, so a session-scoping bypass cannot slip in through this, the
 * only other path that drops (rather than fails on) a benign frame.
 */
function dropBenignSessionUpdate(frame: AcpFrame, sessionId: string | undefined): void {
  const params = record(frame.params);
  const update = params ? record(params.update) : null;
  if (!update || typeof update.sessionUpdate !== 'string' || !BENIGN_SESSION_UPDATE_KINDS.has(update.sessionUpdate)) {
    throw new Error('ACP_UNKNOWN_FRAME');
  }
  if (sessionId !== undefined && params?.sessionId !== sessionId) throw new Error('ACP_UNSAFE_FRAME');
}

async function response(
  connection: SubscriptionProcessConnection,
  id: string,
  sessionId?: string,
  onUpdate?: (frame: AcpFrame) => void,
  onReverseRequest?: (kind: string) => void,
): Promise<Record<string, unknown>> {
  for (;;) {
    const frame = parseStrictAcpFrame(await connection.readLine());
    if (typeof frame.method === 'string' && frame.id !== undefined) {
      // Agent->client JSON-RPC REQUEST (session/request_permission, fs/*, terminal/*, or any other
      // method the adapter decides to ask). Always answered in place -- deny for permission,
      // method-not-found for everything else -- and the stream continues; the action requested is
      // NEVER performed. Reported to the caller as an ignoredKinds count (mirroring the benign
      // session/update bookkeeping), which executeAcpSubscriptionTurn returns and
      // subscriptionAgentRuntime.ts/dispatch.ts thread onto the turn's RESULT telemetry (PRD-007
      // packet Item C-1) -- so what was denied is now visible on the completed turn's evidence,
      // not merely computed and discarded.
      const kind = await answerReverseRequest(connection, frame);
      onReverseRequest?.(kind);
      continue;
    }
    if (frame.method === 'session/update') {
      if (onUpdate) onUpdate(frame); else dropBenignSessionUpdate(frame, sessionId);
      continue;
    }
    if (frame.id !== id) throw new Error('ACP_UNKNOWN_FRAME');
    return record(frame.result)!;
  }
}

type ModelConfig = { id: string; currentValue: string };

/**
 * Resolves the advertised model config, and the identifier this binding accepts as "pinned".
 *
 * For every binding except the one carrying `advertisedAlias` (scoped to the literal
 * `zai-anthropic-glm-5.3-v1` profile at the type level -- see subscriptionRuntimeCatalog.ts),
 * this is verbatim: the exact vendor model id must appear among the advertised `options`, and
 * `length !== 1` / not-found behavior is unchanged from before this alias support existed.
 *
 * For the alias-bearing binding, the advertised `options` are the adapter's own alias set
 * (the real claude-agent-acp v0.64.2 advertises exactly `[default, opus, sonnet, haiku]` -- see
 * T-6 in tests/subscription-alias-binding.test.ts) and never contain `exactModelId`
 * (`glm-5.3`) at all -- so the acceptance check runs against `advertisedAlias` instead, and the
 * function returns which identifier is actually pinned (`acceptedValue`) so downstream code
 * never has to know it isn't the exact model id string.
 */
function exactModelConfig(
  result: Record<string, unknown>,
  runtime: Pick<SubscriptionAcpServerBinding, 'exactModelId' | 'advertisedAlias'>,
): ModelConfig & { acceptedValue: string } {
  const options = Array.isArray(result.configOptions) ? result.configOptions : [];
  const models = options.map(record).filter((option): option is Record<string, unknown> => Boolean(option))
    .filter((option) => option.category === 'model' && option.type === 'select');
  if (models.length !== 1) throw new Error('ACP_MODEL_MISMATCH');
  const model = models[0]!;
  const values = (Array.isArray(model.options) ? model.options : [])
    .map(record).map((option) => option?.value)
    .filter((value): value is string => typeof value === 'string');
  const acceptedValue = runtime.advertisedAlias ?? runtime.exactModelId;
  if (typeof model.id !== 'string' || typeof model.currentValue !== 'string'
    || values.filter((value) => value === acceptedValue).length !== 1) {
    throw new Error('ACP_MODEL_MISMATCH');
  }
  return { id: model.id, currentValue: model.currentValue, acceptedValue };
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
  // No sessionId exists yet at either handshake step -- session/new's result is what mints one --
  // so `dropBenignSessionUpdate` is given `undefined` and skips the sessionId-match check here.
  await response(connection, 'initialize', undefined);
  await send(connection, {
    jsonrpc: '2.0', id: 'session', method: 'session/new', params: { cwd, mcpServers: [] },
  });
  const sessionResult = await response(connection, 'session', undefined);
  if (typeof sessionResult.sessionId !== 'string' || !sessionResult.sessionId.trim()
    || sessionResult.sessionId.length > 512) throw new Error('ACP_MALFORMED_FRAME');
  return { sessionId: sessionResult.sessionId, sessionResult };
}

/**
 * Sets (or re-asserts) the config option to `acceptedValue` and verifies the echoed result.
 * ACP has no read-only "get current config" call, only `session/set_config_option`, which both
 * sets and returns the resulting state (claude-agent-acp treats re-asserting an already-current
 * value as a harmless no-op / SDK-drift repair -- dist/acp-agent.js:3297). Re-sending it is
 * therefore also the only honest way to confirm the pin still holds later.
 */
async function assertConfigOption(
  connection: SubscriptionProcessConnection,
  sessionId: string,
  requestId: string,
  configId: string,
  acceptedValue: string,
  runtime: SubscriptionAcpServerBinding,
): Promise<void> {
  await send(connection, {
    jsonrpc: '2.0', id: requestId, method: 'session/set_config_option',
    params: { sessionId, configId, value: acceptedValue },
  });
  const selected = exactModelConfig(await response(connection, requestId, sessionId), runtime);
  if (selected.id !== configId || selected.currentValue !== acceptedValue) {
    throw new Error('ACP_MODEL_MISMATCH');
  }
}

async function pinExactModel(
  connection: SubscriptionProcessConnection,
  sessionId: string,
  sessionResult: Record<string, unknown>,
  runtime: SubscriptionAcpServerBinding,
): Promise<{ configId: string; acceptedValue: string }> {
  const advertised = exactModelConfig(sessionResult, runtime);
  if (advertised.currentValue !== advertised.acceptedValue) {
    await assertConfigOption(connection, sessionId, 'model', advertised.id, advertised.acceptedValue, runtime);
  }
  return { configId: advertised.id, acceptedValue: advertised.acceptedValue };
}

/**
 * Pre-prompt re-check (PRD-007 Item B step 4 / packet B-3): immediately before `session/prompt`,
 * re-asserts the pinned value and confirms the echo still matches. Runs for every binding, not
 * only the alias-bearing one, so a config that drifted between pin and prompt (operator action,
 * adapter default reset, etc.) fails closed the same way everywhere, before any commit
 * (dispatch.ts:430 / taskStore.complete never sees a mismatched turn).
 */
async function revalidatePinnedModel(
  connection: SubscriptionProcessConnection,
  sessionId: string,
  pinned: { configId: string; acceptedValue: string },
  runtime: SubscriptionAcpServerBinding,
): Promise<void> {
  await assertConfigOption(connection, sessionId, 'preprompt-check', pinned.configId, pinned.acceptedValue, runtime);
}

export async function probeAcpSubscriptionRuntime(
  providerId: string,
  modelId: string,
  driver?: SubscriptionProcessDriver,
  admit: AcpLiveAdmission = () => true,
  signal?: AbortSignal,
): Promise<AcpProbeResult> {
  const runtime = resolveSubscriptionAcpServer(providerId, modelId);
  if (!runtime) {
    return {
      providerId, modelId, exactModelId: null, runtimeFingerprint: null,
      status: 'unavailable', modelAttestation: null,
    };
  }
  const modelAttestation = runtime.modelAttestation ?? 'adapter_verbatim';
  if (!await admit('probe')) {
    return {
      providerId, modelId, exactModelId: null, runtimeFingerprint: runtime.runtimeFingerprint,
      status: 'unavailable', modelAttestation,
    };
  }
  let connection: SubscriptionProcessConnection | undefined;
  try {
    connection = await openRuntime(
      // Readiness covers spawn + initialize + session/new + set_config; claude-agent-acp alone
      // takes ~4s to answer initialize on Windows (measured 2026-08-22), so 8s was too tight.
      selectedProcessDriver(driver), runtime.command, runtime.args, Math.min(runtime.timeoutMs, 15_000), signal,
      runtime.privateEnvironmentProfileId,
    );
    const { sessionId, sessionResult } = await initializeSession(
      connection, process.env.TEMP ?? process.env.TMP ?? process.cwd(),
    );
    const config = exactModelConfig(sessionResult, runtime);
    if (runtime.advertisedAlias !== undefined) {
      // Alias bindings must be actively pinned during readiness too -- the adapter's own
      // 'default' currentValue is not an acceptable resting state for a "connected" probe.
      await pinExactModel(connection, sessionId, sessionResult, runtime);
    } else if (config.currentValue !== runtime.exactModelId) {
      throw new Error('ACP_MODEL_MISMATCH');
    }
    const summary = await connection.stop();
    return {
      providerId, modelId,
      exactModelId: summaryOk(summary) ? runtime.exactModelId : null,
      runtimeFingerprint: runtime.runtimeFingerprint,
      status: summaryOk(summary) ? 'connected' : summary.spawnError === 'not_found' ? 'missing' : 'unavailable',
      modelAttestation,
    };
  } catch {
    const summary = connection ? await connection.stop().catch(() => null) : null;
    return {
      providerId, modelId, exactModelId: null, runtimeFingerprint: runtime.runtimeFingerprint,
      status: summary?.spawnError === 'not_found' ? 'missing' : 'unavailable',
      modelAttestation,
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
}): Promise<{
  text: string;
  exactModelId: string;
  runtimeFingerprint: string;
  /**
   * Sanitized counts of benign `session/update` kinds dropped during the prompt, PLUS any
   * agent->client reverse requests answered and denied during the prompt (kind names only --
   * `request_permission_denied`, `fs/read_text_file_denied`, `terminal/create_denied`, etc.).
   *
   * This return value alone does not put anything on the wire or in the event log -- it is
   * threaded onward by callers: subscriptionAgentRuntime.ts's executeSubscriptionAgentTurn
   * passes it through verbatim, and dispatch.ts's success-path telemetry object (PRD-007 packet
   * Item C-1) is what actually lands it on the emitted RESULT frame / persisted event log. Before
   * that dispatch.ts wiring existed, this field was computed correctly but silently dropped
   * before reaching any turn's evidence -- do not assume "returned here" means "visible to an
   * operator" without checking the caller chain still threads it through.
   */
  ignoredKinds: Record<string, number>;
}> {
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
    const pinned = await pinExactModel(connection, sessionId, sessionResult, runtime);
    if (!await admit('preprompt')) throw new Error('ACP_LIVE_ADMISSION_REFUSED');
    await revalidatePinnedModel(connection, sessionId, pinned, runtime);
    await send(connection, {
      jsonrpc: '2.0', id: 'prompt', method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: input.prompt }] },
    });
    const chunks: string[] = [];
    const ignoredKinds: Record<string, number> = {};
    const promptResult = await response(connection, 'prompt', sessionId, (frame) => {
      const params = record(frame.params);
      const update = record(params?.update);
      if (params?.sessionId !== sessionId || !update || typeof update.sessionUpdate !== 'string') {
        throw new Error('ACP_UNSAFE_FRAME');
      }
      if (update.sessionUpdate === 'agent_message_chunk') {
        const content = record(update.content);
        if (content?.type !== 'text' || typeof content.text !== 'string'
          || content.text.length > 32_768 || CREDENTIAL_TEXT.test(content.text)) throw new Error('ACP_UNSAFE_FRAME');
        chunks.push(content.text);
        return;
      }
      // Benign, content-bearing kinds the real adapter interleaves (usage/available-commands/
      // mode/thought/plan): dropped and counted. Anything else -- tool_call / tool_call_update
      // included, which must never appear for a vendorBuiltInTools:false zai binding -- still
      // fails closed.
      if (!BENIGN_SESSION_UPDATE_KINDS.has(update.sessionUpdate)) throw new Error('ACP_UNSAFE_FRAME');
      ignoredKinds[update.sessionUpdate] = (ignoredKinds[update.sessionUpdate] ?? 0) + 1;
    }, (kind) => {
      ignoredKinds[kind] = (ignoredKinds[kind] ?? 0) + 1;
    });
    if (promptResult.stopReason !== 'end_turn') throw new Error('PROVIDER_FAILED');
    const summary = await connection.stop();
    if (summary.terminationUnconfirmed) throw new Error('TERMINATION_UNCONFIRMED');
    if (summary.cancelled || input.signal?.aborted) throw new Error('CANCELLED');
    if (!summaryOk(summary)) throw new Error(summary.timedOut ? 'TIMED_OUT' : 'PROVIDER_FAILED');
    const text = chunks.join('').trim();
    if (!text || text.length > 32_768 || CREDENTIAL_TEXT.test(text)) throw new Error('UNSAFE_OUTPUT');
    return { text, exactModelId: runtime.exactModelId, runtimeFingerprint: runtime.runtimeFingerprint, ignoredKinds };
  } catch (error) {
    const summary = await connection.stop().catch(() => null);
    if (summary?.terminationUnconfirmed) throw new Error('TERMINATION_UNCONFIRMED');
    if (summary?.cancelled || input.signal?.aborted) throw new Error('CANCELLED');
    throw error;
  }
}
