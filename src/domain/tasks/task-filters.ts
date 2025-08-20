import { TASK_STATUS } from "./taskConstants";

export interface TaskFilterOptions {
  status?: string;
  all?: boolean;
}

export function shouldIncludeTaskStatus(
  status: string | undefined,
  options?: TaskFilterOptions
): boolean {
  // Default behavior: hide DONE and CLOSED when no options provided
  if (!options) {
    return status !== TASK_STATUS.DONE && status !== TASK_STATUS.CLOSED;
  }
  const desiredStatus = options.status?.trim();
  const includeAll = Boolean(options.all);

  if (desiredStatus) {
    return status === desiredStatus;
  }

  if (!includeAll) {
    return status !== TASK_STATUS.DONE && status !== TASK_STATUS.CLOSED;
  }

  return true;
}

export function filterTasksByStatus<T extends { status?: string }>(
  tasks: T[],
  options?: TaskFilterOptions
): T[] {
  return tasks.filter((t) => shouldIncludeTaskStatus(t.status, options));
}
