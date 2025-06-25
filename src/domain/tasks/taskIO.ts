const COMMIT_HASH_SHORT_LENGTH = 7;

/**
 * Task I/O operations module
 * This module isolates side effects like file reading/writing from pure functions
 */

import { promises as fs } from "fs";
import { join, dirname } from "path";
import { log } from "../../utils/logger.js";
import type {
  TaskWriteOperationResult,
  TaskReadOperationResult,
  TaskFileOperationResult,
} from "../../types/tasks/taskData.js";

/**
 * Read the tasks file
 * @param filePath Path to the tasks file
 * @returns Promise resolving to file content or error
 */
export async function readTasksFile(filePath: string): Promise<TaskReadOperationResult> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return {
      success: true,
      filePath,
      content,
    };
  } catch (error) {
    console.log('[DEBUG] Caught error in src/domain/tasks/taskIO.ts:30:', typeof error !== 'undefined' ? 'error defined' : 'error undefined', typeof _error !== 'undefined' ? '_error defined' : '_error undefined');
    const err = error instanceof Error ? error : new Error(String(error));
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
    console.log('[DEBUG] Caught error in src/domain/tasks/taskIO.ts:58:', typeof error !== 'undefined' ? 'error defined' : 'error undefined', typeof _error !== 'undefined' ? '_error defined' : '_error undefined');
    const err = error instanceof Error ? error : new Error(String(error));
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
    const content = await fs.readFile(filePath, "utf-8");
    return {
      success: true,
      filePath,
      content,
    };
  } catch (error) {
    console.log('[DEBUG] Caught error in src/domain/tasks/taskIO.ts:83:', typeof error !== 'undefined' ? 'error defined' : 'error undefined', typeof _error !== 'undefined' ? '_error defined' : '_error undefined');
    const err = error instanceof Error ? error : new Error(String(error));
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

    await fs.writeFile(_filePath, _content, "utf-COMMIT_HASH_SHORT_LENGTH");
    return {
      success: true,
      filePath,
    };
  } catch (error) {
    console.log('[DEBUG] Caught error in src/domain/tasks/taskIO.ts:114:', typeof error !== 'undefined' ? 'error defined' : 'error undefined', typeof _error !== 'undefined' ? '_error defined' : '_error undefined');
    const err = error instanceof Error ? error : new Error(String(error));
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
  } catch (_error) {
    console.log('[DEBUG] Caught error in src/domain/tasks/taskIO.ts:135:', typeof error !== 'undefined' ? 'error defined' : 'error undefined', typeof _error !== 'undefined' ? '_error defined' : '_error undefined');
    return false;
  }
}

/**
 * Create a directory if it doesn't exist
 * @param dirPath Path to the directory
 * @returns Promise resolving to success status or error
 */
export async function createDirectory(__dirPath: string): Promise<TaskFileOperationResult> {
  try {
    await fs.mkdir(_dirPath, { recursive: true });
    return {
      success: true,
      filePath: dirPath,
    };
  } catch (error) {
    console.log('[DEBUG] Caught error in src/domain/tasks/taskIO.ts:153:', typeof error !== 'undefined' ? 'error defined' : 'error undefined', typeof _error !== 'undefined' ? '_error defined' : '_error undefined');
    const err = error instanceof Error ? error : new Error(String(error));
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
export async function deleteFile(_filePath: string): Promise<TaskFileOperationResult> {
  try {
    if (await fileExists(filePath)) {
      await fs.unlink(filePath);
    }
    return {
      success: true,
      filePath,
    };
  } catch (error) {
    console.log('[DEBUG] Caught error in src/domain/tasks/taskIO.ts:179:', typeof error !== 'undefined' ? 'error defined' : 'error undefined', typeof _error !== 'undefined' ? '_error defined' : '_error undefined');
    const err = error instanceof Error ? error : new Error(String(error));
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
export async function listFiles(__dirPath: string): Promise<string[] | null> {
  try {
    const files = await fs.readdir(dirPath);
    return files;
  } catch (error) {
    console.log('[DEBUG] Caught error in src/domain/tasks/taskIO.ts:201:', typeof error !== 'undefined' ? 'error defined' : 'error undefined', typeof _error !== 'undefined' ? '_error defined' : '_error undefined');
    log.error(`Failed to list files in directory: ${dirPath}`, {
      error: error instanceof Error ? error : String(error),
    });
    return null;
  }
}

/**
 * Get task file path from workspace path
 * @param workspacePath Workspace path
 * @returns Path to the tasks file
 */
export function getTasksFilePath(__workspacePath: string): string {
  return join(__workspacePath, "process", "tasks.md");
}

/**
 * Get task spec directory path from workspace path
 * @param workspacePath Workspace path
 * @returns Path to the task specs directory
 */
export function getTaskSpecsDirectoryPath(__workspacePath: string): string {
  return join(__workspacePath, "process", "tasks");
}

/**
 * Get task spec file path from task ID, _title, and workspace path
 * @param taskId Task ID (with or without # prefix)
 * @param title Task title
 * @param workspacePath Workspace path
 * @returns Path to the task spec file
 */
export function getTaskSpecFilePath(
  __taskId: string,
  _title: string,
  _workspacePath: string
): string {
  const taskIdNum = taskId.startsWith("#") ? taskId.slice(1) : taskId;
  const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return join(getTaskSpecsDirectoryPath(_workspacePath), `${taskIdNum}-${normalizedTitle}.md`);
}
