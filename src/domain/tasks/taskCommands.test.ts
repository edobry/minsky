/**
 * Tests for task command functions
 * 
 * Comprehensive tests for interface-agnostic command functions that contain
 * real business logic: parameter validation, ID normalization, workspace resolution, etc.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { 
  getTaskStatusFromParams,
  getTaskFromParams,
  listTasksFromParams,
  setTaskStatusFromParams,
  createTaskFromParams,
  deleteTaskFromParams 
} from "./taskCommands";
import { TASK_STATUS } from "./taskConstants";
import type { TaskService } from "./taskService";
import path from "path";
import fs from "fs/promises";

describe("Interface-Agnostic Task Command Functions", () => {
  const testWorkspacePath = "/tmp/test-minsky-workspace";
  const testTasksFile = path.join(testWorkspacePath, "process", "tasks.md");
  
  // Helper function to create a complete mock TaskService
  const createMockTaskService = (mockGetTask: (taskId: string) => Promise<any>) => ({
    getTask: mockGetTask,
    backends: [],
    currentBackend: "test",
    listTasks: async () => [],
    getTaskStatus: async () => null,
    setTaskStatus: async () => {},
    createTask: async () => ({}),
    deleteTask: async () => false,
    getWorkspacePath: () => testWorkspacePath,
    createTaskFromTitleAndDescription: async () => ({}),
  } as any);

  beforeEach(async () => {
    // Create test workspace structure
    await fs.mkdir(path.join(testWorkspacePath, "process"), { recursive: true });
    
    // Create a test tasks.md file with task 155 having BLOCKED status
    const tasksContent = `# Tasks

## Active Tasks

- [~] Add BLOCKED Status Support [#155](process/tasks/155-add-blocked-status-support.md)
- [ ] Some other task [#156](process/tasks/156-other-task.md)
- [+] In progress task [#157](process/tasks/157-in-progress.md)
- [x] Done task [#158](process/tasks/158-done-task.md)
`;
    
    await fs.writeFile(testTasksFile, tasksContent, "utf8");
  });

  afterEach(async () => {
    // Clean up test workspace
    try {
      await fs.rm(testWorkspacePath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("getTaskStatusFromParams", () => {
    test("should return BLOCKED status for task 155 with [~] checkbox", async () => {
      const params = {
        taskId: "155",
        json: false,
      };

      const mockTaskService = createMockTaskService(async (taskId) => {
        if (taskId === "#155") {
          return { id: "#155", status: TASK_STATUS.BLOCKED };
        }
        return null;
      });

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        resolveMainWorkspacePath: async () => testWorkspacePath,
        createTaskService: async (options: any) => mockTaskService,
      };

      const result = await getTaskStatusFromParams(params, mockDeps);
      expect(result).toBe(TASK_STATUS.BLOCKED);
    });

    test("should return TODO status for task 156 with [ ] checkbox", async () => {
      const params = {
        taskId: "156",
        json: false,
      };

      const mockTaskService = createMockTaskService(async (taskId) => {
        if (taskId === "#156") {
          return { id: "#156", status: TASK_STATUS.TODO };
        }
        return null;
      });

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        resolveMainWorkspacePath: async () => testWorkspacePath,
        createTaskService: async (options: any) => mockTaskService,
      };

      const result = await getTaskStatusFromParams(params, mockDeps);
      expect(result).toBe(TASK_STATUS.TODO);
    });

    test("should return IN_PROGRESS status for task 157 with [+] checkbox", async () => {
      const params = {
        taskId: "157",
        json: false,
      };

      const mockTaskService = createMockTaskService(async (taskId) => {
        if (taskId === "#157") {
          return { id: "#157", status: TASK_STATUS.IN_PROGRESS };
        }
        return null;
      });

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        resolveMainWorkspacePath: async () => testWorkspacePath,
        createTaskService: async (options: any) => mockTaskService,
      };

      const result = await getTaskStatusFromParams(params, mockDeps);
      expect(result).toBe(TASK_STATUS.IN_PROGRESS);
    });

    test("should return DONE status for task 158 with [x] checkbox", async () => {
      const params = {
        taskId: "158",
        json: false,
      };

      const mockTaskService = createMockTaskService(async (taskId) => {
        if (taskId === "#158") {
          return { id: "#158", status: TASK_STATUS.DONE };
        }
        return null;
      });

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        resolveMainWorkspacePath: async () => testWorkspacePath,
        createTaskService: async (options: any) => mockTaskService,
      };

      const result = await getTaskStatusFromParams(params, mockDeps);
      expect(result).toBe(TASK_STATUS.DONE);
    });

    test("should throw error when task not found", async () => {
      const params = {
        taskId: "999",
        json: false,
      };

      const mockTaskService = createMockTaskService(async () => null);

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        resolveMainWorkspacePath: async () => testWorkspacePath,
        createTaskService: async (options: any) => mockTaskService,
      };

      await expect(getTaskStatusFromParams(params, mockDeps)).rejects.toThrow("Task #999 not found or has no status");
    });

    test("should handle task ID normalization", async () => {
      const params = {
        taskId: "155", // Without #
        json: false,
      };

      const mockTaskService = createMockTaskService(async (taskId) => {
        if (taskId === "#155") {
          return { id: "#155", status: TASK_STATUS.BLOCKED };
        }
        return null;
      });

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        resolveMainWorkspacePath: async () => testWorkspacePath,
        createTaskService: async (options: any) => mockTaskService,
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

      const mockTaskService = createMockTaskService(async (taskId) => {
        if (taskId === "#155") {
          return { id: "#155", status: TASK_STATUS.BLOCKED };
        }
        return null;
      });

      const mockDeps = {
        resolveRepoPath: async (options: any) => options.repo || testWorkspacePath,
        resolveMainWorkspacePath: async () => testWorkspacePath,
        createTaskService: async (options: any) => mockTaskService,
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
        id: "#155",
        title: "Add BLOCKED Status Support",
        status: TASK_STATUS.BLOCKED,
        description: "This is a test task",
      };

      const mockTaskService = createMockTaskService(async (taskId) => {
        if (taskId === "#155") {
          return mockTask;
        }
        return null;
      });

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        resolveMainWorkspacePath: async () => testWorkspacePath,
        createTaskService: async (options: any) => mockTaskService,
      };

      const result = await getTaskFromParams(params, mockDeps);
      expect(result).toEqual(mockTask);
    });

    test("should throw error when task not found", async () => {
      const params = {
        taskId: "999",
        json: false,
      };

      const mockTaskService = createMockTaskService(async () => null);

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        resolveMainWorkspacePath: async () => testWorkspacePath,
        createTaskService: async (options: any) => mockTaskService,
      };

      await expect(getTaskFromParams(params, mockDeps)).rejects.toThrow("Task #999 not found");
    });

    test("should handle task ID normalization", async () => {
      const params = {
        taskId: "155", // Without #
        json: false,
      };

      const mockTask = {
        id: "#155",
        title: "Add BLOCKED Status Support",
        status: TASK_STATUS.BLOCKED,
      };

      const mockTaskService = createMockTaskService(async (taskId) => {
        if (taskId === "#155") {
          return mockTask;
        }
        return null;
      });

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        resolveMainWorkspacePath: async () => testWorkspacePath,
        createTaskService: async (options: any) => mockTaskService,
      };

      const result = await getTaskFromParams(params, mockDeps);
      expect(result).toEqual(mockTask);
    });

    test("should handle custom repo path", async () => {
      const params = {
        taskId: "155",
        repo: "/custom/repo/path",
        json: false,
      };

      const mockTask = {
        id: "#155",
        title: "Add BLOCKED Status Support",
        status: TASK_STATUS.BLOCKED,
      };

      const mockTaskService = createMockTaskService(async (taskId) => {
        if (taskId === "#155") {
          return mockTask;
        }
        return null;
      });

      const mockDeps = {
        resolveRepoPath: async (options: any) => options.repo || testWorkspacePath,
        resolveMainWorkspacePath: async () => testWorkspacePath,
        createTaskService: async (options: any) => mockTaskService,
      };

      const result = await getTaskFromParams(params, mockDeps);
      expect(result).toEqual(mockTask);
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
        ...createMockTaskService(async () => null),
        listTasks: async () => mockTasks,
      };

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        resolveMainWorkspacePath: async () => testWorkspacePath,
        createTaskService: async (options: any) => mockTaskService,
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
        ...createMockTaskService(async () => null),
        listTasks: async () => mockTasks,
      };

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        resolveMainWorkspacePath: async () => testWorkspacePath,
        createTaskService: async (options: any) => mockTaskService,
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
        ...createMockTaskService(async () => null),
        listTasks: async () => mockTasks,
      };

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        resolveMainWorkspacePath: async () => testWorkspacePath,
        createTaskService: async (options: any) => mockTaskService,
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
        id: "#155",
        title: "Add BLOCKED Status Support",
        status: TASK_STATUS.BLOCKED,
      };

      let statusSetTo: string | null = null;

      const mockTaskService = {
        ...createMockTaskService(async (taskId) => {
          if (taskId === "#155") {
            return mockTask;
          }
          return null;
        }),
        setTaskStatus: async (taskId: string, status: string) => {
          statusSetTo = status;
        },
      };

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        resolveMainWorkspacePath: async () => testWorkspacePath,
        createTaskService: async (options: any) => mockTaskService as any,
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

      const mockTaskService = createMockTaskService(async () => null);

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        resolveMainWorkspacePath: async () => testWorkspacePath,
        createTaskService: async (options: any) => mockTaskService,
      };

      await expect(setTaskStatusFromParams(params, mockDeps)).rejects.toThrow("Task #999 not found");
    });

    test("should handle task ID normalization", async () => {
      const params = {
        taskId: "155", // Without #
        status: TASK_STATUS.DONE,
        json: false,
      };

      const mockTask = {
        id: "#155",
        title: "Add BLOCKED Status Support",
        status: TASK_STATUS.BLOCKED,
      };

      let statusSetTo: string | null = null;

      const mockTaskService = {
        ...createMockTaskService(async (taskId) => {
          if (taskId === "#155") {
            return mockTask;
          }
          return null;
        }),
        setTaskStatus: async (taskId: string, status: string) => {
          statusSetTo = status;
        },
      };

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        resolveMainWorkspacePath: async () => testWorkspacePath,
        createTaskService: async (options: any) => mockTaskService as any,
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
        resolveMainWorkspacePath: async () => testWorkspacePath,
        createTaskService: async (options: any) => createMockTaskService(async () => null),
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
        resolveMainWorkspacePath: async () => testWorkspacePath,
        createTaskService: async (options: any) => createMockTaskService(async () => null),
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
        id: "#155",
        title: "Test Task",
        status: TASK_STATUS.TODO,
      };

      const mockTaskService = createMockTaskService(async (taskId) => {
        if (taskId === "#155") {
          return mockTask;
        }
        return null;
      });

      const mockDeps = {
        resolveRepoPath: async (options: any) => testWorkspacePath,
        resolveMainWorkspacePath: async () => testWorkspacePath,
        createTaskService: async (options: any) => {
          expect(options.backend).toBe("json-file");
          return mockTaskService;
        },
      };

      const result = await getTaskFromParams(params, mockDeps);
      expect(result).toEqual(mockTask);
    });
  });
}); 
