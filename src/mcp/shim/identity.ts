/**
 * Conversation-identity injection for `minsky mcp shim` (mt#3812, ADR-006
 * Layer 3, ADR-038 §Question 1).
 *
 * Semantics are pinned to `src/mcp/stdio-proxy/conversation-identity.ts`'s
 * `resolveConversationAgentId` + `injectAgentIdMeta` — same env var, same
 * UUID validation, same "don't overwrite a caller-declared agent_id" rule.
 * The logic is DUPLICATED here rather than imported for one reason: that
 * module's top-level import of `@minsky/shared/conversation-pid-map`
 * (mt#3900's harness-pid live-mapping lookup, which shells out to `ps`) is
 * out of scope for the shim's v1 — the mt#3812 spec's Scope section names
 * only the `CLAUDE_CODE_SESSION_ID` env-var path — and importing that
 * module anyway would tie this file's footprint to a dependency it doesn't
 * use, exactly the class of "one careless import restores the weight"
 * regression the spec's BLOCKING section warns about.
 *
 * `identity.test.ts`'s `parity with the stdio proxy writer` block asserts
 * behavioral parity against the stdio-proxy semantics so drift is caught
 * mechanically rather than trusted to review. That block is new in mt#3986:
 * this docblock claimed it existed from mt#3812 onward, but nothing in the
 * test file referenced the proxy until the two writers gained a second shared
 * behavior (`baggage` emission) and the claim had to become true.
 *
 * The W3C Baggage codec is IMPORTED rather than duplicated — unlike the
 * conversation-id resolution above, `@minsky/domain/agent-identity/baggage` is
 * a leaf module with no imports of its own, so it costs the bundle its own
 * ~1.3KB and nothing else.
 *
 * @see src/mcp/stdio-proxy/conversation-identity.ts — the semantics source
 * @see docs/architecture/adr-006-agent-identity.md §Layer 3
 */

import { AGENT_ID_META_KEY } from "@minsky/domain/agent-identity/layer2";
import { isValidAgentId, parseAgentId } from "@minsky/domain/agent-identity/format";
import { KNOWN_KINDS } from "@minsky/domain/agent-identity/kinds";
import {
  BAGGAGE_META_KEY,
  GEN_AI_CONVERSATION_ID_KEY,
  appendBaggageEntry,
} from "@minsky/domain/agent-identity/baggage";
import type { JsonRpcMessage } from "./protocol";

export { AGENT_ID_META_KEY, BAGGAGE_META_KEY };

/** Env var Claude Code sets on every spawned MCP server process. */
export const CLAUDE_CODE_SESSION_ID_ENV = "CLAUDE_CODE_SESSION_ID";

/**
 * UUID shape check (RFC-4122 textual form, case-insensitive). Matches
 * conversation-identity.ts's UUID_RE exactly — accepts any RFC-4122 variant
 * rather than gating on v4, since Claude Code does not document a version
 * guarantee for its conversation ids.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve the conversation-scoped agentId from the process environment.
 *
 * Returns `com.anthropic.claude-code:conv:<uuid>` when
 * `CLAUDE_CODE_SESSION_ID` holds a UUID, or null when the var is absent,
 * empty, or not UUID-shaped.
 */
export function resolveConversationAgentId(
  env: Record<string, string | undefined> = process.env
): string | null {
  const raw = env[CLAUDE_CODE_SESSION_ID_ENV];
  if (typeof raw !== "string") return null;

  const sessionId = raw.trim();
  if (!UUID_RE.test(sessionId)) return null;

  const agentId = `${KNOWN_KINDS.CLAUDE_CODE}:conv:${sessionId.toLowerCase()}`;
  // Defensive round-trip through the canonical validator, same as the
  // stdio proxy — a drift in the format rules must never make the shim
  // emit an id the reader rejects.
  return isValidAgentId(agentId) ? agentId : null;
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
