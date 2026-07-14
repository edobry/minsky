/**
 * Unified run-list conversation merge (mt#2767 — "Unified run list: merge
 * /agents + /conversations into one agent-run browse surface").
 *
 * Merges standalone harness conversations (`agent_transcripts`) into the
 * workspace-session row list the `agents` widget already builds, so `/agents`
 * becomes ONE agent-run list instead of two separate `/agents` +
 * `/conversations` surfaces. Design doc:
 * https://app.notion.com/p/39c937f03cb481d4aa32c9b2891fa100 (parent mt#2766).
 *
 * Three row kinds ("Row model — Kind badge" in the spec):
 *   - "dispatched-agent"        — a Minsky workspace session (the existing
 *     Agents.tsx row; unchanged shape/semantics).
 *   - "principal-conversation"  — a harness conversation with NO workspace
 *     link (`minsky_session_links`) and NO `agent_spawns` parent edge — e.g.
 *     the operator's own iTerm chat, or a top-level orchestrating
 *     conversation that dispatches subagents.
 *   - "subagent-group"          — one or more `agent_spawns` CHILD
 *     conversations that never created their own workspace, collapsed under
 *     their parent run. When the parent IS one of the workspace rows or a
 *     principal-conversation row in the same page, the children are attached
 *     directly to that row's `subagents` array (no separate row). When the
 *     parent is NOT present in the current window, a synthetic top-level
 *     "subagent-group" row is emitted instead — the spec's documented
 *     collapsed-group allowance ("when the parent is not in the visible
 *     page, a collapsed group row is acceptable").
 *
 * Design decision — why a workspace-linked subagent conversation is NOT
 * nested: a dispatched subagent that itself called `session_start` produces
 * a REAL unit of work (task, PR, liveness) — nesting it would hide in-flight
 * work behind a collapse toggle. Nesting applies only to conversations that
 * never created a workspace of their own (e.g. Explore/search-only
 * dispatches). This mirrors the dedup rule below: a workspace-linked
 * conversation never gets its own standalone row, regardless of whether it
 * is ALSO a spawn child.
 *
 * Dedup (mt#2441/mt#2756 join): a conversation linked to a workspace via
 * `minsky_session_links` becomes an ATTRIBUTE of that workspace's row
 * (`conversationId` + `cwd`) rather than its own row — full stop, even when
 * the linked workspace itself is outside the current view (e.g. archived).
 *
 * Nesting depth: only ONE level. A subagent's parent is resolved via its
 * direct `agent_spawns.parent_agent_session_id` edge; multi-level spawn
 * chains (a subagent that itself spawned a subagent) are not walked further
 * — the deeper child nests under its immediate parent, which may itself be
 * a nested/collapsed subagent. Documented simplification given the mt#2767
 * scope; revisit if operators report confusing nesting.
 *
 * Labeling reuses `../conversation-label` (mt#2770) — the same precedence
 * tiers the context-inspector widget uses — but only tiers 2-4 apply here:
 * tier 1 (linked task title) is always null by construction (rows reaching
 * this module's label path are, by definition, unlinked to any workspace).
 * Tier 3 (subagent descriptor) uses only `agent_spawns.agent_kind` (the
 * richer `subagent_invocations`-joined variant is intentionally out of
 * scope here — see context-inspector.ts for that fuller version).
 *
 * Tier 2's `pickFirstUserText` below is markup-aware (mt#2784): a
 * slash-command or hook-injected first turn (e.g. a bare
 * `<command-message>error-handling</command-message>`) is skipped in favor
 * of the next substantive user turn, bounded to
 * `conversation-label.ts`'s `MAX_USER_TURN_CANDIDATES`.
 */
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { agentTranscriptsTable } from "@minsky/domain/storage/schemas/agent-transcripts-schema";
import { agentTranscriptTurnsTable } from "@minsky/domain/storage/schemas/agent-transcript-turns-schema";
import { agentSpawnsTable } from "@minsky/domain/storage/schemas/agent-spawns-schema";
import { minskySessionLinksTable } from "@minsky/domain/storage/schemas/minsky-session-links-schema";
import type { WorkspaceId } from "@minsky/domain/ids";
import { pickBestConversationLink } from "../session-detail";
import {
  computeConversationLabel,
  composeSubagentDescriptor,
  deriveFallbackLabel,
  pickSubstantiveUserText,
} from "../conversation-label";

