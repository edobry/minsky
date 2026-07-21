/**
 * Task-listing filter utilities, built on the registry's canonical
 * hidden-by-default predicate (mt#3010 single-authority consolidation —
 * DEFAULT_HIDDEN_STATUSES / isHiddenByDefaultStatus moved to workflows.ts;
 * this module now consumes them rather than maintaining its own copy).
 */
import { isHiddenByDefaultStatus } from "./workflows";

export { isHiddenByDefaultStatus };

export interface TaskFilterOptions {
  status?: string;
  all?: boolean;
}

export function shouldIncludeTaskStatus(
  status: string | undefined,
  options?: TaskFilterOptions
): boolean {
  // Default behavior: hide terminal statuses when no options provided
  if (!options) {
    return !isHiddenByDefaultStatus(status);
  }
  const desiredStatus = options.status?.trim();
  const includeAll = Boolean(options.all);

  // "all" is a sentinel meaning "no specific status filter" (both
  // minskyTaskBackend.ts and githubIssuesTaskBackend.ts's pre-mt#3010
  // listTasks() implementations special-cased it this way — a bare
  // desiredStatus === status comparison would instead filter OUT every task,
  // since none literally has status "all"; caught by reviewer at mt#3010
  // PR #2171 R1 when githubIssuesTaskBackend.ts was wired onto this shared
  // predicate for the first time, exposing the gap).
  if (desiredStatus && desiredStatus !== "all") {
    return status === desiredStatus;
  }

  if (!includeAll) {
    return !isHiddenByDefaultStatus(status);
  }

  return true;
}

export function filterTasksByStatus<T extends { status?: string }>(
  tasks: T[],
  options?: TaskFilterOptions
): T[] {
  return tasks.filter((t) => shouldIncludeTaskStatus(t.status, options));
}
