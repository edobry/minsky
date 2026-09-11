/**
 * TitlePipeline (mt#3321)
 *
 * Fills `agent_transcripts.title` for conversations that don't have one yet,
 * and REFRESHES it for a conversation that has grown materially since it was
 * titled (mt#4961) — a title minted from a conversation's first few turns
 * otherwise never revisits the subject as the conversation moves on. See
 * {@link TITLE_REFRESH_GROWTH_FACTOR} and {@link titleCandidateConditions}'s
 * second branch for the threshold and why it terminates.
 *
 * **The work set is "untitled AND not already asked" (mt#4179).** It used to be
 * `WHERE title IS NULL` alone, which reads as idempotent-by-construction and is
 * — but only for rows that CAN succeed. A row the model declines to title
 * (nothing in it names a subject) stays NULL forever and is re-selected on
 * every tick, so with the batch ordered newest-first those rows accumulate at
 * the head of the queue until they fill it. Measured 2026-08-16: 15 consecutive
 * sweeps, 25 candidates each, ~25 skipped, 0 errored, while 1,289 older untitled
 * rows sat below a block of ~29 permanent skips and could never be reached.
 * `title_attempted_at` is what makes "not yet tried" distinguishable from
 * "tried, cannot succeed"; the batch advances because a stamped row leaves the
 * candidate set.
 *
 * **Content comes from `agent_transcript_turns`, not the raw blob (mt#4179).**
 * ADR-025 (Accepted) drops `agent_transcripts.transcript`; the per-turn rows
 * survive it and are written on capture (ADR-019 / mt#2381), so reading them
 * both outlives the column and stops pulling a multi-megabyte JSONB blob into
 * memory per candidate.
 *
 * **Batched and SQL-filtered.** Deliberately NOT modeled on
 * {@link SummaryPipeline}, which `SELECT`s every row in `agent_transcripts`
 * and filters in memory — fine for a hand-run backfill, wrong for something
 * on a timer. This filters and limits in SQL, so a tick costs one bounded
 * query plus at most `batchSize` completion calls regardless of table size.
 * That bound is also the API-spend control while the ~2k-row history drains.
 *
 * **Failures are recorded, never swallowed into "nothing to do."** A provider
 * error increments `errored` and logs with the session id; it does NOT write a
 * placeholder title, and — since mt#4179 — it does NOT stamp
 * `title_attempted_at` either, so a model outage retries later instead of being
 * recorded as a verdict about the conversation. This is deliberate: a mechanism
 * whose broken dependency degrades into a looks-like-success empty result is
 * this codebase's dominant latent-bug shape (mem#682), and a title pipeline
 * that silently titled nothing forever would be invisible from every surface.
 *
 * @see mt#3321 — this module
 * @see mt#4179 — the head-of-line fix and the turns-table source
 * @see mt#4961 — the growth-crossing refresh + handoff-aware prompt
 * @see title-generator.ts — the model call
 * @see src/cockpit/sweepers.ts — `startConversationTitleSweeper`, the invocation path
 */

import { and, asc, desc, eq, isNotNull, or, sql, type SQLWrapper } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { agentTranscriptsTable } from "../storage/schemas/agent-transcripts-schema";
import { agentTranscriptTurnsTable } from "../storage/schemas/agent-transcript-turns-schema";
import { tasksTable } from "../storage/schemas/task-embeddings";
import { workPackageMembersTable } from "../storage/schemas/work-package-schema";
import { getLoggableErrorSummary } from "../errors/index";
import { log } from "@minsky/shared/logger";
import type { CognitionProvider } from "../cognition/types";
import {
  TitleGenerator,
  selectTitleTurns,
  selectRefreshTitleTurns,
  TURN_SCAN_LIMIT,
  type IndexedTitleTurn,
  type WorkPackageLookup,
} from "./title-generator";

/**
 * Resolve a handoff-claimed task id to its work package's title and member
 * list (mt#4961, SC3) — the {@link WorkPackageLookup} `TitleGenerator` calls
 * when a conversation's first human turn matches the succession-claim shape.
 *
 * Returns null for anything that isn't a `work-package`-kind task: a bare
 * `handoff mt#N` naming an ordinary task is not this pattern, and the
 * generator falls through to its normal opening-turns prompt rather than
 * title the session after a task that merely shares the claim's id.
 */