/** Max standalone conversations considered per merge pass (mirrors context-inspector's window). */
export const MAX_CONVERSATION_WINDOW = 50;

export type RunKind = "dispatched-agent" | "principal-conversation" | "subagent-group";

/** One nested subagent conversation, collapsed under a parent run's row. */
export interface SubagentEntry {
  conversationId: string;
  label: string;
  cwd: string | null;
  startedAt: string | null;
}

/** Fields the merge attaches to an existing workspace ("dispatched-agent") row. */
export interface WorkspaceConversationAttrs {
  conversationId: string | null;
  cwd: string | null;
  subagents: SubagentEntry[];
}

/** A standalone top-level row the merge produces (principal conversation or subagent group). */
export interface StandaloneRunRow {
  sessionId: string;
  kind: "principal-conversation" | "subagent-group";
  title: string;
  liveness: null;
  taskId: null;
  taskTitle: null;
  prNumber: null;
  prStatus: null;
  lastActivityAt: string;
  agentId: null;
  conversationId: string | null;
  cwd: string | null;
  subagents: SubagentEntry[];
}

export interface RunMergeResult {
  /** Keyed by workspace sessionId — attributes to splice onto the matching workspace row. */
  workspaceAttrsBySessionId: Map<string, WorkspaceConversationAttrs>;
  /** New top-level rows to append to the merged list. */
  standaloneRows: StandaloneRunRow[];
}

const EMPTY_RESULT: RunMergeResult = {
  workspaceAttrsBySessionId: new Map(),
  standaloneRows: [],
};

/**
 * First-SUBSTANTIVE-user-turn text per conversation (tier-2 label input).
 * Collects every non-null-userText turn per conversation, sorts ascending by
 * turnIndex, then lets `pickSubstantiveUserText` (mt#2784) scan only the
 * earliest MAX_USER_TURN_CANDIDATES of those — skipping a markup-only first
 * turn (e.g. a bare `<command-message>` slash-command invocation) in favor of
 * the next real user turn. A conversation whose scanned window is entirely
 * markup has no entry in the returned map, so `labelFor` below falls through
 * to tier 3/4 exactly as it does today for a conversation with no user text
 * at all.
 */
function pickFirstUserText(
  turns: { agentSessionId: string; turnIndex: number; userText: string | null }[]
): Map<string, string> {
  const bySession = new Map<string, { turnIndex: number; userText: string }[]>();
  for (const turn of turns) {
    if (!turn.userText) continue;
    const list = bySession.get(turn.agentSessionId) ?? [];
    list.push({ turnIndex: turn.turnIndex, userText: turn.userText });
    bySession.set(turn.agentSessionId, list);
  }
  const result = new Map<string, string>();
  for (const [id, list] of bySession) {
    list.sort((a, b) => a.turnIndex - b.turnIndex);
    const substantive = pickSubstantiveUserText(list.map((entry) => entry.userText));
    if (substantive) result.set(id, substantive);
  }
  return result;
}

function labelFor(
  row: { agentSessionId: string; cwd: string | null; startedAt: Date | null },
  firstUserTextById: Map<string, string>,
  spawnAgentKindById: Map<string, string>
): string {
  const firstUserText = firstUserTextById.get(row.agentSessionId) ?? null;
  const spawnAgentKind = spawnAgentKindById.get(row.agentSessionId) ?? null;
  const subagentDescriptor = spawnAgentKind
    ? composeSubagentDescriptor({
        invocationAgentType: null,
        invocationTaskId: null,
        invocationTaskTitle: null,
        spawnAgentKind,
      })
    : null;

  if (firstUserText || subagentDescriptor) {
    return computeConversationLabel({
      agentSessionId: row.agentSessionId,
      cwd: row.cwd,
      startedAt: row.startedAt,
      linkedTaskTitle: null,
      firstUserText,
      subagentDescriptor,
    });
  }
  return deriveFallbackLabel(row.agentSessionId, row.cwd, row.startedAt);
}

