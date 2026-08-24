import { describe, expect, it } from 'vitest';
import { resolveSubscriptionAcpServer } from '../packages/gateway/src/subscriptionRuntimeCatalog.js';
import { executeAcpSubscriptionTurn, parseStrictAcpFrame } from '../packages/gateway/src/subscriptionAcpRuntime.js';
import type { ProcessSummary, SubscriptionProcessDriver } from '../packages/gateway/src/safeSubscriptionProcess.js';

/**
 * PRD-007 Item B correction 1: the real claude-agent-acp v0.64.2 interleaves benign
 * `session/update` kinds (usage_update, available_commands_update, current_mode_update,
 * agent_thought_chunk, plan) alongside `agent_message_chunk` during a normal turn. Before this
 * fix, subscriptionAcpRuntime.ts's `response()` onUpdate callback threw ACP_UNSAFE_FRAME on any
 * sessionUpdate kind other than `agent_message_chunk`, so a live turn against the real adapter
 * would fail closed on the very frames it normally sends. These tests are RED against the
 * pre-fix code (they exercise the exact benign-kind branch that did not exist) and green after.
 */

const ok: ProcessSummary = { exitCode: 0, timedOut: false, outputLimitExceeded: false, spawnError: null };

function aliasConfig(currentValue: string) {
  // Real adapter's advertised alias set is 4 values (default/opus/sonnet/haiku) -- see T-6.
  return [{
    id: 'model', category: 'model', type: 'select', currentValue,
    options: [
      { value: 'default', name: 'Default' },
      { value: 'opus', name: 'Opus' },
      { value: 'sonnet', name: 'Sonnet' },
      { value: 'haiku', name: 'Haiku' },
    ],
  }];
}

function interactiveDriver(
  onWrite: (frame: Record<string, any>, emit: (frame: unknown) => void) => void,
  summary: ProcessSummary = ok,
): { driver: SubscriptionProcessDriver; writes: Record<string, any>[] } {
  const writes: Record<string, any>[] = [];
  const lines: string[] = [];
  const readers: Array<(line: string) => void> = [];
  const emit = (frame: unknown) => {
    const line = JSON.stringify(frame);
    const reader = readers.shift();
    if (reader) reader(line); else lines.push(line);
  };
  return {
    writes,
    driver: {
      async probe() { return ok; },
      async invoke() { return ok; },
      async open() {
        return {
          async writeJsonLine(line) {
            const frame = JSON.parse(line);
            writes.push(frame);
            onWrite(frame, emit);
          },
          async readLine() {
            return lines.shift() ?? new Promise<string>((resolve) => readers.push(resolve));
          },
          async stop() { return summary; },
        };
      },
    },
  };
}

function sessionUpdate(sessionId: string, update: Record<string, unknown>) {
  return { jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } };
}

/** Standard init/session/pin/preprompt-check handshake shared by every test in this file. */
function handshake(
  frame: Record<string, any>,
  emit: (frame: unknown) => void,
  sessionId: string,
): boolean {
  if (frame.id === 'initialize') { emit({ jsonrpc: '2.0', id: 'initialize', result: {} }); return true; }
  if (frame.id === 'session') {
    emit({ jsonrpc: '2.0', id: 'session', result: { sessionId, configOptions: aliasConfig('opus') } });
    return true;
  }
  if (frame.id === 'preprompt-check') {
    emit({ jsonrpc: '2.0', id: 'preprompt-check', result: { configOptions: aliasConfig('opus') } });
    return true;
  }
  return false;
}

