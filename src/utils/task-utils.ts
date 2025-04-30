/**
 * Task-related utility functions
 */

/**
 * Normalizes a task ID to always include the leading hash symbol
 * 
 * @param taskId The task ID to normalize (can be with or without leading hash)
 * @returns The normalized task ID with leading hash
 */
export function normalizeTaskId(taskId: string): string {
  if (!taskId) {
    return taskId;
  }
  
  return taskId.startsWith('#') ? taskId : `#${taskId}`;
} 
