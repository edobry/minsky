/**
 * Task ID utilities: STRICT IN, STRICT OUT
 *
 * Policy:
 * - INPUT: Only accepts qualified formats (e.g., "md#283", "gh#456", "task#789")
 * - STORAGE: Same as input (qualified format)
 * - DISPLAY: Same as storage (qualified format)
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

// Strict storage normalization: return the same qualified ID if valid; else null
export function normalizeTaskIdForStorage(input: string | null | undefined): string | null {
  if (typeof input !== "string") return null;
  return validateQualifiedTaskId(input);
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
  const validated = validateQualifiedTaskId(taskId);
  return validated ?? "";
}

/**
 * Check if a task ID is in qualified format (md#123, gh#456)
 *
 * @param taskId Task ID to check
 * @returns True if in qualified format, false otherwise
 */
export function isQualifiedFormat(taskId: string): boolean {
  return /^[a-z-]+#\d+$/i.test((taskId ?? "").trim());
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
  // Storage and display are the same; only return if already valid
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
  if (!validated) return null;
  const match = validated.match(/^[a-z-]+#(\d+)$/i);
  if (!match) return null;
  const num = parseInt(match[1], 10);
  return isNaN(num) ? null : num;
}
