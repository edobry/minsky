/**
 * TranscriptListService
 *
 * Domain service backing `transcripts.list` (mt#2818): enumerate recent
 * conversations from `agent_transcripts` with summary metadata — turn counts,
 * first/last turn timestamps, and the raw inputs needed to derive an mt#2770
 * content label — WITHOUT any disk access (the query surface here is 100%
 * Postgres).
 *
 * Design note: this service returns raw label-precedence INPUTS
 * (`linkedTaskId`, `firstUserTurnCandidates`, subagent-descriptor fields) but
 * does NOT compute the final label string. `computeConversationLabel`
 * (mt#2770) lives alongside it in `packages/domain/src/transcripts/conversation-label.ts`
 * (mt#2818 lifted it there from `src/cockpit/`, so cockpit and this service's
 * caller share ONE precedence decision). The split is kept even though both
 * modules are now in the same layer: this service resolves DB rows, the
 * label module is a pure function over plain data — composing the label is
 * the caller's (`transcripts.list` command's) job, needing no DB access of
 * its own once given the resolved inputs.
 *
 * @see mt#2818 — this file
 * @see mt#2770 — conversation labeling precedence (label INPUTS mirrored here)
 * @see mt#2817 — loud list-truncation convention (`applyListCap`)
 * @see packages/domain/src/utils/list-pagination.ts
 */