/** Newest-first timestamp across a group of subagent entries (for the synthetic group row). */
function latestTimestamp(entries: SubagentEntry[]): string {
  let latest: string | null = null;
  for (const e of entries) {
    if (e.startedAt && (!latest || e.startedAt > latest)) latest = e.startedAt;
  }
  return latest ?? new Date(0).toISOString();
}

/**
 * Merge standalone conversations into the unified run list.
 *
 * @param db  Live Drizzle connection (the caller degrades to {@link EMPTY_RESULT}
 *   when no SQL-capable persistence provider is configured).
 * @param workspaceSessionIds  Every workspace sessionId currently in view — used
 *   to resolve the forward (workspace -> conversation) link direction.
 *
 * Never throws — any query failure degrades to the empty result (matching
 * the established degradation pattern in widgets/context-inspector.ts).
 */
export async function mergeConversationRows(
  db: PostgresJsDatabase,
  workspaceSessionIds: string[]
): Promise<RunMergeResult> {
  try {
    const conversationRows = await db
      .select({
        agentSessionId: agentTranscriptsTable.agentSessionId,
        cwd: agentTranscriptsTable.cwd,
        startedAt: agentTranscriptsTable.startedAt,
        endedAt: agentTranscriptsTable.endedAt,
      })
      .from(agentTranscriptsTable)
      .orderBy(sql`${desc(agentTranscriptsTable.startedAt)} NULLS LAST`)
      .limit(MAX_CONVERSATION_WINDOW);

    const conversationIds = conversationRows.map((r) => r.agentSessionId);

    const [workspaceLinkRows, conversationLinkRows, spawnRows, turnRows] = await Promise.all([
      workspaceSessionIds.length > 0
        ? db
            .select({
              agentSessionId: minskySessionLinksTable.agentSessionId,
              minskySessionId: minskySessionLinksTable.minskySessionId,
              confidence: minskySessionLinksTable.confidence,
              detectedAt: minskySessionLinksTable.detectedAt,
              startedAt: agentTranscriptsTable.startedAt,
              cwd: agentTranscriptsTable.cwd,
            })
            .from(minskySessionLinksTable)
            .innerJoin(
              agentTranscriptsTable,
              eq(agentTranscriptsTable.agentSessionId, minskySessionLinksTable.agentSessionId)
            )
            .where(
              inArray(minskySessionLinksTable.minskySessionId, workspaceSessionIds as WorkspaceId[])
            )
        : Promise.resolve([]),
      conversationIds.length > 0
        ? db
            .select({ agentSessionId: minskySessionLinksTable.agentSessionId })
            .from(minskySessionLinksTable)
            .where(inArray(minskySessionLinksTable.agentSessionId, conversationIds))
        : Promise.resolve([]),
      conversationIds.length > 0
        ? db
            .select({
              parentAgentSessionId: agentSpawnsTable.parentAgentSessionId,
              childAgentSessionId: agentSpawnsTable.childAgentSessionId,
              agentKind: agentSpawnsTable.agentKind,
            })
            .from(agentSpawnsTable)
            .where(inArray(agentSpawnsTable.childAgentSessionId, conversationIds))
        : Promise.resolve([]),
      conversationIds.length > 0
        ? db
            .select({
              agentSessionId: agentTranscriptTurnsTable.agentSessionId,
              turnIndex: agentTranscriptTurnsTable.turnIndex,
              userText: agentTranscriptTurnsTable.userText,
            })
            .from(agentTranscriptTurnsTable)
            .where(
              and(
                inArray(agentTranscriptTurnsTable.agentSessionId, conversationIds),
                isNotNull(agentTranscriptTurnsTable.userText)
              )
            )
        : Promise.resolve([]),
    ]);

    // --- (a) forward direction: best conversation link per VISIBLE workspace ---
    const linkCandidatesByWorkspace = new Map<
      string,
      { agentSessionId: string; confidence: number | null; startedAt: Date | string | null }[]
    >();
    const cwdByLinkedConversationId = new Map<string, string | null>();
    for (const row of workspaceLinkRows) {
      const list = linkCandidatesByWorkspace.get(row.minskySessionId) ?? [];
      list.push({
        agentSessionId: row.agentSessionId,
        confidence: row.confidence,
        startedAt: row.startedAt,
      });
      linkCandidatesByWorkspace.set(row.minskySessionId, list);
      cwdByLinkedConversationId.set(row.agentSessionId, row.cwd);
    }

    const workspaceAttrsBySessionId = new Map<string, WorkspaceConversationAttrs>();
    const workspaceSessionIdByConversationId = new Map<string, string>();
    for (const [minskySessionId, candidates] of linkCandidatesByWorkspace) {
      const best = pickBestConversationLink(candidates);
      workspaceAttrsBySessionId.set(minskySessionId, {
        conversationId: best?.agentSessionId ?? null,
        cwd: best ? (cwdByLinkedConversationId.get(best.agentSessionId) ?? null) : null,
        subagents: [],
      });
      if (best) workspaceSessionIdByConversationId.set(best.agentSessionId, minskySessionId);
    }

    // --- (b) reverse direction: is each windowed conversation linked to ANY workspace? ---
    const linkedConversationIds = new Set(conversationLinkRows.map((r) => r.agentSessionId));

    // --- (c) spawn edges: child -> {parent, agentKind} ---
    const spawnByChild = new Map<string, { parentId: string; agentKind: string | null }>();
    for (const spawn of spawnRows) {
      if (spawn.childAgentSessionId) {
        spawnByChild.set(spawn.childAgentSessionId, {
          parentId: spawn.parentAgentSessionId,
          agentKind: spawn.agentKind ?? null,
        });
      }
    }
    const spawnAgentKindById = new Map<string, string>();
    for (const [childId, { agentKind }] of spawnByChild) {
      if (agentKind) spawnAgentKindById.set(childId, agentKind);
    }

    // --- (d) tier-2 label input ---
    const firstUserTextById = pickFirstUserText(turnRows);

    // --- Classify each windowed, unlinked conversation as principal or subagent ---
    const principalRows: StandaloneRunRow[] = [];
    const principalRowById = new Map<string, StandaloneRunRow>();
    const subagentsByParent = new Map<string, SubagentEntry[]>();

    for (const row of conversationRows) {
      if (linkedConversationIds.has(row.agentSessionId)) continue; // dedup — attribute of its workspace row

      const spawn = spawnByChild.get(row.agentSessionId);
      const lastActivityAt =
        (row.endedAt ?? row.startedAt)?.toISOString() ?? new Date(0).toISOString();

      if (spawn) {
        const entry: SubagentEntry = {
          conversationId: row.agentSessionId,
          label: labelFor(row, firstUserTextById, spawnAgentKindById),
          cwd: row.cwd,
          startedAt: row.startedAt?.toISOString() ?? null,
        };
        const list = subagentsByParent.get(spawn.parentId) ?? [];
        list.push(entry);
        subagentsByParent.set(spawn.parentId, list);
        continue;
      }

      const principalRow: StandaloneRunRow = {
        sessionId: row.agentSessionId,
        kind: "principal-conversation",
        title: labelFor(row, firstUserTextById, spawnAgentKindById),
        liveness: null,
        taskId: null,
        taskTitle: null,
        prNumber: null,
        prStatus: null,
        lastActivityAt,
        agentId: null,
        conversationId: row.agentSessionId,
        cwd: row.cwd,
        subagents: [],
      };
      principalRows.push(principalRow);
      principalRowById.set(row.agentSessionId, principalRow);
    }

    // --- Attach subagent groups to their parent (workspace row, principal row, or a
    //     synthetic group row when the parent isn't in view) ---
    const standaloneGroupRows: StandaloneRunRow[] = [];
    for (const [parentId, entries] of subagentsByParent) {
      const workspaceSessionId = workspaceSessionIdByConversationId.get(parentId);
      if (workspaceSessionId) {
        const attrs = workspaceAttrsBySessionId.get(workspaceSessionId);
        if (attrs) {
          attrs.subagents.push(...entries);
          continue;
        }
      }
      const principalRow = principalRowById.get(parentId);
      if (principalRow) {
        principalRow.subagents.push(...entries);
        continue;
      }
      // Parent not present in the current window — collapsed synthetic group row
      // (spec's documented allowance: "a collapsed group row is acceptable").
      standaloneGroupRows.push({
        sessionId: `group:${parentId}`,
        kind: "subagent-group",
        title: `${entries.length} subagent run${entries.length === 1 ? "" : "s"} (parent not shown)`,
        liveness: null,
        taskId: null,
        taskTitle: null,
        prNumber: null,
        prStatus: null,
        lastActivityAt: latestTimestamp(entries),
        agentId: null,
        conversationId: null,
        cwd: null,
        subagents: entries,
      });
    }

    return {
      workspaceAttrsBySessionId,
      standaloneRows: [...principalRows, ...standaloneGroupRows],
    };
  } catch {
    // Any enrichment-query failure degrades to "workspace rows only" — never
    // fail the whole widget over the conversation-merge portion.
    return EMPTY_RESULT;
  }
}

