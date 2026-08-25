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
 * Label precedence (mt#2770 — see `@minsky/domain/transcripts/conversation-label.ts`
 * for the pure decision logic, lifted to the domain layer by mt#2818):
 *   1. Bound task title, via `minsky_session_links` -> `sessions` -> task
 *      backend. `minsky_session_links` is sparse until mt#2441/mt#2756 land
 *      writers for it — an empty/missing link is NOT an error, it's just a
 *      tier-1 miss that falls through to tier 2.
 *   2. First-SUBSTANTIVE-user-prompt snippet, from `agent_transcript_turns.user_text`
 *      (harness-markup-stripped, markdown-stripped, ~60 chars). A markup-only
 *      first turn (e.g. a bare slash-command `<command-message>` invocation)
 *      is skipped in favor of the next real user turn — see
 *      `pickSubstantiveUserText` / `MAX_USER_TURN_CANDIDATES` in
 *      `@minsky/domain/transcripts/conversation-label.ts` (mt#2784).
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

import { isSqlCapable } from "@minsky/domain/persistence/types";
import { desc, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { agentTranscriptsTable } from "@minsky/domain/storage/schemas/agent-transcripts-schema";
import type { WidgetModule, WidgetContext, WidgetData } from "../types";
import { TaskTitleCache, type TaskProviderLike } from "../task-title-cache";
import { createEpochKeyedCache, getSharedPersistenceService } from "../shared-persistence";
import { describeWidgetDegradedReason } from "../db-providers";
// mt#2818: lifted to the domain layer so both cockpit and the transcripts_list
// shared command import the SAME mt#2770 precedence decision.
import {
  computeConversationLabel,
  deriveFallbackLabel,
} from "@minsky/domain/transcripts/conversation-label";
// mt#3343: the enrichment LOOKUP (tier-1 linked task title, tier-3 first-user
// text + subagent descriptor) is shared with `routes/conversations.ts`'s
// single-conversation overview, so it lives beside the precedence decision
// rather than private to this widget.
import {
  fetchEnrichment,
  EMPTY_ENRICHMENT,
  type RowEnrichment,
} from "../conversation-label-enrichment";

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
   * module docblock above and `@minsky/domain/transcripts/conversation-label.ts` (mt#2770).
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
            // mt#3321 — generated title, read from the row already being
            // selected here rather than via a second enrichment query.
            title: agentTranscriptsTable.title,
          })
          .from(agentTranscriptsTable)
          // mt#3342: order on a NON-NULL key. Postgres sorts NULLs FIRST under
          // `DESC`, so ordering on `started_at` alone let rows with a NULL
          // start time monopolize the window: 57 such rows existed against a
          // 50-row LIMIT, which meant this picker returned ZERO conversations
          // with a real start time and its ordering was meaningless. The
          // conversation-detail page's own label lookup read this window, so
          // every conversation fell back to rendering its raw uuid (mt#3343).
          //
          // COALESCE rather than `NULLS LAST`: a row with no start time is
          // still a real conversation, and `ingested_at` places it at roughly
          // the right recency instead of exiling it to the end of the list.
          // mt#3342's repair pass should drive the NULL count to zero — this
          // ordering is the defense that keeps one bad row from doing it again.
          .orderBy(
            desc(
              sql`COALESCE(${agentTranscriptsTable.startedAt}, ${agentTranscriptsTable.ingestedAt})`
            )
          )
          .limit(MAX_SESSIONS);

        const ids = rows.map((r) => r.agentSessionId);
        const enrichment = await getEnrichment(db, ids);

        const sessions: ContextInspectorSessionRow[] = rows.map((r) => {
          const e = enrichment.get(r.agentSessionId) ?? EMPTY_ENRICHMENT;
          // `r.title` participates in the guard as well as the inputs (mt#3321):
          // a conversation whose ONLY label source is its generated title must
          // still reach `computeConversationLabel`, not drop to the fallback.
          const label =
            e.linkedTaskTitle || r.title || e.firstUserText || e.subagentDescriptor
              ? computeConversationLabel({
                  agentSessionId: r.agentSessionId,
                  cwd: r.cwd,
                  startedAt: r.startedAt,
                  linkedTaskTitle: e.linkedTaskTitle,
                  generatedTitle: r.title,
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
        return {
          state: "degraded",
          reason: describeWidgetDegradedReason("context-inspector", err),
        };
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

/**
 * DB handle cached per persistence epoch (mt#3721).
 *
 * A pool recycle (`recycleSharedPersistence`, mt#3638) ends the underlying
 * postgres-js connection, and every query on an ended handle is rejected
 * forever with `CONNECTION_ENDED` — the `ending` flag is never cleared. Before
 * mt#3721 this cache had no epoch check and this widget served `degraded`
 * indefinitely after a recycle that had already restored the pool.
 */
const defaultDbFactory = createEpochKeyedCache(async (): Promise<PostgresJsDatabase> => {
  const svc = await getSharedPersistenceService();
  const provider = svc.getProvider();

  // Capability + method, via the one guard (mt#4543); the cast goes with the narrowing.
  if (!isSqlCapable(provider)) {
    throw new Error("context-inspector requires a SQL persistence provider");
  }

  // The removed cast was also hiding the `| null` the real signature declares. This
  // factory's own type promises a non-null db, and its not-capable branch above already
  // throws — so a null connection is the same unavailability, said later.
  const db = await provider.getDatabaseConnection();
  if (!db) {
    throw new Error("context-inspector requires a SQL persistence provider");
  }
  return db;
});

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
