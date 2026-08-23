/**
 * PRD-TCLAW-AGENT-PARTICIPATION-007 S2 — Agent read + write path (MCP tools).
 *
 * Two collab-backed MCP tools, registered on a real in-process `McpServer`
 * connected into the bridge registry via `connectInProcessServer`
 * (G1R Gate-1 OQ-6 ruling: an `InMemoryTransport` pair, NOT a `RegisteredTool`
 * handler field — see registry.ts's own doc comment on that function for the
 * full reasoning). Because the transport is real, every call to either tool
 * below runs through the bridge's `executeTool` — `assertOperationAllowed`,
 * path-scope enforcement (a no-op BY EVALUATION for these tools, since
 * neither declares `pathArgKeys`), `requiresApproval` computed by the same
 * expression as every other tool, and the same `result.isError` totality
 * check — before this module's own handler code ever runs. There is no
 * second dispatch path.
 *
 * IDENTITY: neither tool takes a `channelId`-caller or any identity field as
 * an argument. The calling task's bound collab principal arrives via MCP
 * request `_meta` (registry.ts's `COLLAB_CALLER_META_KEY`), which
 * `executeTool` builds itself from its OWN `callerCollabPrincipalId`
 * parameter (sourced, ultimately, from `GatewayRequest.payload.
 * callerCollabPrincipalId` — a gateway-owned field no ClientCommand can
 * populate). A model has no path to set or influence this value: it is not
 * read from `args`, and neither tool's `inputSchema` even accepts an
 * identity-shaped field. A task with no bound identity omits `_meta`
 * entirely (`executeTool` only attaches the key when it has a non-undefined
 * caller id), and both handlers below refuse `COLLAB_IDENTITY_REQUIRED` in
 * that case — the exact §2a refusal-never-substitute discipline S1 and 005
 * already established at the wire layer.
 *
 * ERROR MAPPING reuses collabSurface.ts's own store singleton (`getStore`)
 * and caller-context builder (`callerFor`), exported from that module for
 * exactly this reuse, so the CollabError -> structured-error taxonomy here
 * is the SAME mapping `handleGetChannelTimeline`/`handlePostChannelMessage`
 * use — not a second, independently-written one that could drift from the
 * T-2 byte-identity guarantee (COLLAB_NOT_FOUND must be indistinguishable
 * whether the channel is hidden or does not exist). Both handlers catch
 * every store throw internally and return an MCP `isError: true` result
 * with ONLY the mapped, generic detail — never the raw error object, and
 * never an elaborated "you are not a member" hint (G1R Gate-1 §1.4 item 6:
 * enriching the in-process handler's error beyond the substrate's own
 * message would break the indistinguishability the substrate spent effort
 * establishing).
 *
 * APPROVAL CLASS (OPERATOR RULING, binding): collab__post_message is SPEECH
 * and is FREE — it does NOT require human approval. The operator's words:
 * "the agent is posting a message free ... make it seamless so the agents
 * can chat and learn from each other." An approval gate on every sentence
 * would make agent-to-agent conversation impossible, which is the whole
 * capability this PRD builds toward. This is implemented as an EXPLICIT
 * `capabilities: { post_message: 'read' }` config entry
 * (COLLAB_AGENT_TOOL_CAPABILITIES below), never obtained by omission
 * (capability.ts:172 fails closed to 'write' — "UNKNOWN NEVER MEANS READ")
 * and never obtained by the tool's NAME (post_message matches none of
 * registry.ts's seven DEFAULT_WRITE_PATTERNS, but the name must never be
 * what carries the policy — G1R N-7). Pinned, and falsified live, by
 * tests/agent-participation-s2-registration-live.test.ts.
 *
 * This ruling widens NOTHING else: every other write-capable tool an agent
 * invokes still requires approval on both tiers (talking is free, acting is
 * not — R-3b). The authority boundary is untouched — an agent may post only
 * to a channel where it holds an active collab_members row (§2.1's chain,
 * unchanged); a non-member gets byte-identical COLLAB_NOT_FOUND either way.
 * Free speech is not unscoped speech.
 *
 * RESIDUAL RISK, reported honestly rather than solved here: with posting
 * free and (once S3 exists) unattended, nothing in this slice rate-limits
 * an agent that posts in a tight loop. The operator has separately ruled
 * turn-count unbounded on subscription models (R-2) and this slice does not
 * re-propose a cap. What DOES already bound a runaway poster today,
 * verified from source: (1) the 16,384-UTF-8-byte message size ceiling
 * (text.ts, enforced per message); (2) the substrate's total serialization
 * via `withReadThenSequencer`+`mutex.withLock` (store.ts:1436-1437), which
 * makes posts strictly ordered but does NOT limit their RATE; (3) nothing
 * else — there is no per-connection or per-principal post-rate limiter
 * anywhere in packages/collab or packages/gateway (grep-verified: no
 * rate-limit/throttle logic references collab_events or postChannelMessage).
 * S3's own spec names a STOP control (R-3a) as the human's way to end an
 * unproductive loop, but STOP does not exist yet (S3 is out of this slice's
 * scope) and nothing else in S2 substitutes for it. Today, in isolation,
 * this slice's only caller is a hand-built test harness, so the gap is
 * theoretical until a real caller exists — but it is real and unmitigated,
 * and the operator should have it on record before S3 (auto-reply) ships.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CollabError } from '@torqclaw/collab';
import {
  COLLAB_AGENT_TURN_META_KEY,
  COLLAB_CALLER_META_KEY,
  type CollabAgentTurnToolContext,
} from '@torqclaw/bridge';
import { getStore, callerFor, triggerAutoReply } from './collabSurface.js';

/** The bridge server id these tools register under — fixed, gateway-code-only
 *  (see registry.ts's connectInProcessServer doc: never constructible from
 *  ~/.torqclaw/servers.json). Namespaced tool names become
 *  `${COLLAB_AGENT_SERVER_ID}__read_channel` / `${...}__post_message`. */