// ---------------------------------------------------------------------------
// Short-TTL result cache (mt#2767 latency follow-up)
//
// Live-measured regression (2026-07-14, PR branch cockpit against the live
// DB): the unmerged `agents` widget's warm response was 0.33s; the unified
// merge's was 2-9s with NO warm convergence across repeated polls. Root
// cause was two-fold — (a) two of the merge's four enrichment queries
// filtered on a column that was NOT the leading column of its table's only
// index (fixed by the sibling migration adding
// `idx_minsky_session_links_minsky_session_id` and
// `idx_agent_spawns_child_agent_session_id`), and (b) the merge re-ran its
// full query set on EVERY poll with no memoization at all — unlike the
// context-inspector widget's own `ENRICHMENT_CACHE_TTL_MS` cache, which this
// module's original version omitted.
//
// The widget polls every 5s (`updateMode.intervalMs` in `./agents.ts`); a
// merge response slower than that poll interval means overlapping requests
// queue up on the connection pool — the same stacking mechanism that
// produced the original ~30s first-paint bug on the pre-unification
// `/conversations` page. Caching the merge result for a TTL matching the
// poll interval collapses back-to-back polls to ONE DB round trip per TTL
// window; concurrent callers within the window share the SAME in-flight
// promise (not just the resolved value) so a burst of near-simultaneous
// requests doesn't fan out into N parallel query sets either.
// ---------------------------------------------------------------------------

