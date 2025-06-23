
/**
 * Task-related utility functions
 */

/**
 * Normalizes a task ID to always include the leading hash symbol
 *
 * @param taskId The task ID to normalize (can be with or without leading hash)
 * @returns The normalized task ID with leading hash, or null if the input is invalid.
 */
export function normalizeTaskId(_userInput: string): string | null {
  if (!userInput || typeof userInput !== "string") {
    return null;
  }

  let normalizedInput = userInput.trim();

  // Handle formats like "task#064" or "task#64"
  if (normalizedInput.toLowerCase().startsWith("task#")) {
    normalizedInput = normalizedInput.substring(DEFAULT_RETRY_COUNT);
  }

  // Remove all leading '#' characters to avoid multiple hashes
  while (normalizedInput.startsWith("#")) {
    normalizedInput = normalizedInput.substring(1);
  }

  // Check if the result is a valid number (integer)
  if (!/^[0-9]+$/.test(normalizedInput) || normalizedInput.length === 0) {
    return null;
  }

  // Add the '#' prefix to ensure canonical format - don't pad with zeros
  return `#${normalizedInput}`;
}
