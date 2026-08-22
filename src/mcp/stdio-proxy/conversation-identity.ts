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
 * @see docs/architecture/adr-006-agent-identity.md §Implementation Phase 2
 * @see packages/domain/src/agent-identity/layer2.ts — the reader this feeds
 */

import { AGENT_ID_META_KEY } from "@minsky/domain/agent-identity/layer2";
import { isValidAgentId, parseAgentId } from "@minsky/domain/agent-identity/format";
import { KNOWN_KINDS } from "@minsky/domain/agent-identity/kinds";
import {
  BAGGAGE_META_KEY,
  GEN_AI_CONVERSATION_ID_KEY,
  appendBaggageEntry,
} from "@minsky/domain/agent-identity/baggage";
import { readConversationMapping, resolveHarnessPid } from "@minsky/shared/conversation-pid-map";
import type { JsonRpcMessage } from "./tools";

export { BAGGAGE_META_KEY };

/** Env var Claude Code sets on spawned MCP server processes. */
export const CLAUDE_CODE_SESSION_ID_ENV = "CLAUDE_CODE_SESSION_ID";

/**
 * UUID shape check (RFC-4122 textual form, case-insensitive). Conservative on
 * purpose: only inject when the value is unambiguously a conversation UUID;
 * anything else falls through to Layer 1 rather than fabricating an id.
 *
 * Deliberately accepts ANY RFC-4122 variant rather than gating on v4: Claude
 * Code does not document a version guarantee for its conversation ids, and a
 * future switch (e.g. to time-ordered v7) should keep working without a
 * proxy change. Non-UUID shapes are still rejected.
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
 * Build the Layer-2/3 agentId for a raw conversation UUID, or null when the
 * value is not UUID-shaped.
 *
 * Shared by the env path and the pid-mapping path so both emit an id the
 * canonical validator accepts — a divergence here would be invisible until an
 * agentId was silently dropped downstream.
 */
function toConversationAgentId(sessionId: string): string | null {
  if (!UUID_RE.test(sessionId)) return null;
  const agentId = `${KNOWN_KINDS.CLAUDE_CODE}:conv:${sessionId.toLowerCase()}`;
  return isValidAgentId(agentId) ? agentId : null;
}

/**
 * How long a resolved conversation id is reused before the mapping file is
 * re-read.
 *
 * The read sits on every `tools/call` frame, so it is cached; but the whole
 * point is to notice a switch, so the cache has to expire. 2s is far below the
 * gap between a `/clear` and the next tool call (a human types a prompt first),
 * and far above any plausible burst of frames, so a switch is picked up on the
 * first call after it while a batch of calls pays one `stat`+read between them.
 */
export const CONVERSATION_MAPPING_TTL_MS = 2_000;

interface MappingCache {
  harnessPid: number;
  agentId: string | null;
  readAtMs: number;
}

let mappingCache: MappingCache | null = null;

/** Drop the memoized mapping read. Tests only. */
export function resetConversationMappingCache(): void {
  mappingCache = null;
}

/**
 * Resolve the CURRENT conversation-scoped agentId (mt#3900).
 *
 * Precedence, highest first:
 *   1. the `<harness pid> → conversation id` mapping a SessionStart hook wrote
 *   2. `CLAUDE_CODE_SESSION_ID` captured at proxy spawn
 *
 * (1) beats (2) because (2) cannot change without a respawn, so whenever they
 * disagree it is (2) that is stale — that disagreement IS the defect this
 * closes. Returns null when neither source yields a valid id; the caller then
 * stamps nothing rather than fabricating an identity.
 *
 * `harnessPid` is resolved ONCE by the caller and passed in: it cannot change
 * for the life of the process, and the ancestor walk shells out to `ps`, which
 * has no business running per frame.
 */
export function resolveLiveConversationAgentId(
  harnessPid: number | null,
  fallbackAgentId: string | null,
  deps: {
    readMapping?: (pid: number) => string | null;
    now?: () => number;
    /** Re-walk the ancestor chain when the seed pid misses (SC3, mt#4378). */
    reresolvePid?: () => number | null;
  } = {}
): string | null {
  const {
    readMapping = readConversationMapping,
    now = Date.now,
    reresolvePid = resolveHarnessPid,
  } = deps;

  if (harnessPid === null) return fallbackAgentId;

  const nowMs = now();
  // Keyed by pid, not merely time (PR #2764 R1): the cache is module-global, so
  // an entry cached for one harness must never answer for another. In today's
  // production shape there is one proxy per process and the pid is constant,
  // but the module is shared and exported — an unkeyed cache would hand a
  // second caller the first one's conversation, which is this task's own defect
  // wearing a different hat.
  if (
    mappingCache &&
    mappingCache.harnessPid === harnessPid &&
    nowMs - mappingCache.readAtMs < CONVERSATION_MAPPING_TTL_MS
  ) {
    return mappingCache.agentId ?? fallbackAgentId;
  }

  let mapped = readMapping(harnessPid);

  // RE-RESOLVE ON A MISS (SC3, mt#4378). `harnessPid` is walked once in the
  // proxy's constructor and held in a `readonly` field, and the docblock above
  // justifies that with "it cannot change for the life of the process". That
  // sentence is true of the VARIABLE and false of the FACT it stands for: the
  // MCP server outlives the harness that spawned it, so which harness is
  // actually driving this server does change. Two observed shapes, one task:
  //
  //   - the walked pid is DEAD and its entry was never pruned, so a two-day-old
  //     conversation answered as current (the filing incident);
  //   - the walked pid has NO entry at all while the live harness's entry is
  //     present and correct, so the reader missed and fell back to the
  //     spawn-time env value — which is the pre-`/clear` conversation (the
  //     third recurrence, 2026-08-21, where the mapping was written 5 seconds
  //     before the first mislabeled claim).
  //
  // A miss is the only trigger, so the `ps` cost that motivated resolve-once is
  // respected: the walk runs when the lookup already failed, never per frame,
  // and the result is cached under the pid it produced. A hit never re-walks.
  if (mapped === null) {
    const rewalked = reresolvePid();
    if (rewalked !== null && rewalked !== harnessPid) {
      mapped = readMapping(rewalked);
    }
  }

  const agentId = mapped ? toConversationAgentId(mapped) : null;
  // Cached under the SEED pid, which is the key the caller will present again.
  // The re-walk's result rides in `agentId`, so a hit inside the TTL answers
  // from cache and does not re-walk; the walk recurs only once the TTL lapses
  // and the seed pid misses again, which is the bounded cost SC3 asks for.
  mappingCache = { harnessPid, agentId, readAtMs: nowMs };

  return agentId ?? fallbackAgentId;
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
