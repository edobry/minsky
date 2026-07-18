/**
 * Projects list repository (mt#2418 — Phase 1.5 of mt#2391).
 *
 * A single read helper over `projectsTable`: every known project, for the
 * Cockpit project selector (`GET /api/projects`). Kept in `packages/domain`
 * (not `src/cockpit`) so it is reusable by a future CLI `minsky project list`
 * surface without a cross-layer import.
 */

import { asc } from "drizzle-orm";
import { projectsTable, type ProjectRecord } from "../storage/schemas/projects-schema";

/**
 * Narrow DB interface — mirrors the `ScopeResolverDb` pattern in
 * `scope-resolver.ts` so tests can inject a fake without unsafe casts.
 */
export interface ProjectsRepositoryDb {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  select(fields?: any): any;
}

/**
 * List every known project, ordered by slug (stable, human-readable order
 * for a dropdown). Never throws — callers (the cockpit route) decide how to
 * degrade on a DB error; this function lets a genuine query failure surface
 * as a rejected promise rather than swallowing it, since the caller already
 * wraps every route handler in try/catch.
 */
export async function listProjects(db: ProjectsRepositoryDb): Promise<ProjectRecord[]> {
  return db.select().from(projectsTable).orderBy(asc(projectsTable.slug));
}
