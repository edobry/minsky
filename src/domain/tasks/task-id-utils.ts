/**
 * Task ID utilities: Multi-Backend String ID Support
 *
 * This module implements flexible task ID handling where:
 * - INPUT: Accepts any string format (update-test, 367, #367, md#367, gh#123)
 * - STORAGE: Preserves original format for backend compatibility
 * - DISPLAY: Format for user display (qualified when available)
 * - ROUTING: Qualified IDs route to appropriate backends
 */

// Logger import removed due to no usage after cleanup

/**
 * Normalize task ID for storage - supports legacy numeric formats
 *
 * @param taskId Task ID in any format (283, #283, md#283, update-test, etc.)
 * @returns Qualified task ID for storage, or null if invalid
 */
export function validateQualifiedTaskId(taskId: string): string | null {
  if (!taskId || typeof taskId !== "string") {
    return null;
  }

  const trimmed = taskId.trim();

  // Already qualified format (md#367, gh#123, md#update-test)
  if (/^[a-z-]+#.+$/.test(trimmed)) {
    return trimmed;
  }

  // Legacy display format (#283) -> convert to qualified
  if (/^#\d+$/.test(trimmed)) {
    const num = trimmed.replace(/^#/, "");
    return `md#${num}`;
  }

  // Legacy numeric format (283) -> convert to qualified
  if (/^\d+$/.test(trimmed)) {
    return `md#${trimmed}`;
  }

  // Handle task# prefix format (task#283) -> convert to qualified
  if (/^task#\d+$/i.test(trimmed)) {
    const num = trimmed.replace(/^task#/i, "");
    return `md#${num}`;
  }
  // Strip multiple # prefixes (##283) -> convert to qualified
  if (/^#+\d+$/.test(trimmed)) {
    const num = trimmed.replace(/^#+/, "");
    return `md#${num}`;
  }

  // For string IDs that don't match numeric patterns, return as-is for multi-backend support
  // This allows backend-specific string IDs like "update-test", "delete-test", etc.
  if (/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    return trimmed; // Return string IDs as-is for backend handling
  }

  return null;
}

// Backward compatibility alias
// Backward-compat export name used across code/tests; implements strict validation
export const normalizeTaskIdForStorage = validateQualifiedTaskId;

/**
 * Format task ID for display - supports both numeric and string formats
 *
 * @param taskId Task ID in any format (283, #283, md#283, update-test, etc.)
 * @returns Formatted task ID for display
 */
export function formatTaskIdForDisplay(taskId: string): string {
  if (!taskId || typeof taskId !== "string") {
    return "";
  }

  const trimmed = taskId.trim();

  // Already qualified format (md#367, gh#123) - display as-is
  if (/^[a-z-]+#.+$/.test(trimmed)) {
    return trimmed;
  }

  // Legacy display format (#283) -> convert to qualified
  if (/^#\d+$/.test(trimmed)) {
    const num = trimmed.replace(/^#/, "");
    return `md#${num}`;
  }

  // Legacy numeric format (283) -> convert to qualified
  if (/^\d+$/.test(trimmed)) {
    return `md#${trimmed}`;
  }

  // Handle task# prefix format (task#283) -> convert to qualified
  if (/^task#\d+$/i.test(trimmed)) {
    const num = trimmed.replace(/^task#/i, "");
    return `md#${num}`;
  }
  // String IDs (update-test, delete-test) - return as-is for multi-backend support
  if (/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    return trimmed;
  }

  // Fallback: return the original string to avoid empty display output
  return trimmed;
}

/**
 * Check if a task ID is in qualified format (md#123, gh#456)
 *
 * @param taskId Task ID to check
 * @returns True if in qualified format, false otherwise
 */
export function isQualifiedFormat(taskId: string): boolean {
  if (!taskId || typeof taskId !== "string") {
    return false;
  }
  const trimmed = taskId.trim();
  // Only true qualified format (md#367, gh#123) counts as qualified
  return /^[a-z-]+#.+$/.test(trimmed);
}

// Backward compatibility aliases
export const isStorageFormat = isQualifiedFormat;
export const isDisplayFormat = isQualifiedFormat;

/**
 * Convert task ID to target format
 *
 * @param taskId Task ID in any format
 * @param targetFormat Target format (storage or display)
 * @returns Converted task ID or null if invalid
 */
export function convertTaskIdFormat(
  taskId: string,
  targetFormat: "storage" | "display"
): string | null {
  if (targetFormat === "storage") {
    return validateQualifiedTaskId(taskId);
  } else {
    // For display format, first validate that it's a valid task ID
    const validatedId = validateQualifiedTaskId(taskId);
    if (validatedId === null) {
      return null;
    }
    return formatTaskIdForDisplay(taskId);
  }
}

/**
 * Validate task ID input (accepts any valid format)
 *
 * @param userInput Task ID from user input
 * @returns True if valid task ID in any format
 */
export function isValidTaskIdInput(userInput: string): boolean {
  return validateQualifiedTaskId(userInput) !== null;
}

/**
 * Extract numeric value from task ID (any format)
 *
 * @param taskId Task ID in any format (283, #283, md#123, etc.)
 * @returns Numeric value or null if not numeric
 */
export function getTaskIdNumber(taskId: string): number | null {
  if (!taskId || typeof taskId !== "string") {
    return null;
  }

  const trimmed = taskId.trim();

  // Extract number from qualified format (md#123 -> 123)
  const qualifiedMatch = trimmed.match(/^[a-z-]+#(\d+)$/);
  if (qualifiedMatch) {
    const num = parseInt(qualifiedMatch[1], 10);
    return isNaN(num) ? null : num;
  }

  // Extract number from legacy format (#123 -> 123)
  const legacyMatch = trimmed.match(/^#+(\d+)$/);
  if (legacyMatch) {
    const num = parseInt(legacyMatch[1], 10);
    return isNaN(num) ? null : num;
  }

  // Extract number from task# format (task#123 -> 123)
  const taskMatch = trimmed.match(/^task#(\d+)$/i);
  if (taskMatch) {
    const num = parseInt(taskMatch[1], 10);
    return isNaN(num) ? null : num;
  }

  // Handle pure numeric format (123 -> 123)
  if (/^\d+$/.test(trimmed)) {
    const num = parseInt(trimmed, 10);
    return isNaN(num) ? null : num;
  }

  // Non-numeric string IDs (update-test, delete-test) return null
  return null;
}
