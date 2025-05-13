import { describe, test, expect, mock } from "bun:test";
import { startSession, type StartSessionOptions } from "./startSession";
import type { SessionDB, SessionRecord } from "../../domain/session";
import type { GitService } from "../../domain/git";
import type { TaskService, Task } from "../../domain/tasks";
import * as fs from "node:fs";
import * as path from "node:path";

// Mock implementations for instances
const mockGitServiceInstance = {
  clone: mock.fn(() => Promise.resolve({ workdir: "/test/repo/task#123" })),
  branch: mock.fn(() => Promise.resolve({ branch: "task#123" })),
};
const mockSessionDBInstance = {
  getSession: mock.fn(() => Promise.resolve(null)),
  addSession: mock.fn(() => Promise.resolve()),
  listSessions: mock.fn(() => Promise.resolve([])),
};
const mockTaskServiceInstance = {
  getTask: mock.fn((taskId: string): Promise<Task | null> => {
    if (taskId === "1" || taskId === "001") {
      return Promise.resolve({
        id: "#001", title: "Test Task 1", status: "TODO",
        specPath: "process/tasks/001-test-task.md", description: "Mock description"
      } as Task);
    }
    return Promise.resolve(null);
  }),
  getTaskStatus: mock.fn(() => Promise.resolve("TODO")),
  setTaskStatus: mock.fn(() => Promise.resolve()),
};

// Mock modules to return constructors that yield our mock instances
mock.module("../../domain/git.js", () => ({
  GitService: class { constructor() { return mockGitServiceInstance; } }
}));
mock.module("../../domain/session.js", () => ({
  SessionDB: class { constructor() { return mockSessionDBInstance; } }
}));
mock.module("../../domain/tasks.js", () => ({
  TaskService: class { constructor() { return mockTaskServiceInstance; } },
  TASK_STATUS: { TODO: "TODO", IN_PROGRESS: "IN-PROGRESS" },
}));
mock.module("../../domain/repo-utils.js", () => ({
  resolveRepoPath: mock.fn(() => Promise.resolve("/test/repo")),
  normalizeRepoName: mock.fn((name: string) => name.split('/').pop() || name),
}));


describe("startSession - Task ID Normalization", () => {
  const baseOptions: Partial<StartSessionOptions> = {
    repo: "/test/repo",
    noStatusUpdate: true,
  };

  beforeEach(() => {
    // Clear mocks before each test
    mockGitServiceInstance.clone.mockClear();
    mockGitServiceInstance.branch.mockClear();
    mockSessionDBInstance.getSession.mockClear();
    mockSessionDBInstance.addSession.mockClear();
    mockSessionDBInstance.listSessions.mockClear();
    mockTaskServiceInstance.getTask.mockClear();
    mockTaskServiceInstance.getTaskStatus.mockClear();
    mockTaskServiceInstance.setTaskStatus.mockClear();
    // Also clear the repo-utils mocks if they are to be checked per test
    const repoUtilsMocks = require("../../domain/repo-utils.js");
    repoUtilsMocks.resolveRepoPath.mockClear();
    repoUtilsMocks.normalizeRepoName.mockClear();
  });

  const idFormatsToTest = [
    { inputId: "1", expectedSessionName: "task#1", expectedTaskIdInRecord: "1" },
    { inputId: "001", expectedSessionName: "task#001", expectedTaskIdInRecord: "001" },
    { inputId: "#1", expectedSessionName: "task#1", expectedTaskIdInRecord: "1" },
    { inputId: "#001", expectedSessionName: "task#001", expectedTaskIdInRecord: "001" },
    { inputId: "task#1", expectedSessionName: "task#1", expectedTaskIdInRecord: "1" },
    { inputId: "task#001", expectedSessionName: "task#001", expectedTaskIdInRecord: "001" },
  ];

  for (const { inputId, expectedSessionName, expectedTaskIdInRecord } of idFormatsToTest) {
    test(`should correctly start session for taskId format: "${inputId}"`, async () => {
      const options: StartSessionOptions = {
        ...baseOptions,
        taskId: inputId,
      } as StartSessionOptions;

      const result = await startSession(options);

      expect(result.sessionRecord.session).toBe(expectedSessionName);
      expect(result.sessionRecord.taskId).toBe(expectedTaskIdInRecord);
      expect(result.branchResult.branch).toBe(expectedSessionName);

      expect(mockTaskServiceInstance.getTask).toHaveBeenCalledWith(expectedTaskIdInRecord);
      expect(mockSessionDBInstance.addSession).toHaveBeenCalledWith(
        expect.objectContaining({
          session: expectedSessionName,
          taskId: expectedTaskIdInRecord,
        })
      );
    });
  }

  test("should throw error for invalid task ID format", async () => {
    const options: StartSessionOptions = {
      ...baseOptions,
      taskId: "invalid-id",
    } as StartSessionOptions;
    await expect(startSession(options)).rejects.toThrow(
      'Invalid Task ID format provided: "invalid-id"'
    );
  });

  test("should throw error if task not found after normalization", async () => {
    const options: StartSessionOptions = {
      ...baseOptions,
      taskId: "#999", 
    } as StartSessionOptions;
    await expect(startSession(options)).rejects.toThrow(
      'Task with ID originating from "#999" (normalized to "999") not found'
    );
  });
});

// Remove or update the old placeholder tests
// describe("startSession", () => { ... });
// describe("Local Path to URL Conversion", () => { ... });
