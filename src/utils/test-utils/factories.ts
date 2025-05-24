/**
 * Test data factory functions for creating test fixtures
 * This module provides functions to create test data for various domain entities
 */
import { createMock } from "./mocking";
import type { TaskData, TaskStatusType } from "../../types/tasks/taskData";

/**
 * Creates a test task with specified overrides
 * @param overrides Optional properties to override defaults
 * @returns A task data object for testing
 */
export function createTaskData(overrides: Partial<TaskData> = {}): TaskData {
  const defaultId = `#${String(Math.floor(Math.random() * 900) + 100)}`; // Random 3-digit ID

  return {
    id: defaultId,
    title: "Test Task",
    status: "TODO",
    description: "This is a test task",
    worklog: [
      {
        timestamp: new Date().toISOString(),
        message: "Initial creation",
      },
    ],
    ...overrides,
  };
}

/**
 * Creates an array of task data for testing
 * @param count Number of tasks to create
 * @param commonOverrides Properties to apply to all tasks
 * @returns Array of task data objects
 */
export function createTaskDataArray(
  count: number,
  commonOverrides: Partial<TaskData> = {}
): TaskData[] {
  return Array(count)
    .fill(0)
    .map((_, index) => {
      // Create unique ID for each task
      const id = `#${String(100 + index).padStart(3, "0")}`;
      return createTaskData({
        id,
        ...commonOverrides,
      });
    });
}

/**
 * Creates test session data with specified overrides
 * @param overrides Optional properties to override defaults
 * @returns A session data object for testing
 */
export function createSessionData(
  overrides: {
    session?: string;
    taskId?: string;
    repoName?: string;
    repoPath?: string;
    branch?: string;
    createdAt?: string;
  } = {}
): any {
  const taskId = overrides.taskId || "123";
  const session = overrides.session || `task#${taskId}`;

  return {
    session,
    taskId,
    repoName: overrides.repoName || "test/repo",
    repoPath: overrides.repoPath || `/mock/repo/${createRandomId()}`,
    branch: overrides.branch || `task-${taskId}`,
    createdAt: overrides.createdAt || new Date().toISOString(),
  };
}

/**
 * Creates an array of session data for testing
 * @param count Number of sessions to create
 * @param commonOverrides Properties to apply to all sessions
 * @returns Array of session data objects
 */
export function createSessionDataArray(
  count: number,
  commonOverrides: Partial<Record<string, any>> = {}
): any[] {
  return Array(count)
    .fill(0)
    .map((_, index) => {
      const taskId = `${100 + index}`;
      return createSessionData({
        taskId,
        ...commonOverrides,
      });
    });
}

/**
 * Creates test repository data with specified overrides
 * @param overrides Optional properties to override defaults
 * @returns A repository data object for testing
 */
export function createRepositoryData(
  overrides: {
    name?: string;
    type?: string;
    repoUrl?: string;
    path?: string;
  } = {}
): any {
  return {
    name: overrides.name || "test-repo",
    type: overrides.type || "local",
    repoUrl: overrides.repoUrl || "file:///mock/repo/path",
    path: overrides.path || `/mock/repo/${createRandomId()}`,
  };
}

/**
 * Creates a random ID for testing
 * @param prefix Optional prefix for the ID
 * @returns A random string ID
 */
export function createRandomId(prefix: string = "test"): string {
  return `${prefix}-${Math.floor(Math.random() * 100000)}`;
}

/**
 * Creates a random task ID for testing
 * @returns A random task ID in the format #123
 */
export function createTaskId(): string {
  return `#${String(Math.floor(Math.random() * 900) + 100)}`;
}

/**
 * Creates a random string of specified length
 * @param length Length of the string to generate
 * @returns A random string
 */
export function createRandomString(length: number = 10): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Creates a random file path for testing
 * @param extension Optional file extension
 * @returns A random file path
 */
export function createRandomFilePath(extension: string = "txt"): string {
  const dirs = ["src", "test", "config", "docs"];
  const dir = dirs[Math.floor(Math.random() * dirs.length)];
  const filename = createRandomString(6);
  return `${dir}/${filename}.${extension}`;
}

/**
 * Creates appropriate test data based on field name
 * @param fieldName The name of the field to generate data for
 * @returns Appropriate test data for the field
 */
export function createFieldData(fieldName: string): any {
  // Generate appropriate data based on common field names
  switch (fieldName.toLowerCase()) {
  case "id":
    return createRandomId();
  case "name":
    return `Test ${createRandomString(5)}`;
  case "email":
    return `test.${createRandomString(5)}@example.com`;
  case "date":
  case "createdat":
  case "updatedat":
  case "timestamp":
    return new Date().toISOString();
  case "active":
  case "enabled":
  case "visible":
    return Math.random() > 0.5;
  case "count":
  case "age":
  case "quantity":
    return Math.floor(Math.random() * 100);
  case "price":
  case "amount":
    return parseFloat((Math.random() * 100).toFixed(2));
  default:
    return `Test ${fieldName} ${createRandomString(5)}`;
  }
}
