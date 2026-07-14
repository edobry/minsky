/**
 * Tests for task command functions
 *
 * Comprehensive tests for interface-agnostic command functions that contain
 * real business logic: parameter validation, ID normalization, workspace resolution, etc.
 */

import { describe, test, expect, mock, beforeAll } from "bun:test";
import { first, elementAt } from "@minsky/shared/array-safety";
import {
  getTaskStatusFromParams,
  getTaskFromParams,
  listTasksFromParams,
  setTaskStatusFromParams,
} from "./taskCommands";
import { createTaskFromTitleAndSpec } from "./commands/mutation-commands";
import { TASK_STATUS } from "./taskConstants";
import type { TaskServiceInterface } from "./taskService";
import { TEST_ENTITIES } from "../../../../src/utils/test-utils/test-constants";
import { ValidationError } from "../errors/index";

import path from "path";

describe("Interface-Agnostic Task Command Functions", () => {
  beforeAll(async () => {
    // Initialize configuration — some downstream code paths require it
    const { initializeConfiguration, CustomConfigFactory } = await import("../configuration/index");
    await initializeConfiguration(new CustomConfigFactory());
  });

  const testWorkspacePath = "/tmp/test-minsky-workspace";
  const _testTasksFile = path.join(testWorkspacePath, "process", "tasks.md");
  // Shared spec path constant used in READY → DONE closeout-evidence tests.
  const TEST_SPEC_PATH = "/test/path/spec.md";

  // Helper function to create a complete mock TaskService
  const _createMockTaskService = (mockGetTask: (taskId: string) => Promise<any>) =>
    ({
      getTask: mockGetTask,
      backends: [],
      currentBackend: "test",
      listTasks: async () => [],
      getTaskStatus: async () => null,
      setTaskStatus: async () => {},
      createTask: async () => ({}),
      deleteTask: async () => false,
      getWorkspacePath: () => testWorkspacePath,
      createTaskFromTitleAndSpec: async () => ({}),
    }) as unknown as TaskServiceInterface;

  // No filesystem operations needed with dependency injection

  describe("getTaskStatusFromParams", () => {
    test("should return BLOCKED status for task 155 with [~] checkbox", async () => {
      const params = {
        taskId: "155",
        json: false,
      };

      const mockTaskService = {
        getTask: async (taskId: string) => {
          // Handle both input format and qualified format since function normalizes IDs
          if (taskId === "155" || taskId === "mt#155") {
            return { id: "mt#155", status: TASK_STATUS.BLOCKED };
          }
          return null;
        },
        listTasks: async () => [],
        getTaskStatus: async () => undefined,
        setTaskStatus: async () => {},
        createTask: async () => ({
          id: "#test",
          title: "Test",
          status: "TODO",
        }),
        deleteTask: async () => false,
        getWorkspacePath: () => "/test/path",
        getBackendForTask: async () => "minsky",
        createTaskFromTitleAndSpec: async () => ({
          id: "#test",
          title: "Test",
          status: "TODO",
        }),
      };

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        createConfiguredTaskService: async (options: any) => mockTaskService,
      };

      const result = await getTaskStatusFromParams(params, mockDeps as any);
      expect(result).toBe(TASK_STATUS.BLOCKED);
    });

    test("should return TODO status for task 156 with [ ] checkbox", async () => {
      const params = {
        taskId: "156",
        json: false,
      };

      const mockTaskService = {
        getTask: async (taskId: string) => {
          // Handle both input format and qualified format since function normalizes IDs
          if (taskId === "156" || taskId === "mt#156") {
            return { id: "mt#156", status: TASK_STATUS.TODO };
          }
          return null;
        },
        listTasks: async () => [],
        getTaskStatus: async () => undefined,
        setTaskStatus: async () => {},
        createTask: async () => ({
          id: "#test",
          title: "Test",
          status: "TODO",
        }),
        deleteTask: async () => false,
        getWorkspacePath: () => "/test/path",
        getBackendForTask: async () => "minsky",
        createTaskFromTitleAndSpec: async () => ({
          id: "#test",
          title: "Test",
          status: "TODO",
        }),
      };

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        createConfiguredTaskService: async (options: any) => mockTaskService,
      };

      const result = await getTaskStatusFromParams(params, mockDeps as any);
      expect(result).toBe(TASK_STATUS.TODO);
    });

    test("should return IN_PROGRESS status for task 157 with [+] checkbox", async () => {
      const params = {
        taskId: "157",
        json: false,
      };

      // ✅ FIXED: Use explicit mock instead of unreliable async factory
      const mockTaskService = {
        getTask: mock((taskId: string) => {
          // Handle both input format and qualified format since function normalizes IDs
          if (taskId === "157" || taskId === "mt#157") {
            return Promise.resolve({ id: "mt#157", status: TASK_STATUS.IN_PROGRESS });
          }
          return Promise.resolve(null);
        }),
        listTasks: mock(() => Promise.resolve([])),
        getTaskStatus: mock(() => Promise.resolve(undefined)),
        setTaskStatus: mock(() => Promise.resolve()),
        createTask: mock(() => Promise.resolve({ id: "#test", title: "Test", status: "TODO" })),
        deleteTask: mock(() => Promise.resolve(false)),
        getWorkspacePath: mock(() => "/test/path"),
        getBackendForTask: mock(() => Promise.resolve("minsky")),
        createTaskFromTitleAndSpec: mock(() =>
          Promise.resolve({ id: "#test", title: "Test", status: "TODO" })
        ),
      };

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        createConfiguredTaskService: async (options: any) => mockTaskService,
      };

      const result = await getTaskStatusFromParams(params, mockDeps as any);
      expect(result).toBe(TASK_STATUS.IN_PROGRESS);
    });

    test("should return DONE status for task 158 with [x] checkbox", async () => {
      const params = {
        taskId: "158",
        json: false,
      };

      // ✅ FIXED: Use explicit mock instead of unreliable async factory
      const mockTaskService = {
        getTask: mock((taskId: string) => {
          // Handle both input format and qualified format since function normalizes IDs
          if (taskId === "158" || taskId === "mt#158") {
            return Promise.resolve({ id: "mt#158", status: TASK_STATUS.DONE });
          }
          return Promise.resolve(null);
        }),
        listTasks: mock(() => Promise.resolve([])),
        getTaskStatus: mock(() => Promise.resolve(undefined)),
        setTaskStatus: mock(() => Promise.resolve()),
        createTask: mock(() => Promise.resolve({ id: "#test", title: "Test", status: "TODO" })),
        deleteTask: mock(() => Promise.resolve(false)),
        getWorkspacePath: mock(() => "/test/path"),
        getBackendForTask: mock(() => Promise.resolve("minsky")),
        createTaskFromTitleAndSpec: mock(() =>
          Promise.resolve({ id: "#test", title: "Test", status: "TODO" })
        ),
      };

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        createConfiguredTaskService: async (options: any) => mockTaskService,
      };

      const result = await getTaskStatusFromParams(params, mockDeps as any);
      expect(result).toBe(TASK_STATUS.DONE as any);
    });

    test("should throw error when task not found", async () => {
      const params = {
        taskId: "999",
        json: false,
      };

      // ✅ FIXED: Use explicit mock instead of unreliable async factory
      const mockTaskService = {
        getTask: mock(() => Promise.resolve(null)),
        listTasks: mock(() => Promise.resolve([])),
        getTaskStatus: mock(() => Promise.resolve(undefined)),
        setTaskStatus: mock(() => Promise.resolve()),
        createTask: mock(() => Promise.resolve({ id: "#test", title: "Test", status: "TODO" })),
        deleteTask: mock(() => Promise.resolve(false)),
        getWorkspacePath: mock(() => "/test/path"),
        getBackendForTask: mock(() => Promise.resolve("minsky")),
        createTaskFromTitleAndSpec: mock(() =>
          Promise.resolve({ id: "#test", title: "Test", status: "TODO" })
        ),
      };

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        createConfiguredTaskService: async (options: any) => mockTaskService,
      };

      await expect(getTaskStatusFromParams(params, mockDeps as any)).rejects.toThrow(
        "Task mt#999 not found or has no status"
      );
    });

    test("should handle task ID normalization", async () => {
      const params = {
        taskId: "155", // Without #
        json: false,
      };

      const mockTaskService = {
        getTask: async (taskId: string) => {
          // Handle both input format and qualified format since function normalizes IDs
          if (taskId === "155" || taskId === "mt#155") {
            return { id: "mt#155", status: TASK_STATUS.BLOCKED };
          }
          return null;
        },
        listTasks: async () => [],
        getTaskStatus: async () => undefined,
        setTaskStatus: async () => {},
        createTask: async () => ({
          id: "#test",
          title: "Test",
          status: "TODO",
        }),
        deleteTask: async () => false,
        getWorkspacePath: () => "/test/path",
        getBackendForTask: async () => "minsky",
        createTaskFromTitleAndSpec: async () => ({
          id: "#test",
          title: "Test",
          status: "TODO",
        }),
      };

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        createConfiguredTaskService: async (options: any) => mockTaskService,
      };

      const result = await getTaskStatusFromParams(params, mockDeps as any);
      expect(result).toBe(TASK_STATUS.BLOCKED);
    });

    test("should handle custom repo path", async () => {
      const params = {
        taskId: "155",
        repo: "/custom/repo/path",
        json: false,
      };

      const mockTaskService = {
        getTask: async (taskId: string) => {
          // Handle both input format and qualified format since function normalizes IDs
          if (taskId === "155" || taskId === "mt#155") {
            return { id: "mt#155", status: TASK_STATUS.BLOCKED };
          }
          return null;
        },
        listTasks: async () => [],
        getTaskStatus: async () => undefined,
        setTaskStatus: async () => {},
        createTask: async () => ({
          id: "#test",
          title: "Test",
          status: "TODO",
        }),
        deleteTask: async () => false,
        getWorkspacePath: () => "/test/path",
        getBackendForTask: async () => "minsky",
        createTaskFromTitleAndSpec: async () => ({
          id: "#test",
          title: "Test",
          status: "TODO",
        }),
      };

      const mockDeps = {
        resolveRepoPath: async (options: any) => options.repo || testWorkspacePath,
        createConfiguredTaskService: async (options: any) => mockTaskService,
      };

      const result = await getTaskStatusFromParams(params, mockDeps as any);
      expect(result).toBe(TASK_STATUS.BLOCKED);
    });
  });

  describe("getTaskFromParams", () => {
    test("should get task by ID", async () => {
      const params = {
        taskId: "155",
        json: false,
      };

      const mockTask = {
        id: "155", // Task 283: Use storage format
        title: TEST_ENTITIES.BLOCKED_TASK_TITLE,
        status: TASK_STATUS.BLOCKED,
        description: "This is a test task",
      };

      const mockTaskService = {
        getTask: async (taskId: string) => {
          // Handle both input format and qualified format since function normalizes IDs
          if (taskId === "155" || taskId === "mt#155") {
            return { ...mockTask, id: "mt#155" };
          }
          return null;
        },
        listTasks: async () => [],
        getTaskStatus: async () => undefined,
        setTaskStatus: async () => {},
        createTask: async () => ({
          id: "#test",
          title: "Test",
          status: "TODO",
        }),
        deleteTask: async () => false,
        getWorkspacePath: () => "/test/path",
        getBackendForTask: async () => "minsky",
        createTaskFromTitleAndSpec: async () => ({
          id: "#test",
          title: "Test",
          status: "TODO",
        }),
      };

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        createConfiguredTaskService: async (options: any) => mockTaskService,
      };

      const result = await getTaskFromParams(params, mockDeps as any);
      expect(result).toEqual({ ...mockTask, id: "mt#155" });
    });

    test("should throw error when task not found", async () => {
      const params = {
        taskId: "999",
        json: false,
      };

      const mockTaskService = {
        getTask: async () => null,
        listTasks: async () => [],
        getTaskStatus: async () => undefined,
        setTaskStatus: async () => {},
        createTask: async () => ({
          id: "#test",
          title: "Test",
          status: "TODO",
        }),
        deleteTask: async () => false,
        getWorkspacePath: () => "/test/path",
        getBackendForTask: async () => "minsky",
        createTaskFromTitleAndSpec: async () => ({
          id: "#test",
          title: "Test",
          status: "TODO",
        }),
      };

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        createConfiguredTaskService: async (options: any) => mockTaskService,
      };

      await expect(getTaskFromParams(params, mockDeps as any)).rejects.toThrow(
        "Task mt#999 not found"
      );
    });

    test("should handle task ID normalization", async () => {
      const params = {
        taskId: "155", // Without #
        json: false,
      };

      const mockTask = {
        id: "155", // Task 283: Use storage format
        title: TEST_ENTITIES.BLOCKED_TASK_TITLE,
        status: TASK_STATUS.BLOCKED,
      };

      const mockTaskService = {
        getTask: async (taskId: string) => {
          // Handle both input format and qualified format since function normalizes IDs
          if (taskId === "155" || taskId === "mt#155") {
            return { ...mockTask, id: "mt#155" };
          }
          return null;
        },
        listTasks: async () => [],
        getTaskStatus: async () => undefined,
        setTaskStatus: async () => {},
        createTask: async () => ({
          id: "#test",
          title: "Test",
          status: "TODO",
        }),
        deleteTask: async () => false,
        getWorkspacePath: () => "/test/path",
        getBackendForTask: async () => "minsky",
        createTaskFromTitleAndSpec: async () => ({
          id: "#test",
          title: "Test",
          status: "TODO",
        }),
      };

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        createConfiguredTaskService: async (options: any) => mockTaskService,
      };

      const result = await getTaskFromParams(params, mockDeps as any);
      expect(result).toEqual({ ...mockTask, id: "mt#155" });
    });

    test("should handle custom repo path", async () => {
      const params = {
        taskId: "155",
        repo: "/custom/repo/path",
        json: false,
      };

      const mockTask = {
        id: "155", // Task 283: Use storage format
        title: TEST_ENTITIES.BLOCKED_TASK_TITLE,
        status: TASK_STATUS.BLOCKED,
      };

      const mockTaskService = {
        getTask: async (taskId: string) => {
          // Handle both input format and qualified format since function normalizes IDs
          if (taskId === "155" || taskId === "mt#155") {
            return { ...mockTask, id: "mt#155" };
          }
          return null;
        },
        listTasks: async () => [],
        getTaskStatus: async () => undefined,
        setTaskStatus: async () => {},
        createTask: async () => ({
          id: "#test",
          title: "Test",
          status: "TODO",
        }),
        deleteTask: async () => false,
        getWorkspacePath: () => "/test/path",
        getBackendForTask: async () => "minsky",
        createTaskFromTitleAndSpec: async () => ({
          id: "#test",
          title: "Test",
          status: "TODO",
        }),
      };

      const mockDeps = {
        resolveRepoPath: async (options: any) => options.repo || testWorkspacePath,
        createConfiguredTaskService: async (options: any) => mockTaskService,
      };

      const result = await getTaskFromParams(params, mockDeps as any);
      expect(result).toEqual({ ...mockTask, id: "mt#155" });
    });
  });

  describe("listTasksFromParams", () => {
    test("should list all tasks when no filter is provided", async () => {
      const params = {
        all: true,
        json: false,
      };

      const mockTasks = [
        { id: "#155", title: "Task 1", status: TASK_STATUS.BLOCKED },
        { id: "#156", title: "Task 2", status: TASK_STATUS.TODO },
        { id: "#157", title: "Task 3", status: TASK_STATUS.IN_PROGRESS },
        { id: "#158", title: "Task 4", status: TASK_STATUS.DONE },
      ];

      const mockTaskService = {
        // ✅ FIXED: Use explicit mock methods instead of unreliable async factory
        getTask: mock(() => Promise.resolve(null)),
        listTasks: mock(() => Promise.resolve(mockTasks)),
        getTaskStatus: mock(() => Promise.resolve(undefined)),
        setTaskStatus: mock(() => Promise.resolve()),
        createTask: mock(() => Promise.resolve({ id: "#test", title: "Test", status: "TODO" })),
        deleteTask: mock(() => Promise.resolve(false)),
        getWorkspacePath: mock(() => "/test/path"),
        getBackendForTask: mock(() => Promise.resolve("minsky")),
        createTaskFromTitleAndSpec: mock(() =>
          Promise.resolve({ id: "#test", title: "Test", status: "TODO" })
        ),
      };

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        createConfiguredTaskService: async (options: any) => mockTaskService,
      };

      const result = await listTasksFromParams(params, mockDeps as any);
      expect(result).toEqual(mockTasks);
    });

    test("should filter tasks by status", async () => {
      const params = {
        all: true,
        filter: TASK_STATUS.BLOCKED,
        json: false,
      };

      const mockTasks = [
        { id: "#155", title: "Task 1", status: TASK_STATUS.BLOCKED },
        { id: "#156", title: "Task 2", status: TASK_STATUS.TODO },
        { id: "#157", title: "Task 3", status: TASK_STATUS.IN_PROGRESS },
      ];

      const mockTaskService = {
        listTasks: async () => [{ id: "#155", title: "Task 1", status: TASK_STATUS.BLOCKED }],
        getTask: async () => null,
        getTaskStatus: async () => undefined,
        setTaskStatus: async () => {},
        createTask: async () => ({
          id: "#test",
          title: "Test",
          status: "TODO",
        }),
        deleteTask: async () => false,
        getWorkspacePath: () => "/test/path",
        getBackendForTask: async () => "minsky",
        createTaskFromTitleAndSpec: async () => ({
          id: "#test",
          title: "Test",
          status: "TODO",
        }),
      };

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        createConfiguredTaskService: async (options: any) => mockTaskService,
      };

      const result = await listTasksFromParams(params, mockDeps as any);
      expect(result).toEqual([first(mockTasks)]);
    });

    test("should filter out DONE tasks when all is false", async () => {
      const params = {
        all: false,
        json: false,
      };

      const mockTasks = [
        { id: "#155", title: "Task 1", status: TASK_STATUS.BLOCKED },
        { id: "#156", title: "Task 2", status: TASK_STATUS.TODO },
        { id: "#157", title: "Task 3", status: TASK_STATUS.DONE },
      ];

      const mockTaskService = {
        listTasks: async () => [
          { id: "#155", title: "Task 1", status: TASK_STATUS.BLOCKED },
          { id: "#156", title: "Task 2", status: TASK_STATUS.TODO },
        ],
        getTask: async () => null,
        getTaskStatus: async () => undefined,
        setTaskStatus: async () => {},
        createTask: async () => ({
          id: "#test",
          title: "Test",
          status: "TODO",
        }),
        deleteTask: async () => false,
        getWorkspacePath: () => "/test/path",
        getBackendForTask: async () => "minsky",
        createTaskFromTitleAndSpec: async () => ({
          id: "#test",
          title: "Test",
          status: "TODO",
        }),
      };

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        createConfiguredTaskService: async (options: any) => mockTaskService,
      };

      const result = await listTasksFromParams(params, mockDeps as any);
      expect(result).toEqual([first(mockTasks), elementAt(mockTasks, 1)]);
    });

    test("mt#2762: forwards a valid kind filter to taskService.listTasks (server-side)", async () => {
      const params = {
        all: true,
        kind: "umbrella",
        json: false,
      };

      const listTasksMock = mock(() => Promise.resolve([]));
      const mockTaskService = {
        getTask: async () => null,
        listTasks: listTasksMock,
        getTaskStatus: async () => undefined,
        setTaskStatus: async () => {},
        createTask: async () => ({ id: "#test", title: "Test", status: "TODO" }),
        deleteTask: async () => false,
        getWorkspacePath: () => "/test/path",
        getBackendForTask: async () => "minsky",
        createTaskFromTitleAndSpec: async () => ({ id: "#test", title: "Test", status: "TODO" }),
      };

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        createConfiguredTaskService: async (options: any) => mockTaskService,
      };

      await listTasksFromParams(params, mockDeps as any);

      // The kind filter must reach taskService.listTasks — filtering happens
      // server-side in the backend query, not post-hoc in the adapter (mt#2762).
      expect(listTasksMock).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "umbrella", all: true })
      );
    });

    test("mt#2762: an unknown kind is rejected with a ValidationError naming valid kinds", async () => {
      const params = {
        all: true,
        kind: "not-a-real-kind",
        json: false,
      };

      const listTasksMock = mock(() => Promise.resolve([]));
      const mockTaskService = {
        getTask: async () => null,
        listTasks: listTasksMock,
        getTaskStatus: async () => undefined,
        setTaskStatus: async () => {},
        createTask: async () => ({ id: "#test", title: "Test", status: "TODO" }),
        deleteTask: async () => false,
        getWorkspacePath: () => "/test/path",
        getBackendForTask: async () => "minsky",
        createTaskFromTitleAndSpec: async () => ({ id: "#test", title: "Test", status: "TODO" }),
      };

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        createConfiguredTaskService: async (options: any) => mockTaskService,
      };

      await expect(listTasksFromParams(params, mockDeps as any)).rejects.toBeInstanceOf(
        ValidationError
      );
      // Rejected before ever reaching the backend query.
      expect(listTasksMock).not.toHaveBeenCalled();
    });
  });

  describe("setTaskStatusFromParams", () => {
    test("should set task status", async () => {
      const params = {
        taskId: "155",
        status: TASK_STATUS.PLANNING,
        json: false,
      };

      const mockTask = {
        id: "155", // Task 283: Use storage format
        title: TEST_ENTITIES.BLOCKED_TASK_TITLE,
        status: TASK_STATUS.BLOCKED,
      };

      let statusSetTo: string | null = null;

      const mockTaskService = {
        getTask: async (taskId: string) => {
          // Handle both input format and qualified format since function normalizes IDs
          if (taskId === "155" || taskId === "mt#155") {
            return { ...mockTask, id: "mt#155" };
          }
          return null;
        },
        listTasks: async () => [],
        getTaskStatus: async () => undefined,
        setTaskStatus: async (taskId: string, status: string) => {
          statusSetTo = status;
        },
        createTask: async () => ({
          id: "#test",
          title: "Test",
          status: "TODO",
        }),
        deleteTask: async () => false,
        getWorkspacePath: () => "/test/path",
        getBackendForTask: async () => "minsky",
        createTaskFromTitleAndSpec: async () => ({
          id: "#test",
          title: "Test",
          status: "TODO",
        }),
      };

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        createConfiguredTaskService: async (options: any) => mockTaskService,
      };

      await setTaskStatusFromParams(params, mockDeps as any);
      expect(statusSetTo).toBe(TASK_STATUS.PLANNING as any);
    });

    test("should throw error when task not found", async () => {
      const params = {
        taskId: "999",
        status: TASK_STATUS.DONE,
        json: false,
      };

      const mockTaskService = {
        getTask: async () => null,
        listTasks: async () => [],
        getTaskStatus: async () => undefined,
        setTaskStatus: async () => {},
        createTask: async () => ({
          id: "#test",
          title: "Test",
          status: "TODO",
        }),
        deleteTask: async () => false,
        getWorkspacePath: () => "/test/path",
        getBackendForTask: async () => "minsky",
        createTaskFromTitleAndSpec: async () => ({
          id: "#test",
          title: "Test",
          status: "TODO",
        }),
      };

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        createConfiguredTaskService: async (options: any) => mockTaskService,
      };

      await expect(setTaskStatusFromParams(params, mockDeps as any)).rejects.toThrow(
        "Task mt#999 not found"
      );
    });

    test("should handle task ID normalization", async () => {
      const params = {
        taskId: "155", // Without #
        status: TASK_STATUS.PLANNING,
        json: false,
      };

      const mockTask = {
        id: "155", // Task 283: Use storage format
        title: TEST_ENTITIES.BLOCKED_TASK_TITLE,
        status: TASK_STATUS.BLOCKED,
      };

      let statusSetTo: string | null = null;

      const mockTaskService = {
        getTask: async (taskId: string) => {
          // Handle both input format and qualified format since function normalizes IDs
          if (taskId === "155" || taskId === "mt#155") {
            return { ...mockTask, id: "mt#155" };
          }
          return null;
        },
        listTasks: async () => [],
        getTaskStatus: async () => undefined,
        setTaskStatus: async (taskId: string, status: string) => {
          statusSetTo = status;
        },
        createTask: async () => ({
          id: "#test",
          title: "Test",
          status: "TODO",
        }),
        deleteTask: async () => false,
        getWorkspacePath: () => "/test/path",
        getBackendForTask: async () => "minsky",
        createTaskFromTitleAndSpec: async () => ({
          id: "#test",
          title: "Test",
          status: "TODO",
        }),
      };

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        createConfiguredTaskService: async (options: any) => mockTaskService,
      };

      await setTaskStatusFromParams(params, mockDeps as any);
      expect(statusSetTo).toBe(TASK_STATUS.PLANNING as any);
    });

    test("READY → DONE succeeds when spec has ## Closeout evidence section with content", async () => {
      const params = {
        taskId: "200",
        status: TASK_STATUS.DONE,
        json: false,
      };

      const specWithEvidence = `## Summary\nExternal deliverable.\n\n## Closeout evidence\nhttps://notion.so/page-abc — Published 2026-05-11.\n`;
      let statusSetTo: string | null = null;

      const mockTaskService = {
        getTask: async (taskId: string) => {
          if (taskId === "200" || taskId === "mt#200") {
            return { id: "mt#200", title: "External Task", status: TASK_STATUS.READY };
          }
          return null;
        },
        listTasks: async () => [],
        getTaskStatus: async () => undefined,
        setTaskStatus: async (taskId: string, status: string) => {
          statusSetTo = status;
        },
        deleteTask: async () => false,
        getWorkspacePath: () => "/test/path",
        getBackendForTask: async () => "minsky",
        createTaskFromTitleAndSpec: async () => ({ id: "#test", title: "Test", status: "TODO" }),
        getTaskSpecContent: async () => ({
          task: { id: "mt#200", title: "External Task", status: TASK_STATUS.READY },
          specPath: TEST_SPEC_PATH,
          content: specWithEvidence,
        }),
      };

      const mockDeps = {
        resolveRepoPath: async () => testWorkspacePath,
        createConfiguredTaskService: async () => mockTaskService,
      };

      await setTaskStatusFromParams(params, mockDeps as any);
      expect(statusSetTo).toBe(TASK_STATUS.DONE as any);
    });

    test("READY → DONE is refused when spec has no ## Closeout evidence section", async () => {
      const params = {
        taskId: "201",
        status: TASK_STATUS.DONE,
        json: false,
      };

      const specWithoutEvidence = `## Summary\nNo closeout section.\n\n## Scope\nIn scope: something.\n`;

      const mockTaskService = {
        getTask: async (taskId: string) => {
          if (taskId === "201" || taskId === "mt#201") {
            return { id: "mt#201", title: "External Task", status: TASK_STATUS.READY };
          }
          return null;
        },
        listTasks: async () => [],
        getTaskStatus: async () => undefined,
        setTaskStatus: async () => {},
        deleteTask: async () => false,
        getWorkspacePath: () => "/test/path",
        getBackendForTask: async () => "minsky",
        createTaskFromTitleAndSpec: async () => ({ id: "#test", title: "Test", status: "TODO" }),
        getTaskSpecContent: async () => ({
          task: { id: "mt#201", title: "External Task", status: TASK_STATUS.READY },
          specPath: TEST_SPEC_PATH,
          content: specWithoutEvidence,
        }),
      };

      const mockDeps = {
        resolveRepoPath: async () => testWorkspacePath,
        createConfiguredTaskService: async () => mockTaskService,
      };

      await expect(setTaskStatusFromParams(params, mockDeps as any)).rejects.toThrow(
        /Closeout evidence/
      );
    });

    test("READY → DONE is refused when ## Closeout evidence section is empty", async () => {
      const params = {
        taskId: "202",
        status: TASK_STATUS.DONE,
        json: false,
      };

      // Heading present but no content after it
      const specEmptyEvidence = `## Summary\nSome summary.\n\n## Closeout evidence\n\n`;

      const mockTaskService = {
        getTask: async (taskId: string) => {
          if (taskId === "202" || taskId === "mt#202") {
            return { id: "mt#202", title: "External Task", status: TASK_STATUS.READY };
          }
          return null;
        },
        listTasks: async () => [],
        getTaskStatus: async () => undefined,
        setTaskStatus: async () => {},
        deleteTask: async () => false,
        getWorkspacePath: () => "/test/path",
        getBackendForTask: async () => "minsky",
        createTaskFromTitleAndSpec: async () => ({ id: "#test", title: "Test", status: "TODO" }),
        getTaskSpecContent: async () => ({
          task: { id: "mt#202", title: "External Task", status: TASK_STATUS.READY },
          specPath: TEST_SPEC_PATH,
          content: specEmptyEvidence,
        }),
      };

      const mockDeps = {
        resolveRepoPath: async () => testWorkspacePath,
        createConfiguredTaskService: async () => mockTaskService,
      };

      await expect(setTaskStatusFromParams(params, mockDeps as any)).rejects.toThrow(
        /Closeout evidence/
      );
    });
  });

  describe("Parameter Validation", () => {
    test("should validate task ID format", async () => {
      const params = {
        taskId: "invalid-id",
        json: false,
      };

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        // ✅ FIXED: Use explicit mock instead of unreliable async factory
        createConfiguredTaskService: async (options: any) => ({
          getTask: mock(() => Promise.resolve(null)),
          listTasks: mock(() => Promise.resolve([])),
          getTaskStatus: mock(() => Promise.resolve(undefined)),
          setTaskStatus: mock(() => Promise.resolve()),
          createTask: mock(() => Promise.resolve({ id: "#test", title: "Test", status: "TODO" })),
          deleteTask: mock(() => Promise.resolve(false)),
          getWorkspacePath: mock(() => "/test/path"),
          getBackendForTask: mock(() => Promise.resolve("minsky")),
          createTaskFromTitleAndSpec: mock(() =>
            Promise.resolve({ id: "#test", title: "Test", status: "TODO" })
          ),
        }),
      };

      await expect(getTaskFromParams(params, mockDeps as any)).rejects.toThrow();
    });

    test("should handle empty task ID", async () => {
      const params = {
        taskId: "",
        json: false,
      };

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        // ✅ FIXED: Use explicit mock instead of unreliable async factory
        createConfiguredTaskService: async (options: any) => ({
          getTask: mock(() => Promise.resolve(null)),
          listTasks: mock(() => Promise.resolve([])),
          getTaskStatus: mock(() => Promise.resolve(undefined)),
          setTaskStatus: mock(() => Promise.resolve()),
          createTask: mock(() => Promise.resolve({ id: "#test", title: "Test", status: "TODO" })),
          deleteTask: mock(() => Promise.resolve(false)),
          getWorkspacePath: mock(() => "/test/path"),
          getBackendForTask: mock(() => Promise.resolve("minsky")),
          createTaskFromTitleAndSpec: mock(() =>
            Promise.resolve({ id: "#test", title: "Test", status: "TODO" })
          ),
        }),
      };

      await expect(getTaskFromParams(params, mockDeps as any)).rejects.toThrow();
    });

    test("should handle backend parameter", async () => {
      const params = {
        taskId: "155",
        backend: "github-issues",
        json: false,
      };

      const mockTask = {
        id: "155", // Task 283: Use storage format
        title: "Test Task",
        status: TASK_STATUS.TODO,
      };

      const mockTaskService = {
        getTask: async (taskId: string) => {
          // Handle both input format and qualified format since function normalizes IDs
          if (taskId === "155" || taskId === "mt#155") {
            return { ...mockTask, id: "mt#155" };
          }
          return null;
        },
        listTasks: async () => [],
        getTaskStatus: async () => undefined,
        setTaskStatus: async () => {},
        createTask: async () => ({
          id: "#test",
          title: "Test",
          status: "TODO",
        }),
        deleteTask: async () => false,
        getWorkspacePath: () => "/test/path",
        getBackendForTask: async () => "minsky",
        createTaskFromTitleAndSpec: async () => ({
          id: "#test",
          title: "Test",
          status: "TODO",
        }),
      };

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        createConfiguredTaskService: async (options: any) => {
          expect(options.backend).toBe("github-issues");
          return mockTaskService;
        },
      };

      const result = await getTaskFromParams(params, mockDeps as any);
      expect(result).toEqual({ ...mockTask, id: "mt#155" });
    });
  });
});

describe("createTaskFromTitleAndSpec command — mt#2572 Bug 4 (backend forwarding)", () => {
  test("forwards the requested backend option to the service (command-layer path)", async () => {
    const createSpy = mock((_title: string, _spec: string, _options?: unknown) =>
      Promise.resolve({ id: "mt#1", title: "Test", status: "TODO" })
    );
    const mockTaskService = {
      createTaskFromTitleAndSpec: createSpy,
    } as unknown as TaskServiceInterface;

    await createTaskFromTitleAndSpec(
      { title: "Test", spec: "spec body", backend: "minsky" },
      { taskService: mockTaskService }
    );

    expect(createSpy).toHaveBeenCalledTimes(1);
    // The 3rd arg (options) must carry the caller's backend; otherwise the
    // multi-backend service routes to its default — the exact regression this
    // guards (the command previously omitted the options object). R1 blocking.
    const options = createSpy.mock.calls[0]?.[2] as { backend?: string } | undefined;
    expect(options?.backend).toBe("minsky");
  });
});
