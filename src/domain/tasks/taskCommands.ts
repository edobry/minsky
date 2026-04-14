/**
 * Interface-agnostic command functions for task operations.
 * These functions are used by the CLI and MCP adapters.
 *
 * This is a barrel file — implementations live in commands/query-commands.ts
 * and commands/mutation-commands.ts.
 */

// Re-export task status constants from centralized location
export { TASK_STATUS } from "./taskConstants";
export type { TaskStatus } from "./taskConstants";

// Re-export task data types (empty re-export for side-effect / type augmentation)
export type {} from "../../types/tasks/taskData";

// Query operations (list, get, status, spec)
export {
  listTasksFromParams,
  getTaskFromParams,
  getTaskStatusFromParams,
  getTaskSpecContentFromParams,
} from "./commands/query-commands";

// Mutation operations (setStatus, update, create, delete)
export {
  setTaskStatusFromParams,
  updateTaskFromParams,
  createTaskFromParams,
  createTaskFromTitleAndDescription,
  deleteTaskFromParams,
} from "./commands/mutation-commands";
