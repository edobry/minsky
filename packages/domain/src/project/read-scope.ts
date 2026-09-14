/**
 * Project scope for a READ, resolved from the caller's argument before the
 * process (mt#5155).
 *
 * ADR-021 §Decision: "CLI and stdio MCP resolve the current project
 * per-process via `resolveProjectIdentity`". That was written for a stdio
 * daemon spawned per conversation, whose cwd WAS the project. ADR-038 made the
 * daemon shared, so `process.cwd()` there is the spawner's directory for every
 * caller — and eight read sites resolved from it while the caller's explicit
 * `workspace` / `repo` argument went unread. This module is the one place a
 * read's scope is decided, with the precedence ADR-021 already records for
 * writes (§"Writes resolve from the entity"): the explicit argument first.
 *
 *   1. `allProjects` → every project (the opt-out ADR-021 names).
 *   2. `workspace` (a path) → that path's project.
 *   3. `repo` → a path resolves like `workspace`; an `owner/name` slug resolves
 *      through `projects.slug`.
 *   4. Otherwise the process cwd — the CLI's own directory, or, on the shared
 *      daemon, the spawner's (mt#5168 supplies the caller's cwd on this rung).
 *
 * The explicit rungs do NOT fail open. ADR-021's "unidentified → ALL" default
 * exists for the ambient case — a misconfigured cwd should still see something
 * — and it stays on rung 4. An argument the caller NAMED that resolves to no
 * project is answered with `unresolved` and a reason, and the read returns
 * nothing, because "everything" is the wrong answer to "show me X": it is how
 * flotato's `tasks_list --workspace …/flotato` returned 1016 minsky tasks
 * before that project had a row (mt#5152, 2026-09-14T20:44Z).
 */

import { existsSync } from "fs";
import { isAbsolute, resolve as resolvePath } from "path";
import { log } from "@minsky/shared/logger";
import { resolveProjectIdentity, type ProjectIdentity } from "./identity";
import { resolveScopeOutcome, scopeFromOutcome } from "./scope-resolver";
import { ALL_PROJECTS, type ProjectScope } from "./scope";
import { extractOwnerRepo } from "./slug";

export interface ReadScopeInput {
  /** The caller's `workspace` argument — a filesystem path. */
  workspace?: string;
  /** The caller's `repo` argument — a filesystem path, or an `owner/name` slug. */
  repo?: string;
  /** The opt-out: read every project. */
  allProjects?: boolean;
  /**
   * The process fallback. Defaults to `process.cwd()`; injected by tests and,
   * once mt#5168 lands, by the server with the caller's own cwd.
   */
  cwd?: string;
}

/** Which rung answered. */
export type ReadScopeSource =
  | "all-projects"
  | "workspace"
  | "repo-path"
  | "repo-slug"
  | "cwd"
  /** Rung 4 could not identify a project; ADR-021's soft default applies. */
  | "cwd-unscoped";

export type ReadScopeResolution =
  | {
      kind: "scoped";
      scope: string;
      source: Exclude<ReadScopeSource, "all-projects" | "cwd-unscoped">;
    }
  | { kind: "all"; source: "all-projects" | "cwd-unscoped"; reason?: string }
  /** An explicit argument named no project. The read returns nothing. */
  | {
      kind: "unresolved";
      source: "workspace" | "repo-path" | "repo-slug";
      value: string;
      reason: string;
    };

/**
 * A scope no project row can carry, so a query scoped to it returns no rows.
 *
 * `unresolved` has to become SOMETHING at the query layer, whose only contract
 * is `ProjectScope = uuid | ALL_PROJECTS`. `ALL_PROJECTS` is the wrong
 * translation (it is the defect), so an unresolved explicit argument scopes to
 * this id — the nil UUID, which Postgres accepts as a uuid literal and which
 * `projects.id` (v4-generated) never equals. Memory reads still return
 * `user` / `cross_project` records under it, which is what the RFC's Decision 3
 * requires of any project scope.
 */
