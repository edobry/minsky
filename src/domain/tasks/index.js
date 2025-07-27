/**
 * Re-export functions and types from task modules
 */

// Re-export from taskCommands.js
export {
  TASK_STATUS,
  getTaskFromParams,
  getTaskStatusFromParams,
  setTaskStatusFromParams,
  listTasksFromParams,
  createTaskFromParams,
  getTaskSpecContentFromParams,
} from "./taskCommands";

// Re-export from taskFunctions.js
export { normalizeTaskId } from "./taskFunctions";

// Re-export from taskService.js
export { TaskService, createTaskService } from "./taskService";
