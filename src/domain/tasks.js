export {
  // Re-export from taskCommands.js
  TASK_STATUS,
  getTaskFromParams,
  getTaskStatusFromParams,
  setTaskStatusFromParams,
  listTasksFromParams,
  createTaskFromParams,
  getTaskSpecContentFromParams,
  
  // Re-export from taskFunctions.js
  normalizeTaskId,
  
  // Re-export from taskService.js
  TaskService,
  createTaskService,
} from "./tasks/index.js"; 