export const COLLAB_AGENT_SERVER_ID = 'collab';

/** Mirrors text.ts's normalizeMessageText raw-UTF-8-byte ceiling (the
 *  binding bound; see that module for the full residue — JSON-encoded-byte
 *  overflow and post-NFC byte underflow are NOT expressible in a JSON Schema
 *  max-length grammar and are instead caught by normalizeMessageText itself,
 *  reached via store.postChannelMessage -> store.ts:1428, and surfaced here
 *  as COLLAB_INVALID_REQUEST, per T-9 part 2's residue-enumeration rule). A
 *  JSON Schema `maxLength` here counts UTF-16 code units, not UTF-8 bytes or
 *  Unicode scalars, so this bound is int0entionally generous (4x the byte
 *  ceiling) -- it exists only to give the model a cheap, useful hint before
 *  a round trip, never as the actual enforcement, which remains
 *  normalizeMessageText's. */
const MESSAGE_TEXT_SCHEMA_MAX_LENGTH = 16384 * 4;

function extractCallerPrincipalId(extra: { _meta?: Record<string, unknown> }): string | null {
  const v = extra._meta?.[COLLAB_CALLER_META_KEY];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

type ExtractedAgentTurnContext =
  | { state: 'absent' }
  | { state: 'invalid' }
  | { state: 'valid'; context: CollabAgentTurnToolContext };

function extractAgentTurnContext(
  extra: { _meta?: Record<string, unknown> },
): ExtractedAgentTurnContext {
  const meta = extra._meta;
  if (!meta || !Object.prototype.hasOwnProperty.call(meta, COLLAB_AGENT_TURN_META_KEY)) {
    return { state: 'absent' };
  }
  const value = meta[COLLAB_AGENT_TURN_META_KEY];
  if (!value || typeof value !== 'object') return { state: 'invalid' };
  const context = value as Partial<CollabAgentTurnToolContext>;
  const profile = context.expectedProfile;
  const envelope = context.personaEnvelope;
  if (
    typeof context.channelId !== 'string' || context.channelId.trim().length === 0
    || typeof context.agentPrincipalId !== 'string' || context.agentPrincipalId.trim().length === 0
    || typeof context.triggerEventId !== 'string' || context.triggerEventId.trim().length === 0
    || !Number.isSafeInteger(context.channelSeq) || context.channelSeq! <= 0
    || typeof context.dispatchRequestId !== 'string' || context.dispatchRequestId.trim().length === 0
    || !Number.isInteger(context.personaRevision) || context.personaRevision! < 0
    || (context.recoveryLeaseToken !== undefined
      && (typeof context.recoveryLeaseToken !== 'string' || context.recoveryLeaseToken.trim().length === 0))
    || !profile
    || profile.providerAccountId !== 'ollama-local'
    || profile.adapterId !== 'ollama-local'
    || typeof profile.modelId !== 'string' || profile.modelId.trim().length === 0
    || !Number.isInteger(profile.personaRevision) || profile.personaRevision < 0
    || profile.personaRevision !== context.personaRevision
    || !envelope
    || envelope.version !== 1
    || typeof envelope.content !== 'string'
    || envelope.content !== envelope.content.normalize('NFC').trim()
    || envelope.content.length > 4_000
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u.test(envelope.content)
    || !Number.isInteger(envelope.personaRevision) || envelope.personaRevision < 0
    || envelope.personaRevision !== context.personaRevision
    || (envelope.content === '' && envelope.personaRevision !== 0)
    || typeof envelope.contentSha256 !== 'string'
    || createHash('sha256').update(envelope.content, 'utf8').digest('hex') !== envelope.contentSha256
  ) return { state: 'invalid' };
  return { state: 'valid', context: context as CollabAgentTurnToolContext };
}

const COLLAB_IDENTITY_REQUIRED_TOOL_ERROR = 'COLLAB_IDENTITY_REQUIRED';
const COLLAB_AGENT_TURN_CONTEXT_INVALID_TOOL_ERROR = 'COLLAB_AGENT_TURN_CONTEXT_INVALID';

/** Map a thrown value from the collab store to the exact tool-error text the
 *  model receives -- unelaborated, matching collabSurface.ts's own taxonomy
 *  byte-for-byte on the codes that matter for T-2 (COLLAB_NOT_FOUND). Never
 *  passes through a raw, non-CollabError message: an unclassified failure
 *  (a plain Error, or a non-Error throw where `err?.code` is undefined) maps
 *  to the same generic COLLAB_UNAVAILABLE text as collabSurface.ts's own
 *  final catch-all arm, so nothing internal ever reaches the model. */
function mapStoreErrorToToolErrorText(err: unknown): string {
  const code = err instanceof CollabError ? err.code : (err as { code?: string } | null)?.code;
  const message = err instanceof Error ? err.message : String(err);
  switch (code) {
    case 'COLLAB_NOT_FOUND':
      // T-2: byte-identical to the wire surface's own arm -- same code,
      // same message-derivation, never enriched with a membership hint.
      return `COLLAB_NOT_FOUND: ${message}`;
    case 'INVALID_REQUEST':
      return `COLLAB_INVALID_REQUEST: ${message}`;
    case 'CHANNEL_ARCHIVED':
      return `COLLAB_CHANNEL_ARCHIVED: ${message}`;
    case 'IDEMPOTENCY_CONFLICT':
      return `COLLAB_IDEMPOTENCY_CONFLICT: ${message}`;
    default:
      // Unclassified / unexpected: never leak internal detail, matching
      // collabSurface.ts's generic COLLAB_UNAVAILABLE arm.
      return 'COLLAB_UNAVAILABLE';
  }
}

/** PRD-TCLAW-AGENT-PARTICIPATION-007 S2 §5: `post_message` is chosen
 *  deliberately (G1R N-7) -- it matches NONE of the bridge's seven
 *  DEFAULT_WRITE_PATTERNS (registry.ts), unlike `send_message` which would
 *  match /send/i. Capability is nonetheless set EXPLICITLY below
 *  (`capabilities: { post_message: 'read' }`) rather than relying on the
 *  name, per capability.ts's fail-closed default (P6: "UNKNOWN NEVER MEANS
 *  READ") and G1R's binding instruction that the speech exemption must be an
 *  explicit config decision, never obtained by omission. */
export const COLLAB_AGENT_TOOL_CAPABILITIES: Record<string, 'read'> = {
  read_channel: 'read',
  post_message: 'read',
};

/**
 * Build the in-process McpServer exposing collab__read_channel and
 * collab__post_message. Called once from server.ts, after connectBridge(),
 * and registered via bridge's connectInProcessServer -- never from
 * loadServerConfigs/servers.json (B-2).
 */
export function buildCollabAgentMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'torqclaw-collab-agent-tools', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    'read_channel',
    {
      title: 'Read a channel timeline',
      description:
        'Read committed messages from a channel the calling agent is an active member of, ' +
        'paged by cursor. Returns COLLAB_NOT_FOUND for both a nonexistent channel and a ' +
        'channel the agent is not a member of (these are indistinguishable by design).',
      inputSchema: {
        channelId: z.string().min(1).describe('The channel to read.'),
        afterCursor: z.string().default('0').describe(
          'Cursor to read after (exclusive). Use "0" to read from the start of the channel.',
        ),
        limit: z.number().int().min(1).max(100).default(50).describe(
          'Maximum number of events to return in this page (1-100).',
        ),
      },
    },
    async (args, extra) => {
      const principalId = extractCallerPrincipalId(extra);
      if (principalId === null) {
        return { isError: true, content: [{ type: 'text', text: COLLAB_IDENTITY_REQUIRED_TOOL_ERROR }] };
      }
      const store = getStore();
      if (!store) {
        return { isError: true, content: [{ type: 'text', text: 'COLLAB_UNAVAILABLE' }] };
      }
      try {
        const result = await store.getChannelTimeline(callerFor(principalId), {
          channelId: args.channelId,
          afterCursor: args.afterCursor,
          limit: args.limit,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (err) {
        // A6(b)/totality: every store throw is caught HERE, inside this
        // handler -- nothing escapes to become an unhandled rejection on
        // the in-process transport's message loop. Non-CollabError throws
        // (a plain Error, or a non-Error value where `err?.code` is
        // undefined) fall through mapStoreErrorToToolErrorText's default
        // arm to the same generic COLLAB_UNAVAILABLE text.
        return { isError: true, content: [{ type: 'text', text: mapStoreErrorToToolErrorText(err) }] };
      }
    },
  );

  server.registerTool(
    'post_message',
    {
      title: 'Post a message to a channel',
      description:
        'Post one message to a channel the calling agent is an active member of, as the ' +
        'calling agent. The idempotency key is minted by the gateway, not supplied by the ' +
        'caller -- two calls with identical text in one turn commit two distinct messages. ' +
        'Returns COLLAB_NOT_FOUND for both a nonexistent channel and a channel the agent is ' +
        'not a member of (these are indistinguishable by design).',
      inputSchema: {
        channelId: z.string().min(1).describe('The channel to post to.'),
        text: z.string().min(1).max(MESSAGE_TEXT_SCHEMA_MAX_LENGTH).describe(
          'The message text (max 16,384 UTF-8 bytes after Unicode NFC normalization; ' +
          'this field\'s length limit is a coarse pre-check only -- the real bound is ' +
          'enforced server-side and may reject a shorter string with multi-byte characters).',
        ),
      },
    },
    async (args, extra) => {
      const principalId = extractCallerPrincipalId(extra);
      if (principalId === null) {
        return { isError: true, content: [{ type: 'text', text: COLLAB_IDENTITY_REQUIRED_TOOL_ERROR }] };
      }
      const store = getStore();
      if (!store) {
        return { isError: true, content: [{ type: 'text', text: 'COLLAB_UNAVAILABLE' }] };
      }
      try {
        const extractedTurn = extractAgentTurnContext(extra);
        if (extractedTurn.state === 'invalid') {
          return { isError: true, content: [{ type: 'text', text: COLLAB_AGENT_TURN_CONTEXT_INVALID_TOOL_ERROR }] };
        }
        if (extractedTurn.state === 'valid') {
          const turnContext = extractedTurn.context;
          if (turnContext.agentPrincipalId !== principalId || args.channelId !== turnContext.channelId) {
            return { isError: true, content: [{ type: 'text', text: COLLAB_AGENT_TURN_CONTEXT_INVALID_TOOL_ERROR }] };
          }
          const result = await store.commitAgentTurnToolOutput({
            channelId: turnContext.channelId,
            agentPrincipalId: principalId,
            channelSeq: turnContext.channelSeq,
            dispatchRequestId: turnContext.dispatchRequestId,
            recoveryLeaseToken: turnContext.recoveryLeaseToken,
            expectedProfile: turnContext.expectedProfile,
            personaEnvelope: turnContext.personaEnvelope,
            text: args.text,
          });
          if (!result.replayed) {
            triggerAutoReply({
              channelId: turnContext.channelId,
              channelSeq: Number(result.cursor),
              eventId: result.eventId,
              actorPrincipalId: principalId,
            });
          }
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            structuredContent: result as unknown as Record<string, unknown>,
          };
        }
        // Server-minted idempotency key, per call -- never derived from
        // `args.text` and never accepted as a tool argument. This is
        // deliberately different from the human-client wire path (005 S3),
        // where a human's OWN client supplies the key to survive a dropped
        // socket; a model has no socket to survive, and letting a model
        // choose the key would let it either force a duplicate (fresh key
        // on retry) or collide two distinct messages into one (reused key).
        const idempotencyKey = randomIdempotencyKey();
        const result = await store.postChannelMessage(
          callerFor(principalId),
          { channelId: args.channelId, text: args.text },
          idempotencyKey,
        );
        // PRD-TCLAW-AGENT-PARTICIPATION-007 S3: the SAME trigger
        // collabSurface.ts's human POST_CHANNEL_MESSAGE path fires, after
        // THIS commit -- an agent's own post is exactly as capable of
        // triggering another agent's turn as a human's post is (§4 S3's
        // "Agent A posts -> agent B ... takes a turn -> its post
        // re-triggers A" -- capability 3). Fire-and-forget for the same
        // reason: an agent's own tool call must not block on however many
        // downstream turns its post triggers.
        triggerAutoReply({
          channelId: args.channelId, channelSeq: Number(result.cursor),
          eventId: result.eventId, actorPrincipalId: principalId,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: mapStoreErrorToToolErrorText(err) }] };
      }
    },
  );

  return server;
}

function randomIdempotencyKey(): string {
  // Local import to avoid pulling node:crypto into every caller of this
  // module's exported constants/types at module-eval time is unnecessary
  // here (node:crypto has no side effects on import), but kept as a
  // function so a test can stub it if ever needed.
  return crypto.randomUUID();
}
