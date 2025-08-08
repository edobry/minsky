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

/**
 * Format task ID for display (no-op since input === output)
 *
 * @param taskId Qualified task ID (e.g., "md#356", "gh#123")
 * @returns Same qualified task ID (no transformation needed)
 */
export function formatTaskIdForDisplay(taskId: string): string {
  if (!taskId || typeof taskId !== "string") {
    return "";
  }

  // No transformation needed - qualified format is the display format
  return validateQualifiedTaskId(taskId) || "";
}

/**
 * Check if a task ID is in qualified format (md#123, gh#456)
 *
 * @param taskId Task ID to check
 * @returns True if in qualified format, false otherwise
 */
export function isQualifiedFormat(taskId: string): boolean {
  return validateQualifiedTaskId(taskId) !== null;
}

// Backward compatibility aliases
export const isStorageFormat = isQualifiedFormat;
export const isDisplayFormat = isQualifiedFormat;

/**
 * Validate task ID (no conversion needed since input === output)
 *
 * @param taskId Task ID in qualified format only
 * @param targetFormat Target format (ignored - both return same qualified format)
 * @returns Same qualified task ID or null if invalid
 */
export function convertTaskIdFormat(
  taskId: string,
  targetFormat: "storage" | "display"
): string | null {
  // No conversion needed - just validate
  return validateQualifiedTaskId(taskId);
}

/**
 * Validate task ID input (accepts only qualified format)
 *
 * @param userInput Task ID from user input
 * @returns True if valid qualified task ID
 */
export function isValidTaskIdInput(userInput: string): boolean {
  return validateQualifiedTaskId(userInput) !== null;
}

/**
 * Extract numeric value from qualified task ID
 *
 * @param taskId Task ID in qualified format (md#123, gh#456, etc.)
 * @returns Numeric value or null if invalid
 */
export function getTaskIdNumber(taskId: string): number | null {
  const validated = validateQualifiedTaskId(taskId);
  if (!validated) {
    return null;
  }

  // Extract number from qualified format (md#123 -> 123)
  const match = validated.match(/^[a-z-]+#(\d+)$/);
  if (!match) {
    return null;
  }

  const num = parseInt(match[1], 10);
  return isNaN(num) ? null : num;
}

// Backward compatibility alias
export const normalizeTaskIdForStorage = validateQualifiedTaskId;
