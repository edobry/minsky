/**
 * Cockpit project-scope resolution (mt#2418 — Phase 1.5 of mt#2391).
 *
 * The cockpit daemon serves a shared multi-project Postgres (ADR-021). Per
 * mt#2416's design ("Cockpit daemon" row): scope is supplied PER REQUEST via
 * `req.query.project` (a project slug, e.g. `edobry/minsky` — the same slug
 * form `resolveProjectIdentity()` produces for the CLI), resolved to a
 * project uuid at the route via the shared `resolveProjectScope()` helper.
 * Cockpit's default is ALL PROJECTS (a multi-project dashboard), unlike the
 * CLI/stdio MCP default (resolve-current-repo) — there is no "cwd" for an
 * HTTP request.
 *
 * This module is the ONE place that default-to-ALL + slug-lookup logic
 * lives, so every route/widget that accepts a `?project=` query param goes
 * through the same resolution rules rather than reimplementing them.
 */
import type { ProjectScope } from "@minsky/domain/project/scope";
import type { ScopeResolverDb } from "@minsky/domain/project/scope-resolver";

/** Sentinel value the frontend sends to explicitly request the "All projects" view. */
export const ALL_PROJECTS_PARAM = "all";

/**
 * Resolve a cockpit request's `?project=` query param to a `ProjectScope`.
 *
 * - Absent, empty, or the `"all"` sentinel -> `ALL_PROJECTS` (no DB lookup needed).
 * - No db handle available (persistence provider not SQL-capable / not ready)
 *   -> `ALL_PROJECTS`, fail-open (same posture as `resolveProjectScope` itself).
 * - Otherwise -> slug lookup via `resolveProjectScope`, which itself falls
 *   back to `ALL_PROJECTS` when the slug doesn't resolve to a known project
 *   row (never throws).
 *
 * @param projectParam  Raw `req.query.project` value — pass the plain string
 *   (already coerced from `unknown`/`ParsedQs` by the caller with a
 *   `typeof === "string"` check, matching every other query-param read in
 *   this codebase's route handlers).
 * @param db  A db handle satisfying `ScopeResolverDb`, or `null` when no
 *   SQL-capable persistence provider is configured for this deployment.
 */
export async function resolveCockpitProjectScope(
  projectParam: string | undefined,
  db: ScopeResolverDb | null
): Promise<ProjectScope> {
  const { ALL_PROJECTS } = await import("@minsky/domain/project/scope");

  if (!projectParam || projectParam === ALL_PROJECTS_PARAM || !db) {
    return ALL_PROJECTS;
  }

  const { resolveProjectScope } = await import("@minsky/domain/project/scope-resolver");
  return resolveProjectScope({ kind: "resolved", slug: projectParam, source: "explicit-flag" }, db);
}