describe('subscription ACP runtime: benign session/update kinds during a live turn', () => {
  it('interleaved benign frames (usage_update, available_commands_update, current_mode_update, agent_thought_chunk, plan) are dropped and counted; the turn completes with the chunk text', async () => {
    const runtime = resolveSubscriptionAcpServer('zai-subscription', 'glm-5.3')!;
    const sessionId = 'benign-session';
    const { driver } = interactiveDriver((frame, emit) => {
      if (handshake(frame, emit, sessionId)) return;
      if (frame.id === 'prompt') {
        // The ACP-conventional usage_update shape carries fields like inputTokens/outputTokens;
        // this is benign, un-consumed field-name text, not a credential value, so it passes
        // straight through the benign-kind allowlist below with no special-casing needed.
        emit(sessionUpdate(sessionId, { sessionUpdate: 'usage_update', usage: { inputTokens: 12, outputTokens: 34 } }));
        emit(sessionUpdate(sessionId, { sessionUpdate: 'available_commands_update', availableCommands: [] }));
        emit(sessionUpdate(sessionId, { sessionUpdate: 'current_mode_update', currentModeId: 'default' }));
        emit(sessionUpdate(sessionId, {
          sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking...' },
        }));
        emit(sessionUpdate(sessionId, { sessionUpdate: 'plan', entries: [] }));
        emit(sessionUpdate(sessionId, {
          sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'GLM53_OK' },
        }));
        emit({ jsonrpc: '2.0', id: 'prompt', result: { stopReason: 'end_turn' } });
      }
    });
    const saved = process.env.GLM_API_KEY;
    process.env.GLM_API_KEY = 'test-only';
    try {
      const result = await executeAcpSubscriptionTurn({
        providerId: runtime.providerId, modelId: runtime.exactModelId,
        runtimeFingerprint: runtime.runtimeFingerprint, prompt: 'hi', cwd: 'C:\\safe', driver,
      });
      expect(result.text).toBe('GLM53_OK');
      expect(result.ignoredKinds).toEqual({
        usage_update: 1,
        available_commands_update: 1,
        current_mode_update: 1,
        agent_thought_chunk: 1,
        plan: 1,
      });
    } finally {
      if (saved === undefined) delete process.env.GLM_API_KEY; else process.env.GLM_API_KEY = saved;
    }
  });

  it('an unknown sessionUpdate kind still fails closed with ACP_UNSAFE_FRAME', async () => {
    const runtime = resolveSubscriptionAcpServer('zai-subscription', 'glm-5.3')!;
    const sessionId = 'unknown-kind-session';
    const { driver } = interactiveDriver((frame, emit) => {
      if (handshake(frame, emit, sessionId)) return;
      if (frame.id === 'prompt') {
        emit(sessionUpdate(sessionId, { sessionUpdate: 'some_future_kind_not_yet_allowlisted' }));
      }
    });
    const saved = process.env.GLM_API_KEY;
    process.env.GLM_API_KEY = 'test-only';
    try {
      await expect(executeAcpSubscriptionTurn({
        providerId: runtime.providerId, modelId: runtime.exactModelId,
        runtimeFingerprint: runtime.runtimeFingerprint, prompt: 'hi', cwd: 'C:\\safe', driver,
      })).rejects.toThrow('ACP_UNSAFE_FRAME');
    } finally {
      if (saved === undefined) delete process.env.GLM_API_KEY; else process.env.GLM_API_KEY = saved;
    }
  });

  it('a tool_call session/update fails closed with ACP_UNSAFE_FRAME (vendorBuiltInTools:false; a tool call from the adapter is unexpected)', async () => {
    const runtime = resolveSubscriptionAcpServer('zai-subscription', 'glm-5.3')!;
    const sessionId = 'tool-call-session';
    const { driver } = interactiveDriver((frame, emit) => {
      if (handshake(frame, emit, sessionId)) return;
      if (frame.id === 'prompt') {
        emit(sessionUpdate(sessionId, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'exec' }));
      }
    });
    const saved = process.env.GLM_API_KEY;
    process.env.GLM_API_KEY = 'test-only';
    try {
      await expect(executeAcpSubscriptionTurn({
        providerId: runtime.providerId, modelId: runtime.exactModelId,
        runtimeFingerprint: runtime.runtimeFingerprint, prompt: 'hi', cwd: 'C:\\safe', driver,
      })).rejects.toThrow('ACP_UNSAFE_FRAME');
    } finally {
      if (saved === undefined) delete process.env.GLM_API_KEY; else process.env.GLM_API_KEY = saved;
    }
  });

  it('a tool_call_update session/update fails closed with ACP_UNSAFE_FRAME', async () => {
    const runtime = resolveSubscriptionAcpServer('zai-subscription', 'glm-5.3')!;
    const sessionId = 'tool-call-update-session';
    const { driver } = interactiveDriver((frame, emit) => {
      if (handshake(frame, emit, sessionId)) return;
      if (frame.id === 'prompt') {
        emit(sessionUpdate(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' }));
      }
    });
    const saved = process.env.GLM_API_KEY;
    process.env.GLM_API_KEY = 'test-only';
    try {
      await expect(executeAcpSubscriptionTurn({
        providerId: runtime.providerId, modelId: runtime.exactModelId,
        runtimeFingerprint: runtime.runtimeFingerprint, prompt: 'hi', cwd: 'C:\\safe', driver,
      })).rejects.toThrow('ACP_UNSAFE_FRAME');
    } finally {
      if (saved === undefined) delete process.env.GLM_API_KEY; else process.env.GLM_API_KEY = saved;
    }
  });

  it('a 10KB available_commands_update whose prose contains the word "token" is dropped and the turn completes (PRD-007 Item B correction 2: pre-fix this threw ACP_UNSAFE_FRAME from the raw-line SECRET scan in parseStrictAcpFrame before the benign-kind allowlist ever ran)', async () => {
    const runtime = resolveSubscriptionAcpServer('zai-subscription', 'glm-5.3')!;
    const sessionId = 'benign-large-session';
    // Slash-command listing prose mentioning "token" in a benign, non-credential sense (as the
    // real adapter's command descriptions do), padded to ~10KB.
    const commandDescription =
      'Use this command to check your remaining token budget for the session. '.repeat(150);
    const { driver } = interactiveDriver((frame, emit) => {
      if (handshake(frame, emit, sessionId)) return;
      if (frame.id === 'prompt') {
        emit(sessionUpdate(sessionId, {
          sessionUpdate: 'available_commands_update',
          availableCommands: [{ name: 'usage', description: commandDescription }],
        }));
        emit(sessionUpdate(sessionId, {
          sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'GLM53_OK' },
        }));
        emit({ jsonrpc: '2.0', id: 'prompt', result: { stopReason: 'end_turn' } });
      }
    });
    const saved = process.env.GLM_API_KEY;
    process.env.GLM_API_KEY = 'test-only';
    try {
      expect(commandDescription.length).toBeGreaterThan(10_000);
      const result = await executeAcpSubscriptionTurn({
        providerId: runtime.providerId, modelId: runtime.exactModelId,
        runtimeFingerprint: runtime.runtimeFingerprint, prompt: 'hi', cwd: 'C:\\safe', driver,
      });
      expect(result.text).toBe('GLM53_OK');
      expect(result.ignoredKinds).toEqual({ available_commands_update: 1 });
    } finally {
      if (saved === undefined) delete process.env.GLM_API_KEY; else process.env.GLM_API_KEY = saved;
    }
  });

  it('an agent_message_chunk containing benign prose "tokens remaining" passes through (credential-SHAPED scan, not a bare keyword match)', async () => {
    const runtime = resolveSubscriptionAcpServer('zai-subscription', 'glm-5.3')!;
    const sessionId = 'prose-tokens-session';
    const { driver } = interactiveDriver((frame, emit) => {
      if (handshake(frame, emit, sessionId)) return;
      if (frame.id === 'prompt') {
        emit(sessionUpdate(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'You have 42 tokens remaining in this session.' },
        }));
        emit({ jsonrpc: '2.0', id: 'prompt', result: { stopReason: 'end_turn' } });
      }
    });
    const saved = process.env.GLM_API_KEY;
    process.env.GLM_API_KEY = 'test-only';
    try {
      const result = await executeAcpSubscriptionTurn({
        providerId: runtime.providerId, modelId: runtime.exactModelId,
        runtimeFingerprint: runtime.runtimeFingerprint, prompt: 'hi', cwd: 'C:\\safe', driver,
      });
      expect(result.text).toBe('You have 42 tokens remaining in this session.');
    } finally {
      if (saved === undefined) delete process.env.GLM_API_KEY; else process.env.GLM_API_KEY = saved;
    }
  });

  it('an agent_message_chunk containing a Bearer token still throws ACP_UNSAFE_FRAME', async () => {
    const runtime = resolveSubscriptionAcpServer('zai-subscription', 'glm-5.3')!;
    const sessionId = 'bearer-leak-session';
    const { driver } = interactiveDriver((frame, emit) => {
      if (handshake(frame, emit, sessionId)) return;
      if (frame.id === 'prompt') {
        emit(sessionUpdate(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Here is your header: Bearer abcdefghij1234' },
        }));
        emit({ jsonrpc: '2.0', id: 'prompt', result: { stopReason: 'end_turn' } });
      }
    });
    const saved = process.env.GLM_API_KEY;
    process.env.GLM_API_KEY = 'test-only';
    try {
      await expect(executeAcpSubscriptionTurn({
        providerId: runtime.providerId, modelId: runtime.exactModelId,
        runtimeFingerprint: runtime.runtimeFingerprint, prompt: 'hi', cwd: 'C:\\safe', driver,
      })).rejects.toThrow('ACP_UNSAFE_FRAME');
    } finally {
      if (saved === undefined) delete process.env.GLM_API_KEY; else process.env.GLM_API_KEY = saved;
    }
  });

  it('an agent_message_chunk containing an api_key=sk-... value still throws ACP_UNSAFE_FRAME', async () => {
    const runtime = resolveSubscriptionAcpServer('zai-subscription', 'glm-5.3')!;
    const sessionId = 'apikey-leak-session';
    const { driver } = interactiveDriver((frame, emit) => {
      if (handshake(frame, emit, sessionId)) return;
      if (frame.id === 'prompt') {
        emit(sessionUpdate(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'api_key=sk-abcdefghijklmnopqrst' },
        }));
        emit({ jsonrpc: '2.0', id: 'prompt', result: { stopReason: 'end_turn' } });
      }
    });
    const saved = process.env.GLM_API_KEY;
    process.env.GLM_API_KEY = 'test-only';
    try {
      await expect(executeAcpSubscriptionTurn({
        providerId: runtime.providerId, modelId: runtime.exactModelId,
        runtimeFingerprint: runtime.runtimeFingerprint, prompt: 'hi', cwd: 'C:\\safe', driver,
      })).rejects.toThrow('ACP_UNSAFE_FRAME');
    } finally {
      if (saved === undefined) delete process.env.GLM_API_KEY; else process.env.GLM_API_KEY = saved;
    }
  });

  it('a JSON-RPC error result containing a credential-shaped value throws ACP_UNSAFE_FRAME', async () => {
    const runtime = resolveSubscriptionAcpServer('zai-subscription', 'glm-5.3')!;
    const sessionId = 'error-credential-session';
    const { driver } = interactiveDriver((frame, emit) => {
      if (handshake(frame, emit, sessionId)) return;
      if (frame.id === 'prompt') {
        emit({
          jsonrpc: '2.0', id: 'prompt',
          error: { code: -32000, message: 'upstream rejected credential: api_key=sk-abcdefghijklmnop' },
        });
      }
    });
    const saved = process.env.GLM_API_KEY;
    process.env.GLM_API_KEY = 'test-only';
    try {
      await expect(executeAcpSubscriptionTurn({
        providerId: runtime.providerId, modelId: runtime.exactModelId,
        runtimeFingerprint: runtime.runtimeFingerprint, prompt: 'hi', cwd: 'C:\\safe', driver,
      })).rejects.toThrow('ACP_UNSAFE_FRAME');
    } finally {
      if (saved === undefined) delete process.env.GLM_API_KEY; else process.env.GLM_API_KEY = saved;
    }
  });

  it('a benign-kind frame for a different sessionId still fails closed (sessionId scoping is not weakened)', async () => {
    const runtime = resolveSubscriptionAcpServer('zai-subscription', 'glm-5.3')!;
    const sessionId = 'scoped-session';
    const { driver } = interactiveDriver((frame, emit) => {
      if (handshake(frame, emit, sessionId)) return;
      if (frame.id === 'prompt') {
        emit(sessionUpdate('some-other-session', { sessionUpdate: 'usage_update', usage: {} }));
      }
    });
    const saved = process.env.GLM_API_KEY;
    process.env.GLM_API_KEY = 'test-only';
    try {
      await expect(executeAcpSubscriptionTurn({
        providerId: runtime.providerId, modelId: runtime.exactModelId,
        runtimeFingerprint: runtime.runtimeFingerprint, prompt: 'hi', cwd: 'C:\\safe', driver,
      })).rejects.toThrow('ACP_UNSAFE_FRAME');
    } finally {
      if (saved === undefined) delete process.env.GLM_API_KEY; else process.env.GLM_API_KEY = saved;
    }
  });

  it('B-2: a benign-kind session/update with a MISMATCHED sessionId during the default (non-prompt-stream) wait still fails closed with ACP_UNSAFE_FRAME', async () => {
    // The default `dropBenignSessionUpdate` handler (used by every response() wait outside the
    // prompt stream -- initialize/session/new/set_config_option/preprompt-check) previously
    // dropped ANY benign-kind frame with no regard for which session it claimed to belong to, even
    // though the sibling prompt-stream onUpdate closure already enforced `params.sessionId ===
    // sessionId`. This is RED against the pre-fix code (a mismatched-session benign frame here was
    // silently dropped, not rejected) and green after (dropBenignSessionUpdate now takes the
    // in-scope sessionId and throws ACP_UNSAFE_FRAME on a mismatch, once one exists to check
    // against).
    const runtime = resolveSubscriptionAcpServer('zai-subscription', 'glm-5.3')!;
    const sessionId = 'default-wait-scoped-session';
    const { driver } = interactiveDriver((frame, emit) => {
      if (frame.id === 'initialize') { emit({ jsonrpc: '2.0', id: 'initialize', result: {} }); return; }
      if (frame.id === 'session') {
        emit({ jsonrpc: '2.0', id: 'session', result: { sessionId, configOptions: aliasConfig('opus') } });
        return;
      }
      if (frame.id === 'preprompt-check') {
        // Interleave a benign-kind frame for a DIFFERENT session immediately before the real
        // preprompt-check echo -- this is the wait that uses the default onUpdate handler.
        emit(sessionUpdate('some-other-session', { sessionUpdate: 'usage_update', usage: {} }));
        emit({ jsonrpc: '2.0', id: 'preprompt-check', result: { configOptions: aliasConfig('opus') } });
      }
    });
    const saved = process.env.GLM_API_KEY;
    process.env.GLM_API_KEY = 'test-only';
    try {
      await expect(executeAcpSubscriptionTurn({
        providerId: runtime.providerId, modelId: runtime.exactModelId,
        runtimeFingerprint: runtime.runtimeFingerprint, prompt: 'hi', cwd: 'C:\\safe', driver,
      })).rejects.toThrow('ACP_UNSAFE_FRAME');
    } finally {
      if (saved === undefined) delete process.env.GLM_API_KEY; else process.env.GLM_API_KEY = saved;
    }
  });
});

