/**
 * Task-related utility functions
 */

/**
 * Normalizes a task ID to always include the leading hash symbol
 *
 * @param taskId The task ID to normalize (can be with or without leading hash)
 * @returns The normalized task ID with leading hash, or null if the input is invalid.
 */
export function normalizeTaskId(taskId: string | undefined | null): string | null {
  if (!taskId || typeof taskId !== "string" || taskId.trim() === "") {
    return null;
  }

  // Remove existing '#' prefix if present, then add it back to ensure only one.
  // Also, ensure it's not just '#'
  const cleanedId = taskId.trim().replace(/^#+/, "");
  if (cleanedId === "") {
    return null;
  }

  return `#${cleanedId}`;
}
