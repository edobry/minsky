/**
 * Domain types shared across multiple modules
 */

// Re-export task status types from centralized location
export { TaskStatus, TaskStatusType } from "./tasks/taskConstants.js";

/**
 * Categories of commands supported by the system
 */
export enum CommandCategory {
  SESSION = "SESSION",
  TASKS = "TASKS",
  GIT = "GIT",
  RULES = "RULES",
  INIT = "INIT",
  MCP = "MCP",
}

/**
<<<<<<< Updated upstream
=======
 * Status values for tasks
 */
export enum TaskStatus {
  TODO = "TODO",
  IN_PROGRESS = "IN-PROGRESS",
  IN_REVIEW = "IN-REVIEW",
  DONE = "DONE",
  BLOCKED = "BLOCKED",
}

/**
>>>>>>> Stashed changes
 * Interface for command execution results
 */
export interface CommandResult {
  success: boolean;
  message?: string;
  data?: unknown;
}