/**
 * Agent->client JSON-RPC REQUESTS interleaved during a live turn (PRD-007 defect: `response()`
 * previously threw ACP_PROVIDER_REVERSE_REQUEST / ACP_UNKNOWN_FRAME on any id+method frame,
 * crashing the whole turn the moment the wrapped Claude Agent SDK reached a permission check or a
 * fs/terminal tool -- which it can do on an ordinary prompt, not just an adversarial one, since
 * bypassPermissions is not this runtime's mode). These tests are RED against the pre-fix code
 * (which has no id+method request-answering branch at all in response()/parseStrictAcpFrame) and
 * green after: every reverse request must be answered in place -- deny for permission,
 * method-not-found for everything else -- the requested action must NEVER be performed, and the
 * turn must still complete normally afterward.
 */
describe('subscription ACP runtime: agent->client reverse requests during a live turn', () => {
  it('an interleaved session/request_permission request gets a deny response and the turn completes with the chunk text', async () => {
    const runtime = resolveSubscriptionAcpServer('zai-subscription', 'glm-5.3')!;
    const sessionId = 'permission-session';
    const permissionResponses: Record<string, unknown>[] = [];
    const { driver } = interactiveDriver((frame, emit) => {
      if (handshake(frame, emit, sessionId)) return;
      if (frame.id === 'permission-request') {
        permissionResponses.push(frame);
        return;
      }
      if (frame.id === 'prompt') {
        emit({
          jsonrpc: '2.0', id: 'permission-request', method: 'session/request_permission',
          params: {
            sessionId,
            options: [
              { kind: 'reject_once', name: 'Deny', optionId: 'reject' },
              { kind: 'allow_once', name: 'Allow Once', optionId: 'allow' },
              { kind: 'allow_always', name: 'Always Allow', optionId: 'allow_always' },
            ],
            toolCall: { toolCallId: 't1', rawInput: {}, title: 'exec', kind: 'execute' },
          },
        });
        emit(sessionUpdate(sessionId, {
          sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'GLM53_OK' },
        }));
        emit({ jsonrpc: '2.0', id: 'prompt', result: { stopReason: 'end_turn' } });
      }
    });
    const saved = process.env.GLM_API_KEY;
    process.env.GLM_API_KEY = 'test-only';
    try {
      const result = await executeAcpSubscriptionTurn({
        providerId: runtime.providerId, modelId: runtime.exactModelId,
        runtimeFingerprint: runtime.runtimeFingerprint, prompt: 'hi', cwd: 'C:\\safe', driver,
      });
      expect(result.text).toBe('GLM53_OK');
      expect(result.ignoredKinds).toEqual({ request_permission_denied: 1 });
      // Never auto-approved: the client must select the offered reject option, not allow/allow_always.
      expect(permissionResponses).toHaveLength(1);
      expect(permissionResponses[0]).toEqual({
        jsonrpc: '2.0', id: 'permission-request',
        result: { outcome: { outcome: 'selected', optionId: 'reject' } },
      });
    } finally {
      if (saved === undefined) delete process.env.GLM_API_KEY; else process.env.GLM_API_KEY = saved;
    }
  });

  it('a session/request_permission request with no reject option falls back to a cancelled outcome (never selects allow/allow_always)', async () => {
    const runtime = resolveSubscriptionAcpServer('zai-subscription', 'glm-5.3')!;
    const sessionId = 'permission-no-reject-session';
    const permissionResponses: Record<string, unknown>[] = [];
    const { driver } = interactiveDriver((frame, emit) => {
      if (handshake(frame, emit, sessionId)) return;
      if (frame.id === 'permission-request') {
        permissionResponses.push(frame);
        return;
      }
      if (frame.id === 'prompt') {
        emit({
          jsonrpc: '2.0', id: 'permission-request', method: 'session/request_permission',
          params: {
            sessionId,
            options: [{ kind: 'allow_once', name: 'Allow Once', optionId: 'allow' }],
            toolCall: { toolCallId: 't1', rawInput: {}, title: 'exec', kind: 'execute' },
          },
        });
        emit(sessionUpdate(sessionId, {
          sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'GLM53_OK' },
        }));
        emit({ jsonrpc: '2.0', id: 'prompt', result: { stopReason: 'end_turn' } });
      }
    });
    const saved = process.env.GLM_API_KEY;
    process.env.GLM_API_KEY = 'test-only';
    try {
      const result = await executeAcpSubscriptionTurn({
        providerId: runtime.providerId, modelId: runtime.exactModelId,
        runtimeFingerprint: runtime.runtimeFingerprint, prompt: 'hi', cwd: 'C:\\safe', driver,
      });
      expect(result.text).toBe('GLM53_OK');
      expect(permissionResponses[0]).toEqual({
        jsonrpc: '2.0', id: 'permission-request', result: { outcome: { outcome: 'cancelled' } },
      });
    } finally {
      if (saved === undefined) delete process.env.GLM_API_KEY; else process.env.GLM_API_KEY = saved;
    }
  });

  it('B-1: a reject-kind option carrying the ALLOW optionId "allow" is NEVER selected -- falls back to cancelled (fail-open regression guard)', async () => {
    // Before the B-1 fix, denyPermissionResult() found the option by `kind` (reject_once/
    // reject_always) OR `optionId === 'reject'`, then echoed that option's optionId VERBATIM with
    // no validation. An adversarial or buggy child process offering
    // {kind:'reject_once', optionId:'allow'} would be matched by `kind`, and its optionId --
    // 'allow', one of the real adapter's own ALLOW ids (dist/acp-agent.js:3651) -- would be sent
    // straight back as `{outcome:{outcome:'selected', optionId:'allow'}}`, which the adapter reads
    // as an approval. This is RED against the pre-fix code (it selects 'allow') and green after
    // (DENY_SHAPED_OPTION_IDS rejects the untrusted optionId and falls back to cancelled).
    const runtime = resolveSubscriptionAcpServer('zai-subscription', 'glm-5.3')!;
    const sessionId = 'permission-poisoned-optionid-session';
    const permissionResponses: Record<string, unknown>[] = [];
    const { driver } = interactiveDriver((frame, emit) => {
      if (handshake(frame, emit, sessionId)) return;
      if (frame.id === 'permission-request') {
        permissionResponses.push(frame);
        return;
      }
      if (frame.id === 'prompt') {
        emit({
          jsonrpc: '2.0', id: 'permission-request', method: 'session/request_permission',
          params: {
            sessionId,
            options: [{ kind: 'reject_once', name: 'Deny (poisoned)', optionId: 'allow' }],
            toolCall: { toolCallId: 't1', rawInput: {}, title: 'exec', kind: 'execute' },
          },
        });
        emit(sessionUpdate(sessionId, {
          sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'GLM53_OK' },
        }));
        emit({ jsonrpc: '2.0', id: 'prompt', result: { stopReason: 'end_turn' } });
      }
    });
    const saved = process.env.GLM_API_KEY;
    process.env.GLM_API_KEY = 'test-only';
    try {
      const result = await executeAcpSubscriptionTurn({
        providerId: runtime.providerId, modelId: runtime.exactModelId,
        runtimeFingerprint: runtime.runtimeFingerprint, prompt: 'hi', cwd: 'C:\\safe', driver,
      });
      expect(result.text).toBe('GLM53_OK');
      expect(permissionResponses).toHaveLength(1);
      expect(permissionResponses[0]).toEqual({
        jsonrpc: '2.0', id: 'permission-request', result: { outcome: { outcome: 'cancelled' } },
      });
      expect(permissionResponses[0]).not.toEqual(
        expect.objectContaining({ result: { outcome: { outcome: 'selected', optionId: 'allow' } } }),
      );
    } finally {
      if (saved === undefined) delete process.env.GLM_API_KEY; else process.env.GLM_API_KEY = saved;
    }
  });

  it('B-1: a reject-kind option carrying the real deny optionId "reject" is still selected normally', async () => {
    const runtime = resolveSubscriptionAcpServer('zai-subscription', 'glm-5.3')!;
    const sessionId = 'permission-real-reject-session';
    const permissionResponses: Record<string, unknown>[] = [];
    const { driver } = interactiveDriver((frame, emit) => {
      if (handshake(frame, emit, sessionId)) return;
      if (frame.id === 'permission-request') {
        permissionResponses.push(frame);
        return;
      }
      if (frame.id === 'prompt') {
        emit({
          jsonrpc: '2.0', id: 'permission-request', method: 'session/request_permission',
          params: {
            sessionId,
            options: [{ kind: 'reject_once', name: 'Deny', optionId: 'reject' }],
            toolCall: { toolCallId: 't1', rawInput: {}, title: 'exec', kind: 'execute' },
          },
        });
        emit(sessionUpdate(sessionId, {
          sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'GLM53_OK' },
        }));
        emit({ jsonrpc: '2.0', id: 'prompt', result: { stopReason: 'end_turn' } });
      }
    });
    const saved = process.env.GLM_API_KEY;
    process.env.GLM_API_KEY = 'test-only';
    try {
      const result = await executeAcpSubscriptionTurn({
        providerId: runtime.providerId, modelId: runtime.exactModelId,
        runtimeFingerprint: runtime.runtimeFingerprint, prompt: 'hi', cwd: 'C:\\safe', driver,
      });
      expect(result.text).toBe('GLM53_OK');
      expect(permissionResponses[0]).toEqual({
        jsonrpc: '2.0', id: 'permission-request',
        result: { outcome: { outcome: 'selected', optionId: 'reject' } },
      });
    } finally {
      if (saved === undefined) delete process.env.GLM_API_KEY; else process.env.GLM_API_KEY = saved;
    }
  });

  it('B-1: an option list containing ONLY allow-shaped options (no reject/kind match) falls back to cancelled', async () => {
    const runtime = resolveSubscriptionAcpServer('zai-subscription', 'glm-5.3')!;
    const sessionId = 'permission-only-allow-session';
    const permissionResponses: Record<string, unknown>[] = [];
    const { driver } = interactiveDriver((frame, emit) => {
      if (handshake(frame, emit, sessionId)) return;
      if (frame.id === 'permission-request') {
        permissionResponses.push(frame);
        return;
      }
      if (frame.id === 'prompt') {
        emit({
          jsonrpc: '2.0', id: 'permission-request', method: 'session/request_permission',
          params: {
            sessionId,
            options: [
              { kind: 'allow_once', name: 'Allow Once', optionId: 'allow' },
              { kind: 'allow_always', name: 'Always Allow', optionId: 'allow_always' },
            ],
            toolCall: { toolCallId: 't1', rawInput: {}, title: 'exec', kind: 'execute' },
          },
        });
        emit(sessionUpdate(sessionId, {
          sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'GLM53_OK' },
        }));
        emit({ jsonrpc: '2.0', id: 'prompt', result: { stopReason: 'end_turn' } });
      }
    });
    const saved = process.env.GLM_API_KEY;
    process.env.GLM_API_KEY = 'test-only';
    try {
      const result = await executeAcpSubscriptionTurn({
        providerId: runtime.providerId, modelId: runtime.exactModelId,
        runtimeFingerprint: runtime.runtimeFingerprint, prompt: 'hi', cwd: 'C:\\safe', driver,
      });
      expect(result.text).toBe('GLM53_OK');
      expect(permissionResponses[0]).toEqual({
        jsonrpc: '2.0', id: 'permission-request', result: { outcome: { outcome: 'cancelled' } },
      });
    } finally {
      if (saved === undefined) delete process.env.GLM_API_KEY; else process.env.GLM_API_KEY = saved;
    }
  });

  it('B-1 (property-style): over a small enumeration of option lists, the emitted optionId is never in the known ALLOW set', async () => {
    const KNOWN_ALLOW_IDS = ['allow', 'allow_always', 'auto', 'acceptEdits', 'bypassPermissions', 'default'];
    const optionListEnumeration: Array<Array<{ kind: string; optionId: string }>> = [
      [{ kind: 'reject_once', optionId: 'allow' }],
      [{ kind: 'reject_once', optionId: 'allow_always' }],
      [{ kind: 'reject_once', optionId: 'auto' }],
      [{ kind: 'reject_once', optionId: 'acceptEdits' }],
      [{ kind: 'reject_once', optionId: 'bypassPermissions' }],
      [{ kind: 'reject_once', optionId: 'default' }],
      [{ kind: 'reject_always', optionId: 'allow' }],
      [{ kind: 'reject_once', optionId: 'reject' }],
      [{ kind: 'allow_once', optionId: 'allow' }],
      [{ kind: 'reject_once', optionId: 'some_unrecognized_id' }],
    ];
    const saved = process.env.GLM_API_KEY;
    process.env.GLM_API_KEY = 'test-only';
    try {
      for (const options of optionListEnumeration) {
        const runtime = resolveSubscriptionAcpServer('zai-subscription', 'glm-5.3')!;
        const sessionId = `property-session-${JSON.stringify(options)}`;
        const permissionResponses: Record<string, unknown>[] = [];
        const { driver } = interactiveDriver((frame, emit) => {
          if (handshake(frame, emit, sessionId)) return;
          if (frame.id === 'permission-request') {
            permissionResponses.push(frame);
            return;
          }
          if (frame.id === 'prompt') {
            emit({
              jsonrpc: '2.0', id: 'permission-request', method: 'session/request_permission',
              params: {
                sessionId,
                options: options.map((o) => ({ ...o, name: o.optionId })),
                toolCall: { toolCallId: 't1', rawInput: {}, title: 'exec', kind: 'execute' },
              },
            });
            emit(sessionUpdate(sessionId, {
              sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'GLM53_OK' },
            }));
            emit({ jsonrpc: '2.0', id: 'prompt', result: { stopReason: 'end_turn' } });
          }
        });
        // eslint-disable-next-line no-await-in-loop
        await executeAcpSubscriptionTurn({
          providerId: runtime.providerId, modelId: runtime.exactModelId,
          runtimeFingerprint: runtime.runtimeFingerprint, prompt: 'hi', cwd: 'C:\\safe', driver,
        });
        const result = permissionResponses[0]!.result as { outcome?: { outcome?: string; optionId?: string } };
        const outcome = result.outcome;
        if (outcome?.outcome === 'selected') {
          expect(KNOWN_ALLOW_IDS).not.toContain(outcome.optionId);
        } else {
          expect(outcome?.outcome).toBe('cancelled');
        }
      }
    } finally {
      if (saved === undefined) delete process.env.GLM_API_KEY; else process.env.GLM_API_KEY = saved;
    }
  });

  it('an interleaved fs/read_text_file request gets a method-not-supported error response and NO file is read', async () => {
    const runtime = resolveSubscriptionAcpServer('zai-subscription', 'glm-5.3')!;
    const sessionId = 'fs-read-session';
    let fsRequestAnswered: Record<string, unknown> | null = null;
    const { driver } = interactiveDriver((frame, emit) => {
      if (handshake(frame, emit, sessionId)) return;
      if (frame.id === 'fs-request') {
        fsRequestAnswered = frame;
        return;
      }
      if (frame.id === 'prompt') {
        emit({
          jsonrpc: '2.0', id: 'fs-request', method: 'fs/read_text_file',
          params: { sessionId, path: 'C:\\safe\\secret.txt' },
        });
        emit(sessionUpdate(sessionId, {
          sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'GLM53_OK' },
        }));
        emit({ jsonrpc: '2.0', id: 'prompt', result: { stopReason: 'end_turn' } });
      }
    });
    const saved = process.env.GLM_API_KEY;
    process.env.GLM_API_KEY = 'test-only';
    try {
      const result = await executeAcpSubscriptionTurn({
        providerId: runtime.providerId, modelId: runtime.exactModelId,
        runtimeFingerprint: runtime.runtimeFingerprint, prompt: 'hi', cwd: 'C:\\safe', driver,
      });
      expect(result.text).toBe('GLM53_OK');
      expect(result.ignoredKinds).toEqual({ 'fs/read_text_file_denied': 1 });
      // Answered with a JSON-RPC error, not a result -- no file content is ever returned/read.
      expect(fsRequestAnswered).toEqual({
        jsonrpc: '2.0', id: 'fs-request',
        error: { code: -32601, message: 'Method not found: fs/read_text_file', data: { method: 'fs/read_text_file' } },
      });
    } finally {
      if (saved === undefined) delete process.env.GLM_API_KEY; else process.env.GLM_API_KEY = saved;
    }
  });

  it('an interleaved fs/write_text_file request gets a method-not-supported error response', async () => {
    const runtime = resolveSubscriptionAcpServer('zai-subscription', 'glm-5.3')!;
    const sessionId = 'fs-write-session';
    let fsRequestAnswered: Record<string, unknown> | null = null;
    const { driver } = interactiveDriver((frame, emit) => {
      if (handshake(frame, emit, sessionId)) return;
      if (frame.id === 'fs-request') {
        fsRequestAnswered = frame;
        return;
      }
      if (frame.id === 'prompt') {
        emit({
          jsonrpc: '2.0', id: 'fs-request', method: 'fs/write_text_file',
          params: { sessionId, path: 'C:\\safe\\out.txt', content: 'x' },
        });
        emit(sessionUpdate(sessionId, {
          sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'GLM53_OK' },
        }));
        emit({ jsonrpc: '2.0', id: 'prompt', result: { stopReason: 'end_turn' } });
      }
    });
    const saved = process.env.GLM_API_KEY;
    process.env.GLM_API_KEY = 'test-only';
    try {
      const result = await executeAcpSubscriptionTurn({
        providerId: runtime.providerId, modelId: runtime.exactModelId,
        runtimeFingerprint: runtime.runtimeFingerprint, prompt: 'hi', cwd: 'C:\\safe', driver,
      });
      expect(result.text).toBe('GLM53_OK');
      expect(result.ignoredKinds).toEqual({ 'fs/write_text_file_denied': 1 });
      expect(fsRequestAnswered).toMatchObject({ jsonrpc: '2.0', id: 'fs-request', error: { code: -32601 } });
    } finally {
      if (saved === undefined) delete process.env.GLM_API_KEY; else process.env.GLM_API_KEY = saved;
    }
  });

  it('an interleaved terminal/create request gets a method-not-supported error response', async () => {
    const runtime = resolveSubscriptionAcpServer('zai-subscription', 'glm-5.3')!;
    const sessionId = 'terminal-session';
    let terminalRequestAnswered: Record<string, unknown> | null = null;
    const { driver } = interactiveDriver((frame, emit) => {
      if (handshake(frame, emit, sessionId)) return;
      if (frame.id === 'terminal-request') {
        terminalRequestAnswered = frame;
        return;
      }
      if (frame.id === 'prompt') {
        emit({
          jsonrpc: '2.0', id: 'terminal-request', method: 'terminal/create',
          params: { sessionId, command: 'whoami', args: [] },
        });
        emit(sessionUpdate(sessionId, {
          sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'GLM53_OK' },
        }));
        emit({ jsonrpc: '2.0', id: 'prompt', result: { stopReason: 'end_turn' } });
      }
    });
    const saved = process.env.GLM_API_KEY;
    process.env.GLM_API_KEY = 'test-only';
    try {
      const result = await executeAcpSubscriptionTurn({
        providerId: runtime.providerId, modelId: runtime.exactModelId,
        runtimeFingerprint: runtime.runtimeFingerprint, prompt: 'hi', cwd: 'C:\\safe', driver,
      });
      expect(result.text).toBe('GLM53_OK');
      expect(result.ignoredKinds).toEqual({ 'terminal/create_denied': 1 });
      expect(terminalRequestAnswered).toMatchObject({ jsonrpc: '2.0', id: 'terminal-request', error: { code: -32601 } });
    } finally {
      if (saved === undefined) delete process.env.GLM_API_KEY; else process.env.GLM_API_KEY = saved;
    }
  });

  it('an unknown agent->client request method gets an error response and the stream still completes', async () => {
    const runtime = resolveSubscriptionAcpServer('zai-subscription', 'glm-5.3')!;
    const sessionId = 'unknown-method-session';
    let unknownRequestAnswered: Record<string, unknown> | null = null;
    const { driver } = interactiveDriver((frame, emit) => {
      if (handshake(frame, emit, sessionId)) return;
      if (frame.id === 'unknown-request') {
        unknownRequestAnswered = frame;
        return;
      }
      if (frame.id === 'prompt') {
        emit({
          jsonrpc: '2.0', id: 'unknown-request', method: 'some/future_reverse_method',
          params: { sessionId },
        });
        emit(sessionUpdate(sessionId, {
          sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'GLM53_OK' },
        }));
        emit({ jsonrpc: '2.0', id: 'prompt', result: { stopReason: 'end_turn' } });
      }
    });
    const saved = process.env.GLM_API_KEY;
    process.env.GLM_API_KEY = 'test-only';
    try {
      const result = await executeAcpSubscriptionTurn({
        providerId: runtime.providerId, modelId: runtime.exactModelId,
        runtimeFingerprint: runtime.runtimeFingerprint, prompt: 'hi', cwd: 'C:\\safe', driver,
      });
      expect(result.text).toBe('GLM53_OK');
      expect(result.ignoredKinds).toEqual({ unknown_request_denied: 1 });
      expect(unknownRequestAnswered).toEqual({
        jsonrpc: '2.0', id: 'unknown-request',
        error: {
          code: -32601, message: 'Method not found: some/future_reverse_method',
          data: { method: 'some/future_reverse_method' },
        },
      });
    } finally {
      if (saved === undefined) delete process.env.GLM_API_KEY; else process.env.GLM_API_KEY = saved;
    }
  });

  it('a malformed reverse request (params not an object) still fails closed with ACP_MALFORMED_FRAME', async () => {
    const runtime = resolveSubscriptionAcpServer('zai-subscription', 'glm-5.3')!;
    const sessionId = 'malformed-request-session';
    const { driver } = interactiveDriver((frame, emit) => {
      if (handshake(frame, emit, sessionId)) return;
      if (frame.id === 'prompt') {
        emit({ jsonrpc: '2.0', id: 'bad-request', method: 'session/request_permission', params: 'not-an-object' });
      }
    });
    const saved = process.env.GLM_API_KEY;
    process.env.GLM_API_KEY = 'test-only';
    try {
      await expect(executeAcpSubscriptionTurn({
        providerId: runtime.providerId, modelId: runtime.exactModelId,
        runtimeFingerprint: runtime.runtimeFingerprint, prompt: 'hi', cwd: 'C:\\safe', driver,
      })).rejects.toThrow('ACP_MALFORMED_FRAME');
    } finally {
      if (saved === undefined) delete process.env.GLM_API_KEY; else process.env.GLM_API_KEY = saved;
    }
  });

  it('T-4: a reverse request method NOT in FS_OR_TERMINAL_REVERSE_METHODS produces exactly the key "unknown_request_denied" (never the adapter-supplied method string), and no field of the completed turn\'s result carries the method name', async () => {
    const runtime = resolveSubscriptionAcpServer('zai-subscription', 'glm-5.3')!;
    const sessionId = 'unknown-method-key-space-session';
    const sentinelMethod = 'totally/unrecognized_method_xyz';
    const { driver } = interactiveDriver((frame, emit) => {
      if (handshake(frame, emit, sessionId)) return;
      if (frame.id === 'prompt') {
        emit({ jsonrpc: '2.0', id: 'unknown-request', method: sentinelMethod, params: { sessionId } });
        emit(sessionUpdate(sessionId, {
          sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'GLM53_OK' },
        }));
        emit({ jsonrpc: '2.0', id: 'prompt', result: { stopReason: 'end_turn' } });
      }
    });
    const saved = process.env.GLM_API_KEY;
    process.env.GLM_API_KEY = 'test-only';
    try {
      const result = await executeAcpSubscriptionTurn({
        providerId: runtime.providerId, modelId: runtime.exactModelId,
        runtimeFingerprint: runtime.runtimeFingerprint, prompt: 'hi', cwd: 'C:\\safe', driver,
      });
      // The key is the fixed sentinel 'unknown_request_denied' -- never the adapter's own
      // method string -- so an adapter that invents new reverse-request method names can never
      // grow ignoredKinds' key space (an unbounded key space fed by untrusted process input would
      // itself be a mild DoS/telemetry-poisoning surface).
      expect(Object.keys(result.ignoredKinds)).toEqual(['unknown_request_denied']);
      expect(result.ignoredKinds[sentinelMethod]).toBeUndefined();
      // No field anywhere in the turn's result (text, exactModelId, runtimeFingerprint, or any
      // ignoredKinds key) contains the raw method string -- the only place it may legally appear
      // is the JSON-RPC wire reply this runtime sends back to the child process, never in what
      // reaches dispatch.ts's RESULT telemetry / receipt.
      const serialized = JSON.stringify(result);
      expect(serialized.includes(sentinelMethod)).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.GLM_API_KEY; else process.env.GLM_API_KEY = saved;
    }
  });
});

