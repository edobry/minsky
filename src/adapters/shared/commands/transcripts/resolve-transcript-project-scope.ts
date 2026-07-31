/**
 * Project scope resolution for `transcripts.search` / `transcripts.similar`.
 *
 * Mirrors `resolveMemoryProjectScope` in `../memory/index.ts` (ADR-021, mt#2416):
 * resolves the CLI/stdio-MCP process's current project from `process.cwd()` via
 * the mt#2414 slug resolver, then looks up the `projects.id` uuid. Never throws
 * — any resolution failure (unidentified project, no persistence, no matching
 * row) falls back to `undefined`, which callers treat as "no project filter"
 * (unscoped / all-projects), the same fail-open posture ADR-021 uses elsewhere.
 *
 * @see mt#2417 — Phase 1.4 embeddings/transcript project scoping audit
 */

import { log } from "@minsky/shared/logger";
import type { AppContainerInterface } from "@minsky/domain/composition/types";

export interface TranscriptProjectScopeContext {
  container?: AppContainerInterface;
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
  context: TranscriptProjectScopeContext
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

    const { resolveProjectIdentity } = await import("@minsky/domain/project/identity");
    const { resolveProjectScope } = await import("@minsky/domain/project/scope-resolver");
    const { isAllProjects } = await import("@minsky/domain/project/scope");

    const identity = resolveProjectIdentity({ repoPath: process.cwd() });
    if (identity.kind !== "resolved") return undefined;

    const rawDb = await persistence.getDatabaseConnection();
    if (!rawDb) return undefined;

    const { type: _t, ...db } =
      rawDb as import("@minsky/domain/project/scope-resolver").ScopeResolverDb &
        Record<string, unknown>;
    const scope = await resolveProjectScope(
      identity,
      db as import("@minsky/domain/project/scope-resolver").ScopeResolverDb
    );
    return isAllProjects(scope) ? undefined : scope;
  } catch (err: unknown) {
    log.debug("[transcripts] Project scope resolution failed; defaulting to all projects", {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
