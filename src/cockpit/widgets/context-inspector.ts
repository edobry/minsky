/**
 * Context-inspector widget (mt#2023)
 *
 * Exposes the list of known agent sessions for the cockpit "Context" tab.
 * Per-session detail (the full `SessionContextSnapshot`) is fetched via the
 * separate endpoint `/api/cockpit/context-inspector/snapshot?sessionId=...`
 * registered in `cockpit/server.ts` — the widget framework's single-payload
 * shape doesn't fit the interactive picker → detail pattern, so the snapshot
 * lives as a sibling endpoint.
 *
 * The widget itself returns the session-picker source: the top-50 known
 * sessions from the `agent_transcripts` table, start-time-ordered, with a
 * derived `label` (mt#2770 — conversation labeling). Self-fetching via
 * TanStack Query on the React side — no app-level polling.
 *
 * Label precedence (mt#2770 — see `../conversation-label.ts` for the pure
 * decision logic):
 *   1. Bound task title, via `minsky_session_links` -> `sessions` -> task
 *      backend. `minsky_session_links` is sparse until mt#2441/mt#2756 land
 *      writers for it — an empty/missing link is NOT an error, it's just a
 *      tier-1 miss that falls through to tier 2.
 *   2. First-user-prompt snippet, from `agent_transcript_turns.user_text`
 *      (markdown-stripped, ~60 chars).
 *   3. Subagent dispatch descriptor, composed from `agent_spawns` /
 *      `subagent_invocations` where resolvable.
 *   4. The original timestamp·cwd·id fallback (unchanged).
 *
 * All four enrichment queries below are read-only and filter by
 * `agentSessionId IN (<=50 ids)` — no full-table scans, no writes, and no
 * changes to the transcript-ingest pipeline (mt#2441 owns that surface
 * concurrently; this widget only reads what ingestion already wrote).
 *
 * Query-time + cache: the per-request DB round-trips are wrapped in a short
 * in-process TTL cache (`ENRICHMENT_CACHE_TTL_MS`) keyed by the resolved id
 * set, and task-title lookups additionally go through the longer-TTL shared
 * `TaskTitleCache` — so repeated polls within the cache window (list, picker,
 * and conversation-tab header all read this same widget) do not re-run the
 * enrichment joins or re-hit the task backend.
 *
 * @see mt#2023 — this widget
 * @see mt#2022 — substrate that makes the snapshot endpoint possible
 * @see mt#2033 — canonical SessionContextSnapshot shape returned by the endpoint
 * @see mt#2021 — cockpit context-inspector umbrella
 * @see mt#2770 — conversation labeling (this file's enrichment logic)
 */

