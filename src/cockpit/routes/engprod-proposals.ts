/**
 * Cockpit EngProd proposal-digest routes (mt#3331).
 *
 * The operator-facing half of the toil-miner curation gate (RFC Notion
 * 3ac937f0-3cb4-816e-8af7-e5380f10a24b, Phase 1). Endpoints:
 *
 *   GET  /api/engprod/proposals                  — filed `engprod-proposal`
 *                                                    tasks (any status) + recent
 *                                                    miner runs, raw (grouping
 *                                                    happens client-side —
 *                                                    ../web/lib/engprod-proposals.ts,
 *                                                    mirroring the /digest split)
 *   POST /api/engprod/proposals/:taskId/accept    — accept: task BLOCKED -> TODO
 *                                                    (unblocks into the normal
 *                                                    lifecycle) + ledger
 *                                                    verdict=accepted, atomically
 *   POST /api/engprod/proposals/:taskId/reject    — reject: task BLOCKED -> CLOSED
 *                                                    + ledger verdict=rejected +
 *                                                    the supplied reason, atomically
 *
 * ## Atomicity (spec SC2)
 *
 * "If the two writes diverge, the gate's memory is broken" — a rejected
 * cluster whose ledger verdict never got written would be RE-PROPOSED next
 * run (the ledger is the miner's only memory of a past decision). Both
 * writes therefore run inside ONE `db.transaction()` against the raw
 * `tasksTable` / `engprodProposalLedgerTable` Drizzle handles (bypassing
 * `TaskServiceInterface`, which has no cross-table transaction seam — see
 * `getServerEngprodDb`'s doc comment in `../db-providers.ts`). A missing
 * ledger row for an otherwise-valid BLOCKED proposal task is treated as a
 * hard failure (rolls back the task write too) rather than a partial
 * success — see `LedgerRowMissingError` below.
 *
 * ## Why this bypasses `toilMinerTick`'s own reconciliation pass
 *
 * `toilMinerTick` (packages/domain/src/engprod/toil-miner-tick.ts) ALSO
 * reconciles verdicts every run, by reading each `proposed` ledger row's
 * filed task's CURRENT status (`ProposalLedgerService.reconcileVerdicts`) —
 * but only for rows whose verdict is STILL "proposed". Once this endpoint
 * writes "accepted"/"rejected" directly, that row is no longer eligible for
 * reconciliation on the next tick (its verdict is already terminal) — so an
 * operator action taken here and the miner's own catch-all reconciliation
 * pass never race or double-write. Verified against `reconcileVerdicts`'s
 * `where(eq(..., "proposed"))` filter before this design was chosen (mt#3331
 * premise check).
 *
 * ## Backend assumption
 *
 * Every `engprod-proposal` task observed live is on the "minsky" task
 * backend (verified via `tasks_get` on mt#3419 and mt#3446, both
 * `backend: "minsky"` — the miner's `fileProposal` calls
 * `taskService.createTaskFromTitleAndSpec` with no explicit `backend`
 * override, so it always lands on the multi-backend service's default,
 * which is "minsky" unless the GitHub-issues backend is explicitly enabled).
 * The raw-transaction approach below is therefore safe: `tasksTable` is the
 * SAME Postgres table the minsky backend itself reads/writes
 * (`packages/domain/src/tasks/minskyTaskBackend.ts`). If a future proposal
 * task ever lands on a different backend, its row simply won't be found by
 * `eq(tasksTable.id, taskId)` and the accept/reject call 404s rather than
 * silently touching the wrong store.
 *
 * ## Deliberately NOT project-scoped (mt#4727)
 *
 * `GET /api/engprod/proposals` does not thread `?project=`. The EngProd
 * toil-miner is Minsky's own eng-process tooling — every `engprod-proposal`
 * task it files is filed against Minsky's OWN task backend (see "Backend
 * assumption" above), regardless of which project a multi-project cockpit
 * dashboard happens to be viewing. There is no meaningful "which project do
 * these proposals belong to" question for a project other than Minsky
 * itself, so scoping this endpoint by the dashboard's `?project=` selection
 * would either always resolve to the same set (Minsky) or silently hide the
 * whole digest for any other project — neither is useful. See this task's
 * spec `## Outcome` for the recorded decision.
 */
