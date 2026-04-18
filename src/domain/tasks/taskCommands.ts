/**
 * Interface-agnostic command functions for task operations
 *
 * Barrel re-export — sub-modules contain the actual implementations:
 *   - commands/shared-helpers.ts  — resolveRepoPath, normalizeTaskIdInput,
 *                                   TASK_STATUS, TaskStatus re-exports
 *   - commands/query-commands.ts  — listTasksFromParams, getTaskFromParams,
 *                                   getTaskStatusFromParams, getTaskSpecContentFromParams
 *   - commands/mutation-commands.ts — setTaskStatusFromParams, updateTaskFromParams,
 *                                     createTaskFromParams, createTaskFromTitleAndSpec,
 *                                     deleteTaskFromParams
 */

// Re-export task data types
export type {} from "../../types/tasks/taskData";

// Re-export status constants and types
export { TASK_STATUS, type TaskStatus } from "./commands/shared-helpers";

// Re-export query commands
export {
  listTasksFromParams,
  getTaskFromParams,
  getTaskStatusFromParams,
  getTaskSpecContentFromParams,
} from "./commands/query-commands";

// Re-export mutation commands
export {
  setTaskStatusFromParams,
  updateTaskFromParams,
  createTaskFromParams,
  createTaskFromTitleAndSpec,
  deleteTaskFromParams,
} from "./commands/mutation-commands";
