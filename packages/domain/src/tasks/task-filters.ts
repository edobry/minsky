import { TASK_STATUS } from "./taskConstants";

export interface TaskFilterOptions {
  status?: string;
  all?: boolean;
}

/**
 * Statuses hidden by default in task listings (terminal success/cancellation states).
 *
 * Union across all task kinds (mt#1812):
 * - `DONE`: implementation-kind success terminal
 * - `CLOSED`: terminal for both kinds (cancellation / no-longer-needed)
 * - `COMPLETED`: umbrella-kind success terminal
 *
 * `BLOCKED` is NOT hidden — blocked tasks need operator attention.
 *
 * Note: exposed as a readonly tuple (not a Set) to satisfy the
 * `custom/no-domain-singleton` lint rule. Callers should use the
 * `isHiddenByDefaultStatus()` helper instead of building their own Set.
 */
export const TASK_STATUSES_HIDDEN_BY_DEFAULT = [
  TASK_STATUS.DONE,
  TASK_STATUS.CLOSED,
  TASK_STATUS.COMPLETED,
] as const;

export function isHiddenByDefaultStatus(status: string | undefined): boolean {
  if (status === undefined) return false;
  return (TASK_STATUSES_HIDDEN_BY_DEFAULT as readonly string[]).includes(status);
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
