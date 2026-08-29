/**
 * Projects list repository (mt#2418 — Phase 1.5 of mt#2391).
 *
 * A single read helper over `projectsTable`: every known project, for the
 * Cockpit project selector (`GET /api/projects`). Kept in `packages/domain`
 * (not `src/cockpit`) so it is reusable by a future CLI `minsky project list`
 * surface without a cross-layer import.
 */

import { and, asc, eq, isNull } from "drizzle-orm";
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
 * Narrow DB interface for {@link setProjectDisplayNameIfUnset} — kept
 * SEPARATE from {@link ProjectsRepositoryDb} (mt#4729) so adding it doesn't
 * ripple an `update()` stub requirement through every existing fake that
 * already implements that interface (`projects-repository.test.ts`,
 * `setup.test.ts`). A real drizzle db satisfies both structurally.
 */
export interface ProjectsUpdateDb {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  update(table?: any): any;
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
 *
 * `displayName` (mt#4729) is likewise optional and only ever applied on
 * FIRST INSERT — see the function doc comment for why a conflict never
 * touches it.
 */
export interface EnsureProjectRowInput {
  repoUrl?: string | null;
  displayName?: string | null;
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
 *
 * ## Where `displayName` gets set (mt#4729 SC4)
 *
 * `input.displayName` seeds the column on FIRST INSERT only — `ON CONFLICT
 * DO NOTHING` means a re-run against an already-provisioned slug touches
 * NO column, `displayName` included, preserving both this function's
 * existing idempotency contract (see the docstring above) and an
 * operator-set name from ever being silently overwritten by a later
 * `setup`/`setup db` re-run. `provisionProjectRow` (`./provision.ts`) is the
 * production caller and derives this default from the slug via
 * `deriveDisplayNameFromSlug` (`./slug.ts`) when no explicit override is
 * given — i.e. the decision is "project registration time (`minsky
 * setup`/`setup db`), auto-derived from the slug unless overridden."
 * {@link setProjectDisplayNameIfUnset} is the SEPARATE, narrower mechanism
 * for backfilling a project row that predates this default (or whose first
 * insert omitted a displayName for any other reason) — it is the sanctioned
 * setting path for that case, not a hand-typed SQL UPDATE.
 */
export async function ensureProjectRow(
  slug: string,
  input: EnsureProjectRowInput,
  db: ProjectsRepositoryDb
): Promise<void> {
  await db
    .insert(projectsTable)
    .values({ slug, repoUrl: input.repoUrl ?? null, displayName: input.displayName ?? null })
    .onConflictDoNothing({ target: projectsTable.slug });
}

/**
 * Set `displayName` for `slug`, but ONLY when the column is currently
 * null (mt#4729) — never clobbers an operator-set or previously-derived
 * name. This is the sanctioned setting path for backfilling a project row
 * that predates the `ensureProjectRow` auto-derived default (see that
 * function's doc comment): a real, tested, reusable domain function issuing
 * a scoped `UPDATE ... WHERE slug = ? AND display_name IS NULL`, not a
 * hand-typed SQL statement run outside the application.
 *
 * @returns true if a row was actually updated (the slug existed and its
 *   displayName was null), false otherwise (unknown slug, or a name was
 *   already set — both are legitimate no-ops, not errors).
 */
export async function setProjectDisplayNameIfUnset(
  slug: string,
  displayName: string,
  db: ProjectsUpdateDb
): Promise<boolean> {
  const updated = await db
    .update(projectsTable)
    .set({ displayName })
    .where(and(eq(projectsTable.slug, slug), isNull(projectsTable.displayName)))
    .returning({ id: projectsTable.id });
  return updated.length > 0;
}
