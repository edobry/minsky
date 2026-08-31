/**
 * Cockpit work-package routes (ADR-046, mt#2911).
 *
 *   GET  /api/work-packages             — list work-package tasks; claimed_by visible.
 *                                         Default hides terminal (DONE/CLOSED); ?all=true includes.
 *   POST /api/work-packages/:id/claim   — claim a READY package (CAS; refusal names the holder)
 *   POST /api/work-packages/:id/release — release a claimed package back to READY
 *
 * The briefing itself needs no route: a work package IS a task, so the
 * existing task-detail page renders its spec.
 */
import type express from "express";
import { eq, inArray, sql } from "drizzle-orm";
import { log } from "@minsky/shared/logger";
import { getLoggableErrorSummary } from "@minsky/domain/schemas/error";
import { tasksTable } from "@minsky/domain/storage/schemas/task-embeddings";
import { workPackageMembersTable } from "@minsky/domain/storage/schemas/work-package-schema";
import {
  claimWorkPackage,
  releaseWorkPackage,
  WORK_PACKAGE_KIND,
} from "@minsky/domain/tasks/work-package-claim";
import { createCachedSqlDbGetter, describeServerPersistenceUnavailability } from "../db-providers";
import { respondIfDatabaseUnavailable } from "../db-unavailable-response";

const getWorkPackageDb = createCachedSqlDbGetter({ cacheNegative: false });

/**
 * The identity recorded when the operator claims/releases from the cockpit UI.
 * The cockpit is the principal's own surface, so the claim is theirs — a
 * launched agent that takes over re-claims under its own conversation id after
 * a release, or works the member tasks under the operator's claim.
 */
export const COCKPIT_OPERATOR_ACTOR = "cockpit-operator";

/** Statuses hidden from the default list — history, not the pool. */
const TERMINAL_STATUSES = ["DONE", "CLOSED"] as const;

export interface WorkPackageRoutesOptions {
  /** Override the db getter (used in tests). */
  getDbOverride?: () => Promise<unknown>;
}

export function mountWorkPackageRoutes(
  app: express.Express,
  opts: WorkPackageRoutesOptions = {}
): void {
  const getDb = (opts.getDbOverride ?? getWorkPackageDb) as typeof getWorkPackageDb;

  app.get("/api/work-packages", async (req, res) => {
    try {
      const db = await getDb();
      if (!db) {
        res.status(503).json({
          error: `Database unavailable — ${await describeServerPersistenceUnavailability()}`,
        });
        return;
      }
      const includeAll = req.query.all === "true";
      const rows = await db
        .select({
          id: tasksTable.id,
          title: tasksTable.title,
          status: tasksTable.status,
          claimedBy: tasksTable.claimedBy,
          claimedAt: tasksTable.claimedAt,
          updatedAt: tasksTable.updatedAt,
        })
        .from(tasksTable)
        .where(eq(tasksTable.kind, WORK_PACKAGE_KIND));

      const visible = includeAll
        ? rows
        : rows.filter(
            (r) =>
              !TERMINAL_STATUSES.includes((r.status ?? "") as (typeof TERMINAL_STATUSES)[number])
          );

      // One grouped query for member counts, not one per package
      // (efficient-database-queries.mdc).
      const ids = visible.map((r) => r.id);
      const memberCounts = new Map<string, number>();
      if (ids.length > 0) {
        const counts = await db
          .select({
            packageTaskId: workPackageMembersTable.packageTaskId,
            n: sql<number>`count(*)::int`,
          })
          .from(workPackageMembersTable)
          .where(inArray(workPackageMembersTable.packageTaskId, ids))
          .groupBy(workPackageMembersTable.packageTaskId);
        for (const c of counts) memberCounts.set(c.packageTaskId, c.n);
      }

      res.json({
        workPackages: visible.map((r) => ({
          id: r.id,
          title: r.title ?? "",
          status: (r.status ?? "TODO").toUpperCase(),
          claimedBy: r.claimedBy,
          claimedAt: r.claimedAt ? r.claimedAt.toISOString() : null,
          updatedAt: r.updatedAt ? r.updatedAt.toISOString() : null,
          memberCount: memberCounts.get(r.id) ?? 0,
        })),
      });
    } catch (err) {
      if (await respondIfDatabaseUnavailable(res, err, "work-packages")) return;
      log.error(
        `[work-packages] GET /api/work-packages — internal error: ${getLoggableErrorSummary(err)}`
      );
      res.status(500).json({ error: "An internal error occurred while listing work packages." });
    }
  });

  app.post("/api/work-packages/:id/claim", async (req, res) => {
    try {
      const db = await getDb();
      if (!db) {
        res.status(503).json({
          error: `Database unavailable — ${await describeServerPersistenceUnavailability()}`,
        });
        return;
      }
      const taskId = decodeURIComponent(req.params.id);
      const bodyClaimant = (req.body as { claimedBy?: unknown } | undefined)?.claimedBy;
      const claimedBy =
        typeof bodyClaimant === "string" && bodyClaimant.trim()
          ? bodyClaimant.trim()
          : COCKPIT_OPERATOR_ACTOR;
      const outcome = await claimWorkPackage(db, { taskId, claimedBy });
      if (outcome.ok) {
        res.json({ ...outcome, claimedAt: outcome.claimedAt.toISOString() });
        return;
      }
      res.status(outcome.reason === "not-found" ? 404 : 409).json(outcome);
    } catch (err) {
      if (await respondIfDatabaseUnavailable(res, err, "work-packages")) return;
      log.error(`[work-packages] POST claim — internal error: ${getLoggableErrorSummary(err)}`);
      res.status(500).json({ error: "An internal error occurred while claiming the package." });
    }
  });

  app.post("/api/work-packages/:id/release", async (req, res) => {
    try {
      const db = await getDb();
      if (!db) {
        res.status(503).json({
          error: `Database unavailable — ${await describeServerPersistenceUnavailability()}`,
        });
        return;
      }
      const taskId = decodeURIComponent(req.params.id);
      const bodyNotes = (req.body as { notes?: unknown } | undefined)?.notes;
      const outcome = await releaseWorkPackage(db, {
        taskId,
        byConversation: COCKPIT_OPERATOR_ACTOR,
        notes: typeof bodyNotes === "string" && bodyNotes.trim() ? bodyNotes.trim() : undefined,
      });
      if (outcome.ok) {
        res.json(outcome);
        return;
      }
      res.status(outcome.reason === "not-found" ? 404 : 409).json(outcome);
    } catch (err) {
      if (await respondIfDatabaseUnavailable(res, err, "work-packages")) return;
      log.error(`[work-packages] POST release — internal error: ${getLoggableErrorSummary(err)}`);
      res.status(500).json({ error: "An internal error occurred while releasing the package." });
    }
  });
}
