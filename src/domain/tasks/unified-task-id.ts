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

  // Handle legacy task#123 format first
  const legacyTaskMatch = taskId.match(/^task#(\d+)$/);
  if (legacyTaskMatch && legacyTaskMatch[1]) {
    return `task-md#${legacyTaskMatch[1]}`;
  }

  // Handle legacy unqualified IDs - assume markdown backend
  if (/^\d+$/.test(taskId)) {
    return `task-md#${taskId}`;
  }

  // Handle legacy #123 format
  const legacyHashMatch = taskId.match(/^#(\d+)$/);
  if (legacyHashMatch && legacyHashMatch[1]) {
    return `task-md#${legacyHashMatch[1]}`;
  }

  return taskId; // Return as-is if unparseable
}

export function sessionNameToTaskId(sessionName: string): string {
  // task-md#123 → md#123
  const match = sessionName.match(/^task-(.+)$/);
  if (match && match[1]) {
    return match[1];
  }

  // Handle legacy task#123 format
  const legacyMatch = sessionName.match(/^task#(\d+)$/);
  if (legacyMatch && legacyMatch[1]) {
    return `md#${legacyMatch[1]}`;
  }

  return sessionName; // Return as-is if unparseable
}

// Migration utilities
export function migrateUnqualifiedTaskId(taskId: string, defaultBackend = "md"): string {
  // Already qualified
  if (isQualifiedTaskId(taskId)) {
    return taskId;
  }

  // Plain number → md#123
  if (/^\d+$/.test(taskId)) {
    return formatTaskId(defaultBackend, taskId);
  }

  // task#123 → md#123
  const legacyTaskMatch = taskId.match(/^task#(\d+)$/);
  if (legacyTaskMatch && legacyTaskMatch[1]) {
    return formatTaskId(defaultBackend, legacyTaskMatch[1]);
  }

  // #123 → md#123
  const legacyHashMatch = taskId.match(/^#(\d+)$/);
  if (legacyHashMatch && legacyHashMatch[1]) {
    return formatTaskId(defaultBackend, legacyHashMatch[1]);
  }

  return taskId; // Can't migrate, return as-is
}

// Backward compatibility
export function isLegacyTaskId(taskId: string): boolean {
  return /^\d+$/.test(taskId) || /^task#\d+$/.test(taskId);
}

export function normalizeLegacyTaskId(taskId: string, defaultBackend = "md"): string {
  if (isLegacyTaskId(taskId)) {
    return migrateUnqualifiedTaskId(taskId, defaultBackend);
  }
  return taskId;
}
