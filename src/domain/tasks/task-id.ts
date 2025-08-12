// Unified Task ID System
// Task IDs: md#123, gh#456, json#789
// Session/Branch names: task-md#123, task-gh#456, task-json#789

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

// Session/Branch conversion functions
export function taskIdToSessionName(taskId: string): string {
  // md#123 → task-md#123
  if (isQualifiedTaskId(taskId)) {
    return `task-${taskId}`;
  }

  return taskId; // Return as-is if unparseable
}

export function sessionNameToTaskId(sessionName: string): string {
  // task-md#123 → md#123
  const match = sessionName.match(/^task-(.+)$/);
  if (match && match[1]) {
    return match[1];
  }

  return sessionName; // Return as-is if unparseable
}
