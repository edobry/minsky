/**
 * Cockpit project routes (mt#2418 — Phase 1.5 of mt#2391).
 *
 *   GET /api/projects — every known project, for the shell's project selector.
 */
import type express from "express";
import { log } from "@minsky/shared/logger";
import { getContextInspectorDb } from "../db-providers";
import { respondIfDatabaseUnavailable } from "../db-unavailable-response";
import { getLoggableErrorSummary } from "@minsky/domain/schemas/error";

/** Shape returned to the frontend selector — a trimmed `ProjectRecord`. */
export interface ProjectSummary {
  id: string;
  slug: string;
  displayName: string | null;
}

/** Injection seam for {@link mountProjectRoutes}. */
export interface ProjectRoutesOptions {
  /**
   * Test seam: override the database resolution (mt#3254).
   *
   * The default reaches `getContextInspectorDb()`, the PRODUCTION resolution
   * path, which a test process is refused. A test asserting this route's
   * no-database degradation injects `async () => null` rather than resolving
   * whatever the environment happens to point at.
   *
   * Simplified signature, deliberately NOT `typeof getContextInspectorDb` —
   * that type also carries the production-only `__resetForTests` method, which
   * a plain test fake has no reason to implement (same convention as
   * `driven-session-launch.ts`'s seams).
   */
  getDb?: () => ReturnType<typeof getContextInspectorDb>;
}

/** Mount the /api/projects route on `app`. */
export function mountProjectRoutes(app: express.Express, opts: ProjectRoutesOptions = {}): void {
  const resolveDb = opts.getDb ?? getContextInspectorDb;
  /**
   * GET /api/projects — every known project (mt#2418).
   *
   * Returns: { projects: ProjectSummary[] }
   *
   * Degrades to an empty list (200, not 503) when no SQL-capable persistence
   * provider is configured — a single-project / non-Postgres deployment has
   * no `projects` table to read, and the shell's selector should render as
   * "no projects known" (effectively hiding itself) rather than erroring.
   */
  app.get("/api/projects", async (_req, res) => {
    try {
      const db = await resolveDb();
      if (!db) {
        res.json({ projects: [] });
        return;
      }

      const { listProjects } = await import("@minsky/domain/project/projects-repository");
      const rows = await listProjects(db);
      const projects: ProjectSummary[] = rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        displayName: r.displayName,
      }));
      res.json({ projects });
    } catch (err) {
      if (await respondIfDatabaseUnavailable(res, err, "projects")) return;
      log.error(`[projects] GET /api/projects — internal error: ${getLoggableErrorSummary(err)}`);
      res.status(500).json({ error: "An internal error occurred while listing projects." });
    }
  });
}
