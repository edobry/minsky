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
 *
 * ## Fail-open contract (PR #2056 R1)
 *
 * Project scoping is a VIEW CONVENIENCE layered on top of already-working
 * unscoped reads — it must never be able to take a widget down. This
 * function owns the ENTIRE resolution chain (fetching a db handle, resolving
 * the slug) inside ONE try/catch, so a failure ANYWHERE in that chain —
 * `getContextInspectorDb()` returning null, a dynamic-import failure (module
 * resolution can fail at runtime even when it typechecks — see mt#2776), or
 * an unexpected throw from `resolveProjectScope` itself — degrades to
 * `ALL_PROJECTS` rather than propagating. Every consumer (agents.ts,
 * task-list.ts, changesets.ts) calls this function directly with just the
 * raw query param; none of them do their own db-fetch/import, so none of
 * them can be taken down by a project-scope-resolution failure.
 */
import { ALL_PROJECTS, type ProjectScope } from "@minsky/domain/project/scope";
import type { ScopeResolverDb } from "@minsky/domain/project/scope-resolver";
import { log } from "@minsky/shared/logger";

/** Sentinel value the frontend sends to explicitly request the "All projects" view. */
export const ALL_PROJECTS_PARAM = "all";

/**
 * Default db-handle getter — dynamically imports `../db-providers` so this
 * module (and its many `await import("../project-scope")` callers) doesn't
 * pull the persistence layer into its static import graph. Wrapped by the
 * caller's try/catch below, so an import failure here is also fail-open.
 */
async function defaultGetDb(): Promise<ScopeResolverDb | null> {
  const { getContextInspectorDb } = await import("./db-providers");
  return getContextInspectorDb();
}

/**
 * Resolve a cockpit request's `?project=` query param to a `ProjectScope`.
 *
 * - Absent, empty, or the `"all"` sentinel -> `ALL_PROJECTS` (no DB lookup needed).
 * - No db handle available (persistence provider not SQL-capable / not ready)
 *   -> `ALL_PROJECTS`, fail-open (same posture as `resolveProjectScope` itself).
 * - The db-getter or the `resolveProjectScope` import/call throwing for ANY
 *   reason -> `ALL_PROJECTS`, fail-open (this function never throws).
 * - Otherwise -> slug lookup via `resolveProjectScope`, which itself falls
 *   back to `ALL_PROJECTS` when the slug doesn't resolve to a known project
 *   row (never throws).
 *
 * @param projectParam  Raw `req.query.project` / `ctx.query.project` value —
 *   pass the plain string (already coerced from `unknown`/`ParsedQs` by the
 *   caller with a `typeof === "string"` check, matching every other
 *   query-param read in this codebase's route handlers).
 * @param options.getDb  Test seam: override the db-handle getter. Defaults
 *   to {@link defaultGetDb}. Production callers never set this.
 */
export async function resolveCockpitProjectScope(
  projectParam: string | undefined,
  options?: { getDb?: () => Promise<ScopeResolverDb | null> }
): Promise<ProjectScope> {
  if (!projectParam || projectParam === ALL_PROJECTS_PARAM) {
    return ALL_PROJECTS;
  }

  try {
    const getDb = options?.getDb ?? defaultGetDb;
    const db = await getDb();
    if (!db) {
      return ALL_PROJECTS;
    }

    const { resolveProjectScope } = await import("@minsky/domain/project/scope-resolver");
    return await resolveProjectScope(
      { kind: "resolved", slug: projectParam, source: "explicit-flag" },
      db
    );
  } catch (err) {
    log.warn(
      `[cockpit] project-scope resolution failed for slug "${projectParam}"; ` +
        `falling back to ALL_PROJECTS (a scoping failure must never take a widget down)`,
      { error: err instanceof Error ? err.message : String(err) }
    );
    return ALL_PROJECTS;
  }
}
