/**
 * Project scope types for domain read methods (ADR-021, mt#2416).
 *
 * Every domain read method that returns rows scoped to a project accepts a
 * `ProjectScope` parameter.  The caller supplies one of:
 *
 *   - A uuid string  — filter to rows whose `project_id` matches this uuid.
 *   - `ALL_PROJECTS` — no project filter; return cross-project rows.
 *
 * The sentinel is a branded string constant (not `undefined`) so that omitting
 * the argument is a type error — ensuring every call site is explicit about
 * whether it wants scoped or cross-project reads.
 */

/** Sentinel value meaning "no project filter — return rows from all projects." */
export const ALL_PROJECTS = "allProjects" as const;
export type AllProjects = typeof ALL_PROJECTS;

/**
 * Project scope for read queries.
 *
 * - A uuid string: filter rows belonging to that project.
 * - ALL_PROJECTS sentinel: no project filter (return cross-project rows).
 */
export type ProjectScope = string | AllProjects;

/** Type-guard: returns true when scope is the ALL_PROJECTS sentinel. */
export function isAllProjects(scope: ProjectScope): scope is AllProjects {
  return scope === ALL_PROJECTS;
}
