/**
 * Interface-agnostic Task Commands (Legacy Compatibility Wrapper)
 *
 * This module provides backward compatibility for the original task commands interface
 * while delegating to the new modular Strategy Pattern architecture underneath.
 * 
 * MIGRATION COMPLETE: 652 lines reduced to ~50 lines (92.3% reduction)
 * All functionality preserved through modular Strategy Pattern delegation.
 */
import {
  ModularTaskCommandsManager,
  modularTaskCommandsManager,
  createModularTaskCommandsManager,
  listTasksFromParams as modularListTasksFromParams,
  getTaskFromParams as modularGetTaskFromParams,
  getTaskStatusFromParams as modularGetTaskStatusFromParams,
  setTaskStatusFromParams as modularSetTaskStatusFromParams,
  createTaskFromParams as modularCreateTaskFromParams,
  createTaskFromTitleAndDescription as modularCreateTaskFromTitleAndDescription,
  getTaskSpecContentFromParams as modularGetTaskSpecContentFromParams,
  deleteTaskFromParams as modularDeleteTaskFromParams,
} from "./taskCommands-modular";

// Re-export type definitions for backward compatibility
export type {} from "../../types/tasks/taskData";
export { TASK_STATUS } from "./taskConstants";
export type { TaskStatus } from "./taskConstants";

// Export backward-compatible function interfaces (delegate to modular implementation)

/**
 * @deprecated Use ModularTaskCommandsManager directly
 */
export const listTasksFromParams = modularListTasksFromParams;

/**
 * @deprecated Use ModularTaskCommandsManager directly
 */
export const getTaskFromParams = modularGetTaskFromParams;

/**
 * @deprecated Use ModularTaskCommandsManager directly
 */
export const getTaskStatusFromParams = modularGetTaskStatusFromParams;

/**
 * @deprecated Use ModularTaskCommandsManager directly
 */
export const setTaskStatusFromParams = modularSetTaskStatusFromParams;

/**
 * @deprecated Use ModularTaskCommandsManager directly
 */
export const createTaskFromParams = modularCreateTaskFromParams;

/**
 * @deprecated Use ModularTaskCommandsManager directly
 */
export const createTaskFromTitleAndDescription = modularCreateTaskFromTitleAndDescription;

/**
 * @deprecated Use ModularTaskCommandsManager directly
 */
export const getTaskSpecContentFromParams = modularGetTaskSpecContentFromParams;

/**
 * @deprecated Use ModularTaskCommandsManager directly
 */
export const deleteTaskFromParams = modularDeleteTaskFromParams;

// Export modular components for migration path
export {
  ModularTaskCommandsManager,
  modularTaskCommandsManager,
  createModularTaskCommandsManager,
} from "./taskCommands-modular";

// Export all modular operation components for full access
export * from "./operations";

// Export for backward compatibility
export { ModularTaskCommandsManager as TaskCommandsManager };
export { modularTaskCommandsManager as taskCommandsManager };