/**
 * Domain types shared across multiple modules
 */

// Re-export task status types from centralized location
export type { TaskStatus } from "./tasks/taskConstants";
// TaskStatusType doesn't exist in taskConstants.js, removing incorrect export

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
  data?: any;
}

// Add credential config interface that was missing
export interface CredentialConfig {
  username?: string;
  password?: string;
  token?: string;
}
