/**
 * LIVE conversation-identity resolution, shared by every writer that stamps
 * `_meta` (mt#4440, ADR-006 §Layer 3).
 *
 * ## Why this module exists rather than living in one writer
 *
 * There are two writers of conversation identity onto the wire — the stdio
 * proxy (`src/mcp/stdio-proxy/conversation-identity.ts`) and the local-daemon
 * shim (`src/mcp/shim/identity.ts`) — and until mt#4440 they held SEPARATE
 * copies of this logic. mt#3900 taught one of them to prefer the
 * `<harness pid> → conversation id` mapping over the spawn-time env value; the
 * other kept the frozen env value, because pulling in the mapping was named
 * out of scope for the shim's v1 (mt#3812).
 *
 * That divergence is not a tidiness complaint, it is the defect. Measured
 * 2026-08-27: a shim spawned five days and three `/clear`s earlier was still
 * stamping the conversation id frozen in its environment at spawn, while the
 * pid map one directory away held the correct current id. Every downstream
 * consumer — presence claims, session attachment, calibration claims, dispatch
 * attribution, the `gen_ai.conversation.id` baggage entry — faithfully
 * propagated the stale value, so a session's own writes were attributed to
 * another live conversation and the collision probe every other agent reads was
 * degraded.
 *
 * mt#3986 had already added a `parity with the stdio proxy writer` test block
 * for exactly this drift class. It caught the drift it was pointed at
 * (`baggage` emission) and could not catch this one, because the live path was
 * never in its scope. A shared implementation removes the axis rather than
 * asserting over it.
 *
 * @see docs/architecture/adr-006-agent-identity.md §Layer 3
 * @see packages/shared/src/conversation-pid-map.ts — the mapping this reads
 */

import { isValidAgentId } from "./format";
import { KNOWN_KINDS } from "./kinds";
import { readConversationMapping, resolveHarnessPid } from "@minsky/shared/conversation-pid-map";

/** Env var Claude Code sets on every MCP server process it spawns. */
export const CLAUDE_CODE_SESSION_ID_ENV = "CLAUDE_CODE_SESSION_ID";

/**
 * UUID shape check (RFC-4122 textual form, case-insensitive). Conservative on
 * purpose: only stamp when the value is unambiguously a conversation UUID;
 * anything else falls through rather than fabricating an id.
 *
 * Deliberately accepts ANY RFC-4122 variant rather than gating on v4: Claude
 * Code does not document a version guarantee for its conversation ids, and a
 * future switch (e.g. to time-ordered v7) should keep working without a change
 * here. Non-UUID shapes are still rejected.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Build the Layer-2/3 agentId for a raw conversation UUID, or null when the
 * value is not UUID-shaped.
 *
 * Shared by the env path and the pid-mapping path so both emit an id the
 * canonical validator accepts — a divergence here would be invisible until an
 * agentId was silently dropped downstream.
 */
export function toConversationAgentId(sessionId: string): string | null {
  if (!UUID_RE.test(sessionId)) return null;
  const agentId = `${KNOWN_KINDS.CLAUDE_CODE}:conv:${sessionId.toLowerCase()}`;
  // Defensive round-trip through the canonical validator so a drift in the
  // format rules can never make a writer emit an id the reader rejects.
  return isValidAgentId(agentId) ? agentId : null;
}

/**
 * Resolve the conversation-scoped agentId from a process environment.
 *
 * Returns `com.anthropic.claude-code:conv:<uuid>` when
 * `CLAUDE_CODE_SESSION_ID` holds a UUID, or null when the var is absent,
 * empty, or not UUID-shaped (hookless environments, non-Claude-Code parents,
 * manual invocations).
 *
 * This is the SPAWN-TIME value and it goes stale the moment an in-process
 * conversation switch (`/clear`, resume, fork) changes the conversation without
 * respawning MCP servers. It remains the correct fallback — and the only source
 * at all in hookless environments — but a writer should prefer
 * {@link resolveLiveConversationAgentId} over calling this directly.
 */
export function resolveConversationAgentIdFromEnv(
  env: Record<string, string | undefined> = process.env
): string | null {
  const raw = env[CLAUDE_CODE_SESSION_ID_ENV];
  if (typeof raw !== "string") return null;
  return toConversationAgentId(raw.trim());
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
 * Resolve the CURRENT conversation-scoped agentId (mt#3900, generalized to
 * every writer by mt#4440).
 *
 * Precedence, highest first:
 *   1. the `<harness pid> → conversation id` mapping a SessionStart hook wrote
 *   2. the spawn-time `CLAUDE_CODE_SESSION_ID`, passed in as `fallbackAgentId`
 *
 * (1) beats (2) because (2) cannot change without a respawn, so whenever they
 * disagree it is (2) that is stale — that disagreement IS the defect this
 * closes. Returns null when neither source yields a valid id; the caller then
 * stamps nothing rather than fabricating an identity.
 *
 * `harnessPid` is resolved ONCE by the caller and passed in as a SEED, because
 * the ancestor walk shells out to `ps` and has no business running per frame.
 *
 * It used to say the value "cannot change for the life of the process", and
 * mt#4378 retired that claim: it is true of the VARIABLE and false of the FACT
 * it stands for, since the server outlives the harness that spawned it. The
 * seed is now re-walked ON A MISS — see the re-resolution block in the body for
 * the two observed shapes and why a hit must never pay for it.
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
  // production shape there is one writer per process and the pid is constant,
  // but the module is shared and exported — an unkeyed cache would hand a
  // second caller the first one's conversation, which is this defect wearing a
  // different hat.
  if (
    mappingCache &&
    mappingCache.harnessPid === harnessPid &&
    nowMs - mappingCache.readAtMs < CONVERSATION_MAPPING_TTL_MS
  ) {
    return mappingCache.agentId ?? fallbackAgentId;
  }

  let mapped = readMapping(harnessPid);

  // RE-RESOLVE ON A MISS (SC3, mt#4378). `harnessPid` is walked once at
  // construction and held, and the docblock above justifies that with "it
  // cannot change for the life of the process". That sentence is true of the
  // VARIABLE and false of the FACT it stands for: the process outlives the
  // harness that spawned it, so which harness is actually driving it does
  // change. Two observed shapes, one task:
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
 * Resolve the harness-pid SEED a writer passes to
 * {@link resolveLiveConversationAgentId}.
 *
 * Re-exported here so a writer needs exactly ONE import to adopt the live path.
 * The previous shape — import the resolver from one module and the seed from
 * another — is a small thing that nonetheless made "adopt the live path" look
 * like a bigger change than it is, and this module exists precisely because
 * that adoption did not happen once already.
 */
export { resolveHarnessPid };
