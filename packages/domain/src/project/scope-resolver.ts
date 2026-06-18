/**
 * Slug→uuid scope resolver for project-scoped queries (ADR-021, mt#2416).
 *
 * Takes the output of `resolveProjectIdentity()` (a slug string) and looks up
 * the corresponding `projects` table uuid. When the identity is unidentified OR
 * no matching row exists, returns the `ALL_PROJECTS` sentinel so callers see
 * cross-project rows (the "unidentified→ALL" default from ADR-021 §Decision).
 *
 * ## Narrow DB interface
 * Uses the same `MinskyBackendDb` narrow-interface pattern as minskyTaskBackend
 * so tests can inject fakes without unsafe casts.
 */

import { eq } from "drizzle-orm";
import { ALL_PROJECTS, type ProjectScope } from "./scope";
import type { ProjectIdentity } from "./identity";
import { projectsTable } from "../storage/schemas/projects-schema";
import { log } from "@minsky/shared/logger";

// ---------------------------------------------------------------------------
// Narrow DB interface
// ---------------------------------------------------------------------------

export interface ScopeResolverDb {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  select(fields?: any): any;
}

// ---------------------------------------------------------------------------
// Slug → uuid lookup
// ---------------------------------------------------------------------------

/**
 * Resolve a `ProjectIdentity` to a `ProjectScope` suitable for domain read methods.
 *
 * - Resolved identity with a slug → query `projects` table for the uuid.
 *   - Found → return the uuid.
 *   - Not found → return `ALL_PROJECTS` (no matching project row; preserve today's behavior).
 * - Unidentified identity → return `ALL_PROJECTS` (fail-open per ADR-021).
 *
 * Never throws. All error paths return `ALL_PROJECTS` so callers get an
 * unscoped read rather than a crash.
 */
export async function resolveProjectScope(
  identity: ProjectIdentity,
  db: ScopeResolverDb
): Promise<ProjectScope> {
  if (identity.kind === "unidentified") {
    log.debug(
      `[project-scope] Unidentified project identity (${identity.reason}); defaulting to ALL_PROJECTS`
    );
    return ALL_PROJECTS;
  }

  const { slug } = identity;

  try {
    const rows = await db.select().from(projectsTable).where(eq(projectsTable.slug, slug)).limit(1);

    const row = rows[0];
    if (!row) {
      log.debug(
        `[project-scope] No project row found for slug "${slug}"; defaulting to ALL_PROJECTS`
      );
      return ALL_PROJECTS;
    }

    log.debug(`[project-scope] Resolved slug "${slug}" to project id "${row.id}"`);
    return row.id as string;
  } catch (err) {
    log.warn(
      `[project-scope] Failed to resolve slug "${slug}" to project id; defaulting to ALL_PROJECTS`,
      { error: err instanceof Error ? err.message : String(err) }
    );
    return ALL_PROJECTS;
  }
}
