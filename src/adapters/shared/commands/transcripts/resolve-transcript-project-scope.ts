/**
 * Project scope resolution for `transcripts.search` / `transcripts.similar`.
 *
 * Mirrors `resolveMemoryProjectScope` in `../memory/index.ts` (ADR-021, mt#2416):
 * resolves the caller's `workspace` argument, else the process's current project
 * from `process.cwd()`, through the shared read-scope helper (mt#5155) — the
 * mt#2414 slug resolver, then a `projects.id` lookup. Never throws. With no
 * `workspace`, a resolution failure (unidentified cwd, no persistence, no
 * matching row) falls back to `undefined`, which callers treat as "no project
 * filter" (unscoped / all-projects) — ADR-021's fail-open default. With an
 * explicit `workspace` that names no project the read is scoped to the
 * nil-uuid sentinel instead (mt#5155): it returns nothing, never another
 * project's rows.
 *
 * @see mt#2417 — Phase 1.4 embeddings/transcript project scoping audit
 */

import { log } from "@minsky/shared/logger";
import type { AppContainerInterface } from "@minsky/domain/composition/types";

export interface TranscriptProjectScopeContext {
  container?: AppContainerInterface;
}

export interface TranscriptProjectScopeInput {
  /** The caller's `workspace` argument; outranks the process cwd (mt#5155). */
  workspace?: string;
}

/**
 * Resolve a project uuid to scope a transcripts search/similar query, or
 * `undefined` for an unscoped (all-projects) read.
 *
 * @param allProjects - When true, always returns `undefined` (explicit opt-out).
 * @param context - Command execution context carrying the DI container.
 */
export async function resolveTranscriptProjectScope(
  allProjects: boolean | undefined,
  context: TranscriptProjectScopeContext,
  explicit: TranscriptProjectScopeInput = {}
): Promise<string | undefined> {
  if (allProjects) return undefined;

  const persistence = context?.container?.has("persistence")
    ? context.container.get("persistence")
    : undefined;
  if (!persistence) return undefined;

  try {
    const { PersistenceProvider } = await import("@minsky/domain/persistence/types");
    if (!(persistence instanceof PersistenceProvider)) return undefined;
    if (!persistence.capabilities.sql || typeof persistence.getDatabaseConnection !== "function") {
      return undefined;
    }

    const { resolveReadScope, readScopeToProjectScope } = await import(
      "@minsky/domain/project/read-scope"
    );
    const { isAllProjects } = await import("@minsky/domain/project/scope");

    const rawDb = await persistence.getDatabaseConnection();
    // Null handle included (PR #3763 R1): the helper classifies it, so an
    // explicit workspace with no DB reads nothing rather than everything.

    // Pass the handle through UNCOPIED (mt#4509). This previously read
    // `const { type: _t, ...db } = rawDb`, and an object rest-spread copies only own
    // enumerable properties — drizzle defines `select` on the prototype, so every copy
    // arrived without it and every call threw `db.select is not a function`. The stripped
    // `type` key does not exist on the handle, so the destructuring bought nothing.
    //
    // mt#5155: an explicit `workspace` outranks the process cwd (the shared daemon's
    // cwd is the spawner's, ADR-038); one naming no project reads nothing, not all.
    const scope = readScopeToProjectScope(await resolveReadScope(explicit, rawDb, "transcripts"));
    return isAllProjects(scope) ? undefined : scope;
  } catch (err: unknown) {
    log.debug("[transcripts] Project scope resolution failed; defaulting to all projects", {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
