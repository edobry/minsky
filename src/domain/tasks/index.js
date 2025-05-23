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
} from "./taskCommands.js";

// Re-export from taskFunctions.js
export { normalizeTaskId } from "./taskFunctions.js";

// Re-export from taskService.js
export { TaskService, createTaskService } from "./taskService.js"; 
