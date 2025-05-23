/**
 * Domain types shared across multiple modules
 */

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
 * Status values for tasks
 */
export enum TaskStatus {
  TODO = "TODO",
  IN_PROGRESS = "IN-PROGRESS",
  IN_REVIEW = "IN-REVIEW",
  DONE = "DONE",
}

/**
 * Interface for command execution results
 */
export interface CommandResult {
  success: boolean;
  message?: string;
  data?: unknown;
} 
