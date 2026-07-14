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

/** First-user-turn text per conversation, lowest turnIndex wins (tier-2 label input). */
function pickFirstUserText(
  turns: { agentSessionId: string; turnIndex: number; userText: string | null }[]
): Map<string, string> {
  const best = new Map<string, { turnIndex: number; userText: string }>();
  for (const turn of turns) {
    if (!turn.userText) continue;
    const existing = best.get(turn.agentSessionId);
    if (!existing || turn.turnIndex < existing.turnIndex) {
      best.set(turn.agentSessionId, { turnIndex: turn.turnIndex, userText: turn.userText });
    }
  }
  const result = new Map<string, string>();
  for (const [id, entry] of best) result.set(id, entry.userText);
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
