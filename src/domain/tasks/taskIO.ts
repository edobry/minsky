const COMMIT_HASH_SHORT_LENGTH = 7;

/**
 * Task I/O operations module
 * This module isolates side effects like file reading/writing from pure functions
 */

import { promises as fs } from "fs";
import { join, dirname } from "path";
import { log } from "../../utils/logger";
import type {
  TaskWriteOperationResult,
  TaskReadOperationResult,
  TaskFileOperationResult,
} from "../../types/tasks/taskData";

/**
 * Read the tasks file
 * @param filePath Path to the tasks file
 * @returns Promise resolving to file content or error
 */
export async function readTasksFile(filePath: string): Promise<TaskReadOperationResult> {
  try {
    const content = (String(await fs.readFile(filePath, "utf-8"))) as string;
    return {
      success: true,
      filePath,
      content,
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error as any));
    log.error(`Failed to read tasks file: ${filePath}`, { error: err });
    return {
      success: false,
      filePath,
      error: err,
    };
  }
}

/**
 * Write to the tasks file
 * @param filePath Path to the tasks file
 * @param content Content to write
 * @returns Promise resolving to success status or error
 */
export async function writeTasksFile(
  filePath: string,
  content: string
): Promise<TaskWriteOperationResult> {
  try {
    await fs.writeFile(filePath, content, "utf-8");
    return {
      success: true,
      filePath,
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error as any));
    log.error(`Failed to write tasks file: ${filePath}`, { error: err });
    return {
      success: false,
      filePath,
      error: err,
    };
  }
}

/**
 * Read a task specification file
 * @param filePath Path to the task spec file
 * @returns Promise resolving to file content or error
 */
export async function readTaskSpecFile(filePath: string): Promise<TaskReadOperationResult> {
  try {
    const content = (String(await fs.readFile(filePath, "utf-8"))) as string;
    return {
      success: true,
      filePath,
      content,
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error as any));
    log.error(`Failed to read task spec file: ${filePath}`, { error: err });
    return {
      success: false,
      filePath,
      error: err,
    };
  }
}

/**
 * Write to a task specification file
 * @param filePath Path to the task spec file
 * @param content Content to write
 * @returns Promise resolving to success status or error
 */
export async function writeTaskSpecFile(
  filePath: string,
  content: string
): Promise<TaskWriteOperationResult> {
  try {
    // Create parent directories if they don't exist
    await createDirectory(dirname(filePath));

    await fs.writeFile(filePath, content, "utf8");
    return {
      success: true,
      filePath,
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error as any));
    log.error(`Failed to write task spec file: ${filePath}`, { error: err });
    return {
      success: false,
      filePath,
      error: err,
    };
  }
}

/**
 * Check if a file exists
 * @param filePath Path to the file
 * @returns Promise resolving to true if file exists, false otherwise
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Create a directory if it doesn't exist
 * @param dirPath Path to the directory
 * @returns Promise resolving to success status or error
 */
export async function createDirectory(dirPath: string): Promise<TaskFileOperationResult> {
  try {
    await fs.mkdir(dirPath, { recursive: true });
    return {
      success: true,
      filePath: dirPath,
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error as any));
    log.error(`Failed to create directory: ${dirPath}`, { error: err });
    return {
      success: false,
      filePath: dirPath,
      error: err,
    };
  }
}

/**
 * Delete a file if it exists
 * @param filePath Path to the file
 * @returns Promise resolving to success status or error
 */
export async function deleteFile(filePath: string): Promise<TaskFileOperationResult> {
  try {
    if (await fileExists(filePath)) {
      await fs.unlink(filePath);
    }
    return {
      success: true,
      filePath,
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error as any));
    log.error(`Failed to delete file: ${filePath}`, { error: err });
    return {
      success: false,
      filePath,
      error: err,
    };
  }
}

/**
 * List files in a directory
 * @param dirPath Path to the directory
 * @param pattern Optional glob pattern to filter files
 * @returns Promise resolving to array of file paths or error
 */
export async function listFiles(dirPath: string): Promise<string[] | null> {
  try {
    const files = await fs.readdir(dirPath);
    return files;
  } catch (error) {
    log.error(`Failed to list files in directory: ${dirPath}`, {
      error: error instanceof Error ? error : String(error as any),
    });
    return null as any;
  }
}

/**
 * Get task file path from workspace path
 * @param workspacePath Workspace path
 * @returns Path to the tasks file
 */
export function getTasksFilePath(workspacePath: string): string {
  return join(workspacePath, "process", "tasks.md");
}

/**
 * Get task spec directory path from workspace path
 * @param workspacePath Workspace path
 * @returns Path to the task specs directory
 */
export function getTaskSpecsDirectoryPath(workspacePath: string): string {
  return join(workspacePath, "process", "tasks");
}

/**
 * Get task spec file path from task ID, _title, and workspace path
 * @param taskId Task ID (with or without # prefix)
 * @param title Task title
 * @param workspacePath Workspace path
 * @returns Path to the task spec file
 */
export function getTaskSpecFilePath(
  taskId: string,
  title: string,
  workspacePath: string
): string {
  const taskIdNum = taskId.startsWith("#") ? taskId.slice(1) : taskId;
  const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return join(getTaskSpecsDirectoryPath(workspacePath), `${taskIdNum}-${normalizedTitle}.md`);
}

/**
 * Get task spec path relative to workspace root
 * Always returns paths relative to the workspace root, regardless of current directory
 * @param taskId Task ID (with or without # prefix)
 * @param title Task title
 * @param workspacePath Workspace path (not used in path construction, kept for compatibility)
 * @returns Relative path to the task spec file
 */
export function getTaskSpecRelativePath(
  taskId: string,
  title: string,
  workspacePath: string
): string {
  const taskIdNum = taskId.startsWith("#") ? taskId.slice(1) : taskId;
  const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");

  // Always return paths relative to workspace root
  return join("process", "tasks", `${taskIdNum}-${normalizedTitle}.md`);
}