export const NO_PROJECT_SCOPE = "00000000-0000-0000-0000-000000000000";

/** What a command reports about the scope it read under (`tasks.list`, `session.list`). */
export interface ReadScopeSummary {
  kind: ReadScopeResolution["kind"];
  source: ReadScopeSource;
  /** The project id a `scoped` read used. */
  projectId?: string;
  /** The argument an `unresolved` read was given. */
  value?: string;
  /** Why an `unresolved` read returned nothing, or why a cwd read fell open to ALL. */
  reason?: string;
}

export function summarizeReadScope(resolution: ReadScopeResolution): ReadScopeSummary {
  switch (resolution.kind) {
    case "scoped":
      return { kind: "scoped", source: resolution.source, projectId: resolution.scope };
    case "all":
      return {
        kind: "all",
        source: resolution.source,
        ...(resolution.reason && { reason: resolution.reason }),
      };
    case "unresolved":
      return {
        kind: "unresolved",
        source: resolution.source,
        value: resolution.value,
        reason: resolution.reason,
      };
  }
}

/** The `ProjectScope` the query layer takes, for any resolution. */
export function readScopeToProjectScope(resolution: ReadScopeResolution): ProjectScope {
  switch (resolution.kind) {
    case "scoped":
      return resolution.scope;
    case "all":
      return ALL_PROJECTS;
    case "unresolved":
      return NO_PROJECT_SCOPE;
  }
}

/** Whether a `repo` argument names a filesystem location rather than a slug. */
export function repoLooksLikePath(
  repo: string,
  pathExists: (p: string) => boolean = existsSync
): boolean {
  if (isAbsolute(repo) || repo.startsWith(".") || repo.startsWith("~")) return true;
  // `owner/name` is also a valid relative path; prefer the slug reading unless it exists on disk.
  return pathExists(resolvePath(repo));
}

export interface ReadScopeDeps {
  resolveIdentity?: (repoPath: string) => ProjectIdentity;
  pathExists?: (p: string) => boolean;
  cwd?: () => string;
}

async function scopeForPath(
  path: string,
  source: "workspace" | "repo-path",
  db: unknown,
  caller: string,
  deps: Required<ReadScopeDeps>
): Promise<ReadScopeResolution> {
  const identity = deps.resolveIdentity(path);
  const outcome = await resolveScopeOutcome(identity, db);
  if (outcome.kind === "resolved") {
    return { kind: "scoped", scope: outcome.projectId, source };
  }
  const reason =
    outcome.kind === "unidentified"
      ? `${path} is not an identified Minsky project (${outcome.reason})`
      : outcome.kind === "no-row"
        ? `${path} resolves to project "${outcome.slug}", which has no projects row`
        : outcome.kind === "invalid-db-handle"
          ? `project lookup unavailable (${outcome.received})`
          : `project lookup failed for "${outcome.slug}": ${outcome.error}`;
  log.debug(`[${caller}] explicit ${source} did not resolve to a project (mt#5155)`, {
    path,
    reason,
  });
  return { kind: "unresolved", source, value: path, reason };
}

/** A bare `owner/name`; `extractOwnerRepo` covers the remote-URL spellings. */
const BARE_SLUG = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/;

/** The `owner/name` a `repo` argument names, or null when it is not a slug. */
export function slugFromRepoArgument(repo: string): string | null {
  const bare = repo.match(BARE_SLUG);
  if (bare && bare[1] && bare[2]) return `${bare[1]}/${bare[2]}`;
  return extractOwnerRepo(repo);
}

