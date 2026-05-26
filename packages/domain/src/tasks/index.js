/**
 * Re-export functions and types from task modules
 */

// Re-export from taskCommands.js
export {
  TASK_STATUS,
  getTaskFromParams,
  getTaskStatusFromParams,
  setTaskStatusFromParams,
  updateTaskFromParams,
  listTasksFromParams,
  createTaskFromParams,
  getTaskSpecContentFromParams,
} from "./taskCommands";

// Re-export from taskFunctions.js
// normalizeTaskId removed

// Re-export from taskService.js
export { TaskServiceInterface } from "./taskService";
