/**
 * Pure functions for task operations
 * These functions don't have side effects and work with the task data types
 */
import type { TaskData, TaskFilter, TaskSpecData } from "../../types/tasks/taskData";

// Import constants and utilities from centralized location
import { TASK_PARSING_UTILS, isValidTaskStatus as isValidTaskStatusUtil } from "./taskConstants";
import type { TaskStatus } from "./taskConstants";
import {
  normalizeTaskIdForStorage,
  formatTaskIdForDisplay,
  getTaskIdNumber,
} from "./task-id-utils";

/**
 * Parse tasks from markdown content (pure function)
 * @param content Markdown content with task entries
 * @returns Array of task data objects
 */
export function parseTasksFromMarkdown(content: string): TaskData[] {
  const tasks: TaskData[] = [];
  if (!content) return tasks;

  // Split into lines and track code block state
  const lines = content.toString().split("\n");
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    // Parse task line using centralized utility
    const parsed = TASK_PARSING_UTILS.parseTaskLine(line);
    if (!parsed) continue;

    const { checkbox, title, id } = parsed;
    // Accept both legacy (#123) and qualified (md#123) ID formats
    if (!title || !id || !/^(#\d+|[a-z-]+#\d+)$/.test(id)) continue; // skip malformed or empty

    const status = TASK_PARSING_UTILS.getStatusFromCheckbox(checkbox);

    // Aggregate indented lines as description
    let description = "";
    for (let j = i + 1; j < lines.length; j++) {
      const subline = lines[j] ?? "";
      if (subline.trim().startsWith("```")) break;
      if (/^- \[.\]/.test(subline)) break; // next top-level task
      if (/^\s+- /.test(subline)) {
        description += `${subline.trim().replace(/^- /, "") ?? ""}\n`;
      } else if ((subline.trim() ?? "") === "") {
        continue;
      } else {
        break;
      }
    }

    // Normalize ID to qualified format for internal storage consistency
    const normalizedId = normalizeTaskIdForStorage(id) || id;

    tasks.push({
      id: normalizedId,
      title,
      status,
      description: description.trim(),
    });
  }

  return tasks;
}

/**
 * Format tasks to markdown content (pure function)
 * @param tasks Array of task data objects
 * @returns Formatted markdown content
 */
export function formatTasksToMarkdown(tasks: TaskData[]): string {
  if (!tasks || tasks.length === 0) return "";

  return tasks
    .map((task) => {
      const checkbox = TASK_PARSING_UTILS.getCheckboxFromStatus(task.status);
      const specPath = task.specPath || "#";
      // TASK 283: Use formatTaskIdForDisplay() to ensure # prefix in markdown display
      const displayId = formatTaskIdForDisplay(task.id);
      const taskLine = `- [${checkbox}] ${task.title} [${displayId}](${specPath})`;

      // Always return only the task line - descriptions should remain in spec files
      return taskLine;
    })
    .join("\n\n");
}

/**
 * Find a task by its ID (pure function)
 * @param tasks Array of task data objects
 * @param id Task ID to find
 * @returns Found task or null
 */
export function getTaskById(tasks: TaskData[], id: string): TaskData | null {
  if (!tasks || !id) return null;

  // First try exact match
  const exactMatch = tasks.find((task) => task.id === id);
  if (exactMatch) {
    return exactMatch;
  }

  // If no exact match, try numeric comparison
  // This handles case where ID is provided without leading zeros
  const normalizedId = normalizeTaskId(id);
  if (!normalizedId) return null;

  const numericId = parseInt(normalizedId.replace(/^#/, ""), 10);
  if (isNaN(numericId)) return null;

  const numericMatch = tasks.find((task) => {
    const taskNumericId = parseInt(task.id.replace(/^#/, ""), 10);
    return !isNaN(taskNumericId) && taskNumericId === numericId;
  });

  return numericMatch || null;
}

/**
 * Normalize task ID to consistent format using unified task ID system
 * Supports both legacy formats (#XXX) and qualified formats (md#XXX, gh#XXX)
 * @param id Task ID to normalize
 * @returns Normalized task ID or undefined if invalid
 */
export function normalizeTaskId(id: string): string | undefined {
  if (!id) return undefined;

  // Use unified task ID system for consistent handling
  const {
    isQualifiedTaskId,
    isLegacyTaskId,
    migrateUnqualifiedTaskId,
  } = require("./unified-task-id");

  // If it's already a qualified ID, return as-is
  if (isQualifiedTaskId(id)) {
    return id;
  }

  // If it's a legacy format, migrate to qualified format
  if (isLegacyTaskId(id)) {
    return migrateUnqualifiedTaskId(id, "md"); // Default to markdown backend
  }

  // If already in #XXX format, keep for backward compatibility
  if (/^#[a-zA-Z0-9_]+$/.test(id)) {
    return id;
  }

  // If purely alphanumeric, convert to #XXX format (legacy compatibility)
  if (/^[a-zA-Z0-9_]+$/.test(id)) {
    return `#${id}`;
  }

  return undefined;
}

/**
 * Calculate the next available task ID (pure function)
 * @param tasks Array of task data objects
 * @returns Next available task ID in storage format (plain number)
 */
export function getNextTaskId(tasks: TaskData[]): string {
  if (!tasks || tasks.length === 0) return "001";

  const maxId = tasks.reduce((max, task) => {
    // Use the new utility to extract numeric value from any format
    const id = getTaskIdNumber(task.id);
    return id !== null && id > max ? id : max;
  }, 0);

  // TASK 283: Return plain format for storage (e.g., "002" instead of "#002")
  return String(maxId + 1).padStart(3, "0");
}

/**
 * Update a task's status in an immutable way (pure function)
 * @param tasks Array of task data objects
 * @param id Task ID to update
 * @param status New status
 * @returns New array with the updated task
 */
export function setTaskStatus(tasks: TaskData[], id: string, status: TaskStatus): TaskData[] {
  if (!tasks || !id || !status) return tasks;

  const normalizedId = normalizeTaskId(id);
  if (!normalizedId) return tasks;

  // Validate status using centralized utility
  if (!isValidTaskStatusUtil(status)) {
    return tasks;
  }

  return tasks.map((task) =>
    task.id === normalizedId ||
    parseInt(task.id.replace(/^#/, ""), 10) === parseInt(normalizedId.replace(/^#/, ""), 10)
      ? { ...task, status }
      : task
  );
}

/**
 * Add a new task to the collection (pure function)
 * @param tasks Array of task data objects
 * @param newTask New task to add
 * @returns New array with the added task
 */
export function addTask(tasks: TaskData[], newTask: TaskData): TaskData[] {
  if (!tasks || !newTask) return tasks;

  // Ensure the task has a valid ID
  if (!newTask.id || !normalizeTaskId(newTask.id)) {
    newTask = {
      ...newTask,
      id: getNextTaskId(tasks),
    };
  }

  // Check if task with the same ID already exists
  const existingTask = getTaskById(tasks, newTask.id);
  if (existingTask) {
    // Replace the existing task
    return tasks.map((task) => (task.id === existingTask.id ? newTask : task));
  }

  // Add the new task
  return [...tasks, newTask];
}

/**
 * Filter tasks based on criteria (pure function)
 * @param tasks Array of task data objects
 * @param filter Filter criteria
 * @returns Filtered array of tasks
 */
export function filterTasks(tasks: TaskData[], filter?: TaskFilter): TaskData[] {
  if (!tasks) return [];
  if (!filter) return tasks;

  return tasks.filter((task) => {
    // Filter by status
    if (filter.status && task.status !== filter.status) {
      return false;
    }

    // Filter by ID
    if (filter.id) {
      // Handle special case: if filter.id is a simple number (like "2") and task.id is "#002"
      if (/^\d+$/.test(filter.id)) {
        // If filter is just digits, compare numeric values directly
        const filterNum = parseInt(filter.id, 10);
        const taskNum = parseInt(task.id.replace(/\D/g, ""), 10);

        if (!isNaN(filterNum) && !isNaN(taskNum) && filterNum === taskNum) {
          return true;
        }
      }

      // Try normalized string comparison
      const normalizedFilterId = normalizeTaskId(filter.id);
      const normalizedTaskId = normalizeTaskId(task.id);

      if (normalizedFilterId && normalizedTaskId) {
        // Strip the "#" prefix for more flexible comparison
        const filterIdNum = parseInt(normalizedFilterId.replace(/^#/, ""), 10);
        const taskIdNum = parseInt(normalizedTaskId.replace(/^#/, ""), 10);

        if (!isNaN(filterIdNum) && !isNaN(taskIdNum) && filterIdNum === taskIdNum) {
          return true;
        }

        // Fallback to exact string comparison
        return normalizedFilterId === normalizedTaskId;
      }

      return false;
    }

    // Filter by title (string match)
    if (filter.title && typeof filter.title === "string") {
      return task.title.toLowerCase().includes(filter.title.toLowerCase());
    }

    // Filter by title (regex match)
    if (filter.title && filter.title instanceof RegExp) {
      return filter.title.test(task.title);
    }

    // Filter by spec path existence
    if (filter.hasSpecPath !== undefined) {
      return filter.hasSpecPath ? !!task.specPath : !task.specPath;
    }

    return true;
  });
}

/**
 * Parse task specification from markdown content (pure function)
 * @param content Markdown content of a task specification
 * @returns Parsed task specification data
 */
export function parseTaskSpecFromMarkdown(content: string): TaskSpecData {
  if (!content) {
    return { title: "", description: "" };
  }

  const lines = content.toString().split("\n");

  // Extract title from the first heading
  const titleLine = lines.find((line) => line.startsWith("# "));
  if (!titleLine) {
    return { title: "", description: "" };
  }

  // Support multiple title formats for backward compatibility:
  // 1. Old format with task number: "# Task #XXX: Title"
  // 2. Old format without number: "# Task: Title"
  // 3. New clean format: "# Title"
  const titleWithIdMatch = titleLine.match(/^# Task #(\d+): (.+)$/);
  const titleWithoutIdMatch = titleLine.match(/^# Task: (.+)$/);
  const cleanTitleMatch = titleLine.match(/^# (.+)$/);

  let title = "";
  let id: string | undefined;

  if (titleWithIdMatch && titleWithIdMatch[2]) {
    // Old format: "# Task #XXX: Title"
    title = titleWithIdMatch[2];
    id = `#${titleWithIdMatch[1]}`;
  } else if (titleWithoutIdMatch && titleWithoutIdMatch[1]) {
    // Old format: "# Task: Title"
    title = titleWithoutIdMatch[1];
  } else if (cleanTitleMatch && cleanTitleMatch[1]) {
    // New clean format: "# Title"
    title = cleanTitleMatch[1];
    // Skip if this looks like an old task format to avoid false positives
    if (!title.startsWith("Task ")) {
      // This is likely the new clean format
    }
  }

  // Extract description from the Context section
  const contextIndex = lines.findIndex((line) => line.trim() === "## Context");
  let description = "";

  if (contextIndex !== -1) {
    for (let i = contextIndex + 1; i < lines.length; i++) {
      const line = lines[i] || "";
      if (line.trim().startsWith("## ")) break;
      if (line.trim()) description += `${line.trim()}\n`;
    }
  }

  return {
    title,
    description: description.trim(),
    id,
  };
}

/**
 * Format task specification to markdown content (pure function)
 * @param spec Task specification data
 * @returns Formatted markdown content
 */
export function formatTaskSpecToMarkdown(spec: TaskSpecData): string {
  if (!spec) return "";

  // Generate clean title format without task numbers
  const titleLine = `# ${spec.title}`;

  const contextSection = `
## Context

${spec.description}

## Requirements

1. TBD

## Implementation Steps

1. [ ] TBD

## Verification

- [ ] TBD
`;

  return `${titleLine}${contextSection}`;
}

/**
 * Validate a task status value (pure function)
 * @param status Status to validate
 * @returns True if valid, false otherwise
 */
export function isValidTaskStatus(status: string): status is TaskStatus {
  return isValidTaskStatusUtil(status);
}

/**
 * Format task state to markdown content (pure function)
 * @param state Task state object
 * @returns Formatted markdown content
 */
export function formatTaskStateToMarkdown(state: TaskStatus): string {
  return formatTasksToMarkdown(state.tasks);
}

/**
 * Parse markdown content to task state (pure function)
 * @param content Markdown content
 * @returns Task state object
 */
export function parseMarkdownToTaskState(content: string): TaskData[] {
  // Fixed return type - should return TaskData[] not TaskStatus
  return parseTasksFromMarkdown(content);
}
