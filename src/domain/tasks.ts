const COMMIT_HASH_SHORT_LENGTH = 7;

/**
 * Task operations for the Minsky CLI
 * This file provides all task-related functionality including managing tasks
 */

import { promises as fs } from "fs";
import { join } from "path";
import { log } from "../utils/logger";
import { normalizeTaskId } from "./tasks/utils";
import { createJsonFileTaskBackend } from "./tasks/jsonFileTaskBackend";
export { normalizeTaskId } from "./tasks/utils"; // Re-export normalizeTaskId from new location
import { ResourceNotFoundError, getErrorMessage } from "../errors/index";
const matter = require("gray-matter");
// Import constants and utilities for use within this file
import { TASK_STATUS, TASK_STATUS_CHECKBOX, TASK_PARSING_UTILS } from "./tasks/taskConstants";
import type { TaskStatus } from "./tasks/taskConstants";
import { getTaskSpecRelativePath } from "./tasks/taskIO";

// Import and re-export functions from taskCommands.ts
import {
  listTasksFromParams,
  getTaskFromParams,
  getTaskStatusFromParams,
  setTaskStatusFromParams,
  createTaskFromParams,
  createTaskFromTitleAndDescription,
  getTaskSpecContentFromParams,
  deleteTaskFromParams,
} from "./tasks/taskCommands";

export {
  listTasksFromParams,
  getTaskFromParams,
  getTaskStatusFromParams,
  setTaskStatusFromParams,
  createTaskFromParams,
  createTaskFromTitleAndDescription,
  getTaskSpecContentFromParams,
  deleteTaskFromParams,
};

// Re-export task status constants from centralized location
export { TASK_STATUS, TASK_STATUS_CHECKBOX } from "./tasks/taskConstants";
export type { TaskStatus } from "./tasks/taskConstants";

// Import and re-export extracted types and classes
export type {
  TaskServiceInterface,
  Task,
  TaskBackend,
  TaskListOptions,
  CreateTaskOptions,
  DeleteTaskOptions,
  TaskServiceOptions,
} from "./tasks/types";

export { MarkdownTaskBackend } from "./tasks/markdown-task-backend";
export { GitHubTaskBackend } from "./tasks/github-task-backend";
export { TaskService } from "./tasks/task-service";