async function lookupWorkPackage(
  db: PostgresJsDatabase,
  taskId: string
): Promise<{ title: string; members: Array<{ id: string; title: string | null }> } | null> {
  const [task] = await db
    .select({ title: tasksTable.title, kind: tasksTable.kind })
    .from(tasksTable)
    .where(eq(tasksTable.id, taskId))
    .limit(1);
  if (!task || task.kind !== "work-package") return null;

  const memberRows = await db
    .select({ memberTaskId: workPackageMembersTable.memberTaskId, memberTitle: tasksTable.title })
    .from(workPackageMembersTable)
    .leftJoin(tasksTable, eq(tasksTable.id, workPackageMembersTable.memberTaskId))
    .where(eq(workPackageMembersTable.packageTaskId, taskId))
    .orderBy(asc(workPackageMembersTable.rank));

  return {
    title: task.title ?? taskId,
    members: memberRows.map((m) => ({ id: m.memberTaskId, title: m.memberTitle ?? null })),
  };
}

/**
 * Rows titled per tick. Bounds both wall-clock and API spend for one run.
 * Sized so the ~2k-row backlog drains over a few hours at the sweeper's
 * cadence rather than in one burst of completion calls.
 */
export const DEFAULT_TITLE_BATCH_SIZE = 25;

/**
 * Why an attempt produced no title. Persisted to `title_skip_reason`.
 *
 * The three are distinguished because they have DIFFERENT re-ask triggers, not
 * for reporting flavor:
 *
 * - `no-turns` — the conversation has no text-bearing turn row *yet*. This can
 *   be a race rather than a verdict (see {@link TitlePipeline.candidateConditions}),
 *   so it is the one reason that re-enters the candidate set on turn arrival.
 * - `no-content` — turn rows exist, but nothing in the scanned window survives
 *   markup/attachment stripping. Deterministic given the content; re-asked only
 *   when new content arrives.
 * - `no-subject` — the model read real content and declined to name a subject.
 *   Also re-asked only on new content.
 *
 * `no-content` is split out from `no-subject` because only the latter cost a
 * model call: collapsing them would make the skip counters unable to say
 * whether the model declined or was never asked.
 */
export type TitleSkipReason = "no-turns" | "no-content" | "no-subject";

export interface TitlePipelineRunResult {
  /** Rows selected as candidates this run (bounded by `batchSize`). */
  candidates: number;
  /**
   * Rows that had NO PRIOR title and received one this run — a FIRST titling.
   * Distinct from {@link refreshed} (mt#4961): both write the same column,
   * but they answer different operator questions ("is the backlog draining?"
   * vs "is the refresh mechanism doing anything?").
   */
  titled: number;
  /**
   * Rows that ALREADY had a title and had it REPLACED this run — the
   * growth-crossing refresh {@link titleCandidateConditions}'s second branch
   * selects for (mt#4961, SC1/SC5). A refresh whose model answer is
   * `no-subject` does NOT count here — the existing title survives, so
   * nothing was replaced; it falls into `skippedNoSubject` below like any
   * other no-subject attempt.
   */
  refreshed: number;
  /** Rows attempted that produced no title. Sum of the two breakdowns below. */
  skipped: number;
  /** Skipped because the conversation has no text-bearing turn row at all. */
  skippedNoTurns: number;
  /** Skipped because every scanned turn was markup/attachment only — no model call made. */
  skippedNoContent: number;
  /** Skipped because the model read real content and found no identifiable subject. */
  skippedNoSubject: number;
  /** Rows that errored (provider or write failure). Left unstamped for a later retry. */
  errored: number;
}

export interface TitlePipelineOptions {
  /** Re-title rows that already have a title, and re-ask rows already attempted. Default: false. */
  force?: boolean;
  /** Rows per run. Default: {@link DEFAULT_TITLE_BATCH_SIZE}. */
  batchSize?: number;
}

