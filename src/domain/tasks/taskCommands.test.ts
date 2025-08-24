/**
 * Tests for task command functions
 *
 * Comprehensive tests for interface-agnostic command functions that contain
 * real business logic: parameter validation, ID normalization, workspace resolution, etc.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  getTaskStatusFromParams,
  getTaskFromParams,
  listTasksFromParams,
  setTaskStatusFromParams,
  createTaskFromParams,
  deleteTaskFromParams,
} from "./taskCommands";
import { TASK_STATUS } from "./taskConstants";
import type { TaskService } from "./taskService";
import { createMockTaskService } from "../../utils/test-utils/dependencies";

import path from "path";

describe("Interface-Agnostic Task Command Functions", () => {
  const testWorkspacePath = "/tmp/test-minsky-workspace";
  const testTasksFile = path.join(testWorkspacePath, "process", "tasks.md");

  // Helper function to create a complete mock TaskService
  const createMockTaskService = (mockGetTask: (taskId: string) => Promise<any>) =>
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
    }) as any;

  // Create mock tasks data for dependency injection
  const mockTasks = [
    { id: "155", title: "Add BLOCKED Status Support", status: TASK_STATUS.BLOCKED },
    { id: "156", title: "Some other task", status: TASK_STATUS.TODO },
    { id: "157", title: "In progress task", status: TASK_STATUS.IN_PROGRESS },
    { id: "158", title: "Done task", status: TASK_STATUS.DONE },
  ];

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
          if (taskId === "155" || taskId === "md#155") {
            return { id: "md#155", status: TASK_STATUS.BLOCKED };
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
        getBackendForTask: async () => "markdown",
        createTaskFromTitleAndSpec: async () => ({
          id: "#test",
          title: "Test",
          status: "TODO",
        }),
      };

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        resolveTaskWorkspacePath: async (options?: any) => testWorkspacePath,
        createConfiguredTaskService: async (options: any) => mockTaskService,
      };

      const result = await getTaskStatusFromParams(params, mockDeps);
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
          if (taskId === "156" || taskId === "md#156") {
            return { id: "md#156", status: TASK_STATUS.TODO };
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
        getBackendForTask: async () => "markdown",
        createTaskFromTitleAndSpec: async () => ({
          id: "#test",
          title: "Test",
          status: "TODO",
        }),
      };

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        resolveTaskWorkspacePath: async (options?: any) => testWorkspacePath,
        createConfiguredTaskService: async (options: any) => mockTaskService,
      };

      const result = await getTaskStatusFromParams(params, mockDeps);
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
          if (taskId === "157" || taskId === "md#157") {
            return Promise.resolve({ id: "md#157", status: TASK_STATUS.IN_PROGRESS });
          }
          return Promise.resolve(null);
        }),
        listTasks: mock(() => Promise.resolve([])),
        getTaskStatus: mock(() => Promise.resolve(undefined)),
        setTaskStatus: mock(() => Promise.resolve()),
        createTask: mock(() => Promise.resolve({ id: "#test", title: "Test", status: "TODO" })),
        deleteTask: mock(() => Promise.resolve(false)),
        getWorkspacePath: mock(() => "/test/path"),
        getBackendForTask: mock(() => Promise.resolve("markdown")),
        createTaskFromTitleAndSpec: mock(() =>
          Promise.resolve({ id: "#test", title: "Test", status: "TODO" })
        ),
      };

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        resolveTaskWorkspacePath: async (options?: any) => testWorkspacePath,
        createConfiguredTaskService: async (options: any) => mockTaskService,
      };

      const result = await getTaskStatusFromParams(params, mockDeps);
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
          if (taskId === "158" || taskId === "md#158") {
            return Promise.resolve({ id: "md#158", status: TASK_STATUS.DONE });
          }
          return Promise.resolve(null);
        }),
        listTasks: mock(() => Promise.resolve([])),
        getTaskStatus: mock(() => Promise.resolve(undefined)),
        setTaskStatus: mock(() => Promise.resolve()),
        createTask: mock(() => Promise.resolve({ id: "#test", title: "Test", status: "TODO" })),
        deleteTask: mock(() => Promise.resolve(false)),
        getWorkspacePath: mock(() => "/test/path"),
        getBackendForTask: mock(() => Promise.resolve("markdown")),
        createTaskFromTitleAndSpec: mock(() =>
          Promise.resolve({ id: "#test", title: "Test", status: "TODO" })
        ),
      };

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        resolveTaskWorkspacePath: async (options?: any) => testWorkspacePath,
        createConfiguredTaskService: async (options: any) => mockTaskService,
      };

      const result = await getTaskStatusFromParams(params, mockDeps);
      expect(result).toBe(TASK_STATUS.DONE);
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
        getBackendForTask: mock(() => Promise.resolve("markdown")),
        createTaskFromTitleAndSpec: mock(() =>
          Promise.resolve({ id: "#test", title: "Test", status: "TODO" })
        ),
      };

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        resolveTaskWorkspacePath: async (options?: any) => testWorkspacePath,
        createConfiguredTaskService: async (options: any) => mockTaskService,
      };

      await expect(getTaskStatusFromParams(params, mockDeps)).rejects.toThrow(
        "Task md#999 not found or has no status"
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
          if (taskId === "155" || taskId === "md#155") {
            return { id: "md#155", status: TASK_STATUS.BLOCKED };
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
        getBackendForTask: async () => "markdown",
        createTaskFromTitleAndSpec: async () => ({
          id: "#test",
          title: "Test",
          status: "TODO",
        }),
      };

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        resolveTaskWorkspacePath: async (options?: any) => testWorkspacePath,
        createConfiguredTaskService: async (options: any) => mockTaskService,
      };

      const result = await getTaskStatusFromParams(params, mockDeps);
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
          if (taskId === "155" || taskId === "md#155") {
            return { id: "md#155", status: TASK_STATUS.BLOCKED };
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
        getBackendForTask: async () => "markdown",
        createTaskFromTitleAndSpec: async () => ({
          id: "#test",
          title: "Test",
          status: "TODO",
        }),
      };

      const mockDeps = {
        resolveRepoPath: async (options: any) => options.repo || testWorkspacePath,
        resolveTaskWorkspacePath: async (options?: any) => testWorkspacePath,
        createConfiguredTaskService: async (options: any) => mockTaskService,
      };

      const result = await getTaskStatusFromParams(params, mockDeps);
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
        title: "Add BLOCKED Status Support",
        status: TASK_STATUS.BLOCKED,
        description: "This is a test task",
      };

      const mockTaskService = {
        getTask: async (taskId: string) => {
          // Handle both input format and qualified format since function normalizes IDs
          if (taskId === "155" || taskId === "md#155") {
            return { ...mockTask, id: "md#155" };
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
        getBackendForTask: async () => "markdown",
        createTaskFromTitleAndSpec: async () => ({
          id: "#test",
          title: "Test",
          status: "TODO",
        }),
      };

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        resolveTaskWorkspacePath: async (options?: any) => testWorkspacePath,
        createConfiguredTaskService: async (options: any) => mockTaskService,
      };

      const result = await getTaskFromParams(params, mockDeps);
      expect(result).toEqual({ ...mockTask, id: "md#155" });
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
        getBackendForTask: async () => "markdown",
        createTaskFromTitleAndSpec: async () => ({
          id: "#test",
          title: "Test",
          status: "TODO",
        }),
      };

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        resolveTaskWorkspacePath: async (options?: any) => testWorkspacePath,
        createConfiguredTaskService: async (options: any) => mockTaskService,
      };

      await expect(getTaskFromParams(params, mockDeps)).rejects.toThrow("Task md#999 not found");
    });

    test("should handle task ID normalization", async () => {
      const params = {
        taskId: "155", // Without #
        json: false,
      };

      const mockTask = {
        id: "155", // Task 283: Use storage format
        title: "Add BLOCKED Status Support",
        status: TASK_STATUS.BLOCKED,
      };

      const mockTaskService = {
        getTask: async (taskId: string) => {
          // Handle both input format and qualified format since function normalizes IDs
          if (taskId === "155" || taskId === "md#155") {
            return { ...mockTask, id: "md#155" };
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
        getBackendForTask: async () => "markdown",
        createTaskFromTitleAndSpec: async () => ({
          id: "#test",
          title: "Test",
          status: "TODO",
        }),
      };

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        resolveTaskWorkspacePath: async (options?: any) => testWorkspacePath,
        createConfiguredTaskService: async (options: any) => mockTaskService,
      };

      const result = await getTaskFromParams(params, mockDeps);
      expect(result).toEqual({ ...mockTask, id: "md#155" });
    });

    test("should handle custom repo path", async () => {
      const params = {
        taskId: "155",
        repo: "/custom/repo/path",
        json: false,
      };

      const mockTask = {
        id: "155", // Task 283: Use storage format
        title: "Add BLOCKED Status Support",
        status: TASK_STATUS.BLOCKED,
      };

      const mockTaskService = {
        getTask: async (taskId: string) => {
          // Handle both input format and qualified format since function normalizes IDs
          if (taskId === "155" || taskId === "md#155") {
            return { ...mockTask, id: "md#155" };
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
        getBackendForTask: async () => "markdown",
        createTaskFromTitleAndSpec: async () => ({
          id: "#test",
          title: "Test",
          status: "TODO",
        }),
      };

      const mockDeps = {
        resolveRepoPath: async (options: any) => options.repo || testWorkspacePath,
        resolveTaskWorkspacePath: async (options?: any) => testWorkspacePath,
        createConfiguredTaskService: async (options: any) => mockTaskService,
      };

      const result = await getTaskFromParams(params, mockDeps);
      expect(result).toEqual({ ...mockTask, id: "md#155" });
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
        getBackendForTask: mock(() => Promise.resolve("markdown")),
        createTaskFromTitleAndSpec: mock(() =>
          Promise.resolve({ id: "#test", title: "Test", status: "TODO" })
        ),
      };

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        resolveTaskWorkspacePath: async (options?: any) => testWorkspacePath,
        createConfiguredTaskService: async (options: any) => mockTaskService,
      };

      const result = await listTasksFromParams(params, mockDeps);
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
        getBackendForTask: async () => "markdown",
        createTaskFromTitleAndSpec: async () => ({
          id: "#test",
          title: "Test",
          status: "TODO",
        }),
      };

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        resolveTaskWorkspacePath: async (options?: any) => testWorkspacePath,
        createConfiguredTaskService: async (options: any) => mockTaskService,
      };

      const result = await listTasksFromParams(params, mockDeps);
      expect(result).toEqual([mockTasks[0]]);
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
        getBackendForTask: async () => "markdown",
        createTaskFromTitleAndSpec: async () => ({
          id: "#test",
          title: "Test",
          status: "TODO",
        }),
      };

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        resolveTaskWorkspacePath: async (options?: any) => testWorkspacePath,
        createConfiguredTaskService: async (options: any) => mockTaskService,
      };

      const result = await listTasksFromParams(params, mockDeps);
      expect(result).toEqual([mockTasks[0], mockTasks[1]]);
    });
  });

  describe("setTaskStatusFromParams", () => {
    test("should set task status", async () => {
      const params = {
        taskId: "155",
        status: TASK_STATUS.DONE,
        json: false,
      };

      const mockTask = {
        id: "155", // Task 283: Use storage format
        title: "Add BLOCKED Status Support",
        status: TASK_STATUS.BLOCKED,
      };

      let statusSetTo: string | null = null;

      const mockTaskService = {
        getTask: async (taskId: string) => {
          // Handle both input format and qualified format since function normalizes IDs
          if (taskId === "155" || taskId === "md#155") {
            return { ...mockTask, id: "md#155" };
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
        getBackendForTask: async () => "markdown",
        createTaskFromTitleAndSpec: async () => ({
          id: "#test",
          title: "Test",
          status: "TODO",
        }),
      };

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        resolveTaskWorkspacePath: async (options?: any) => testWorkspacePath,
        createConfiguredTaskService: async (options: any) => mockTaskService as any,
      };

      await setTaskStatusFromParams(params as any, mockDeps);
      expect(statusSetTo).toBe(TASK_STATUS.DONE);
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
        getBackendForTask: async () => "markdown",
        createTaskFromTitleAndSpec: async () => ({
          id: "#test",
          title: "Test",
          status: "TODO",
        }),
      };

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        resolveTaskWorkspacePath: async (options?: any) => testWorkspacePath,
        createConfiguredTaskService: async (options: any) => mockTaskService,
      };

      await expect(setTaskStatusFromParams(params, mockDeps)).rejects.toThrow(
        "Task md#999 not found"
      );
    });

    test("should handle task ID normalization", async () => {
      const params = {
        taskId: "155", // Without #
        status: TASK_STATUS.DONE,
        json: false,
      };

      const mockTask = {
        id: "155", // Task 283: Use storage format
        title: "Add BLOCKED Status Support",
        status: TASK_STATUS.BLOCKED,
      };

      let statusSetTo: string | null = null;

      const mockTaskService = {
        getTask: async (taskId: string) => {
          // Handle both input format and qualified format since function normalizes IDs
          if (taskId === "155" || taskId === "md#155") {
            return { ...mockTask, id: "md#155" };
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
        getBackendForTask: async () => "markdown",
        createTaskFromTitleAndSpec: async () => ({
          id: "#test",
          title: "Test",
          status: "TODO",
        }),
      };

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        resolveTaskWorkspacePath: async (options?: any) => testWorkspacePath,
        createConfiguredTaskService: async (options: any) => mockTaskService as any,
      };

      await setTaskStatusFromParams(params as any, mockDeps);
      expect(statusSetTo).toBe(TASK_STATUS.DONE);
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
        resolveTaskWorkspacePath: async (options?: any) => testWorkspacePath,
        // ✅ FIXED: Use explicit mock instead of unreliable async factory
        createConfiguredTaskService: async (options: any) => ({
          getTask: mock(() => Promise.resolve(null)),
          listTasks: mock(() => Promise.resolve([])),
          getTaskStatus: mock(() => Promise.resolve(undefined)),
          setTaskStatus: mock(() => Promise.resolve()),
          createTask: mock(() => Promise.resolve({ id: "#test", title: "Test", status: "TODO" })),
          deleteTask: mock(() => Promise.resolve(false)),
          getWorkspacePath: mock(() => "/test/path"),
          getBackendForTask: mock(() => Promise.resolve("markdown")),
          createTaskFromTitleAndSpec: mock(() =>
            Promise.resolve({ id: "#test", title: "Test", status: "TODO" })
          ),
        }),
      };

      await expect(getTaskFromParams(params, mockDeps)).rejects.toThrow();
    });

    test("should handle empty task ID", async () => {
      const params = {
        taskId: "",
        json: false,
      };

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        resolveTaskWorkspacePath: async (options?: any) => testWorkspacePath,
        // ✅ FIXED: Use explicit mock instead of unreliable async factory
        createConfiguredTaskService: async (options: any) => ({
          getTask: mock(() => Promise.resolve(null)),
          listTasks: mock(() => Promise.resolve([])),
          getTaskStatus: mock(() => Promise.resolve(undefined)),
          setTaskStatus: mock(() => Promise.resolve()),
          createTask: mock(() => Promise.resolve({ id: "#test", title: "Test", status: "TODO" })),
          deleteTask: mock(() => Promise.resolve(false)),
          getWorkspacePath: mock(() => "/test/path"),
          getBackendForTask: mock(() => Promise.resolve("markdown")),
          createTaskFromTitleAndSpec: mock(() =>
            Promise.resolve({ id: "#test", title: "Test", status: "TODO" })
          ),
        }),
      };

      await expect(getTaskFromParams(params, mockDeps)).rejects.toThrow();
    });

    test("should handle backend parameter", async () => {
      const params = {
        taskId: "155",
        backend: "json-file",
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
          if (taskId === "155" || taskId === "md#155") {
            return { ...mockTask, id: "md#155" };
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
        getBackendForTask: async () => "markdown",
        createTaskFromTitleAndSpec: async () => ({
          id: "#test",
          title: "Test",
          status: "TODO",
        }),
      };

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        resolveTaskWorkspacePath: async (options?: any) => testWorkspacePath,
        createConfiguredTaskService: async (options: any) => {
          expect(options.backend).toBe("json-file");
          return mockTaskService;
        },
      };

      const result = await getTaskFromParams(params, mockDeps);
      expect(result).toEqual({ ...mockTask, id: "md#155" });
    });
  });
});
