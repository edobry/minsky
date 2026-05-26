// Barrel exports for task domain (TS source)

// Re-export command-layer functions (used by CLI/MCP adapters)
export {
  TASK_STATUS,
  getTaskFromParams,
  getTaskStatusFromParams,
  setTaskStatusFromParams,
  listTasksFromParams,
  createTaskFromParams,
  getTaskSpecContentFromParams,
  deleteTaskFromParams,
} from "../tasks";

// Re-export service interfaces/factory
export { TaskServiceInterface, createConfiguredTaskService } from "./taskService";

// Optionally expose pure helpers (kept minimal to avoid surface changes)
export {
  getTaskById,
  getNextTaskId,
  filterTasks,
  parseTaskSpecFromMarkdown,
  formatTaskSpecToMarkdown,
  isValidTaskStatus,
} from "./taskFunctions";

// Export read-only interfaces for ADR-004 validate() phase
export type { ReadonlyTaskService } from "./readonly-interfaces";
