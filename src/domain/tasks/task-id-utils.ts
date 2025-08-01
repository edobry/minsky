/**
 * Task ID utilities for Task 283: Separate Task ID Storage from Display Format
 *
 * This module implements the new approach where:
 * - Task IDs are stored as plain numbers/strings (e.g., "283")
 * - Task IDs are displayed with # prefix (e.g., "#283")
 * - Input accepts both formats but normalizes to plain for storage
 */

/**
 * Normalize task ID input for storage (removes # prefix, validates format)
 *
 * @param userInput Task ID from user input (can be "283", "#283", "task#283", etc.)
 * @returns Plain task ID for storage (e.g., "283") or null if invalid
 */
export function normalizeTaskIdForStorage(userInput: string): string | null {
  if (!userInput || typeof userInput !== "string") {
    return null;
  }

  let normalized = userInput.trim();

  // Handle formats like "task#283" or "task#64"
  if (normalized.toLowerCase().startsWith("task#")) {
    normalized = normalized.substring(5);
  }

  // Remove all leading '#' characters to get plain format
  while (normalized.startsWith("#")) {
    normalized = normalized.substring(1);
  }

  // Check if the result is valid (numeric only for now)
  if (!/^\d+$/.test(normalized) || normalized.length === 0) {
    return null;
  }

  // Return plain format for storage (no # prefix)
  return normalized;
}

/**
 * Format task ID for display (shows qualified backend ID)
 *
 * @param storageId Task ID from storage (e.g., "md#356", "gh#123", or legacy "283")
 * @returns Formatted task ID for display (e.g., "md#356", "gh#123", or "#283" for legacy)
 */
export function formatTaskIdForDisplay(storageId: string): string {
  if (!storageId || typeof storageId !== "string") {
    return "";
  }

  // If it's a qualified backend ID (md#123, gh#456), return as-is for multi-backend display
  if (/^[a-z-]+#\d+$/.test(storageId)) {
    return storageId;
  }

  // If it already has # prefix (legacy #123), return as-is
  if (storageId.startsWith("#")) {
    return storageId;
  }

  // For plain numeric IDs (legacy), add # prefix for backward compatibility
  return `#${storageId}`;
}

/**
 * Check if a task ID is in storage format (plain, no # prefix)
 *
 * @param taskId Task ID to check
 * @returns True if in storage format, false if in display format or invalid
 */
export function isStorageFormat(taskId: string): boolean {
  if (!taskId || typeof taskId !== "string") {
    return false;
  }

  return !taskId.startsWith("#") && /^\d+$/.test(taskId.trim());
}

/**
 * Check if a task ID is in display format (# prefix)
 *
 * @param taskId Task ID to check
 * @returns True if in display format, false if in storage format or invalid
 */
export function isDisplayFormat(taskId: string): boolean {
  if (!taskId || typeof taskId !== "string") {
    return false;
  }

  return taskId.startsWith("#") && /^#\d+$/.test(taskId.trim());
}

/**
 * Convert between storage and display formats
 *
 * @param taskId Task ID in either format
 * @param targetFormat Target format ("storage" or "display")
 * @returns Task ID in target format or null if invalid
 */
export function convertTaskIdFormat(
  taskId: string,
  targetFormat: "storage" | "display"
): string | null {
  if (!taskId || typeof taskId !== "string") {
    return null;
  }

  if (targetFormat === "storage") {
    return normalizeTaskIdForStorage(taskId);
  } else {
    const storageId = normalizeTaskIdForStorage(taskId);
    return storageId ? formatTaskIdForDisplay(storageId) : null;
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
 * Extract numeric value from task ID (regardless of format)
 *
 * @param taskId Task ID in any format
 * @returns Numeric value or null if invalid
 */
export function getTaskIdNumber(taskId: string): number | null {
  const storageId = normalizeTaskIdForStorage(taskId);
  if (!storageId) {
    return null;
  }

  const num = parseInt(storageId, 10);
  return isNaN(num) ? null : num;
}