import { injectable } from "tsyringe";
import { and, desc, inArray, isNotNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { agentTranscriptsTable } from "../storage/schemas/agent-transcripts-schema";
import { agentTranscriptTurnsTable } from "../storage/schemas/agent-transcript-turns-schema";
import { agentSpawnsTable } from "../storage/schemas/agent-spawns-schema";
import { subagentInvocationsTable } from "../storage/schemas/subagent-invocations-schema";
import { minskySessionLinksTable } from "../storage/schemas/minsky-session-links-schema";
import { postgresSessions } from "../storage/schemas/session-schema";
import { formatTaskIdForDisplay } from "../tasks/task-id-utils";
import type { WorkspaceId } from "../ids";
import { applyListCap, type ListTruncationMetadata } from "../utils/list-pagination";
import { log } from "@minsky/shared/logger";
import { getErrorMessage } from "../errors/index";
// mt#2818: reuse the same bound `pickSubstantiveUserText` (mt#2784) scans by
// — both modules live in this package now, so there is no reason to keep an
// independently-drifting duplicate of this constant.
import { MAX_USER_TURN_CANDIDATES as FIRST_USER_TURN_CANDIDATE_LIMIT } from "./conversation-label";

export interface TranscriptListRow {
  agentSessionId: string;
  harness: string;
  startedAt: Date | null;
  endedAt: Date | null;
  cwd: string | null;
  /** LLM-generated session summary (per-turn summary pipeline), when present. */
  summary: string | null;
  relatedTaskIds: string[] | null;
  relatedPrNumbers: string[] | null;
  /** Ingest high-water-mark — see the coverage-honesty doc in list-command.ts. */
  lastIngestedJsonlTimestamp: Date | null;

  /** Number of rows in `agent_transcript_turns` for this conversation. */
  turnCount: number;
  /** Earliest turn's own `started_at`, or null if the conversation has no turns. */
  firstTurnAt: Date | null;
  /** Latest turn's own `ended_at` (falling back to `started_at`), or null. */
  lastTurnAt: Date | null;

  // ── Raw label-precedence inputs (mt#2770) — composed into a label string
  // by the caller via `computeConversationLabel` et al. ─────────────────────

  /** Tier 1 input: display-form task id (e.g. "mt#123") bound via minsky_session_links, if resolved. */
  linkedTaskId: string | null;
  /** Tier 2 input: earliest-first raw user-turn text candidates (not yet snippet-cleaned). */
  firstUserTurnCandidates: string[];
  /** Tier 3 input: agent_spawns.agent_kind for the child edge, if only the spawn edge resolved. */
  subagentSpawnAgentKind: string | null;
  /** Tier 3 input: subagent_invocations.agent_type, if an invocation row resolved. */
  subagentInvocationAgentType: string | null;
  /** Tier 3 input: subagent_invocations' bound task id (display form), if any. */
  subagentInvocationTaskId: string | null;
}

export interface TranscriptListOptions {
  /** Max conversations to return. Defaults to `DEFAULT_LIST_CAP` (500) per mt#2817. */
  limit?: number;
}

export interface TranscriptListResult {
  conversations: TranscriptListRow[];
  truncation: ListTruncationMetadata;
}

@injectable()
export class TranscriptListService {
  constructor(private readonly db: PostgresJsDatabase) {}

  /**
   * List conversations ordered by recency (agent_transcripts.started_at DESC),
   * enriched with turn stats and mt#2770 label-precedence inputs. Zero disk
   * access — every field here is sourced from Postgres.
   *
   * **Not project/workspace-scoped — verified as the transcripts subsystem's
   * existing convention, not an oversight (mt#2818 R1).** ADR-021's
   * project-scoping model (`docs/architecture/adr-021-project-scoping-resolution-model.md`
   * "User-facing behavior" table) enumerates exactly five scoped operations —
   * `tasks.list`, `session.list`, `memory.list`, `memory.search`,
   * `asks.list` — and does not include any `transcripts_*` tool.
   * `transcripts.search` / `search-text` / `get` / `similar` /
   * `spawns-extract` are ALL unscoped today (grepped: none of them reference
   * `projectDir`, `projectScope`, or `allProjects`). `agent_transcripts` does
   * carry a `projectDir` column, but every existing reader of it
   * (`src/cockpit/routes/agents.ts`, `routes/conversations.ts`,
   * `live-tail-poller.ts`) uses it only as a JSONL-file-locate optimization,
   * never as a query filter. `transcripts.list` matches that established
   * subsystem convention rather than inventing new scoping unilaterally —
   * a harness conversation is not reliably attributable to one Minsky
   * project (it may span checkouts or be a non-project chat), which is a
   * plausible reason ADR-021 left this subsystem out; if project-scoped
   * transcript enumeration becomes a real need, extend ADR-021's table (and
   * all five transcripts_* readers together, not just this one) rather than
   * scoping `transcripts.list` alone and leaving its siblings inconsistent.
   */
  async listConversations(opts: TranscriptListOptions = {}): Promise<TranscriptListResult> {
    try {
      const baseRows = await this.db
        .select({
          agentSessionId: agentTranscriptsTable.agentSessionId,
          harness: agentTranscriptsTable.harness,
          startedAt: agentTranscriptsTable.startedAt,
          endedAt: agentTranscriptsTable.endedAt,
          cwd: agentTranscriptsTable.cwd,
          summary: agentTranscriptsTable.summary,
          relatedTaskIds: agentTranscriptsTable.relatedTaskIds,
          relatedPrNumbers: agentTranscriptsTable.relatedPrNumbers,
          lastIngestedJsonlTimestamp: agentTranscriptsTable.lastIngestedJsonlTimestamp,
        })
        .from(agentTranscriptsTable)
        // Unscoped by project/workspace — see the docblock above for the
        // verified basis (ADR-021's scoped-operations table does not include
        // any transcripts_* tool; matches all 5 sibling readers).
        .orderBy(desc(agentTranscriptsTable.startedAt));

      // mt#2817: loud cap — `total` reflects every conversation in the store
      // (this query applies no filters), `truncated`/`returned` are always
      // reported so a caller relying on the full set can tell it got a page.
      const { items: pageRows, meta: truncation } = applyListCap(baseRows, opts.limit);

      const ids = pageRows.map((r) => r.agentSessionId);
      const enrichment = await this.fetchEnrichment(ids);

      const conversations: TranscriptListRow[] = pageRows.map((row) => {
        const e = enrichment.get(row.agentSessionId);
        return {
          ...row,
          turnCount: e?.turnCount ?? 0,
          firstTurnAt: e?.firstTurnAt ?? null,
          lastTurnAt: e?.lastTurnAt ?? null,
          linkedTaskId: e?.linkedTaskId ?? null,
          firstUserTurnCandidates: e?.firstUserTurnCandidates ?? [],
          subagentSpawnAgentKind: e?.subagentSpawnAgentKind ?? null,
          subagentInvocationAgentType: e?.subagentInvocationAgentType ?? null,
          subagentInvocationTaskId: e?.subagentInvocationTaskId ?? null,
        };
      });

      return { conversations, truncation };
    } catch (err) {
      throw new Error(
        `TranscriptListService.listConversations: query failed: ${getErrorMessage(err)}`,
        { cause: err }
      );
    }
  }

  // ── Enrichment ────────────────────────────────────────────────────────────

  private async fetchEnrichment(
    ids: string[]
  ): Promise<Map<string, Omit<TranscriptListRow, TranscriptListBaseFields>>> {
    type Enrichment = Omit<TranscriptListRow, TranscriptListBaseFields>;
    if (ids.length === 0) return new Map<string, Enrichment>();

    try {
      const [turnStats, turnCandidates, links, spawns, invocations] = await Promise.all([
        this.db
          .select({
            agentSessionId: agentTranscriptTurnsTable.agentSessionId,
            turnCount: sql<number>`count(*)::int`,
            firstTurnAt: sql<Date | null>`min(${agentTranscriptTurnsTable.startedAt})`,
            lastTurnAt: sql<Date | null>`max(coalesce(${agentTranscriptTurnsTable.endedAt}, ${agentTranscriptTurnsTable.startedAt}))`,
          })
          .from(agentTranscriptTurnsTable)
          .where(inArray(agentTranscriptTurnsTable.agentSessionId, ids))
          .groupBy(agentTranscriptTurnsTable.agentSessionId),
        this.db
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
        this.db
          .select({
            agentSessionId: minskySessionLinksTable.agentSessionId,
            minskySessionId: minskySessionLinksTable.minskySessionId,
            confidence: minskySessionLinksTable.confidence,
            detectedAt: minskySessionLinksTable.detectedAt,
          })
          .from(minskySessionLinksTable)
          .where(inArray(minskySessionLinksTable.agentSessionId, ids)),
        this.db
          .select({
            childAgentSessionId: agentSpawnsTable.childAgentSessionId,
            agentKind: agentSpawnsTable.agentKind,
          })
          .from(agentSpawnsTable)
          .where(inArray(agentSpawnsTable.childAgentSessionId, ids)),
        this.db
          .select({
            agentSessionId: subagentInvocationsTable.agentSessionId,
            taskId: subagentInvocationsTable.taskId,
            agentType: subagentInvocationsTable.agentType,
            startedAt: subagentInvocationsTable.startedAt,
          })
          .from(subagentInvocationsTable)
          .where(inArray(subagentInvocationsTable.agentSessionId, ids)),
      ]);

      // Tier 1: best link per session -> minskySessionId -> taskId (display form).
      const bestLinkBySession = pickBestLinks(links);
      const minskySessionIds = Array.from(new Set(bestLinkBySession.values()));
      const sessionTaskIds =
        minskySessionIds.length > 0
          ? await this.db
              .select({ sessionId: postgresSessions.sessionId, taskId: postgresSessions.taskId })
              .from(postgresSessions)
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

      // Tier 2: earliest-N non-null user-turn candidates, ordered by turnIndex.
      const turnCandidatesBySession = new Map<string, { turnIndex: number; userText: string }[]>();
      for (const turn of turnCandidates) {
        if (!turn.userText) continue;
        const list = turnCandidatesBySession.get(turn.agentSessionId) ?? [];
        list.push({ turnIndex: turn.turnIndex, userText: turn.userText });
        turnCandidatesBySession.set(turn.agentSessionId, list);
      }
      for (const list of turnCandidatesBySession.values()) {
        list.sort((a, b) => a.turnIndex - b.turnIndex);
      }

      // Tier 3 inputs.
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

      const turnStatsBySession = new Map(turnStats.map((r) => [r.agentSessionId, r]));

      const result = new Map<string, Enrichment>();
      for (const id of ids) {
        const stats = turnStatsBySession.get(id);
        const candidates = (turnCandidatesBySession.get(id) ?? [])
          .slice(0, FIRST_USER_TURN_CANDIDATE_LIMIT)
          .map((c) => c.userText);
        const invocation = invocationBySession.get(id);

        result.set(id, {
          turnCount: stats?.turnCount ?? 0,
          firstTurnAt: coerceDate(stats?.firstTurnAt),
          lastTurnAt: coerceDate(stats?.lastTurnAt),
          linkedTaskId: linkedTaskIdBySession.get(id) ?? null,
          firstUserTurnCandidates: candidates,
          subagentSpawnAgentKind: spawnKindBySession.get(id) ?? null,
          subagentInvocationAgentType: invocation?.agentType ?? null,
          subagentInvocationTaskId: invocation?.taskId ?? null,
        });
      }
      return result;
    } catch (err) {
      // Enrichment is best-effort — a failure here degrades every row to
      // zeroed turn stats + no label inputs (tier 4 fallback), never a
      // failed `transcripts.list` call.
      log.warn(
        `TranscriptListService.fetchEnrichment: enrichment query failed: ${getErrorMessage(err)}`
      );
      return new Map<string, Enrichment>();
    }
  }
}

/**
 * Coerce a `min()`/`max()` raw-SQL aggregate result to a `Date`.
 *
 * Unlike a plain typed column (e.g. `agentTranscriptsTable.startedAt`), a
 * `sql<Date | null>` template built over an aggregate function is NOT run
 * through Drizzle's column-type mapping — postgres.js returns it as an ISO
 * timestamp STRING, not a `Date` instance. Without this coercion,
 * `firstTurnAt`/`lastTurnAt` silently read as non-Date values downstream
 * (e.g. `list-command.ts`'s `toIso()`'s `instanceof Date` check would fail
 * and drop the value to `null` even though real data was returned).
 *
 * mt#2818 R1 nit: grepped for an existing aggregate-date coercion helper
 * elsewhere in the codebase before adding this — none found (`coerceDate`,
 * `toDate`, `parseDate`, `asDate` all came up empty). Kept local rather than
 * pre-emptively generalizing into a shared util for a single call site; if a
 * second raw-SQL aggregate call site needing this shows up, promote it to
 * `packages/domain/src/utils/` then.
 */
function coerceDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    const parsed = new Date(value);
    return isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/** Fields sourced directly from the `agent_transcripts` base row (not enrichment). */
type TranscriptListBaseFields =
  | "agentSessionId"
  | "harness"
  | "startedAt"
  | "endedAt"
  | "cwd"
  | "summary"
  | "relatedTaskIds"
  | "relatedPrNumbers"
  | "lastIngestedJsonlTimestamp";

/**
 * Resolve the best `minsky_session_links` row per `agentSessionId` — highest
 * `confidence` wins; ties break on the most recently `detectedAt`. Mirrors
 * `pickBestLinks` in `src/cockpit/widgets/context-inspector.ts` (mt#2770) —
 * that copy is a private (non-exported) helper local to the widget's own
 * DB-fetch function, so it isn't importable regardless of layer; duplicated
 * here rather than exporting-and-importing across two independently evolving
 * enrichment call sites (context-inspector's fetch shape differs from this
 * service's).
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
