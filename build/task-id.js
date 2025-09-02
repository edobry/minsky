// src/domain/tasks/task-id.ts
function parseTaskId(taskId) {
  if (!taskId || typeof taskId !== "string") {
    return null;
  }
  const hashIndex = taskId.indexOf("#");
  if (hashIndex === -1 || hashIndex === 0 || hashIndex === taskId.length - 1) {
    return null;
  }
  if (taskId.indexOf("#", hashIndex + 1) !== -1) {
    return null;
  }
  const backend = taskId.substring(0, hashIndex);
  const localId = taskId.substring(hashIndex + 1);
  if (!backend || !localId) {
    return null;
  }
  if (backend === "task" && /^\d+$/.test(localId)) {
    return null;
  }
  return {
    backend,
    localId,
    full: taskId,
  };
}
function isQualifiedTaskId(taskId) {
  return parseTaskId(taskId) !== null;
}
function formatTaskId(backend, localId) {
  if (!backend || typeof backend !== "string") {
    throw new Error("Backend must be a non-empty string");
  }
  if (!localId || typeof localId !== "string") {
    throw new Error("Local ID must be a non-empty string");
  }
  return `${backend}#${localId}`;
}
function extractBackend(taskId) {
  const parsed = parseTaskId(taskId);
  return parsed ? parsed.backend : null;
}
function extractLocalId(taskId) {
  const parsed = parseTaskId(taskId);
  return parsed ? parsed.localId : null;
}
function taskIdToSessionName(taskId) {
  if (isQualifiedTaskId(taskId)) {
    return `task-${taskId}`;
  }
  return taskId;
}
function sessionNameToTaskId(sessionName) {
  const match = sessionName.match(/^task-(.+)$/);
  if (match && match[1]) {
    return match[1];
  }
  return sessionName;
}
export {
  taskIdToSessionName,
  sessionNameToTaskId,
  parseTaskId,
  isQualifiedTaskId,
  formatTaskId,
  extractLocalId,
  extractBackend,
};
