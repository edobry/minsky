/**
 * Derived workspace -> conversation links (mt#3529).
 *
 * `minsky_session_links` rows are the PRIMARY resolution mechanism and stay
 * so: mt#2768 deleted the old `cwd LIKE` fallback because it was a HEURISTIC,
 * and nothing here reinstates it. What this module adds is a different kind of
 * source — `SessionRecord.agentId`, a fact the workspace record already
 * carries, recorded at the time the agent connected.
 *
 * Why the primary mechanism needs a second source at all: a link row is
 * written by one of five writers (`session_creator`, `pr_author`,
 * `subagent_spawn`, `driven_spawn`, `cwd_match`). If none of them fires for a
 * given workspace, the workspace reads as having NO conversation forever —
 * even when its own `agentId` names one, that conversation is ingested, and
 * the cockpit is already rendering it under `/conversation/:id`. Observed on
 * ws#308 (2026-08-01): `agentId` was
 * `com.anthropic.claude-code:conv:ac34711e-…`, `agent_transcripts` had the
 * row, `minsky_session_links` had nothing, and `/agents/:id` showed "No
 * conversation linked to this workspace yet."
 *
 * Two properties keep a derived link honest:
 *
 *   - It is EXISTENCE-CHECKED. A candidate is only emitted once the referenced
 *     `agent_session_id` is confirmed present in `agent_transcripts`, so a
 *     derived link can never point the Conversation tab at a 404.
 *   - It is MARKED. Callers surface `source: "derived-agent-id"` rather than
 *     folding it into the stamped set. ADR-006 §Consequences is explicit that
 *     the identity scheme has "No forgery defense" — a caller can declare any
 *     `agentId` it likes — so a derived link rests on a weaker trust basis
 *     than a row a writer stamped, and the response says so.
 *
 * @see docs/architecture/adr-006-agent-identity.md — the `{kind}:{scope}:{id}`
 *   format and the `conv` scope this reads.
 */
import { inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { agentTranscriptsTable } from "@minsky/domain/storage/schemas/agent-transcripts-schema";
import { conversationIdFromAgentId } from "@minsky/domain/agent-identity/format";
import type { ConversationId } from "@minsky/domain/ids";

// Re-exported for callers already importing from this module; the union itself
// lives in its own dependency-free module so the web bundle can share it.
export type { ConversationLinkSource } from "./conversation-link-source";

/** A conversation candidate derived from a workspace record's own `agentId`. */
export interface DerivedConversationLink {
  agentSessionId: string;
  startedAt: string | null;
}

/**
 * Extract the conversation id an `agentId` names, or null when it names none.
 *
 * Moved to `@minsky/domain/agent-identity/format` by mt#3945, which gave it a
 * second caller (the MCP server's presence writers) in a layer that must not
 * import from `src/cockpit`. Re-exported here so this module's own consumers —
 * and `scripts/verify-derived-conversation-link.ts` — keep their import path.
 * The behavior, including the `/task:` compound-form carve-out, is unchanged;
 * `derived-conversation-link.test.ts` still covers it through this export.
 */
export { conversationIdFromAgentId };

/**
 * Resolve existence-checked conversation links for workspaces that have no
 * stamped link row.
 *
 * @param db  Live Drizzle connection.
 * @param workspaces  Workspaces to derive for — pass ONLY the ones that came
 *   back unlinked, so a stamped row always wins without the caller having to
 *   order the merge.
 * @returns Map keyed by workspace sessionId. A workspace whose `agentId` names
 *   no conversation, or names one with no transcript row, is absent from the
 *   map rather than present with a null — "no derivable link" and "derived a
 *   link to nothing" must not be the same value.
 *
 * Never throws: a query failure degrades to an empty map, matching the
 * enrichment-degradation pattern every sibling read in this directory uses.
 */
export async function resolveDerivedConversationLinks(
  db: PostgresJsDatabase,
  workspaces: Array<{ sessionId: string; agentId: string | null | undefined }>
): Promise<Map<string, DerivedConversationLink>> {
  const derived = new Map<string, DerivedConversationLink>();

  const candidateByWorkspace = new Map<string, string>();
  for (const ws of workspaces) {
    const conversationId = conversationIdFromAgentId(ws.agentId);
    if (conversationId) candidateByWorkspace.set(ws.sessionId, conversationId);
  }
  if (candidateByWorkspace.size === 0) return derived;

  try {
    const candidateIds = Array.from(new Set(candidateByWorkspace.values()));
    const existingRows = await db
      .select({
        agentSessionId: agentTranscriptsTable.agentSessionId,
        startedAt: agentTranscriptsTable.startedAt,
      })
      .from(agentTranscriptsTable)
      // Cast mirrors run-merge.ts's `workspaceSessionIds as WorkspaceId[]`:
      // the column is branded `ConversationId`, and these ids come from an
      // agentId string, so the brand is asserted at this one boundary.
      .where(inArray(agentTranscriptsTable.agentSessionId, candidateIds as ConversationId[]));

    const startedAtById = new Map<string, string | null>();
    for (const row of existingRows) {
      startedAtById.set(
        row.agentSessionId,
        row.startedAt instanceof Date ? row.startedAt.toISOString() : null
      );
    }

    for (const [sessionId, conversationId] of candidateByWorkspace) {
      // Absence from the transcripts table is the whole guard: an agentId can
      // name a conversation this deployment never ingested.
      if (!startedAtById.has(conversationId)) continue;
      derived.set(sessionId, {
        agentSessionId: conversationId,
        startedAt: startedAtById.get(conversationId) ?? null,
      });
    }
  } catch {
    // Degrade to "nothing derived" — the stamped-link path is unaffected, and
    // the caller's empty state is still correct, just no better than before.
    return new Map();
  }

  return derived;
}
