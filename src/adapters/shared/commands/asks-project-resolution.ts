/**
 * Which project does an Ask belong to? (ADR-021)
 *
 * Extracted from `asks.ts` by mt#4772. Two resolvers, one read-side and one
 * write-side, that between them keep `asks.list`'s default filter and
 * `asks.create`'s stamp agreeing on the same `project_id`.
 *
 * The extraction is not cosmetic: adding the write-side precedence pushed
 * `asks.ts` past the 1500-line `max-lines` ceiling, and project resolution is a
 * different concern from command registration — it has its own dependencies
 * (project identity, scope resolution, the task→project lookup) and its own
 * tests. Splitting it here gives both resolvers a real module boundary instead
 * of an `export`-for-testing carve-out in a 2800-line file.
 */

import { log } from "@minsky/shared/logger";
import type { AppContainerInterface } from "@minsky/domain/composition/types";
import type { SqlCapablePersistenceProvider } from "@minsky/domain/persistence/types";

/**
 * Resolve the current project's uuid for project-scoped Ask reads and writes
 * (ADR-021 — mt#2416 read-side, mt#2563 write-side). Single source of truth so
 * `asks.create` stamps the SAME project the `asks.list` default filter reads by:
 * create/list scope parity. Returns the project uuid, or `undefined` when
 * persistence is unavailable, the project is unidentified (hosted server /
 * cockpit daemon with no single-repo cwd), or resolution fails — fail-open to an
 * unscoped read/write, never a throw.
 */
export async function resolveCurrentProjectScope(
  container: AppContainerInterface | undefined,
  caller: string
): Promise<string | undefined> {
  if (!container?.has("persistence")) return undefined;
  try {
    const persistenceProvider = container.get("persistence") as SqlCapablePersistenceProvider;
    if (!persistenceProvider.getDatabaseConnection) return undefined;
    const { resolveProjectIdentity } = await import("@minsky/domain/project/identity");
    const { resolveProjectScope } = await import("@minsky/domain/project/scope-resolver");
    const { isAllProjects } = await import("@minsky/domain/project/scope");
    const identity = resolveProjectIdentity({ repoPath: process.cwd() });
    if (identity.kind !== "resolved") return undefined;
    const rawDb = await persistenceProvider.getDatabaseConnection();
    if (!rawDb) return undefined;
    const scope = await resolveProjectScope(
      identity,
      rawDb as import("@minsky/domain/project/scope-resolver").ScopeResolverDb
    );
    return isAllProjects(scope) ? undefined : scope;
  } catch (err: unknown) {
    log.debug(`[${caller}] Project scope resolution failed; defaulting to unscoped`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Resolve the project a NEW Ask belongs to (mt#4772).
 *
 * Precedence: the PARENT TASK's project, then the filing context. An Ask is
 * ABOUT its parent task, so when the two disagree the parent is the honest
 * answer — the filing context only records which server the agent happened to
 * be connected to. Before this, `asks.create` read the filing context and
 * nothing else, so an Ask on a foreign-project task listed under the wrong
 * project filter while its own activity event (keyed on `relatedTaskId`)
 * rendered under the right one: one entity, two project identities depending
 * on which page you were looking at.
 *
 * Third and last call site of the root mt#4758 fixed for `session_start` and
 * mt#4808 for `tasks_create`: context-derived attribution beating
 * entity-derived attribution on the write path. The parent lookup is mt#4808's
 * `resolveTaskProjectId` REUSED rather than reimplemented — same fail-open
 * contract, already tested against a null `project_id`, a missing row, a
 * broken handle and a rejecting query.
 *
 * Two levels, not mt#4808's three. `tasks_create` accepts an explicit
 * `workspace`/`repo` that outranks the parent; `asks_create` has no such
 * parameter, so this is exactly mt#4808's levels 2 and 3 with level 1 absent
 * — not a divergent precedence.
 *
 * Fails open at every step: a create must not fail, and must not silently
 * switch project, because a lookup did. `undefined` only when NEITHER level
 * resolves, which is the pre-mt#4772 unscoped-Ask behavior unchanged.
 */
export async function resolveNewAskProjectId(
  container: AppContainerInterface | undefined,
  parentTaskId: string | undefined,
  caller: string
): Promise<string | undefined> {
  if (parentTaskId && container?.has("persistence")) {
    try {
      const persistenceProvider = container.get("persistence") as SqlCapablePersistenceProvider;
      const rawDb = await persistenceProvider.getDatabaseConnection?.();
      if (rawDb) {
        const { resolveTaskProjectId } = await import("@minsky/domain/project/new-task-project");
        const parentProjectId = await resolveTaskProjectId(parentTaskId, rawDb);
        if (parentProjectId) return parentProjectId;
      }
    } catch (err: unknown) {
      log.debug(`[${caller}] Parent-task project lookup failed; falling back (mt#4772)`, {
        parentTaskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return resolveCurrentProjectScope(container, caller);
}
