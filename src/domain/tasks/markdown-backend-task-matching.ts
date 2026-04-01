/**
 * Task ID matching utilities for the Markdown Task Backend.
 * Handles the various ID format variations (qualified, legacy, plain).
 */

import type { TaskData } from "../../types/tasks/taskData";

/**
 * Test whether a stored task ID matches a search ID, handling
 * qualified IDs (md#123), legacy hash-prefixed IDs (#123),
 * and plain numeric IDs (123).
 */
export function taskIdMatches(taskId: string, searchId: string): boolean {
  // Exact match
  if (taskId === searchId) return true;

  // Extract local parts for comparison
  const taskLocalId = taskId.includes("#") ? taskId.split("#").pop() : taskId;
  const searchLocalId = searchId.includes("#") ? searchId.split("#").pop() : searchId;

  if (taskLocalId === searchLocalId) return true;

  // Handle # prefix variations for legacy compatibility
  if (!/^#/.test(searchId) && taskId === `#${searchId}`) return true;
  if (searchId.startsWith("#") && taskId === searchId.substring(1)) return true;

  return false;
}

/**
 * Find a task by ID using flexible matching.
 * Returns the task or null.
 */
export function findTaskById(tasks: TaskData[], id: string): TaskData | null {
  return tasks.find((t) => taskIdMatches(t.id, id)) ?? null;
}

/**
 * Find the index of a task by ID using flexible matching.
 * Returns -1 if not found.
 */
export function findTaskIndexById(tasks: TaskData[], id: string): number {
  return tasks.findIndex((t) => taskIdMatches(t.id, id));
}
