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
 * Interface for command execution results
 */
export interface CommandResult {
  success: boolean;
  message?: string;
  data?: unknown;
}
