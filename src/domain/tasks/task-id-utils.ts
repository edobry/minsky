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
  
  // Remove common prefixes
  normalized = normalized.replace(/^(task)?#?/, "");
  
  // Validate that remaining is a positive integer
  if (!/^\d+$/.test(normalized)) {
    return null;
  }
  
  return normalized;
}

/**
 * Format task ID for display (adds # prefix)
 * 
 * @param storageId Plain task ID from storage (e.g., "283")
 * @returns Display format with # prefix (e.g., "#283")
 */
export function formatTaskIdForDisplay(storageId: string | number): string {
  if (!storageId && storageId !== 0) {
    return "#unknown";
  }
  
  const id = String(storageId);
  
  // If already has #, return as-is
  if (id.startsWith("#")) {
    return id;
  }
  
  return `#${id}`;
}

/**
 * Check if a task ID is in storage format (plain number/string)
 */
export function isStorageFormat(taskId: string): boolean {
  return /^\d+$/.test(taskId.trim());
}

/**
 * Check if a task ID is in display format (has # prefix)
 */
export function isDisplayFormat(taskId: string): boolean {
  return /^#\d+$/.test(taskId.trim());
}

/**
 * Convert between storage and display formats
 * 
 * @param taskId Task ID in either format
 * @param targetFormat Target format to convert to
 * @returns Converted task ID or null if invalid
 */
export function convertTaskIdFormat(
  taskId: string, 
  targetFormat: "storage" | "display"
): string | null {
  if (targetFormat === "storage") {
    return normalizeTaskIdForStorage(taskId);
  } else {
    const normalized = normalizeTaskIdForStorage(taskId);
    return normalized ? formatTaskIdForDisplay(normalized) : null;
  }
}

/**
 * Validate if input is a valid task ID (accepts both formats)
 */
export function isValidTaskIdInput(input: string): boolean {
  return normalizeTaskIdForStorage(input) !== null;
}

/**
 * Extract numeric task ID value
 * 
 * @param taskId Task ID in any valid format
 * @returns Numeric value or null if invalid
 */
export function getTaskIdNumber(taskId: string): number | null {
  const normalized = normalizeTaskIdForStorage(taskId);
  return normalized ? parseInt(normalized, 10) : null;
} 
