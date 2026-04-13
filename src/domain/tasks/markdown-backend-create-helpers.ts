/**
 * Task creation helpers for the Markdown Task Backend.
 * Extracts the logic for creating tasks from objects and from spec file paths.
 */

import { join, dirname } from "path";
import { promises as fs } from "fs";
import { getErrorMessage } from "../../errors/index";
import type { Task } from "../tasks";
import type { TaskData, TaskSpecData } from "../../types/tasks/taskData";
import { TASK_STATUS, type TaskStatus } from "./taskConstants";
import { getTaskIdNumber, formatTaskIdForDisplay } from "./task-id-utils";
import { getTaskSpecRelativePath } from "./taskIO";
import { elementAt } from "../../utils/array-safety";

/**
 * Determine the next local ID from existing tasks.
 */
export function getNextLocalId(existingTasks: TaskData[]): number {
  return (
    existingTasks.reduce((max, task) => {
      const id = getTaskIdNumber(task.id);
      return id !== null && id > max ? id : max;
    }, 0) + 1
  );
}

/**
 * Extract a local ID from a spec-provided ID, or generate one.
 */
export function resolveLocalId(specId: string | undefined, existingTasks: TaskData[]): string {
  if (specId) {
    // If spec.id is qualified (md#123), extract local part (123)
    if (specId.includes("#")) {
      return elementAt(specId.split("#"), 1, "qualified task ID local part");
    }
    return specId;
  }
  return `${getNextLocalId(existingTasks)}`;
}

/**
 * Build a qualified ID string for commit messages.
 */
export function toQualifiedId(localId: string): string {
  if (/^(md#|#)/.test(localId)) {
    return localId.startsWith("#") ? `md${localId}` : localId;
  }
  return `md#${localId}`;
}

/**
 * Create a task from an object with title/description.
 */
export function buildTaskFromObject(
  spec: { title: string; description?: string; id?: string },
  existingTasks: TaskData[]
): TaskData {
  const localId = resolveLocalId(spec.id, existingTasks);
  return {
    id: localId,
    title: spec.title,
    description: spec.description || "",
    status: TASK_STATUS.TODO,
    specPath: "",
  };
}

/**
 * Create a task from a spec file path:
 * - Reads the spec file
 * - Moves it to the proper location
 * - Returns the new TaskData
 */
export async function buildTaskFromSpecPath(
  specPath: string,
  existingTasks: TaskData[],
  workspacePath: string,
  parseTaskSpec: (content: string) => TaskSpecData,
  getTaskSpecData: (path: string) => Promise<{ success: boolean; content?: string }>
): Promise<TaskData> {
  const specResult = await getTaskSpecData(specPath);
  if (!specResult.success || !specResult.content) {
    throw new Error(`Failed to read spec file: ${specPath}`);
  }

  const spec = parseTaskSpec(specResult.content);
  const maxId = getNextLocalId(existingTasks) - 1;
  const newId = `md#${maxId + 1}`;
  const displayId = formatTaskIdForDisplay(newId);
  const properSpecPath = getTaskSpecRelativePath(displayId, spec.title, workspacePath);
  const fullProperPath = join(workspacePath, properSpecPath);

  // Ensure the tasks directory exists
  const tasksDir = dirname(fullProperPath);
  try {
    await fs.mkdir(tasksDir, { recursive: true });
  } catch (_error) {
    // Directory already exists
  }

  // Move the temporary file to the proper location
  try {
    const specContent = await fs.readFile(specPath, "utf-8");
    await fs.writeFile(fullProperPath, specContent, "utf-8");
    try {
      await fs.unlink(specPath);
    } catch (_error) {
      // Ignore cleanup errors
    }
  } catch (error) {
    throw new Error(
      `Failed to move spec file from ${specPath} to ${properSpecPath}: ${getErrorMessage(error)}`
    );
  }

  return {
    id: newId,
    title: spec.title,
    description: spec.description,
    status: "TODO" as TaskStatus,
    specPath: properSpecPath,
  };
}

/**
 * Convert TaskData to the Task interface for return values.
 */
export function taskDataToTask(data: TaskData): Task {
  return {
    id: data.id,
    title: data.title,
    description: data.description,
    status: data.status,
    specPath: data.specPath,
  };
}

/**
 * Generate a task specification markdown file from title and description.
 */
export function generateTaskSpecification(title: string, description: string): string {
  return `# ${title}

## Context

${description}

## Requirements

## Solution

## Notes
`;
}
