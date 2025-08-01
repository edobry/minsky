// Types
export interface BackendQualifiedId {
  backend: string;
  localId: string;
  full: string; // Full task ID string "task-backend#localId"
}

export interface TaskBackendMeta {
  prefix: string;
  name: string;
}

// Core ID parsing and validation functions
export function parseTaskId(taskId: string): BackendQualifiedId | null {
  if (!taskId || typeof taskId !== "string") {
    return null;
  }

  // Check for basic format: backend:localId
  const colonIndex = taskId.indexOf(":");
  if (colonIndex === -1 || colonIndex === 0 || colonIndex === taskId.length - 1) {
    return null;
  }

  // Check for multiple colons (not allowed)
  if (taskId.indexOf(":", colonIndex + 1) !== -1) {
    return null;
  }

  const backend = taskId.substring(0, colonIndex);
  const localId = taskId.substring(colonIndex + 1);

  // Validate backend and localId are not empty
  if (!backend || !localId) {
    return null;
  }

  return {
    backend,
    localId,
    full: taskId,
  };
}

export function isQualifiedId(taskId: string): boolean {
  return parseTaskId(taskId) !== null;
}

export function formatTaskId(backend: string, localId: string): string {
  if (!backend || typeof backend !== "string") {
    throw new Error("Backend must be a non-empty string");
  }
  if (!localId || typeof localId !== "string") {
    throw new Error("Local ID must be a non-empty string");
  }

  return `${backend}:${localId}`;
}

export function formatForDisplay(taskId: string): string {
  // Return as-is for both qualified and unqualified IDs
  return taskId;
}

export function extractBackendFromId(taskId: string): string | null {
  const parsed = parseTaskId(taskId);
  return parsed ? parsed.backend : null;
}

export function extractLocalIdFromId(taskId: string): string | null {
  if (!taskId || typeof taskId !== "string") {
    return null;
  }

  const parsed = parseTaskId(taskId);
  if (parsed) {
    return parsed.localId;
  }

  // For backward compatibility, return the full ID if it's not qualified
  // but only if it doesn't contain colons (which would make it malformed)
  if (taskId.includes(":")) {
    return null; // Contains colon but failed parsing, so it's malformed
  }

  return taskId ? taskId : null;
}

// Unified format conversion functions
// UNIFIED FORMAT: task-md#123 (used everywhere - tasks, sessions, branches)

export function qualifiedIdToUnifiedFormat(qualifiedId: string): string {
  const parsed = parseTaskId(qualifiedId);
  if (!parsed) {
    // Handle legacy unqualified IDs - assume markdown backend
    if (/^\d+$/.test(qualifiedId)) {
      return `task-md#${qualifiedId}`;
    }
    return qualifiedId; // Return as-is if unparseable
  }

  return `task-${parsed.backend}#${parsed.localId}`;
}

export function unifiedFormatToQualifiedId(unifiedFormat: string): string {
  // Parse task-md#123 → md:123
  const match = unifiedFormat.match(/^task-([^#]+)#(.+)$/);
  if (!match) {
    // Handle legacy formats or invalid input
    const legacyMatch = unifiedFormat.match(/^task#(\d+)$/);
    if (legacyMatch) {
      return `md:${legacyMatch[1]}`; // task#123 → md:123
    }

    // Check if it's already a qualified ID
    if (parseTaskId(unifiedFormat)) {
      return unifiedFormat;
    }

    // If it looks like a plain number, assume markdown backend
    if (/^\d+$/.test(unifiedFormat)) {
      return `md:${unifiedFormat}`;
    }

    return unifiedFormat; // Return as-is if unparseable
  }

  const [, backend, localId] = match;
  if (!backend || !localId) {
    return unifiedFormat; // Return as-is if invalid
  }
  return formatTaskId(backend, localId);
}

// Git branch naming conversion functions
export function sessionNameToBranchName(sessionName: string): string {
  // Convert colons to dashes for git branch compatibility
  // task#md:123 → task#md-123
  return sessionName.replace(/:/g, "-");
}

export function branchNameToSessionName(branchName: string): string {
  // Convert dashes back to colons for session names
  // task#md-123 → task#md:123
  // task#gh-issue-123 → task#gh:issue-123
  // Find the backend part and convert only the separator dash to colon
  const match = branchName.match(/^(.+#)([^#-]+)-(.+)$/);
  if (match) {
    const [, prefix, backend, localId] = match;
    return `${prefix}${backend}:${localId}`;
  }
  return branchName; // Return as-is if no conversion needed
}

// Migration utilities
export function migrateUnqualifiedId(taskId: string, defaultBackend = "md"): string {
  // Convert unqualified ID to qualified format
  if (isQualifiedId(taskId)) {
    return taskId; // Already qualified
  }

  if (/^\d+$/.test(taskId)) {
    return formatTaskId(defaultBackend, taskId);
  }

  // Handle task#123 format
  const legacyMatch = taskId.match(/^(?:task#)?(\d+)$/);
  if (legacyMatch && legacyMatch[1]) {
    return formatTaskId(defaultBackend, legacyMatch[1]);
  }

  return taskId; // Can't migrate, return as-is
}
