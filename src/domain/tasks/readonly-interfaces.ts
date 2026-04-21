import type { TaskServiceInterface } from "./taskService";

/** Read-only subset of TaskServiceInterface for use in validate() phase (ADR-004) */
export type ReadonlyTaskService = Pick<
  TaskServiceInterface,
  "listTasks" | "getTask" | "getTaskStatus" | "getTasks" | "getTaskSpecContent" | "getWorkspacePath"
>;
