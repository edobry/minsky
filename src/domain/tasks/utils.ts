/**
 * Task-related utility functions
 */

import { normalizeTaskIdForStorage } from "./task-id-utils";

/**
 * Normalizes a task ID using the unified "permissive in, strict out" approach
 *
 * @param userInput The task ID to normalize (accepts any format: 123, #123, task#123, md#123)
 * @returns The normalized task ID in qualified format (md#123) or null if invalid
 * @deprecated Use normalizeTaskIdForStorage directly for new code
 */
export function normalizeTaskId(userInput: string): string | undefined {
  // Delegate to the new unified task ID system
  const result = normalizeTaskIdForStorage(userInput);
  return result || undefined; // Convert null to undefined for backward compatibility
}