import type express from "express";
import { eq, and, desc } from "drizzle-orm";
import { log } from "@minsky/shared/logger";
import {
  getServerTaskService,
  getServerEngprodDb,
  describeServerPersistenceUnavailability,
} from "../db-providers";
import { ENGPROD_PROPOSAL_TAG } from "@minsky/domain/engprod/types";
import { ProposalLedgerService } from "@minsky/domain/engprod/ledger-service";
import {
  engprodProposalLedgerTable,
  engprodMinerRunsTable,
} from "@minsky/domain/storage/schemas/engprod-proposal-ledger-schema";
import { tasksTable } from "@minsky/domain/storage/schemas/task-embeddings";
import { respondIfDatabaseUnavailable } from "../db-unavailable-response";
import { getLoggableErrorSummary } from "@minsky/domain/schemas/error";

/** Most recent N miner runs returned per the run-history read. */
const MAX_RUNS = 50;

/** Thrown (and caught) when a BLOCKED proposal task has no matching ledger row — see module doc "Atomicity". */
class LedgerRowMissingError extends Error {
  constructor(taskId: string) {
    super(
      `No engprod_proposal_ledger row found with filed_task_id=${taskId} — refusing to update ` +
        `task status without also writing the ledger verdict (would break the curation gate's memory).`
    );
    this.name = "LedgerRowMissingError";
  }
}

/** Mount the /api/engprod/proposals* routes on `app`. */
export function mountEngprodProposalRoutes(app: express.Express): void {
  /**
   * GET /api/engprod/proposals — raw proposal-digest read model.
   *
   * Returns every `engprod-proposal`-tagged task (any status — a task that
   * has already been accepted/rejected still renders, showing its final
   * disposition rather than disappearing) plus the most recent miner runs.
   * Grouping-by-run and ranking are pure client-side derivation
   * (`../web/lib/engprod-proposals.ts`), mirroring the existing `/digest`
   * split (raw rows over the wire, derivation in one unit-tested module).
   */
  app.get("/api/engprod/proposals", async (_req, res) => {
    try {
      const taskService = await getServerTaskService();
      if (!taskService) {
        res.status(503).json({
          error: `Task service unavailable — ${await describeServerPersistenceUnavailability()}`,
        });
        return;
      }
      const db = await getServerEngprodDb();
      if (!db) {
        res.status(503).json({
          error: `EngProd ledger unavailable — ${await describeServerPersistenceUnavailability()}`,
        });
        return;
      }

      const { formatTaskIdForDisplay } = await import("@minsky/domain/tasks/task-id-utils");

      const [proposalTasks, runRows] = await Promise.all([
        taskService.listTasks({ tags: [ENGPROD_PROPOSAL_TAG], all: true }),
        db
          .select()
          .from(engprodMinerRunsTable)
          .orderBy(desc(engprodMinerRunsTable.startedAt))
          .limit(MAX_RUNS),
      ]);

      const taskIds = proposalTasks.map((t) => formatTaskIdForDisplay(t.id));
      const ledgerService = new ProposalLedgerService(db);
      const ledgerRows = await ledgerService.getByFiledTaskIds(taskIds);
      const ledgerByTaskId = new Map(
        ledgerRows.filter((r) => r.filedTaskId).map((r) => [r.filedTaskId as string, r])
      );

      const proposals = proposalTasks.map((t) => {
        const id = formatTaskIdForDisplay(t.id);
        const ledger = ledgerByTaskId.get(id);
        const snapshot = (ledger?.evidenceSnapshot ?? {}) as { score?: unknown };
        const score = typeof snapshot.score === "number" ? snapshot.score : 0;
        return {
          taskId: id,
          title: t.title ?? "",
          status: (t.status ?? "TODO").toUpperCase(),
          clusterSignature: ledger?.clusterSignature ?? "",
          toolSequence: ledger?.toolSequence ?? [],
          evidenceFrequency: ledger?.evidenceFrequency ?? 0,
          evidenceSessions: ledger?.evidenceSessions ?? 0,
          evidenceChainLength: ledger?.evidenceChainLength ?? 0,
          score,
          rejectionReason: ledger?.rejectionReason ?? null,
          // Ledger row's ORIGINAL insert timestamp — stable across the
          // suppressed-batch overwrite bug documented in
          // ledger-service.ts's getByFiledTaskIds. Falls back to the
          // task's own createdAt (near-identical in practice — both are
          // stamped in the same tick) on the rare miss where no ledger
          // row was found at all.
          createdAt: ledger?.createdAt
            ? ledger.createdAt.toISOString()
            : (t.createdAt?.toISOString?.() ?? new Date(0).toISOString()),
        };
      });

      const runs = runRows.map((r) => ({
        id: r.id,
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
        turnsScanned: r.turnsScanned,
        clustersFound: r.clustersFound,
        clustersSentToLlm: r.clustersSentToLlm,
        proposalsGenerated: r.proposalsGenerated,
        suppressedByDedupe: r.suppressedByDedupe,
        suppressedByBudget: r.suppressedByBudget,
        suppressedByMaximalCollapse: r.suppressedByMaximalCollapse,
        suppressedByLowDistinctiveness: r.suppressedByLowDistinctiveness,
        llmErrors: r.llmErrors,
        errored: r.errored,
      }));

      res.json({ runs, proposals });
    } catch (err) {
      if (await respondIfDatabaseUnavailable(res, err, "engprod-proposals")) return;
      log.error(
        `[engprod-proposals] GET /api/engprod/proposals — internal error: ${getLoggableErrorSummary(err)}`
      );
      res
        .status(500)
        .json({ error: "An internal error occurred while listing EngProd proposals." });
    }
  });

  app.post("/api/engprod/proposals/:taskId/accept", (req, res) => {
    void handleDecision(req, res, "accept");
  });

  app.post("/api/engprod/proposals/:taskId/reject", (req, res) => {
    void handleDecision(req, res, "reject");
  });
}

