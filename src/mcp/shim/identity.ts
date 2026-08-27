/**
 * Conversation-identity injection for `minsky mcp shim` (mt#3812, ADR-006
 * Layer 3, ADR-038 §Question 1).
 *
 * ## The resolution is SHARED now, not duplicated (mt#4440)
 *
 * This docblock used to say the resolution logic was "DUPLICATED here rather
 * than imported for one reason: that module's top-level import of
 * `@minsky/shared/conversation-pid-map` (mt#3900's harness-pid live-mapping
 * lookup, which shells out to `ps`) is out of scope for the shim's v1". That
 * was an accurate record of mt#3812's scope and it had a cost the scope note
 * did not anticipate: the proxy gained mt#3900's live mapping and the shim did
 * not, so on the local-daemon transport — the path this repo's own MCP access
 * actually uses — every `tools/call` frame carried the conversation id frozen
 * in this process's environment at spawn.
 *
 * Measured 2026-08-27: a shim spawned five days and three `/clear`s earlier was
 * still stamping the conversation from before the first of them, while the pid
 * map held the correct current id and agreed with the live harness's start time
 * exactly. Presence claims, session attachment, calibration claims and the
 * `gen_ai.conversation.id` baggage entry all propagated it faithfully, so a
 * session's own writes were attributed to a different live conversation.
 *
 * Both writers now call
 * `@minsky/domain/agent-identity/live-conversation`, so the drift axis is gone
 * rather than merely asserted over. `identity.test.ts`'s `parity with the stdio
 * proxy writer` block still covers the message-shaped helpers below, which
 * remain per-writer because each is typed against its own transport's
 * `JsonRpcMessage`.
 *
 * ## Footprint
 *
 * The dependency this pulls in is small and node-builtin-only —
 * `conversation-pid-map` imports `node:fs`, `node:path` and
 * `@minsky/shared/paths` (itself `path` + `os`) — and `rss-budget.test.ts`
 * measures the claim rather than trusting it: a PRIMARY deterministic
 * bundle-size gate plus a SECONDARY live-RSS bound. That test is the reason
 * this import can be made without re-litigating ADR-038's resource case.
 *
 * The W3C Baggage codec is IMPORTED rather than duplicated — unlike the
 * message helpers below, `@minsky/domain/agent-identity/baggage` is a leaf
 * module with no imports of its own.
 *
 * @see packages/domain/src/agent-identity/live-conversation.ts — the resolution
 * @see src/mcp/stdio-proxy/conversation-identity.ts — the sibling writer
 * @see docs/architecture/adr-006-agent-identity.md §Layer 3
 */

import { AGENT_ID_META_KEY } from "@minsky/domain/agent-identity/layer2";
import { parseAgentId } from "@minsky/domain/agent-identity/format";
import {
  BAGGAGE_META_KEY,
  GEN_AI_CONVERSATION_ID_KEY,
  appendBaggageEntry,
} from "@minsky/domain/agent-identity/baggage";
import {
  CLAUDE_CODE_SESSION_ID_ENV,
  resolveConversationAgentIdFromEnv,
  resolveHarnessPid,
  resolveLiveConversationAgentId,
} from "@minsky/domain/agent-identity/live-conversation";
import type { JsonRpcMessage } from "./protocol";

export { AGENT_ID_META_KEY, BAGGAGE_META_KEY };

export { CLAUDE_CODE_SESSION_ID_ENV, resolveHarnessPid, resolveLiveConversationAgentId };

/**
 * Resolve the conversation-scoped agentId from the process environment.
 *
 * Returns `com.anthropic.claude-code:conv:<uuid>` when
 * `CLAUDE_CODE_SESSION_ID` holds a UUID, or null when the var is absent,
 * empty, or not UUID-shaped.
 *
 * This is the SPAWN-TIME value. It is the correct FALLBACK — and the only
 * source at all in a hookless environment — but it is not what a writer should
 * stamp on its own: see {@link resolveLiveConversationAgentId}, which prefers
 * the live pid mapping and falls back to this.
 */