/** Matches the `agents` widget's own `updateMode.intervalMs` (./agents.ts). */
export const DEFAULT_MERGE_CACHE_TTL_MS = 5_000;

export interface CachedRunMerge {
  /** Same contract as {@link mergeConversationRows}, transparently cached. */
  getMerge(db: PostgresJsDatabase, workspaceSessionIds: string[]): Promise<RunMergeResult>;
}

/**
 * Build a short-TTL, request-deduplicating cache in front of
 * {@link mergeConversationRows}. One instance per widget construction (mirrors
 * `TaskTitleCache`'s per-widget-instance lifetime in `./agents.ts`) — NOT a
 * module-level singleton, so tests get a fresh cache per `createAgentsWidget()`
 * call.
 *
 * Cache key is the SORTED workspace-sessionId set: membership changes (a
 * session starting or leaving the non-terminal set) invalidate correctly,
 * while polls against an unchanged fleet hit cache.
 */
export function createCachedRunMerge(ttlMs: number = DEFAULT_MERGE_CACHE_TTL_MS): CachedRunMerge {
  let entry: { key: string; expiresAt: number; promise: Promise<RunMergeResult> } | null = null;

  return {
    async getMerge(db, workspaceSessionIds) {
      const key = JSON.stringify([...workspaceSessionIds].sort());
      const now = Date.now();
      if (entry && entry.key === key && entry.expiresAt > now) {
        return entry.promise;
      }

      const promise = mergeConversationRows(db, workspaceSessionIds);
      entry = { key, expiresAt: now + ttlMs, promise };

      // Defense in depth: mergeConversationRows() never rejects (it catches
      // internally and returns EMPTY_RESULT), but if that ever changes, an
      // unexpected rejection shouldn't poison the cache for the full TTL.
      promise.catch(() => {
        if (entry?.promise === promise) entry = null;
      });

      return promise;
    },
  };
}
