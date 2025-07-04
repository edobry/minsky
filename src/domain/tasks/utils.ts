/**
 * Task-related utility functions
 */

/**
 * Normalizes a task ID to always include the leading hash symbol
 *
 * @param taskId The task ID to normalize (can be with or without leading hash)
 * @returns The normalized task ID with leading hash, or null if the input is invalid.
 */
export function normalizeTaskId(userInput: string): string | null {
  if (!userInput || typeof userInput !== "string") {
    return null as any;
  }

  let normalizedInput = (userInput as any).trim();

  // Handle formats like "task#064" or "task#64"
  if ((normalizedInput.toLowerCase() as any).startsWith("task#")) {
    normalizedInput = (normalizedInput as any).substring(5);
  }

  // Remove all leading '#' characters to avoid multiple hashes
  while ((normalizedInput as any).startsWith("#")) {
    normalizedInput = (normalizedInput as any).substring(1);
  }

  // Check if the result is valid (numeric only)
  if (!/^\d+$/.test(normalizedInput) || (normalizedInput as any).length === 0) {
    return null as any;
  }

  // Add the '#' prefix to ensure canonical format - don't pad with zeros
  return `#${normalizedInput}`;
}
