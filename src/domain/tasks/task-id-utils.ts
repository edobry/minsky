/**
 * Task ID utilities: PERMISSIVE INPUT, STRICT OUTPUT
 *
 * Policy:
 * - INPUT: Accept legacy/user formats (e.g., "283", "#283", "##283", "task#283", whitespace variants)
 * - STORAGE: Always normalized to qualified format with markdown prefix (e.g., "md#283")
 * - DISPLAY: Same as storage (qualified normalized format)
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
 * Normalize user-provided task ID to qualified storage format (md#NNN).
 *
 * Accepts inputs like:
 * - "283" → "md#283"
 * - "#283" → "md#283"
 * - "##283" → "md#283"
 * - "task#283" / "TASK#283" → "md#283"
 * - Already-qualified formats remain as-is except "task#" is converted to "md#"
 *
 * Returns null for invalid inputs.
 */
export function normalizeTaskIdForStorage(input: string | null | undefined): string | null {
  if (typeof input !== "string") return null;
  const raw = input.trim();
  if (raw.length === 0) return null;

  // Already qualified formats: md#123, gh#456, task#789, custom-prefix#123
  const qualifiedMatch = raw.match(/^([a-z-]+)#(\d+)$/i);
  if (qualifiedMatch) {
    const num = qualifiedMatch[2];
    // Normalize any qualified input to md# for storage
    return `md#${num}`;
  }

  // Strip leading "task#" (case-insensitive) and normalize
  const taskPrefixMatch = raw.match(/^task#(\d+)$/i);
  if (taskPrefixMatch) {
    return `md#${taskPrefixMatch[1]}`;
  }

  // Handle leading # symbols (one or many): ##283 -> 283
  const hashStripped = raw.replace(/^#+/, "");
  if (/^\d+$/.test(hashStripped)) {
    return `md#${hashStripped}`;
  }

  // Pure numeric input
  if (/^\d+$/.test(raw)) {
    return `md#${raw}`;
  }

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
  const normalized = normalizeTaskIdForStorage(taskId);
  return normalized ?? "";
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
  const normalized = normalizeTaskIdForStorage(taskId);
  return normalized;
}

/**
 * Validate task ID input (accepts only qualified format)
 *
 * @param userInput Task ID from user input
 * @returns True if valid qualified task ID
 */
export function isValidTaskIdInput(userInput: string): boolean {
  return normalizeTaskIdForStorage(userInput) !== null;
}

/**
 * Extract numeric value from qualified task ID
 *
 * @param taskId Task ID in qualified format (md#123, gh#456, etc.)
 * @returns Numeric value or null if invalid
 */
export function getTaskIdNumber(taskId: string): number | null {
  const normalized = normalizeTaskIdForStorage(taskId);
  if (!normalized) return null;
  const match = normalized.match(/^[a-z-]+#(\d+)$/i);
  if (!match) return null;
  const num = parseInt(match[1], 10);
  return isNaN(num) ? null : num;
}