type DecisionOutcome =
  | { kind: "not-found" }
  | { kind: "not-a-proposal" }
  | { kind: "conflict"; status: string }
  | { kind: "ok"; newStatus: string };

/**
 * Parse the `tasks.tags` column (a JSON-serialized string[], per
 * `task-embeddings.ts`'s schema comment) defensively — malformed content
 * degrades to no tags rather than throwing. Pure and exported so the guard
 * logic below is directly unit-testable (mirrors this file's sibling
 * `tasks.ts`'s convention of extracting pure helpers for routes with no DI
 * seam — see `tasks.test.ts`'s header comment).
 */
export function parseTaskTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Pure guard: given a task row (or none, for a missing id), decide whether
 * an accept/reject action may proceed. Extracted from `handleDecision` so
 * the DECISION rules (not-found / wrong-tag / already-actioned) are
 * testable without a database — same pattern as
 * `ledger-service.ts`'s `decideShouldPropose`/`decideReconciliation`.
 */
export type ProposalGuardResult =
  | { kind: "not-found" }
  | { kind: "not-a-proposal" }
  | { kind: "conflict"; status: string }
  | { kind: "ok" };

export function checkProposalGuard(
  task: { status: string | null | undefined; tags: string | null | undefined } | undefined
): ProposalGuardResult {
  if (!task) return { kind: "not-found" };
  if (!parseTaskTags(task.tags).includes(ENGPROD_PROPOSAL_TAG)) {
    return { kind: "not-a-proposal" };
  }
  if (task.status !== "BLOCKED") {
    return { kind: "conflict", status: task.status ?? "unknown" };
  }
  return { kind: "ok" };
}

/**
 * Pure validation for the reject action's required free-text reason (spec
 * requirement #4). Free text is fine; empty/whitespace-only or a
 * non-string body field is not.
 */
export function validateRejectionReason(
  body: unknown
): { ok: true; reason: string } | { ok: false } {
  const reason = (body as { reason?: unknown } | null | undefined)?.reason;
  if (typeof reason !== "string" || reason.trim().length === 0) {
    return { ok: false };
  }
  return { ok: true, reason: reason.trim() };
}

/**
 * Shared accept/reject handler. Both actions share the identical guard
 * sequence (task exists, is tagged `engprod-proposal`, is currently
 * BLOCKED) and the identical atomicity contract (task status + ledger
 * verdict in one transaction) — they differ only in the target status,
 * the ledger verdict value, and whether a reason is required.
 */
