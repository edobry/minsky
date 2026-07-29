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
 * Known limitation: the env value is fixed at proxy spawn. An in-process
 * conversation switch (/clear, in-process resume) changes the conversation id
 * without respawning MCP servers, so calls attribute to the pre-switch
 * conversation until the next reconnect respawns the proxy.
 *
 * @see docs/architecture/adr-006-agent-identity.md §Implementation Phase 2
 * @see packages/domain/src/agent-identity/layer2.ts — the reader this feeds
 */

import { AGENT_ID_META_KEY } from "@minsky/domain/agent-identity/layer2";
import { isValidAgentId } from "@minsky/domain/agent-identity/format";
import { KNOWN_KINDS } from "@minsky/domain/agent-identity/kinds";
import type { JsonRpcMessage } from "./tools";

/** Env var Claude Code sets on spawned MCP server processes. */
export const CLAUDE_CODE_SESSION_ID_ENV = "CLAUDE_CODE_SESSION_ID";

/**
 * UUID shape check (RFC-4122 textual form, case-insensitive). Conservative on
 * purpose: only inject when the value is unambiguously a conversation UUID;
 * anything else falls through to Layer 1 rather than fabricating an id.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve the conversation-scoped agentId from the process environment.
 *
 * Returns `com.anthropic.claude-code:conv:<uuid>` when
 * `CLAUDE_CODE_SESSION_ID` holds a UUID, or null when the var is absent,
 * empty, or not UUID-shaped (hookless environments, non-Claude-Code parents,
 * manual proxy invocations).
 */
export function resolveConversationAgentId(
  env: Record<string, string | undefined> = process.env
): string | null {
  const raw = env[CLAUDE_CODE_SESSION_ID_ENV];
  if (typeof raw !== "string") return null;

  const sessionId = raw.trim();
  if (!UUID_RE.test(sessionId)) return null;

  const agentId = `${KNOWN_KINDS.CLAUDE_CODE}:conv:${sessionId.toLowerCase()}`;
  // Defensive round-trip through the canonical validator so a drift in the
  // format rules can never make the proxy emit an id the reader rejects.
  return isValidAgentId(agentId) ? agentId : null;
}

/**
 * Inject the agentId into a `tools/call` request's `_meta`.
 *
 * Returns a NEW message object when injection applies, or null when it does
 * not — the caller then forwards the original raw line untouched, preserving
 * byte-fidelity for all non-injected traffic.
 *
 * No-injection cases:
 * - not a `tools/call` request (responses, notifications, initialize, ping)
 * - `params` missing or not an object
 * - `_meta["io.minsky/agent_id"]` already present: an upstream caller that
 *   declares its own identity (e.g. a future subagent-grain declaration,
 *   mt#2292) is more specific than the proxy's conversation grain — preserve
 *   it rather than overwrite.
 */
export function injectAgentIdMeta(msg: JsonRpcMessage, agentId: string): JsonRpcMessage | null {
  if (msg.method !== "tools/call") return null;
  if (!msg.params || typeof msg.params !== "object" || Array.isArray(msg.params)) return null;

  const existingMeta = msg.params["_meta"];
  const metaIsObject =
    existingMeta !== null && typeof existingMeta === "object" && !Array.isArray(existingMeta);
  if (metaIsObject && (existingMeta as Record<string, unknown>)[AGENT_ID_META_KEY] !== undefined) {
    return null;
  }

  return {
    ...msg,
    params: {
      ...msg.params,
      _meta: {
        ...(metaIsObject ? (existingMeta as Record<string, unknown>) : {}),
        [AGENT_ID_META_KEY]: agentId,
      },
    },
  };
}