async function scopeForSlug(
  repo: string,
  db: unknown,
  caller: string
): Promise<ReadScopeResolution> {
  const slug = slugFromRepoArgument(repo);
  if (!slug) {
    return {
      kind: "unresolved",
      source: "repo-slug",
      value: repo,
      reason: `"${repo}" is neither a path on this machine nor an owner/name project slug`,
    };
  }
  const identity: ProjectIdentity = { kind: "resolved", slug, source: "explicit-flag" };
  const outcome = await resolveScopeOutcome(identity, db);
  if (outcome.kind === "resolved") {
    return { kind: "scoped", scope: outcome.projectId, source: "repo-slug" };
  }
  const reason =
    outcome.kind === "no-row"
      ? `no project is registered under "${slug}"`
      : outcome.kind === "invalid-db-handle"
        ? `project lookup unavailable (${outcome.received})`
        : outcome.kind === "query-failed"
          ? `project lookup failed for "${slug}": ${outcome.error}`
          : `"${slug}" could not be resolved`;
  log.debug(`[${caller}] explicit repo slug did not resolve to a project (mt#5155)`, {
    repo,
    reason,
  });
  return { kind: "unresolved", source: "repo-slug", value: repo, reason };
}

/**
 * Resolve the scope for a read. Never throws: a failure on the explicit rungs
 * is `unresolved` (the read returns nothing, with the reason); a failure on the
 * cwd rung is `all` (ADR-021's soft default, unchanged).
 *
 * @param db The SQL handle `resolveScopeOutcome` accepts; `unknown` on purpose,
 *   the resolver classifies a bad handle itself (mt#4509).
 * @param caller A short label for log lines (`tasks.list`, `session.list`, …).
 */
export async function resolveReadScope(
  input: ReadScopeInput,
  db: unknown,
  caller: string,
  deps: ReadScopeDeps = {}
): Promise<ReadScopeResolution> {
  const fullDeps: Required<ReadScopeDeps> = {
    resolveIdentity: deps.resolveIdentity ?? ((repoPath) => resolveProjectIdentity({ repoPath })),
    pathExists: deps.pathExists ?? existsSync,
    cwd: deps.cwd ?? (() => process.cwd()),
  };

  if (input.allProjects) return { kind: "all", source: "all-projects" };

  const workspace = input.workspace?.trim();
  if (workspace) return scopeForPath(workspace, "workspace", db, caller, fullDeps);

  const repo = input.repo?.trim();
  if (repo) {
    if (repoLooksLikePath(repo, fullDeps.pathExists)) {
      return scopeForPath(repo, "repo-path", db, caller, fullDeps);
    }
    return scopeForSlug(repo, db, caller);
  }

  // Rung 4: the process. On the CLI this is the caller's own directory; on the
  // shared daemon it is the spawner's until mt#5168 threads the caller's cwd in
  // through `input.cwd`. ADR-021's fail-open default stays exactly as it was.
  const cwd = input.cwd ?? fullDeps.cwd();
  const identity = fullDeps.resolveIdentity(cwd);
  const outcome = await resolveScopeOutcome(identity, db);
  if (outcome.kind === "resolved") {
    return { kind: "scoped", scope: outcome.projectId, source: "cwd" };
  }
  const reason =
    outcome.kind === "unidentified"
      ? `cwd ${cwd} is not an identified project (${outcome.reason})`
      : outcome.kind === "no-row"
        ? `cwd project "${outcome.slug}" has no projects row`
        : outcome.kind === "invalid-db-handle"
          ? `project lookup unavailable (${outcome.received})`
          : `project lookup failed: ${outcome.error}`;
  log.debug(`[${caller}] cwd scope did not resolve; reading all projects (ADR-021 default)`, {
    cwd,
    reason,
  });
  // `scopeFromOutcome` is what every pre-mt#5155 site returned here; keep the
  // exact mapping so the ambient path is byte-for-byte the old behaviour.
  const legacy = scopeFromOutcome(outcome);
  return legacy === ALL_PROJECTS
    ? { kind: "all", source: "cwd-unscoped", reason }
    : { kind: "scoped", scope: legacy, source: "cwd" };
}
