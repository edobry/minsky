import { describe, test, expect } from "bun:test";
import {
  createMockSessionProvider,
  createMockGitService,
  createMockTaskService,
  type MockSessionProviderOptions,
  type MockGitServiceOptions,
  type MockTaskServiceOptions
} from "./dependencies";
import type { SessionRecord } from "../../domain/session";
import type { Task } from "../../domain/tasks";

describe("Individual Service Mock Factories", () => {
  describe("createMockSessionProvider", () => {
    test("creates a mock with default behavior", async () => {
      const mockProvider = createMockSessionProvider();

      expect(await mockProvider.listSessions()).toEqual([]);
      expect(await mockProvider.getSession("test")).toBeNull();
      expect(await mockProvider.getSessionByTaskId("123")).toBeNull();
      expect(await mockProvider.deleteSession("test")).toBe(true);
      expect(await mockProvider.getRepoPath()).toBe("/mock/repo/path");
      expect(await mockProvider.getSessionWorkdir()).toBe("/mock/session/workdir");
      
      // Test methods that require parameters
      await mockProvider.addSession({
        session: "test",
        repoName: "test-repo", 
        repoUrl: "https://github.com/test/repo",
        createdAt: "2023-01-01T00:00:00Z"
      });
      await mockProvider.updateSession("test", { taskId: "456" });
    });

    test("uses provided sessions array", async () => {
      const sessions: SessionRecord[] = [
        {
          session: "test-session",
          repoName: "test-repo",
          repoUrl: "https://github.com/test/repo",
          createdAt: "2023-01-01T00:00:00Z",
          taskId: "123",
        },
      ];

      const mockProvider = createMockSessionProvider({ sessions });

      expect(await mockProvider.listSessions()).toEqual(sessions);
      expect(await mockProvider.getSession("test-session")).toEqual(sessions[0]);
      expect(await mockProvider.getSessionByTaskId("123")).toEqual(sessions[0]);
      expect(await mockProvider.getSession("nonexistent")).toBeNull();
    });

    test("accepts method overrides", async () => {
      const customOptions: MockSessionProviderOptions = {
        getSession: () => Promise.resolve({
          session: "custom",
          repoName: "custom-repo",
          repoUrl: "https://github.com/custom/repo",
          createdAt: "2023-01-01T00:00:00Z",
        }),
        deleteSession: () => Promise.resolve(false),
      };

      const mockProvider = createMockSessionProvider(customOptions);

      const result = await mockProvider.getSession("any");
      expect(result?.session).toBe("custom");
      expect(await mockProvider.deleteSession("any")).toBe(false);
    });

    test("supports empty options", async () => {
      const mockProvider = createMockSessionProvider({});
      expect(await mockProvider.listSessions()).toEqual([]);
    });
  });

  describe("createMockGitService", () => {
    test("creates a mock with default behavior", async () => {
      const mockService = createMockGitService();

      expect(await mockService.clone()).toEqual({
        workdir: "/mock/workdir",
        session: "test-session",
      });
      expect(await mockService.branch()).toEqual({
        workdir: "/mock/workdir",
        branch: "test-branch",
      });
      expect(mockService.getSessionWorkdir()).toBe("/mock/session/workdir");
      expect(await mockService.getStatus()).toEqual({
        modified: [],
        untracked: [],
        deleted: [],
      });
    });

    test("supports branch existence configuration", async () => {
      const mockServiceExists = createMockGitService({ branchExists: true });
      const mockServiceNotExists = createMockGitService({ branchExists: false });

      expect(await mockServiceExists.execInRepository("/test", "show-ref pr/123")).toBe("ref-exists");
      expect(await mockServiceNotExists.execInRepository("/test", "show-ref pr/123")).toBe("not-exists");
      expect(await mockServiceExists.execInRepository("/test", "ls-remote pr/123")).toBe("remote-ref-exists");
      expect(await mockServiceNotExists.execInRepository("/test", "ls-remote pr/123")).toBe("");
    });

    test("tracks git call count", async () => {
      const mockService = createMockGitService();

      expect((mockService as any).getGitCallCount()).toBe(0);

      await mockService.execInRepository("/test", "status");
      expect((mockService as any).getGitCallCount()).toBe(1);

      await mockService.execInRepository("/test", "log");
      expect((mockService as any).getGitCallCount()).toBe(2);

      (mockService as any).resetGitCallCount();
      expect((mockService as any).getGitCallCount()).toBe(0);
    });

    test("accepts method overrides", async () => {
      const customOptions: MockGitServiceOptions = {
        clone: () => Promise.resolve({
          workdir: "/custom/workdir",
          session: "custom-session",
        }),
        getSessionWorkdir: () => "/custom/session/workdir",
      };

      const mockService = createMockGitService(customOptions);

      expect(await mockService.clone()).toEqual({
        workdir: "/custom/workdir",
        session: "custom-session",
      });
      expect(mockService.getSessionWorkdir()).toBe("/custom/session/workdir");
    });

    test("handles non-PR git commands", async () => {
      const mockService = createMockGitService();

      expect(await mockService.execInRepository("/test", "status")).toBe("mock git output");
      expect(await mockService.execInRepository("/test", "log --oneline")).toBe("mock git output");
    });
  });

  describe("createMockTaskService", () => {
    test("creates a mock with default behavior", async () => {
      const mockService = createMockTaskService();

      expect(await mockService.getTask("123")).toBeNull();
      expect(await mockService.listTasks()).toEqual([]);
      expect(await mockService.getTaskStatus("123")).toBeUndefined();
      expect(await mockService.deleteTask("123")).toBe(false);
      expect(await mockService.getBackendForTask("123")).toBe("markdown");
    });

    test("creates tasks with proper structure", async () => {
      const mockService = createMockTaskService();

      const task = await mockService.createTask("/path/to/spec");
      expect(task).toEqual({
        id: "#test",
        title: "Test Task",
        status: "TODO",
      });

      const taskFromTitle = await mockService.createTaskFromTitleAndDescription(
        "Custom Title",
        "Custom Description"
      );
      expect(taskFromTitle).toEqual({
        id: "#test-from-title",
        title: "Test Task",
        status: "TODO",
      });
    });

    test("supports additional properties", () => {
      const mockService = createMockTaskService({
        backends: ["markdown", "json"],
        currentBackend: "json",
        getWorkspacePath: () => "/custom/workspace",
      });

      expect((mockService as any).backends).toEqual(["markdown", "json"]);
      expect((mockService as any).currentBackend).toBe("json");
      expect((mockService as any).getWorkspacePath()).toBe("/custom/workspace");
    });

    test("accepts method overrides", async () => {
      const customTask: Task = {
        id: "#custom",
        title: "Custom Task",
        status: "IN_PROGRESS",
      };

      const customOptions: MockTaskServiceOptions = {
        mockGetTask: () => Promise.resolve(customTask),
        getTaskStatus: () => Promise.resolve("IN_PROGRESS"),
        deleteTask: () => Promise.resolve(true),
      };

      const mockService = createMockTaskService(customOptions);

      expect(await mockService.getTask("any")).toEqual(customTask);
      expect(await mockService.getTaskStatus("any")).toBe("IN_PROGRESS");
      expect(await mockService.deleteTask("any")).toBe(true);
    });

    test("supports custom task creation", async () => {
      const customOptions: MockTaskServiceOptions = {
        createTask: () => Promise.resolve({
          id: "#custom-create",
          title: "Custom Created Task",
          status: "CREATED",
        }),
      };

      const mockService = createMockTaskService(customOptions);

      const task = await mockService.createTask("/custom/spec");
      expect(task).toEqual({
        id: "#custom-create",
        title: "Custom Created Task",
        status: "CREATED",
      });
    });

    test("handles empty options", async () => {
      const mockService = createMockTaskService({});
      expect(await mockService.listTasks()).toEqual([]);
      expect((mockService as any).backends).toEqual([]);
      expect((mockService as any).currentBackend).toBe("test");
    });
  });

  describe("Factory Integration", () => {
    test("all factories work together in a test scenario", async () => {
      const sessions: SessionRecord[] = [
        {
          session: "integration-session",
          repoName: "integration-repo",
          repoUrl: "https://github.com/test/integration",
          createdAt: "2023-01-01T00:00:00Z",
          taskId: "INT-001",
        },
      ];

      const mockSessionProvider = createMockSessionProvider({ sessions });
      const mockGitService = createMockGitService({ branchExists: true });
      const mockTaskService = createMockTaskService({
        mockGetTask: () => Promise.resolve({
          id: "#INT-001",
          title: "Integration Task",
          status: "IN_PROGRESS",
        }),
      });

      // Test session provider
      const session = await mockSessionProvider.getSessionByTaskId("INT-001");
      expect(session?.session).toBe("integration-session");

      // Test git service
      const branchResult = await mockGitService.execInRepository("/test", "show-ref pr/INT-001");
      expect(branchResult).toBe("ref-exists");

      // Test task service
      const task = await mockTaskService.getTask("INT-001");
      expect(task?.title).toBe("Integration Task");
    });

    test("factories can be used independently", async () => {
      // Each factory should work on its own without dependencies
      const sessionProvider = createMockSessionProvider();
      const gitService = createMockGitService();
      const taskService = createMockTaskService();

      expect(sessionProvider).toBeDefined();
      expect(gitService).toBeDefined();
      expect(taskService).toBeDefined();

      // Basic functionality should work
      expect(await sessionProvider.listSessions()).toEqual([]);
      expect(await gitService.getStatus()).toBeDefined();
      expect(await taskService.listTasks()).toEqual([]);
    });
  });
}); 
