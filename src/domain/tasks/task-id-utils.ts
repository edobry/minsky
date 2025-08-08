/**
 * Task ID utilities: STRICT QUALIFIED IDs ONLY
 *
 * This module implements unified task ID handling where:
 * - INPUT: Only accepts qualified format (md#367, gh#123)
 * - STORAGE: Always qualified format (md#283, gh#367)
 * - DISPLAY: Always qualified format (md#283, gh#367)
 * - No normalization needed - input === storage === display
 */

/**
 * Validate task ID (qualified format only)
 *
 * @param taskId Task ID that must be qualified (md#367, gh#123, etc.)
 * @returns Same qualified task ID if valid, null if invalid
 */
export function validateQualifiedTaskId(taskId: string): string | null {
  if (!taskId || typeof taskId !== "string") {
    return null;
  }

  const trimmed = taskId.trim();

  // Only accept qualified IDs (md#367, gh#123)
  if (/^[a-z-]+#\d+$/.test(trimmed)) {
    return trimmed;
  }

  // Reject all other formats
  return null;
}

// Backward compatibility alias
export const normalizeTaskIdForStorage = validateQualifiedTaskId;

/**
 * Format task ID for display - STRICT OUT
 * Expects qualified format from storage, returns qualified format for display
 *
 * @param storageId Qualified task ID from storage (e.g., "md#356", "gh#123")
 * @returns Qualified task ID for display (same as storage - qualified format)
 */
export function formatTaskIdForDisplay(storageId: string): string {
  if (!storageId || typeof storageId !== "string") {
    return "";
  }

  // STRICT OUT: Storage should already be qualified format, return as-is
  if (/^[a-z-]+#\d+$/.test(storageId)) {
    return storageId;
  }

  // Legacy fallback: If somehow we get plain numbers or #-prefixed, normalize to md#
  if (storageId.startsWith("#")) {
    const number = storageId.substring(1);
    return `md#${number}`;
  }

  if (/^\d+$/.test(storageId)) {
    return `md#${storageId}`;
  }

  // Return as-is if we can't parse it
  return storageId;
}

/**
 * Check if a task ID is in the correct internal format (qualified: md#123, gh#456)
 *
 * @param taskId Task ID to check
 * @returns True if in qualified format, false otherwise
 */
export function isStorageFormat(taskId: string): boolean {
  if (!taskId || typeof taskId !== "string") {
    return false;
  }

  // STRICT OUT: Storage format is qualified format (md#123, gh#456)
  return /^[a-z-]+#\d+$/.test(taskId.trim());
}

/**
 * Check if a task ID is in the correct display format (qualified: md#123, gh#456)
 * Note: With "strict out", display format equals storage format
 *
 * @param taskId Task ID to check
 * @returns True if in qualified format, false otherwise
 */
export function isDisplayFormat(taskId: string): boolean {
  // With strict out approach, display format = storage format = qualified format
  return isStorageFormat(taskId);
}

/**
 * Convert task ID to qualified format (PERMISSIVE IN, STRICT OUT)
 * Both "storage" and "display" now return the same qualified format
 *
 * @param taskId Task ID in any input format
 * @param targetFormat Target format ("storage" or "display") - both return qualified format
 * @returns Qualified task ID (md#123) or null if invalid
 */
export function convertTaskIdFormat(
  taskId: string,
  targetFormat: "storage" | "display"
): string | null {
  if (!taskId || typeof taskId !== "string") {
    return null;
  }

  // Both storage and display formats are now qualified format
  const qualifiedId = normalizeTaskIdForStorage(taskId);

  if (targetFormat === "storage") {
    return qualifiedId;
  } else {
    // Display format is the same as storage format (qualified)
    return qualifiedId ? formatTaskIdForDisplay(qualifiedId) : null;
  }
}

/**
 * Validate task ID input (accepts both formats)
 *
 * @param userInput Task ID from user input
 * @returns True if valid task ID in either format
 */
export function isValidTaskIdInput(userInput: string): boolean {
  return normalizeTaskIdForStorage(userInput) !== null;
}

/**
 * Extract numeric value from task ID (accepts any input format)
 *
 * @param taskId Task ID in any format (accepts legacy #123, md#123, etc.)
 * @returns Numeric value or null if invalid
 */
export function getTaskIdNumber(taskId: string): number | null {
  const qualifiedId = normalizeTaskIdForStorage(taskId);
  if (!qualifiedId) {
    return null;
  }

  // Extract number from qualified format (md#123 -> 123)
  const match = qualifiedId.match(/^[a-z-]+#(\d+)$/);
  if (!match) {
    return null;
  }

  const num = parseInt(match[1], 10);
  return isNaN(num) ? null : num;
}
