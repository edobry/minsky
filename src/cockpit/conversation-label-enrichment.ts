/**
 * Conversation-label ENRICHMENT lookup (mt#3343).
 *
 * `@minsky/domain/transcripts/conversation-label.ts` owns the label PRECEDENCE
 * decision (which tier wins). This module owns the other half — fetching the
 * per-conversation inputs those tiers consume:
 *
 *   - tier 1 `linkedTaskTitle` — `minsky_session_links` -> `sessions` -> task backend
 *   - tier 3 `firstUserText`   — first SUBSTANTIVE `agent_transcript_turns.user_text`
 *   - tier 3 `subagentDescriptor` — composed from `agent_spawns` / `subagent_invocations`
 *
 * (Tier 2, the generated `agent_transcripts.title` from mt#3321, is read
 * directly off the transcript row by each caller — it needs no join.)
 *
 * Extracted from `widgets/context-inspector.ts` by mt#3343 so the
 * conversation-keyed overview route (`routes/conversations.ts`) can label a
 * SINGLE conversation with the same inputs the 50-row picker uses, instead of
 * growing a second lookup that drifts from this one. This mirrors what mt#2818
 * already did for the precedence function itself: ONE decision, one lookup, two
 * callers.
 *
 * The memoization wrapper deliberately did NOT move. It is keyed by the whole
 * id-set and tuned for the widget's repeated 50-id polls; a single-id route
 * call has different cache economics (and the browser already caches the
 * overview response under TanStack's `staleTime`).
 *
 * @see @minsky/domain/transcripts/conversation-label.ts — the precedence half
 * @see mt#2770 — conversation labeling · mt#2818 — precedence lifted to domain
 * @see mt#3343 — this extraction (conversation page reads its OWN label)
 */