describe('T-5: parseStrictAcpFrame requires a scalar (string|number) id on an agent->client reverse request', () => {
  const baseRequest = (id: unknown) => JSON.stringify({
    jsonrpc: '2.0', id, method: 'fs/read_text_file', params: { sessionId: 's', path: 'x' },
  });

  it('accepts a string id (the common case)', () => {
    const frame = parseStrictAcpFrame(baseRequest('abc-123'));
    expect(frame.id).toBe('abc-123');
  });

  it('accepts a number id (JSON-RPC 2.0 legally allows either scalar type)', () => {
    const frame = parseStrictAcpFrame(baseRequest(42));
    expect(frame.id).toBe(42);
  });

  it('rejects an object id with ACP_MALFORMED_FRAME', () => {
    expect(() => parseStrictAcpFrame(baseRequest({ x: 1 }))).toThrow('ACP_MALFORMED_FRAME');
  });

  it('rejects an array id with ACP_MALFORMED_FRAME', () => {
    expect(() => parseStrictAcpFrame(baseRequest([1, 2]))).toThrow('ACP_MALFORMED_FRAME');
  });

  it('rejects a null id with ACP_MALFORMED_FRAME (JSON-RPC reserves null for an unknown-id notification-like reply, not a real request)', () => {
    expect(() => parseStrictAcpFrame(baseRequest(null))).toThrow('ACP_MALFORMED_FRAME');
  });

  it('a non-scalar id is never echoed into the -32601 reply -- the frame never reaches answerReverseRequest at all', async () => {
    const runtime = resolveSubscriptionAcpServer('zai-subscription', 'glm-5.3')!;
    const sessionId = 'object-id-reverse-request-session';
    const { driver } = interactiveDriver((frame, emit) => {
      if (handshake(frame, emit, sessionId)) return;
      if (frame.id === 'prompt') {
        emit({
          jsonrpc: '2.0', id: { untrusted: 'shape' }, method: 'fs/read_text_file',
          params: { sessionId, path: 'C:\\safe\\secret.txt' },
        });
      }
    });
    const saved = process.env.GLM_API_KEY;
    process.env.GLM_API_KEY = 'test-only';
    try {
      await expect(executeAcpSubscriptionTurn({
        providerId: runtime.providerId, modelId: runtime.exactModelId,
        runtimeFingerprint: runtime.runtimeFingerprint, prompt: 'hi', cwd: 'C:\\safe', driver,
      })).rejects.toThrow('ACP_MALFORMED_FRAME');
    } finally {
      if (saved === undefined) delete process.env.GLM_API_KEY; else process.env.GLM_API_KEY = saved;
    }
  });
});
