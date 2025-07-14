/**
 * Tests for centralized service mock factories
 * 
 * This file demonstrates the usage of the new centralized service mock factories
 * and verifies they provide comprehensive interface coverage.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  createMockSessionProvider,
  createMockGitService,
  createMockTaskService,
} from "./dependencies";
import type { SessionProviderInterface } from "../../domain/session";
import type { GitServiceInterface } from "../../domain/git";
import type { TaskServiceInterface } from "../../domain/tasks";

describe("Centralized Service Mock Factories", () => {
  describe("createMockSessionProvider", () => {
    test("should create a mock SessionProvider with all required methods", () => {
      const mockSessionProvider = createMockSessionProvider();

      // Verify all interface methods are present
      expect(typeof mockSessionProvider.listSessions).toBe("function");
      expect(typeof mockSessionProvider.getSession).toBe("function");
      expect(typeof mockSessionProvider.getSessionByTaskId).toBe("function");
      expect(typeof mockSessionProvider.addSession).toBe("function");
      expect(typeof mockSessionProvider.updateSession).toBe("function");
      expect(typeof mockSessionProvider.deleteSession).toBe("function");
      expect(typeof mockSessionProvider.getRepoPath).toBe("function");
      expect(typeof mockSessionProvider.getSessionWorkdir).toBe("function");
    });

    test("should return default mock values", async () => {
      const mockSessionProvider = createMockSessionProvider();

      // Test default return values
      expect(await mockSessionProvider.listSessions()).toEqual([]);
      expect(await mockSessionProvider.getSession("test")).toBeNull();
      expect(await mockSessionProvider.getSessionByTaskId("test")).toBeNull();
      expect(await mockSessionProvider.deleteSession("test")).toBe(true);
      expect(await mockSessionProvider.getRepoPath({} as any)).toBe("/mock/repo/path");
      expect(await mockSessionProvider.getSessionWorkdir("test")).toBe("/mock/session/workdir");
    });

    test("should allow method overrides", async () => {
      const mockSessionProvider = createMockSessionProvider({
        getSession: () => Promise.resolve({
          session: "custom-session",
          repoName: "custom-repo",
          repoUrl: "https://custom.com/repo",
          createdAt: "2023-01-01T00:00:00Z",
          taskId: "#123",
          branch: "custom-branch",
          repoPath: "/custom/path",
        }),
        listSessions: () => Promise.resolve([
          {
            session: "session1",
            repoName: "repo1",
            repoUrl: "https://example.com/repo1",
            createdAt: "2023-01-01T00:00:00Z",
            taskId: "#001",
            branch: "main",
            repoPath: "/path/to/repo1",
          },
        ]),
      });

      const session = await mockSessionProvider.getSession("test");
      expect(session?.session).toBe("custom-session");
      expect(session?.repoName).toBe("custom-repo");

      const sessions = await mockSessionProvider.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].session).toBe("session1");
    });
  });

  describe("createMockGitService", () => {
    test("should create a mock GitService with all required methods", () => {
      const mockGitService = createMockGitService();

      // Verify all interface methods are present
      expect(typeof mockGitService.clone).toBe("function");
      expect(typeof mockGitService.branch).toBe("function");
      expect(typeof mockGitService.branchWithoutSession).toBe("function");
      expect(typeof mockGitService.execInRepository).toBe("function");
      expect(typeof mockGitService.getSessionWorkdir).toBe("function");
      expect(typeof mockGitService.stashChanges).toBe("function");
      expect(typeof mockGitService.pullLatest).toBe("function");
      expect(typeof mockGitService.mergeBranch).toBe("function");
      expect(typeof mockGitService.push).toBe("function");
      expect(typeof mockGitService.popStash).toBe("function");
      expect(typeof mockGitService.getStatus).toBe("function");
      expect(typeof mockGitService.getCurrentBranch).toBe("function");
      expect(typeof mockGitService.hasUncommittedChanges).toBe("function");
      expect(typeof mockGitService.fetchDefaultBranch).toBe("function");
      expect(typeof mockGitService.predictMergeConflicts).toBe("function");
      expect(typeof mockGitService.analyzeBranchDivergence).toBe("function");
      expect(typeof mockGitService.smartSessionUpdate).toBe("function");
    });

    test("should return default mock values", async () => {
      const mockGitService = createMockGitService();

      // Test default return values
      const cloneResult = await mockGitService.clone({ repoUrl: "test", workdir: "/test/workdir", session: "test" });
      expect(cloneResult.workdir).toBe("/mock/workdir");
      expect(cloneResult.session).toBe("test-session");

      const branchResult = await mockGitService.branch({ session: "test", branch: "test" });
      expect(branchResult.workdir).toBe("/mock/workdir");
      expect(branchResult.branch).toBe("test-branch");

      const execResult = await mockGitService.execInRepository("/test", "status");
      expect(execResult).toBe("mock git output");

      const workdir = mockGitService.getSessionWorkdir("test");
      expect(workdir).toBe("/mock/session/workdir");

      const status = await mockGitService.getStatus();
      expect(status).toEqual({ modified: [], untracked: [], deleted: [] });

      const currentBranch = await mockGitService.getCurrentBranch("/test");
      expect(currentBranch).toBe("main");

      const hasChanges = await mockGitService.hasUncommittedChanges("/test");
      expect(hasChanges).toBe(false);
    });

    test("should allow method overrides", async () => {
      const mockGitService = createMockGitService({
        clone: () => Promise.resolve({ workdir: "/custom/workdir", session: "custom-session" }),
        execInRepository: () => Promise.resolve("custom git output"),
        getStatus: () => Promise.resolve({ modified: ["file1.ts"], untracked: [], deleted: [] }),
      });

      const cloneResult = await mockGitService.clone({ repoUrl: "test", workdir: "/test/workdir", session: "test" });
      expect(cloneResult.workdir).toBe("/custom/workdir");
      expect(cloneResult.session).toBe("custom-session");

      const execResult = await mockGitService.execInRepository("/test", "status");
      expect(execResult).toBe("custom git output");

      const status = await mockGitService.getStatus();
      expect(status.modified).toEqual(["file1.ts"]);
    });
  });

  describe("createMockTaskService", () => {
    test("should create a mock TaskService with all required methods", () => {
      const mockTaskService = createMockTaskService();

      // Verify all interface methods are present
      expect(typeof mockTaskService.listTasks).toBe("function");
      expect(typeof mockTaskService.getTask).toBe("function");
      expect(typeof mockTaskService.getTaskStatus).toBe("function");
      expect(typeof mockTaskService.setTaskStatus).toBe("function");
      expect(typeof mockTaskService.getWorkspacePath).toBe("function");
      expect(typeof mockTaskService.createTask).toBe("function");
      expect(typeof mockTaskService.createTaskFromTitleAndDescription).toBe("function");
      expect(typeof mockTaskService.deleteTask).toBe("function");
      expect(typeof mockTaskService.getBackendForTask).toBe("function");
    });

    test("should return default mock values", async () => {
      const mockTaskService = createMockTaskService();

      // Test default return values
      const tasks = await mockTaskService.listTasks();
      expect(tasks).toEqual([]);

      const task = await mockTaskService.getTask("test");
      expect(task).toBeNull();

      const status = await mockTaskService.getTaskStatus("test");
      expect(status).toBeUndefined();

      const workspacePath = mockTaskService.getWorkspacePath();
      expect(workspacePath).toBe("/mock/workspace/path");

      const createdTask = await mockTaskService.createTask("test-spec.md");
      expect(createdTask.id).toBe("#test");
      expect(createdTask.title).toBe("Test Task");
      expect(createdTask.status).toBe("TODO");

      const createdTaskFromTitle = await mockTaskService.createTaskFromTitleAndDescription("Test Title", "Test Description");
      expect(createdTaskFromTitle.title).toBe("Test Task");

      const deleted = await mockTaskService.deleteTask("test");
      expect(deleted).toBe(true);

      const backend = await mockTaskService.getBackendForTask("test");
      expect(backend).toBe("markdown");
    });

    test("should allow method overrides", async () => {
      const mockTaskService = createMockTaskService({
        listTasks: () => Promise.resolve([
          {
            id: "#001",
            title: "Custom Task",
            status: "IN-PROGRESS",
            description: "Custom task description",
            worklog: [],
          },
        ]),
        getTask: () => Promise.resolve({
          id: "#001",
          title: "Custom Task",
          status: "IN-PROGRESS",
          description: "Custom task description",
          worklog: [],
        }),
        getTaskStatus: () => Promise.resolve("IN-PROGRESS"),
        getWorkspacePath: () => "/custom/workspace/path",
      });

      const tasks = await mockTaskService.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].title).toBe("Custom Task");
      expect(tasks[0].status).toBe("IN-PROGRESS");

      const task = await mockTaskService.getTask("test");
      expect(task?.title).toBe("Custom Task");
      expect(task?.status).toBe("IN-PROGRESS");

      const status = await mockTaskService.getTaskStatus("test");
      expect(status).toBe("IN-PROGRESS");

      const workspacePath = mockTaskService.getWorkspacePath();
      expect(workspacePath).toBe("/custom/workspace/path");
    });
  });
}); 
