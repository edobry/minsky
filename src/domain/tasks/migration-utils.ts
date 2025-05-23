import { readFile, writeFile, access } from "fs/promises";
import { join } from "path";
import type { TaskData, TaskState } from "../../types/tasks/taskData.js";
import { createJsonFileStorage } from "../storage/json-file-storage.js";

/**
 * Get the user's home directory in a cross-platform way
 * @returns Home directory path
 */
function getHomeDirectory(): string {
  return process.env.HOME || process.env.USERPROFILE || process.cwd();
}

constructor(config: MigrationConfig) {
  this.workspacePath = config.workspacePath;
  this.targetDbPath = config.targetDbPath || join(getHomeDirectory(), ".local", "state", "minsky", "tasks.json");
  this.createBackup = config.createBackup !== false;
  this.preserveOriginal = config.preserveOriginal !== false;
}
