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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  insert(table?: any): any;
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

/**
 * Input for {@link ensureProjectRow}. `repoUrl` is optional — the schema
 * column is nullable (`projects-schema.ts`), and a caller that can't
 * cheaply derive a remote URL (e.g. no git remote configured) may omit it.
 */
export interface EnsureProjectRowInput {
  repoUrl?: string | null;
}

/**
 * Idempotently create the `projects` row for `slug` if it does not already
 * exist (mt#2934 — the provisioning point decided in the mt#2934 spec's
 * "Mechanism" section).
 *
 * Mirrors migration `0047_backfill_project_id_minsky.sql`'s
 * `INSERT ... ON CONFLICT (slug) DO NOTHING` exactly: `slug`'s `UNIQUE`
 * constraint (`projects-schema.ts`) makes re-running this against an
 * already-provisioned slug a true no-op, so callers may invoke it on every
 * `setup` / `setup db` run without a separate existence check.
 *
 * A genuine query failure (connection lost, constraint violation other than
 * the conflict target, etc.) propagates to the caller — same "let real
 * failures surface" contract as {@link listProjects}; callers that must not
 * fail their overall flow on a provisioning error (e.g. `setup`) catch at
 * the call site instead of here.
 */
export async function ensureProjectRow(
  slug: string,
  input: EnsureProjectRowInput,
  db: ProjectsRepositoryDb
): Promise<void> {
  await db
    .insert(projectsTable)
    .values({ slug, repoUrl: input.repoUrl ?? null })
    .onConflictDoNothing({ target: projectsTable.slug });
}
