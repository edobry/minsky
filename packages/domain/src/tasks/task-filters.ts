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

  if (desiredStatus) {
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