import { and, inArray, isNotNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { agentTranscriptTurnsTable } from "@minsky/domain/storage/schemas/agent-transcript-turns-schema";
import { agentSpawnsTable } from "@minsky/domain/storage/schemas/agent-spawns-schema";
import { subagentInvocationsTable } from "@minsky/domain/storage/schemas/subagent-invocations-schema";
import { minskySessionLinksTable } from "@minsky/domain/storage/schemas/minsky-session-links-schema";
import { postgresSessions } from "@minsky/domain/storage/schemas/session-schema";
import { formatTaskIdForDisplay } from "@minsky/domain/tasks/task-id-utils";
import type { WorkspaceId } from "@minsky/domain/ids";
import {
  composeSubagentDescriptor,
  pickSubstantiveUserText,
} from "@minsky/domain/transcripts/conversation-label";
import type { TaskTitleCache } from "./task-title-cache";

/** Per-conversation enrichment inputs feeding `computeConversationLabel`. */
export interface RowEnrichment {
  linkedTaskTitle: string | null;
  firstUserText: string | null;
  subagentDescriptor: string | null;
}

export const EMPTY_ENRICHMENT: RowEnrichment = {
  linkedTaskTitle: null,
  firstUserText: null,
  subagentDescriptor: null,
};

/**
 * Resolve the best `minsky_session_links` row per `agentSessionId` — highest
 * `confidence` wins; ties break on the most recently `detectedAt`. Multiple
 * rows per agent session are possible (a conversation can touch more than one
 * Minsky workspace over its life); we only need the strongest link for a
 * label.
 */
export function pickBestLinks(
  links: {
    agentSessionId: string;
    minskySessionId: string;
    confidence: number | null;
    detectedAt: Date | null;
  }[]
): Map<string, string> {
  const best = new Map<
    string,
    { minskySessionId: string; confidence: number; detectedAt: number }
  >();
  for (const link of links) {
    const confidence = link.confidence ?? 0;
    const detectedAt = link.detectedAt instanceof Date ? link.detectedAt.getTime() : 0;
    const existing = best.get(link.agentSessionId);
    if (
      !existing ||
      confidence > existing.confidence ||
      (confidence === existing.confidence && detectedAt > existing.detectedAt)
    ) {
      best.set(link.agentSessionId, {
        minskySessionId: link.minskySessionId,
        confidence,
        detectedAt,
      });
    }
  }
  const result = new Map<string, string>();
  for (const [agentSessionId, entry] of best) {
    result.set(agentSessionId, entry.minskySessionId);
  }
  return result;
}

/**
 * Batch-fetch the enrichment inputs for the given agent session ids. Returns
 * an empty map (all tiers miss, callers fall back to the timestamp·cwd label)
 * on ANY query failure — a degraded enrichment step must never fail the whole
 * widget, and must never throw when `minsky_session_links` (or any of the
 * other joined tables) is empty or unreachable.
 */
export async function fetchEnrichment(
  db: PostgresJsDatabase,
  ids: string[],
  titleCache: TaskTitleCache | null
): Promise<Map<string, RowEnrichment>> {
  if (ids.length === 0) return new Map();

  try {
    const [links, turns, spawns, invocations] = await Promise.all([
      db
        .select({
          agentSessionId: minskySessionLinksTable.agentSessionId,
          minskySessionId: minskySessionLinksTable.minskySessionId,
          confidence: minskySessionLinksTable.confidence,
          detectedAt: minskySessionLinksTable.detectedAt,
        })
        .from(minskySessionLinksTable)
        .where(inArray(minskySessionLinksTable.agentSessionId, ids)),
      db
        .select({
          agentSessionId: agentTranscriptTurnsTable.agentSessionId,
          turnIndex: agentTranscriptTurnsTable.turnIndex,
          userText: agentTranscriptTurnsTable.userText,
        })
        .from(agentTranscriptTurnsTable)
        .where(
          and(
            inArray(agentTranscriptTurnsTable.agentSessionId, ids),
            isNotNull(agentTranscriptTurnsTable.userText)
          )
        ),
      db
        .select({
          childAgentSessionId: agentSpawnsTable.childAgentSessionId,
          agentKind: agentSpawnsTable.agentKind,
        })
        .from(agentSpawnsTable)
        .where(inArray(agentSpawnsTable.childAgentSessionId, ids)),
      db
        .select({
          agentSessionId: subagentInvocationsTable.agentSessionId,
          taskId: subagentInvocationsTable.taskId,
          agentType: subagentInvocationsTable.agentType,
          startedAt: subagentInvocationsTable.startedAt,
        })
        .from(subagentInvocationsTable)
        .where(inArray(subagentInvocationsTable.agentSessionId, ids)),
    ]);

    // Tier 1: best link per session -> minskySessionId -> taskId -> title.
    const bestLinkBySession = pickBestLinks(links);
    const minskySessionIds = Array.from(new Set(bestLinkBySession.values()));
    const sessionTaskIds =
      minskySessionIds.length > 0
        ? await db
            .select({ sessionId: postgresSessions.sessionId, taskId: postgresSessions.taskId })
            .from(postgresSessions)
            // Mint at the boundary: minskySessionId is opaque text in
            // minsky_session_links, but sessions.session is the branded
            // WorkspaceId column.
            .where(inArray(postgresSessions.sessionId, minskySessionIds as WorkspaceId[]))
        : [];
    const taskIdByMinskySessionId = new Map<string, string>();
    for (const row of sessionTaskIds) {
      if (row.taskId)
        taskIdByMinskySessionId.set(row.sessionId, formatTaskIdForDisplay(row.taskId));
    }
    const linkedTaskIdBySession = new Map<string, string>();
    for (const [agentSessionId, minskySessionId] of bestLinkBySession) {
      const taskId = taskIdByMinskySessionId.get(minskySessionId);
      if (taskId) linkedTaskIdBySession.set(agentSessionId, taskId);
    }

    // Tier 2: first-SUBSTANTIVE user-turn text per session. Collect every
    // non-null-userText turn per session (already batch-fetched above, no
    // extra query), then sort ascending by turnIndex — pickSubstantiveUserText
    // (mt#2784) scans only the earliest MAX_USER_TURN_CANDIDATES of those,
    // skipping any that are harness markup only (e.g. a bare
    // `<command-message>` slash-command invocation) in favor of the next
    // real user turn.
    const userTurnCandidatesBySession = new Map<
      string,
      { turnIndex: number; userText: string }[]
    >();
    for (const turn of turns) {
      if (!turn.userText) continue;
      const list = userTurnCandidatesBySession.get(turn.agentSessionId) ?? [];
      list.push({ turnIndex: turn.turnIndex, userText: turn.userText });
      userTurnCandidatesBySession.set(turn.agentSessionId, list);
    }
    for (const list of userTurnCandidatesBySession.values()) {
      list.sort((a, b) => a.turnIndex - b.turnIndex);
    }

    // Tier 3 inputs: agent_spawns agentKind (child edge) + subagent_invocations
    // (agentType + taskId), most-recent invocation per session when duplicates exist.
    const spawnKindBySession = new Map<string, string>();
    for (const spawn of spawns) {
      if (spawn.childAgentSessionId && spawn.agentKind) {
        spawnKindBySession.set(spawn.childAgentSessionId, spawn.agentKind);
      }
    }
    const invocationBySession = new Map<
      string,
      { taskId: string | null; agentType: string | null; startedAt: number }
    >();
    for (const inv of invocations) {
      if (!inv.agentSessionId) continue;
      const startedAt = inv.startedAt instanceof Date ? inv.startedAt.getTime() : 0;
      const existing = invocationBySession.get(inv.agentSessionId);
      if (!existing || startedAt > existing.startedAt) {
        invocationBySession.set(inv.agentSessionId, {
          taskId: inv.taskId ? formatTaskIdForDisplay(inv.taskId) : null,
          agentType: inv.agentType ?? null,
          startedAt,
        });
      }
    }

    // Batch-resolve every task id we might need a title for (tier 1's linked
    // task ids AND tier 3's subagent-invocation task ids) in one call.
    const allTaskIds = new Set<string>();
    for (const taskId of linkedTaskIdBySession.values()) allTaskIds.add(taskId);
    for (const inv of invocationBySession.values()) if (inv.taskId) allTaskIds.add(inv.taskId);

    const taskTitles =
      titleCache && allTaskIds.size > 0
        ? await titleCache.getTitles(Array.from(allTaskIds))
        : new Map<string, string>();

    const result = new Map<string, RowEnrichment>();
    for (const agentSessionId of ids) {
      const linkedTaskId = linkedTaskIdBySession.get(agentSessionId) ?? null;
      const linkedTaskTitle = linkedTaskId ? (taskTitles.get(linkedTaskId) ?? null) : null;

      const userTurnCandidates = userTurnCandidatesBySession.get(agentSessionId) ?? [];
      const firstUserText = pickSubstantiveUserText(userTurnCandidates.map((c) => c.userText));

      const invocation = invocationBySession.get(agentSessionId);
      const subagentDescriptor = composeSubagentDescriptor({
        invocationAgentType: invocation?.agentType ?? null,
        invocationTaskId: invocation?.taskId ?? null,
        invocationTaskTitle: invocation?.taskId
          ? (taskTitles.get(invocation.taskId) ?? null)
          : null,
        spawnAgentKind: spawnKindBySession.get(agentSessionId) ?? null,
      });

      result.set(agentSessionId, { linkedTaskTitle, firstUserText, subagentDescriptor });
    }
    return result;
  } catch {
    // Any enrichment-query failure (unreachable table, mocked db without the
    // extra query shapes, etc.) degrades to "no enrichment" — callers fall
    // back to the pre-existing timestamp·cwd·id label, never an error.
    return new Map();
  }
}
