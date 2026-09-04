/**
 * Conversation-scoped agent identity injection for the stdio proxy
 * (mt#3285, ADR-006 Phase 2).
 *
 * Claude Code sets `CLAUDE_CODE_SESSION_ID` — the conversation UUID — in the
 * environment of every MCP server process it spawns. The proxy resolves it
 * once at construction into a Layer-2/3 agentId
 * (`com.anthropic.claude-code:conv:<uuid>`) and injects it as
 * `_meta["io.minsky/agent_id"]` on every inbound `tools/call` request, so the
 * inner server's existing Layer-2 reader (`readLayer2`) resolves a
 * conversation-scoped identity instead of falling through to the per-process
 * Layer-1 hash.
 *
 * Why the proxy and not a PreToolUse hook: ADR-006 §Layer 3 assumed a hook
 * could inject into `_meta`, but the documented hook output contract
 * (`updatedInput`) replaces a tool's ARGUMENTS only — there is no hook path to
 * protocol-level `_meta`. The proxy sits on the raw JSON-RPC stream and
 * already parses every inbound line, so injection is a serialize-instead-of-
 * raw-push at an existing parse point. See ADR-006 §Implementation Phase 2.
 *
 * The env value is fixed at proxy spawn, so on its own it goes stale the moment
 * an in-process conversation switch (`/clear`, resume, fork) changes the
 * conversation without respawning MCP servers. mt#3900 closes that: a
 * SessionStart hook records `<harness pid> → conversation id`, and
 * {@link resolveLiveConversationAgentId} prefers that mapping, falling back to
 * the spawn-time env value when no mapping exists. The env path remains the
 * only source in hookless environments.
 *
 * **The resolution itself now lives in
 * `@minsky/domain/agent-identity/live-conversation` (mt#4440)** and is shared
 * with the local-daemon shim, which held a divergent copy that never gained the
 * live path. This module keeps the proxy-facing names as re-exports so its
 * public surface is unchanged; what moved is the implementation, so the two
 * writers can no longer drift on it.
 *
 * @see docs/architecture/adr-006-agent-identity.md §Implementation Phase 2
 * @see packages/domain/src/agent-identity/live-conversation.ts — the resolution
 * @see packages/domain/src/agent-identity/layer2.ts — the reader this feeds
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
  CONVERSATION_MAPPING_TTL_MS,
  resolveConversationAgentIdFromEnv,
  resolveLiveConversationAgentId,
  resetConversationMappingCache,
} from "@minsky/domain/agent-identity/live-conversation";
import type { JsonRpcMessage } from "./tools";

export { BAGGAGE_META_KEY };

export {
  CLAUDE_CODE_SESSION_ID_ENV,
  CONVERSATION_MAPPING_TTL_MS,
  resolveLiveConversationAgentId,
  resetConversationMappingCache,
};

/**
 * Resolve the conversation-scoped agentId from the process environment.
 *
 * Returns `com.anthropic.claude-code:conv:<uuid>` when
 * `CLAUDE_CODE_SESSION_ID` holds a UUID, or null when the var is absent,
 * empty, or not UUID-shaped (hookless environments, non-Claude-Code parents,
 * manual proxy invocations).
 *
 * Thin wrapper over the shared implementation, kept because callers and tests
 * address it by this name.
 */
export function resolveConversationAgentId(
  env: Record<string, string | undefined> = process.env
): string | null {
  return resolveConversationAgentIdFromEnv(env);
}

/**
 * Redact an agentId for log output: keep the kind and scope, truncate the id
 * segment to its first 8 chars. Conversation UUIDs are attribution keys —
 * logging them verbatim would create linkage between transcripts and
 * infrastructure log sinks (PR #2390 R1).
 */
export function redactAgentId(agentId: string): string {
  const lastColon = agentId.lastIndexOf(":");
  if (lastColon === -1) return `${agentId.slice(0, 8)}…`;
  const id = agentId.slice(lastColon + 1);
  return `${agentId.slice(0, lastColon + 1)}${id.slice(0, 8)}…`;
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
 * neither is — the caller then forwards the original raw line untouched,
 * preserving byte-fidelity for all non-injected traffic.
 *
 * The two keys are decided INDEPENDENTLY, so a caller that declared its own
 * `agent_id` still gets baggage added, and vice versa.
 *
 * No-injection cases:
 * - not a `tools/call` request (responses, notifications, initialize, ping)
 * - `params` missing or not an object
 * - `_meta["io.minsky/agent_id"]` already present: an upstream caller that
 *   declares its own identity (e.g. a future subagent-grain declaration,
 *   mt#2292) is more specific than the proxy's conversation grain — preserve
 *   it rather than overwrite
 * - `_meta.baggage` already carries `gen_ai.conversation.id`, is unparseable,
 *   or cannot fit the new entry within the W3C limits (see
 *   `@minsky/domain/agent-identity/baggage`)
 */
export function injectAgentIdMeta(msg: JsonRpcMessage, agentId: string): JsonRpcMessage | null {
  if (msg.method !== "tools/call") return null;
  if (!msg.params || typeof msg.params !== "object" || Array.isArray(msg.params)) return null;

  const existingMeta = msg.params["_meta"];
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
      ...msg.params,
      _meta: {
        ...meta,
        ...(agentIdApplies ? { [AGENT_ID_META_KEY]: agentId } : {}),
        ...(nextBaggage !== null ? { [BAGGAGE_META_KEY]: nextBaggage } : {}),
      },
    },
  };
}
