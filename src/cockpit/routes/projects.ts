/**
 * Cockpit project routes (mt#2418 — Phase 1.5 of mt#2391).
 *
 *   GET /api/projects — every known project, for the shell's project selector.
 */
import type express from "express";
import { log } from "@minsky/shared/logger";
import { getContextInspectorDb } from "../db-providers";

/** Shape returned to the frontend selector — a trimmed `ProjectRecord`. */
export interface ProjectSummary {
  id: string;
  slug: string;
  displayName: string | null;
}

/** Mount the /api/projects route on `app`. */
export function mountProjectRoutes(app: express.Express): void {
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
      const db = await getContextInspectorDb();
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
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[projects] GET /api/projects — internal error: ${message}`);
      res.status(500).json({ error: "An internal error occurred while listing projects." });
    }
  });
}