export function resolveConversationAgentId(
  env: Record<string, string | undefined> = process.env
): string | null {
  return resolveConversationAgentIdFromEnv(env);
}

/**
 * Extract the conversation id an agentId names, or null when it names
 * something else.
 *
 * Only a `conv`-scoped id is a conversation id. A `run`-scoped subagent id or a
 * `proc`-scoped Layer 1 hash must never be emitted as `gen_ai.conversation.id`
 * — the attribute means one specific thing, and filling it with a different
 * grain would make baggage-resolved identity silently wrong rather than absent.
 */
export function conversationIdFromAgentId(agentId: string): string | null {
  const parsed = parseAgentId(agentId);
  if (!parsed || parsed.scope !== "conv") return null;
  return parsed.id;
}

/**
 * Inject conversation identity into a `tools/call` request's `_meta`, under
 * BOTH keys: `io.minsky/agent_id` and the W3C `baggage` entry
 * `gen_ai.conversation.id` (mt#3986).
 *
 * Returns a NEW message object when either key is written, or null when
 * neither is — the caller then forwards the original message untouched.
 *
 * The two keys are decided INDEPENDENTLY, so a caller that declared its own
 * `agent_id` still gets baggage added, and vice versa.
 *
 * No-injection cases:
 * - not a `tools/call` request (responses, notifications, initialize, ping)
 * - `params` missing or not an object
 * - `_meta["io.minsky/agent_id"]` already present: an upstream caller that
 *   declares its own identity is more specific than the shim's conversation
 *   grain — preserve it rather than overwrite (mirrors
 *   conversation-identity.ts's injectAgentIdMeta exactly)
 * - `_meta.baggage` already carries `gen_ai.conversation.id`, is unparseable,
 *   or cannot fit the new entry within the W3C limits (see
 *   `@minsky/domain/agent-identity/baggage`)
 */
export function injectAgentIdMeta(msg: JsonRpcMessage, agentId: string): JsonRpcMessage | null {
  if (msg.method !== "tools/call") return null;
  if (!msg.params || typeof msg.params !== "object" || Array.isArray(msg.params)) return null;

  const params = msg.params as Record<string, unknown>;
  const existingMeta = params["_meta"];
  const metaIsObject =
    existingMeta !== null && typeof existingMeta === "object" && !Array.isArray(existingMeta);
  const meta = metaIsObject ? (existingMeta as Record<string, unknown>) : {};

  const agentIdApplies = meta[AGENT_ID_META_KEY] === undefined;

  const conversationId = conversationIdFromAgentId(agentId);
  const nextBaggage = conversationId
    ? appendBaggageEntry(meta[BAGGAGE_META_KEY], GEN_AI_CONVERSATION_ID_KEY, conversationId)
    : null;

  if (!agentIdApplies && nextBaggage === null) return null;

  return {
    ...msg,
    params: {
      ...params,
      _meta: {
        ...meta,
        ...(agentIdApplies ? { [AGENT_ID_META_KEY]: agentId } : {}),
        ...(nextBaggage !== null ? { [BAGGAGE_META_KEY]: nextBaggage } : {}),
      },
    },
  };
}

/**
 * Redact an agentId for log output: keep the kind and scope, truncate the
 * id segment to its first 8 chars. Conversation UUIDs are attribution
 * keys — logging them verbatim would link transcripts to infra log sinks
 * (mirrors conversation-identity.ts's redactAgentId).
 */
export function redactAgentId(agentId: string): string {
  const lastColon = agentId.lastIndexOf(":");
  if (lastColon === -1) return `${agentId.slice(0, 8)}…`;
  const id = agentId.slice(lastColon + 1);
  return `${agentId.slice(0, lastColon + 1)}${id.slice(0, 8)}…`;
}