/**
 * How much a titled conversation must have grown, in TOTAL turn count (every
 * `agent_transcript_turns` row, not just text-bearing ones — the same count a
 * reader would see as "N turns" on the conversation), before it re-enters the
 * candidate set for a REFRESH (mt#4961, SC1).
 *
 * Grounded in the corpus measured 2026-09-11 against the 503 conversations
 * titled within 30 minutes of their first turn — the "live" regime, i.e. the
 * population an ongoing refresh mechanism actually governs, as distinct from
 * the one-off historical backfill mt#3321 ran once: growth p50 5.75x, p75
 * 11.8x, p90 21.7x; 266 of 503 (53%) had grown at least 5x by the time they
 * were measured. 5 sits at roughly the live median, so about half of ongoing
 * conversations cross it at least once over their life — high enough that a
 * conversation which merely continued its opening subject is left alone, low
 * enough to catch the drift this task exists to fix (the originating case:
 * titled at 2 turns, 163 turns by the time the principal noticed — an 81x
 * eventual growth that this factor would have caught on its first crossing,
 * at 10 turns).
 *
 * **Why it terminates.** The comparison is against the turn count AT THE LAST
 * ATTEMPT, and every attempt — the success path (`.set({ title, ... })`
 * below) and {@link TitlePipeline.recordSkip}'s `no-subject` re-ask alike —
 * unconditionally re-stamps `title_attempted_at` to `now()`. So a refresh
 * re-bases its own comparison: the NEXT refresh needs another full
 * {@link TITLE_REFRESH_GROWTH_FACTOR}x on top of the count AT THIS refresh,
 * not on top of the count when the row was first titled. A p90 conversation
 * (182 turns, titled at ~21) crosses once at 105 and again only at 525 — at
 * most a handful of refreshes over any conversation's life, never a per-tick
 * re-trigger. This is the SAME invariant mt#4179 fixed for the untitled
 * branch below (a stamped row leaves the candidate set) applied to the titled
 * branch this task adds; see that task's docblock for the incident it fixed.
 */
export const TITLE_REFRESH_GROWTH_FACTOR = 5;

/**
 * WHERE condition selecting titling candidates — the ONE definition.
 *
 * Exported, and a free function rather than a method, because it has a SECOND
 * caller: `scripts/smoke-conversation-titles.ts` previews the candidate set the
 * sweeper would pick. That script used to restate the filter, and a restated
 * filter drifts — it drifted twice inside mt#4179 alone (it still carried
 * `transcript IS NOT NULL AND title IS NULL` after the pipeline had moved on,
 * and then still lacked the `no-turns` clause after the pipeline gained it, which
 * is what PR #3040 R1 caught). An acceptance instrument that previews a
 * different query than the one it exists to check is worse than no instrument,
 * so there is now nothing to keep in sync.
 *
 * **One OR of two branches (mt#4961).** Until this task the whole condition
 * was an AND — untitled AND not-already-asked — expressed as a two-element
 * array the caller ANDed together. A row is now ALSO a candidate when it is
 * ALREADY titled and has grown enough since to warrant a refresh, and that is
 * structurally an OR, not another AND-ed clause: a row qualifies via EITHER
 * branch, not both. So this now returns a SINGLE array element — one big OR
 * expression spanning both branches — rather than two ANDed ones;
 * {@link TitlePipeline.candidateConditionCount} reports 1 in normal mode (was
 * 2), 0 under `force` (unchanged — force still drops every filter).
 *
 * Built as an explicit array (rather than a conditional `undefined` folded
 * into `and(...)`, PR #2408 R1) purely so `candidateConditionCount()` stays a
 * meaningful assertion of the query's SHAPE; the OR/AND structure inside the
 * one element is plain SQL text, not composed from drizzle's `and()`/`or()`
 * helpers, so nothing here depends on their `SQL | undefined` return type.
 *
 * ── Branch 1: untitled ──────────────────────────────────────────────────
 *
 * The `transcript IS NOT NULL` condition this used to carry is gone with the
 * blob read (mt#4179). A contentless row is no longer excluded up front — it
 * is attempted once, stamped, and leaves the candidate set, which costs one
 * slot exactly once instead of a permanent filter on a column ADR-025 removes.
 *
 * The inner OR closes a two-channel race. Content comes from
 * `agent_transcript_turns`, but the re-ask trigger is
 * `last_ingested_jsonl_timestamp` — the BLOB-ingest high-water mark. Those are
 * different channels: ingest writes the transcript row and its HWM BEFORE the
 * turn rows, turn writes are tolerated-partial by design (mt#2457/mt#3514),
 * and the embeddings-path re-materialization deliberately does not bump the
 * HWM. So an attempt landing in that window sees zero turns for a conversation
 * that has content, and the HWM clause alone would never re-open it. A
 * `no-turns` row therefore also re-enters once a text-bearing turn row EXISTS.
 *
 * That clause is scoped to `no-turns` precisely so it terminates: the re-ask
 * either produces a title or lands on `no-content` / `no-subject`, neither of
 * which the clause matches. Widening it to every skip reason would re-create
 * the permanent-candidate defect mt#4179 exists to fix, one reason over.
 *
 * ── Branch 2: titled, grown enough to refresh (mt#4961) ────────────────
 *
 * `title IS NOT NULL AND title_attempted_at IS NOT NULL` scopes this branch to
 * rows that have genuinely been titled and attempted — matching
 * {@link TITLE_REFRESH_GROWTH_FACTOR}'s docblock, which explains why the
 * comparison terminates. Both turn counts are DERIVED from
 * `agent_transcript_turns` at query time; no column stores "turn count at
 * titling" — the row's own `title_attempted_at` is the only state needed, and
 * re-stamping it on every attempt is what re-bases the comparison for free.
 * `GREATEST(..., 1)` guards a titled-but-somehow-zero-turns-at-titling row
 * (defensive; should not occur in practice) from a divide-by-zero-shaped
 * comparison against `0 * anything`.
 *
 * Both EXISTS/subquery forms are written as raw SQL rather than drizzle's
 * query-builder helpers because {@link TitlePipeline.candidateConditionCount}
 * exercises this function with a fake `db` — building either subquery through
 * the real query builder would make the shape assertion depend on the fake.
 */