import { and, desc, inArray, isNotNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { agentTranscriptsTable } from "@minsky/domain/storage/schemas/agent-transcripts-schema";
import { agentTranscriptTurnsTable } from "@minsky/domain/storage/schemas/agent-transcript-turns-schema";
import { agentSpawnsTable } from "@minsky/domain/storage/schemas/agent-spawns-schema";
import { subagentInvocationsTable } from "@minsky/domain/storage/schemas/subagent-invocations-schema";
import { minskySessionLinksTable } from "@minsky/domain/storage/schemas/minsky-session-links-schema";
import { postgresSessions } from "@minsky/domain/storage/schemas/session-schema";
import { formatTaskIdForDisplay } from "@minsky/domain/tasks/task-id-utils";
import type { WorkspaceId } from "@minsky/domain/ids";
import type { WidgetModule, WidgetContext, WidgetData } from "../types";
import { TaskTitleCache, type TaskProviderLike } from "../task-title-cache";
import {
  computeConversationLabel,
  composeSubagentDescriptor,
  deriveFallbackLabel,
} from "../conversation-label";

/** Shape of a single session-picker row */
export interface ContextInspectorSessionRow {
  agentSessionId: string;
  harness: string;
  startedAt: string | null;
  endedAt: string | null;
  cwd: string | null;
  /**
   * Human-readable label — precedence: bound task title, first-user-prompt
   * snippet, subagent dispatch descriptor, timestamp·cwd·id fallback. See the
   * module docblock above and `../conversation-label.ts` (mt#2770).
   */
  label: string;
}

/** Full payload returned by this widget when state === "ok" */
export interface ContextInspectorPayload {
  sessions: ContextInspectorSessionRow[];
}

/** Max sessions returned to keep the dropdown sane */
const MAX_SESSIONS = 50;

/** How long the computed enrichment map stays valid for a given id set. */
const ENRICHMENT_CACHE_TTL_MS = 15_000;

/** Per-session enrichment inputs feeding `computeConversationLabel`. */
interface RowEnrichment {
  linkedTaskTitle: string | null;
  firstUserText: string | null;
  subagentDescriptor: string | null;
}

const EMPTY_ENRICHMENT: RowEnrichment = {
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
function pickBestLinks(
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
async function fetchEnrichment(
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

    // Tier 2: first user-turn text per session (lowest turnIndex with non-null userText).
    const firstUserTextBySession = new Map<string, { turnIndex: number; userText: string }>();
    for (const turn of turns) {
      if (!turn.userText) continue;
      const existing = firstUserTextBySession.get(turn.agentSessionId);
      if (!existing || turn.turnIndex < existing.turnIndex) {
        firstUserTextBySession.set(turn.agentSessionId, {
          turnIndex: turn.turnIndex,
          userText: turn.userText,
        });
      }
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

      const firstUserText = firstUserTextBySession.get(agentSessionId)?.userText ?? null;

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

/**
 * Factory: returns the widget backed by the given DB factory. Tests inject a
 * mocked db; production wires the canonical Postgres connection.
 *
 * @param getTaskProvider  Optional async factory returning a `TaskProviderLike`
 *   (mirrors `widgets/agents.ts`). When omitted, task-title resolution (tier 1
 *   and part of tier 3) is skipped and labels fall through to the next tier —
 *   callers that don't need task-bound labels (most tests) can omit it.
 */
export function createContextInspectorWidget(
  getDb: () => Promise<PostgresJsDatabase>,
  getTaskProvider?: () => Promise<TaskProviderLike>
): WidgetModule {
  const titleCache = getTaskProvider ? new TaskTitleCache(getTaskProvider) : null;

  let enrichmentCache: { key: string; expiresAt: number; data: Map<string, RowEnrichment> } | null =
    null;

  async function getEnrichment(
    db: PostgresJsDatabase,
    ids: string[]
  ): Promise<Map<string, RowEnrichment>> {
    // JSON.stringify rather than a delimiter-joined string: agentSessionId
    // values are UUIDs so a comma join is safe in practice, but stringify
    // avoids relying on that assumption for cache-key collision-freedom
    // (PR #1902 R1 reviewer nit).
    const key = JSON.stringify(ids);
    const now = Date.now();
    if (enrichmentCache && enrichmentCache.key === key && enrichmentCache.expiresAt > now) {
      return enrichmentCache.data;
    }
    const data = await fetchEnrichment(db, ids, titleCache);
    enrichmentCache = { key, expiresAt: now + ENRICHMENT_CACHE_TTL_MS, data };
    return data;
  }

  return {
    id: "context-inspector",
    title: "Context",
    updateMode: { type: "polling", intervalMs: 15000 },
    async fetch(_ctx: WidgetContext): Promise<WidgetData> {
      try {
        const db = await getDb();
        const rows = await db
          .select({
            agentSessionId: agentTranscriptsTable.agentSessionId,
            harness: agentTranscriptsTable.harness,
            startedAt: agentTranscriptsTable.startedAt,
            endedAt: agentTranscriptsTable.endedAt,
            cwd: agentTranscriptsTable.cwd,
          })
          .from(agentTranscriptsTable)
          .orderBy(desc(agentTranscriptsTable.startedAt))
          .limit(MAX_SESSIONS);

        const ids = rows.map((r) => r.agentSessionId);
        const enrichment = await getEnrichment(db, ids);

        const sessions: ContextInspectorSessionRow[] = rows.map((r) => {
          const e = enrichment.get(r.agentSessionId) ?? EMPTY_ENRICHMENT;
          const label =
            e.linkedTaskTitle || e.firstUserText || e.subagentDescriptor
              ? computeConversationLabel({
                  agentSessionId: r.agentSessionId,
                  cwd: r.cwd,
                  startedAt: r.startedAt,
                  linkedTaskTitle: e.linkedTaskTitle,
                  firstUserText: e.firstUserText,
                  subagentDescriptor: e.subagentDescriptor,
                })
              : deriveFallbackLabel(r.agentSessionId, r.cwd, r.startedAt);

          return {
            agentSessionId: r.agentSessionId,
            harness: r.harness,
            startedAt: r.startedAt instanceof Date ? r.startedAt.toISOString() : null,
            endedAt: r.endedAt instanceof Date ? r.endedAt.toISOString() : null,
            cwd: r.cwd,
            label,
          };
        });

        const payload: ContextInspectorPayload = { sessions };
        return { state: "ok", payload };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { state: "degraded", reason: `context-inspector error: ${message}` };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Default production widget
//
// Mirrors the agents.ts singleton pattern: lazy PersistenceService init, no DI
// container. The cockpit server doesn't have one and constructing a singleton
// here is the established pattern.
// ---------------------------------------------------------------------------

let _cachedDb: PostgresJsDatabase | null = null;

async function defaultDbFactory(): Promise<PostgresJsDatabase> {
  if (_cachedDb) return _cachedDb;

  const { getSharedPersistenceService } = await import("../shared-persistence");
  const svc = await getSharedPersistenceService();
  const provider = svc.getProvider();

  if (
    !("getDatabaseConnection" in provider) ||
    typeof (provider as { getDatabaseConnection?: unknown }).getDatabaseConnection !== "function"
  ) {
    throw new Error("context-inspector requires a SQL persistence provider");
  }

  const sqlProvider = provider as {
    getDatabaseConnection: () => Promise<PostgresJsDatabase>;
  };
  _cachedDb = await sqlProvider.getDatabaseConnection();
  return _cachedDb;
}

// ---------------------------------------------------------------------------
// Default task provider — lazy singleton via the cockpit-wide
// PersistenceService (mt#2615's getServerTaskService), same shape as
// widgets/agents.ts's defaultTaskProviderFactory.
//
// Never throws: `getServerTaskService()` can legitimately return `null` (no
// SQL-capable persistence provider configured), and this factory is called
// from inside `TaskTitleCache`, not awaited at widget-construction time — a
// thrown error here should degrade tier-1/tier-3 task-title resolution, not
// surface as a hard failure. Returning a null-object `TaskProviderLike`
// (every lookup resolves to "not found") makes that degradation explicit at
// the type level instead of relying solely on TaskTitleCache's internal
// try/catch to absorb a throw (PR #1902 R1 reviewer finding).
// ---------------------------------------------------------------------------

const NULL_TASK_PROVIDER: TaskProviderLike = {
  async getTask() {
    return null;
  },
  async getTasks() {
    return [];
  },
};

async function defaultTaskProviderFactory(): Promise<TaskProviderLike> {
  const { getServerTaskService } = await import("../db-providers");
  const taskService = await getServerTaskService();
  return taskService ?? NULL_TASK_PROVIDER;
}

/** Default context-inspector widget — drop into WIDGET_REGISTRY */
export const contextInspectorWidget: WidgetModule = createContextInspectorWidget(
  defaultDbFactory,
  defaultTaskProviderFactory
);
