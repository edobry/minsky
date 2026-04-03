import { randomUUID } from "crypto";

// Unified Task ID System
// Task IDs: md#123, gh#456, json#789
// Session IDs: generated UUIDs (opaque, internal-only)
// Branch names: task/md-123, task/gh-456, task/json-789

export interface TaskId {
  backend: string;
  localId: string;
  full: string; // Full task ID: "md#123"
}

// Core parsing functions
export function parseTaskId(taskId: string): TaskId | null {
  if (!taskId || typeof taskId !== "string") {
    return null;
  }

  // Parse format: backend#localId
  const hashIndex = taskId.indexOf("#");
  if (hashIndex === -1 || hashIndex === 0 || hashIndex === taskId.length - 1) {
    return null;
  }

  // Check for multiple hashes (not allowed)
  if (taskId.indexOf("#", hashIndex + 1) !== -1) {
    return null;
  }

  const backend = taskId.substring(0, hashIndex);
  const localId = taskId.substring(hashIndex + 1);

  // Validate backend and localId are not empty
  if (!backend || !localId) {
    return null;
  }

  // Treat "task#123" as legacy format, not qualified
  if (backend === "task" && /^\d+$/.test(localId)) {
    return null;
  }

  return {
    backend,
    localId,
    full: taskId,
  };
}

export function isQualifiedTaskId(taskId: string): boolean {
  return parseTaskId(taskId) !== null;
}

export function formatTaskId(backend: string, localId: string): string {
  if (!backend || typeof backend !== "string") {
    throw new Error("Backend must be a non-empty string");
  }
  if (!localId || typeof localId !== "string") {
    throw new Error("Local ID must be a non-empty string");
  }

  return `${backend}#${localId}`;
}

export function extractBackend(taskId: string): string | null {
  const parsed = parseTaskId(taskId);
  return parsed ? parsed.backend : null;
}

export function extractLocalId(taskId: string): string | null {
  const parsed = parseTaskId(taskId);
  return parsed ? parsed.localId : null;
}

/** UUID v4 regex for identifying UUID-format session names */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Session/Branch conversion functions

/** @deprecated Use generateSessionId() for new sessions. Kept for legacy session name parsing. */
export function taskIdToSessionName(taskId: string): string {
  // md#123 → task-md#123
  if (isQualifiedTaskId(taskId)) {
    return `task-${taskId}`;
  }

  return taskId; // Return as-is if unparseable
}

/** @deprecated Use branchNameToTaskId() for new-format branches. Kept for legacy session name parsing. */
export function sessionNameToTaskId(sessionName: string): string | null {
  // UUID session names don't encode task IDs — use DB lookup instead
  if (isUuidSessionName(sessionName)) {
    return null;
  }
  // Legacy: task-md#123 → md#123
  const match = sessionName.match(/^task-(.+)$/);
  if (match && match[1]) {
    return match[1] || null;
  }

  return null;
}

/**
 * Generate a unique session ID (UUID v4).
 * Session IDs are opaque identifiers — they do not encode task information.
 * @param idGenerator Optional custom ID generator (for testing)
 */
export function generateSessionId(idGenerator?: () => string): string {
  return idGenerator ? idGenerator() : randomUUID();
}

/**
 * Check if a session name is a UUID-format session ID (new format).
 */
export function isUuidSessionName(name: string): boolean {
  return UUID_REGEX.test(name);
}

/**
 * Convert a qualified task ID to a shell-safe git branch name.
 * mt#638 → task/mt-638
 */
export function taskIdToBranchName(taskId: string): string {
  const parsed = parseTaskId(taskId);
  if (!parsed) {
    return taskId;
  }
  return `task/${parsed.backend}-${parsed.localId}`;
}

/**
 * Convert a task branch name back to a qualified task ID.
 * task/mt-638 → mt#638
 * Returns null if the branch name doesn't match the task branch format.
 */
export function branchNameToTaskId(branchName: string): string | null {
  const match = branchName.match(/^task\/([^-]+)-(.+)$/);
  if (!match || !match[1] || !match[2]) {
    return null;
  }
  return `${match[1]}#${match[2]}`;
}