export function titleCandidateConditions(): SQLWrapper[] {
  return [
    sql`(
      (
        ${agentTranscriptsTable.title} IS NULL
        AND (${agentTranscriptsTable.titleAttemptedAt} IS NULL
             OR ${agentTranscriptsTable.lastIngestedJsonlTimestamp} > ${agentTranscriptsTable.titleAttemptedAt}
             OR (${agentTranscriptsTable.titleSkipReason} = 'no-turns' AND EXISTS (
                   SELECT 1 FROM ${agentTranscriptTurnsTable} turns_probe
                    WHERE turns_probe.agent_session_id = ${agentTranscriptsTable.agentSessionId}
                      AND (turns_probe.user_text IS NOT NULL
                           OR turns_probe.assistant_text IS NOT NULL))))
      )
      OR
      (
        ${agentTranscriptsTable.title} IS NOT NULL
        AND ${agentTranscriptsTable.titleAttemptedAt} IS NOT NULL
        AND (SELECT count(*) FROM ${agentTranscriptTurnsTable} turns_now
              WHERE turns_now.agent_session_id = ${agentTranscriptsTable.agentSessionId})
            >= ${TITLE_REFRESH_GROWTH_FACTOR} * GREATEST(
              (SELECT count(*) FROM ${agentTranscriptTurnsTable} turns_at_titling
                WHERE turns_at_titling.agent_session_id = ${agentTranscriptsTable.agentSessionId}
                  AND turns_at_titling.started_at <= ${agentTranscriptsTable.titleAttemptedAt}),
              1)
      )
    )`,
  ];
}

export class TitlePipeline {
  private readonly generator: TitleGenerator;

  constructor(
    private readonly db: PostgresJsDatabase,
    cognitionProvider: CognitionProvider,
    private readonly options: TitlePipelineOptions = {}
  ) {
    // mt#4961, SC3 — bound to this instance's `db` so the generator itself
    // stays free of any DB import; see `lookupWorkPackage` above.
    const workPackageLookup: WorkPackageLookup = (taskId) => lookupWorkPackage(this.db, taskId);
    this.generator = new TitleGenerator(cognitionProvider, undefined, workPackageLookup);
  }

