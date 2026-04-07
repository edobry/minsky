import { describe, test, expect } from "bun:test";
import { FakeGitService } from "../../domain/git/fake-git-service";
import { FakeTaskService } from "../../domain/tasks/fake-task-service";
import { FakeSessionProvider } from "../../domain/session/fake-session-provider";
import type { SessionRecord } from "../../domain/session";
import type { Task } from "../../domain/tasks";
import { TEST_DESC_PATTERNS } from "./test-constants";

describe("Individual Service Mock Factories", () => {
  describe("FakeSessionProvider", () => {
    test(TEST_DESC_PATTERNS.CREATES_MOCK_DEFAULT, async () => {
      const mockProvider = new FakeSessionProvider();

      expect(await mockProvider.listSessions()).toEqual([]);
      expect(await mockProvider.getSession("test")).toBeNull();
      expect(await mockProvider.getSessionByTaskId("123")).toBeNull();
      expect(await mockProvider.deleteSession("test")).toBe(false);
      expect(
        await mockProvider.getRepoPath({
          session: "test",
          repoName: "test-repo",
          repoUrl: "https://github.com/test/repo",
          createdAt: "2023-01-01T00:00:00Z",
        })
      ).toBe("/mock/repo/path");
      expect(await mockProvider.getSessionWorkdir("test")).toBe("/mock/session/workdir");

      // Test methods that require parameters
      await mockProvider.addSession({
        session: "test",
        repoName: "test-repo",
        repoUrl: "https://github.com/test/repo",
        createdAt: "2023-01-01T00:00:00Z",
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
          taskId: "md#123",
        },
      ];

      const mockProvider = new FakeSessionProvider({ initialSessions: sessions });

      expect(await mockProvider.listSessions()).toEqual(sessions);
      expect(await mockProvider.getSession("test-session")).toEqual(sessions[0] ?? null);
      expect(await mockProvider.getSessionByTaskId("md#123")).toEqual(sessions[0] ?? null);
      expect(await mockProvider.getSession("nonexistent")).toBeNull();
    });

    test(TEST_DESC_PATTERNS.ACCEPTS_METHOD_OVERRIDES, async () => {
      const mockProvider = new FakeSessionProvider();
      mockProvider.getSession = () =>
        Promise.resolve({
          session: "custom",
          repoName: "custom-repo",
          repoUrl: "https://github.com/custom/repo",
          createdAt: "2023-01-01T00:00:00Z",
        });
      mockProvider.deleteSession = () => Promise.resolve(false);

      const result = await mockProvider.getSession("any");
      expect(result?.session).toBe("custom");
      expect(await mockProvider.deleteSession("any")).toBe(false);
    });

    test("supports empty options", async () => {
      const mockProvider = new FakeSessionProvider({});
      expect(await mockProvider.listSessions()).toEqual([]);
    });

    test("maintains state across calls", async () => {
      const mockProvider = new FakeSessionProvider();

      expect(await mockProvider.listSessions()).toEqual([]);

      const record: SessionRecord = {
        session: "new-session",
        repoName: "test-repo",
        repoUrl: "https://github.com/test/repo",
        createdAt: "2023-01-01T00:00:00Z",
      };
      await mockProvider.addSession(record);
      expect(await mockProvider.listSessions()).toHaveLength(1);

      await mockProvider.updateSession("new-session", { taskId: "md#42" });
      const updated = await mockProvider.getSession("new-session");
      expect(updated?.taskId).toBe("md#42");

      expect(await mockProvider.deleteSession("new-session")).toBe(true);
      expect(await mockProvider.listSessions()).toEqual([]);
    });
  });

  describe("FakeGitService", () => {
    test(TEST_DESC_PATTERNS.CREATES_MOCK_DEFAULT, async () => {
      const mockService = new FakeGitService();

      expect(
        await mockService.clone({
          repoUrl: "https://github.com/test/repo",
          workdir: "/mock/workdir",
          session: "test-session",
        })
      ).toEqual({
        workdir: "/mock/workdir",
        session: "test-session",
      });
      expect(await mockService.branch({ session: "test-session", branch: "test-branch" })).toEqual({
        workdir: "/mock/workdir",
        branch: "test-branch",
      });
      expect(mockService.getSessionWorkdir("test-session")).toBe("/mock/session/workdir");
      expect(await mockService.getStatus()).toEqual({
        modified: [],
        untracked: [],
        deleted: [],
      });
    });

    test("supports branch existence configuration", async () => {
      const mockServiceExists = new FakeGitService({ branchExists: true });
      const mockServiceNotExists = new FakeGitService({ branchExists: false });

      expect(await mockServiceExists.execInRepository("/test", "show-ref pr/123")).toBe(
        "ref-exists"
      );
      expect(await mockServiceNotExists.execInRepository("/test", "show-ref pr/123")).toBe(
        "not-exists"
      );
      expect(await mockServiceExists.execInRepository("/test", "ls-remote pr/123")).toBe(
        "remote-ref-exists"
      );
      expect(await mockServiceNotExists.execInRepository("/test", "ls-remote pr/123")).toBe("");
    });

    test("tracks git call count", async () => {
      const mockService = new FakeGitService();

      expect(mockService.callCount).toBe(0);

      await mockService.execInRepository("/test", "status");
      expect(mockService.callCount).toBe(1);

      await mockService.execInRepository("/test", "log");
      expect(mockService.callCount).toBe(2);

      mockService.resetCallCount();
      expect(mockService.callCount).toBe(0);
    });

    test(TEST_DESC_PATTERNS.ACCEPTS_METHOD_OVERRIDES, async () => {
      const mockService = new FakeGitService();
      mockService.clone = () =>
        Promise.resolve({
          workdir: "/custom/workdir",
          session: "custom-session",
        });
      mockService.getSessionWorkdir = () => "/custom/session/workdir";

      expect(
        await mockService.clone({
          repoUrl: "https://github.com/test/repo",
          workdir: "/custom/workdir",
          session: "custom-session",
        })
      ).toEqual({
        workdir: "/custom/workdir",
        session: "custom-session",
      });
      expect(mockService.getSessionWorkdir("test-session")).toBe("/custom/session/workdir");
    });

    test("handles non-PR git commands", async () => {
      const mockService = new FakeGitService();

      expect(await mockService.execInRepository("/test", "status")).toBe("mock git output");
      expect(await mockService.execInRepository("/test", "log --oneline")).toBe("mock git output");
    });
  });

  describe("FakeTaskService", () => {
    test(TEST_DESC_PATTERNS.CREATES_MOCK_DEFAULT, async () => {
      const mockService = new FakeTaskService();

      expect(await mockService.getTask("123")).toBeNull();
      expect(await mockService.listTasks()).toEqual([]);
      expect(await mockService.getTaskStatus("123")).toBeUndefined();
      expect(await mockService.deleteTask("123")).toBe(false);
      expect(await mockService.getBackendForTask!("123")).toBe("markdown");
    });

    test("creates tasks with proper structure", async () => {
      const mockService = new FakeTaskService();

      const task = await mockService.createTask("/path/to/spec");
      expect(task.id).toMatch(/^#fake-/);
      expect(task.title).toBe("Fake Task");
      expect(task.status).toBe("TODO");

      const taskFromTitle = await mockService.createTaskFromTitleAndSpec(
        "Custom Title",
        "Custom Description"
      );
      expect(taskFromTitle.id).toMatch(/^#fake-/);
      expect(taskFromTitle.title).toBe("Custom Title");
      expect(taskFromTitle.status).toBe("TODO");
    });

    test("supports initialTasks constructor option", async () => {
      const initialTasks: Task[] = [
        { id: "#001", title: "First Task", status: "TODO" },
        { id: "#002", title: "Second Task", status: "IN_PROGRESS" },
      ];
      const mockService = new FakeTaskService({ initialTasks });

      expect(await mockService.listTasks()).toEqual(initialTasks);
      expect(await mockService.getTask("#001")).toEqual(initialTasks[0] ?? null);
      expect(await mockService.getTask("#002")).toEqual(initialTasks[1] ?? null);
      expect(await mockService.getTask("#999")).toBeNull();
    });

    test("supports custom workspacePath", () => {
      const mockService = new FakeTaskService({ workspacePath: "/custom/workspace" });
      expect(mockService.getWorkspacePath()).toBe("/custom/workspace");
    });

    test(TEST_DESC_PATTERNS.ACCEPTS_METHOD_OVERRIDES, async () => {
      const customTask: Task = {
        id: "#custom",
        title: "Custom Task",
        status: "IN_PROGRESS",
      };

      const mockService = new FakeTaskService();
      mockService.getTask = () => Promise.resolve(customTask);
      mockService.getTaskStatus = () => Promise.resolve("IN_PROGRESS");
      mockService.deleteTask = () => Promise.resolve(true);

      expect(await mockService.getTask("any")).toEqual(customTask);
      expect(await mockService.getTaskStatus("any")).toBe("IN_PROGRESS");
      expect(await mockService.deleteTask("any")).toBe(true);
    });

    test("supports custom task creation via method reassignment", async () => {
      const mockService = new FakeTaskService();
      mockService.createTask = () =>
        Promise.resolve({
          id: "#custom-create",
          title: "Custom Created Task",
          status: "CREATED",
        });

      const task = await mockService.createTask("/custom/spec");
      expect(task).toEqual({
        id: "#custom-create",
        title: "Custom Created Task",
        status: "CREATED",
      });
    });

    test("maintains state across calls", async () => {
      const mockService = new FakeTaskService();

      expect(await mockService.listTasks()).toEqual([]);
      await mockService.createTask("/spec");
      expect(await mockService.listTasks()).toHaveLength(1);

      const task = (await mockService.listTasks())[0]!;
      await mockService.setTaskStatus(task.id, "DONE");
      expect(await mockService.getTaskStatus(task.id)).toBe("DONE");

      await mockService.deleteTask(task.id);
      expect(await mockService.listTasks()).toEqual([]);
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
          taskId: "md#001",
        },
      ];

      const mockSessionProvider = new FakeSessionProvider({ initialSessions: sessions });
      const mockGitService = new FakeGitService({ branchExists: true });
      const mockTaskService = new FakeTaskService({
        initialTasks: [{ id: "md#001", title: "Integration Task", status: "IN_PROGRESS" }],
      });

      // Test session provider
      const session = await mockSessionProvider.getSessionByTaskId("md#001");
      expect(session?.session).toBe("integration-session");

      // Test git service
      const branchResult = await mockGitService.execInRepository("/test", "show-ref pr/md#001");
      expect(branchResult).toBe("ref-exists");

      // Test task service
      const task = await mockTaskService.getTask("md#001");
      expect(task?.title).toBe("Integration Task");
    });

    test("factories can be used independently", async () => {
      // Each factory should work on its own without dependencies
      const sessionProvider = new FakeSessionProvider();
      const gitService = new FakeGitService();
      const taskService = new FakeTaskService();

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