async function handleDecision(
  req: express.Request,
  res: express.Response,
  decision: "accept" | "reject"
): Promise<void> {
  const rawId = req.params.taskId;
  if (!rawId) {
    res.status(400).json({ error: "Task ID required" });
    return;
  }
  const taskId = decodeURIComponent(rawId);

  // Requirement #4 (spec): rejection must capture a reason — free text is
  // fine, but it cannot be empty. The re-surface threshold logic
  // (`decideShouldPropose`'s "rejected" branch) only reads evidenceFrequency,
  // not this text — the reason is the human-readable audit trail a
  // principal reviewing the ledger later depends on, so it is still
  // required at the API boundary rather than treated as optional.
  let reason: string | undefined;
  if (decision === "reject") {
    const validated = validateRejectionReason(req.body);
    if (!validated.ok) {
      res.status(400).json({ error: "A rejection reason is required." });
      return;
    }
    reason = validated.reason;
  }

  try {
    const db = await getServerEngprodDb();
    if (!db) {
      res.status(503).json({
        error: `EngProd ledger unavailable — ${await describeServerPersistenceUnavailability()}`,
      });
      return;
    }

    const newStatus = decision === "accept" ? "TODO" : "CLOSED";

    const outcome: DecisionOutcome = await db.transaction(async (tx) => {
      const taskRows = await tx.select().from(tasksTable).where(eq(tasksTable.id, taskId)).limit(1);
      const task = taskRows[0];

      const guard = checkProposalGuard(task);
      if (guard.kind === "not-found") return { kind: "not-found" };
      if (guard.kind === "not-a-proposal") return { kind: "not-a-proposal" };
      if (guard.kind === "conflict") return { kind: "conflict", status: guard.status };

      const ledgerRows = await tx
        .select()
        .from(engprodProposalLedgerTable)
        .where(eq(engprodProposalLedgerTable.filedTaskId, taskId))
        .limit(1);
      const ledgerRow = ledgerRows[0];
      if (!ledgerRow) {
        // Thrown (not returned) so it propagates out of db.transaction() and
        // rolls back — see class doc + module doc "Atomicity".
        throw new LedgerRowMissingError(taskId);
      }

      const now = new Date();
      await tx
        .update(tasksTable)
        .set({ status: newStatus as (typeof tasksTable.$inferSelect)["status"], updatedAt: now })
        .where(eq(tasksTable.id, taskId));

      // Constrained by BOTH the cluster signature AND the filedTaskId (the
      // same key `checkProposalGuard`/the ledger lookup above resolved this
      // row through) — not clusterSignature alone. Belt-and-suspenders: today
      // clusterSignature is the ledger's primary key, so a signature-only
      // WHERE cannot address a second row — but anchoring to the SAME key
      // the guard used makes the task-scoped intent explicit in the query
      // itself, so a future schema change (e.g. a non-unique signature, or a
      // second ledger row keyed differently) can't silently widen this
      // UPDATE's blast radius without also changing this WHERE clause
      // (reviewer finding, PR #2507 R1).
      await tx
        .update(engprodProposalLedgerTable)
        .set({
          verdict: decision === "accept" ? "accepted" : "rejected",
          rejectionReason: decision === "reject" ? (reason ?? null) : null,
          updatedAt: now,
        })
        .where(
          and(
            eq(engprodProposalLedgerTable.clusterSignature, ledgerRow.clusterSignature),
            eq(engprodProposalLedgerTable.filedTaskId, taskId)
          )
        );

      return { kind: "ok", newStatus };
    });

    switch (outcome.kind) {
      case "not-found":
        res.status(404).json({ error: `Task ${taskId} not found` });
        return;
      case "not-a-proposal":
        res.status(400).json({ error: `Task ${taskId} is not an EngProd proposal` });
        return;
      case "conflict":
        res.status(409).json({
          error: `Task ${taskId} is not BLOCKED (current status: ${outcome.status}) — it may have already been actioned.`,
        });
        return;
      case "ok":
        res.json({ ok: true, taskId, status: outcome.newStatus });
        return;
    }
  } catch (err) {
    if (await respondIfDatabaseUnavailable(res, err, "engprod-proposals")) return;
    if (err instanceof LedgerRowMissingError) {
      log.error(`[engprod-proposals] ${decision} on ${taskId} — ${err.message}`);
      res.status(500).json({ error: err.message });
      return;
    }
    log.error(
      `[engprod-proposals] POST .../${decision} — internal error: ${getLoggableErrorSummary(err)}`
    );
    res.status(500).json({ error: `An internal error occurred while processing the ${decision}.` });
  }
}