  /** {@link titleCandidateConditions}, or none at all under `force`. */
  private candidateConditions(): SQLWrapper[] {
    // force re-titles every row — both filters are omitted rather than negated.
    if (this.options.force) return [];
    return titleCandidateConditions();
  }

  /**
   * Number of WHERE conditions the current options produce — 1 normally (the
   * single OR spanning the untitled and titled-and-grown-enough-to-refresh
   * branches, mt#4961), 0 under `force` (every row). Exposed for tests so the
   * force branch's query shape is asserted against the real builder rather
   * than inferred from a fake DB.
   */
  candidateConditionCount(): number {
    return this.candidateConditions().length;
  }

  async run(): Promise<TitlePipelineRunResult> {
    const result: TitlePipelineRunResult = {
      candidates: 0,
      titled: 0,
      refreshed: 0,
      skipped: 0,
      skippedNoTurns: 0,
      skippedNoContent: 0,
      skippedNoSubject: 0,
      errored: 0,
    };
    const batchSize = this.options.batchSize ?? DEFAULT_TITLE_BATCH_SIZE;
    const conditions = this.candidateConditions();

    // `title` rides along on the same select so `run()` can tell a FIRST
    // titling from a REFRESH without a second query (mt#4961) — the row
    // already had a title going in exactly when this run is refreshing it,
    // since the candidate query's OR only admits an untitled row or a
    // titled-and-grown-enough one.
    let rows: Array<{ agentSessionId: string; title: string | null }>;
    try {
      const base = this.db
        .select({
          agentSessionId: agentTranscriptsTable.agentSessionId,
          title: agentTranscriptsTable.title,
        })
        .from(agentTranscriptsTable);
      rows = await (conditions.length > 0 ? base.where(and(...conditions)) : base)
        // Newest first: the conversation an operator is most likely looking at
        // right now is the one that most needs a readable title.
        .orderBy(sql`${agentTranscriptsTable.startedAt} DESC NULLS LAST`)
        .limit(batchSize);
    } catch (err) {
      log.error("TitlePipeline: failed to load candidate transcripts", {
        error: getLoggableErrorSummary(err),
      });
      return result;
    }

    result.candidates = rows.length;

    for (const row of rows) {
      const isRefresh = row.title !== null;
      try {
        const outcome = await this.titleRow(row.agentSessionId, isRefresh);
        if (outcome === null) {
          if (isRefresh) result.refreshed++;
          else result.titled++;
        } else {
          result.skipped++;
          if (outcome === "no-turns") result.skippedNoTurns++;
          else if (outcome === "no-content") result.skippedNoContent++;
          else result.skippedNoSubject++;
        }
      } catch (err) {
        result.errored++;
        log.warn(`TitlePipeline: failed to title ${row.agentSessionId}`, {
          error: getLoggableErrorSummary(err),
        });
      }
    }

    if (result.candidates > 0) {
      log.info("TitlePipeline: run complete", { ...result });
    }
    return result;
  }

  /**
   * Generate and persist a title for one transcript — a first titling when
   * `isRefresh` is false, a growth-crossing REFRESH when true (mt#4961).
   *
   * Returns `null` when a title was written, or the {@link TitleSkipReason}
   * recorded when none could be. Both outcomes stamp `title_attempted_at`, so
   * the row leaves the candidate set either way (and, for a refresh, RE-BASES
   * the growth comparison — see {@link TITLE_REFRESH_GROWTH_FACTOR}); a THROW
   * (provider failure) propagates without stamping, leaving the row for a
   * later tick.
   *
   * A refresh's model call sees a WIDER window than a first titling: the
   * opening PLUS a recent-weighted tail ({@link selectRefreshTitleTurns}),
   * because the whole reason a refresh fires is that the conversation moved
   * on from its opening. A `no-subject` answer here is `recordSkip`'s
   * ordinary path — it does NOT clear `title`, so the existing title survives
   * a refresh the model declines to name a new subject for.
   */
  private async titleRow(
    agentSessionId: string,
    isRefresh: boolean
  ): Promise<TitleSkipReason | null> {
    const headTurns = await this.loadTurns(agentSessionId);
    if (headTurns.length === 0) return this.recordSkip(agentSessionId, "no-turns");

    // Applied HERE as well as inside the generator so the two no-model-call
    // cases stay distinguishable: a row whose every scanned turn is markup or
    // an attachment placeholder is `no-content`, not `no-subject`. Letting the
    // generator's own empty-selection guard answer for both would report a
    // model verdict for a call that was never made.
    let visible: IndexedTitleTurn[];
    if (isRefresh) {
      const tailTurns = await this.loadTailTurns(agentSessionId);
      visible = selectRefreshTitleTurns(headTurns, tailTurns);
    } else {
      visible = selectTitleTurns(headTurns);
    }
    if (visible.length === 0) return this.recordSkip(agentSessionId, "no-content");

    const title = await this.generator.generateTitle(agentSessionId, visible);
    if (!title) return this.recordSkip(agentSessionId, "no-subject");

    await this.db
      .update(agentTranscriptsTable)
      .set({ title, titleAttemptedAt: new Date(), titleSkipReason: null })
      // `agentSessionId` is a BRANDED ConversationId column, so a plain string
      // does not satisfy `eq`'s type; the sql template binds it as a parameter.
      .where(sql`${agentTranscriptsTable.agentSessionId} = ${agentSessionId}`);

    return null;
  }

