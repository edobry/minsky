// Types
export interface BackendQualifiedId {
  backend: string;
  localId: string;
  full: string; // Full qualified ID string "backend:localId"
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

// Git branch naming conversion functions
export function sessionNameToBranchName(sessionName: string): string {
  if (!sessionName || typeof sessionName !== "string") {
    return sessionName;
  }

  // Convert task#md:123 → task#md-123
  // Only replace the first colon after # to maintain git compatibility
  const hashIndex = sessionName.indexOf("#");
  if (hashIndex === -1) {
    return sessionName;
  }

  const beforeHash = sessionName.substring(0, hashIndex + 1);
  const afterHash = sessionName.substring(hashIndex + 1);

  // Replace the first colon in the after-hash part
  const colonIndex = afterHash.indexOf(":");
  if (colonIndex === -1) {
    return sessionName; // No colon, return as-is
  }

  const converted = `${beforeHash + afterHash.substring(0, colonIndex)}-${afterHash.substring(colonIndex + 1)}`;
  return converted;
}

export function branchNameToSessionName(branchName: string): string {
  if (!branchName || typeof branchName !== "string") {
    return branchName;
  }

  // Convert task#md-123 → task#md:123
  // Only replace the first dash after # that represents a backend separator
  const hashIndex = branchName.indexOf("#");
  if (hashIndex === -1) {
    return branchName;
  }

  const beforeHash = branchName.substring(0, hashIndex + 1);
  const afterHash = branchName.substring(hashIndex + 1);

  // Look for pattern: backend-localId
  // Find the first dash that could be a backend separator
  const dashIndex = afterHash.indexOf("-");
  if (dashIndex === -1) {
    return branchName; // No dash, return as-is
  }

  // Check if this looks like a backend-localId pattern
  const potentialBackend = afterHash.substring(0, dashIndex);
  if (!potentialBackend) {
    return branchName; // Invalid pattern
  }

  const converted = `${beforeHash + potentialBackend}:${afterHash.substring(dashIndex + 1)}`;
  return converted;
}
