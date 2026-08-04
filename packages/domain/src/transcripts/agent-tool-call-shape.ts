/**
 * Shared Agent-tool-call JSONB shape + finder.
 *
 * Both `AgentSpawnsPipeline` (agent-spawns-pipeline.ts) and the
 * `subagent_spawn` backfill sweep (spawn-link-writer.ts's
 * `backfillSpawnLinks`) parse the SAME `agent_transcript_turns.tool_calls`
 * JSONB shape to find the Agent tool call for a spawn-boundary turn. Prior to
 * mt#2756 R1 this logic was duplicated (deliberately, to avoid a circular
 * import between the two files) — a reviewer flagged the duplication as a
 * drift risk. Extracting it here (a leaf module neither of the other two
 * needs to avoid importing) removes the duplication without reintroducing
 * the circular-import problem.
 *
 * @see mt#1327 — agent-spawns-pipeline.ts (original owner of this shape)
 * @see mt#2756 — spawn-link-writer.ts (the second consumer that triggered the extraction)
 */

/** Content block shape from `agent_transcript_turns.tool_calls` JSONB. */
export interface AgentToolCallBlock {
  type: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  [key: string]: unknown;
}

/** True for a `tool_calls` JSONB entry that is an Agent tool_use block. */
function isAgentToolCall(block: unknown): block is AgentToolCallBlock {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as AgentToolCallBlock).type === "tool_use" &&
    (block as AgentToolCallBlock).name === "Agent"
  );
}

/**
 * Find EVERY Agent tool call in a `tool_calls` JSONB array, in order.
 * Returns an empty array if the array is missing or has no Agent call.
 *
 * A single turn can dispatch several subagents at once — parallel dispatch is
 * idiomatic, and 85 turns in the corpus carry 2+ Agent calls (one carries 8).
 * `AgentSpawnsPipeline` records one `agent_spawns` row per call, so it needs all
 * of them; `findAgentToolCall` below answers the narrower "did this turn spawn
 * anything, and with what prompt" question (mt#3692).
 */
export function findAgentToolCalls(toolCalls: unknown): AgentToolCallBlock[] {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.filter(isAgentToolCall);
}

/**
 * Find the first Agent tool call in a `tool_calls` JSONB array.
 * Returns `null` if the array is missing or has no Agent call.
 */
export function findAgentToolCall(toolCalls: unknown): AgentToolCallBlock | null {
  return findAgentToolCalls(toolCalls)[0] ?? null;
}