  /**
   * The conversation's OPENING turns that carry any text at all, scanning up
   * to {@link TURN_SCAN_LIMIT}. Used directly for a first titling, and as the
   * HEAD half of a refresh's window ({@link selectRefreshTitleTurns}).
   *
   * Rows with both text columns NULL are dropped in SQL because they are the
   * BULK of a working conversation's opening — an agent running Read/Grep/Bash
   * emits them continuously — and letting them consume the scan window is the
   * defect this fixes. The finer judgment (a turn whose only text is an
   * attachment placeholder or harness markup) belongs to the generator, which
   * owns what the model sees.
   */
  private async loadTurns(agentSessionId: string): Promise<IndexedTitleTurn[]> {
    return await this.db
      .select({
        turnIndex: agentTranscriptTurnsTable.turnIndex,
        userText: agentTranscriptTurnsTable.userText,
        assistantText: agentTranscriptTurnsTable.assistantText,
      })
      .from(agentTranscriptTurnsTable)
      .where(
        and(
          eq(agentTranscriptTurnsTable.agentSessionId, agentSessionId),
          or(
            isNotNull(agentTranscriptTurnsTable.userText),
            isNotNull(agentTranscriptTurnsTable.assistantText)
          )
        )
      )
      .orderBy(asc(agentTranscriptTurnsTable.turnIndex))
      .limit(TURN_SCAN_LIMIT);
  }

  /**
   * The conversation's LAST {@link TURN_SCAN_LIMIT} text-bearing turns, in
   * ASCENDING (conversation) order — the TAIL half of a refresh's window
   * (mt#4961). Ordered DESC in SQL (so `LIMIT` keeps the most recent ones) and
   * reversed in memory, since drizzle has no "last N in ascending order" form.
   */
  private async loadTailTurns(agentSessionId: string): Promise<IndexedTitleTurn[]> {
    const rows = await this.db
      .select({
        turnIndex: agentTranscriptTurnsTable.turnIndex,
        userText: agentTranscriptTurnsTable.userText,
        assistantText: agentTranscriptTurnsTable.assistantText,
      })
      .from(agentTranscriptTurnsTable)
      .where(
        and(
          eq(agentTranscriptTurnsTable.agentSessionId, agentSessionId),
          or(
            isNotNull(agentTranscriptTurnsTable.userText),
            isNotNull(agentTranscriptTurnsTable.assistantText)
          )
        )
      )
      .orderBy(desc(agentTranscriptTurnsTable.turnIndex))
      .limit(TURN_SCAN_LIMIT);
    return rows.reverse();
  }

  /** Stamp an attempt that produced no title, and echo the reason back to the caller. */
  private async recordSkip(
    agentSessionId: string,
    reason: TitleSkipReason
  ): Promise<TitleSkipReason> {
    await this.db
      .update(agentTranscriptsTable)
      .set({ titleAttemptedAt: new Date(), titleSkipReason: reason })
      // Branded-column binding, same as the title write above.
      .where(sql`${agentTranscriptsTable.agentSessionId} = ${agentSessionId}`);
    return reason;
  }
}
