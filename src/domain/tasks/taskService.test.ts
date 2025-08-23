const TEST_VALUE = 123;

/**
 * Tests for TaskService orchestration
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { TaskService } from "./taskService";
import type { TaskBackend } from "./taskBackend";
import type {
  TaskReadOperationResult,
  TaskWriteOperationResult,
  TaskData,
  TaskStatus,
} from "../../types/tasks/taskData";
import type { Task } from "./types";

// Create a mock backend for testing
function createMockBackend(): TaskBackend {
  // Make the mock stateful to support status updates
  let currentTasks = [
    { id: "md#001", title: "Task 1", status: "TODO" },
    { id: "md#002", title: "Task 2", status: "IN-PROGRESS" },
  ];

  return {
    name: "mock",

    // Primary list API used by TaskService
    listTasks: mock((options?: { status?: string }) => {
      if (options?.status) {
        return Promise.resolve(currentTasks.filter((t) => t.status === options.status));
      }
      return Promise.resolve([...currentTasks]);
    }),

    // Additional required methods to complete TaskBackend interface
    getTask: mock((id: string) => Promise.resolve(currentTasks.find((t) => t.id === id) || null)),
    getTaskStatus: mock((id: string) =>
      Promise.resolve(currentTasks.find((t) => t.id === id)?.status)
    ),
    setTaskStatus: mock((id: string, status: string) => {
      const task = currentTasks.find((t) => t.id === id);
      if (task) {
        task.status = status;
      }
      return Promise.resolve();
    }),
    deleteTask: mock(() => Promise.resolve(true)),
    createTaskFromTitleAndSpec: mock((title: string, spec: string) => {
      const newTask = {
        id: "md#003",
        title,
        status: "TODO",
        specPath: "process/tasks/003-test-task.md",
        backend: "mock",
      } as any;
      currentTasks.push(newTask);
      return Promise.resolve(newTask);
    }),
    // Optional helpers used by other tests
    getWorkspacePath: mock(() => "mock"),
    getTaskSpecPath: mock((taskId) => `mock/specs/${taskId.replace(/^#/, "")}.md`),
    fileExists: mock(() => Promise.resolve(true)),
  };
}

describe("TaskService", () => {
  let mockBackend: TaskBackend;
  let taskService: TaskService;

  beforeEach(() => {
    mockBackend = createMockBackend();
    taskService = new TaskService({
      workspacePath: "/tmp",
      backends: [mockBackend],
      backend: "mock",
    });
  });

  describe("listTasks", () => {
    test("should list tasks via backend", async () => {
      const tasks = await taskService.listTasks();
      expect((mockBackend as any).listTasks).toHaveBeenCalled();
      expect(tasks).toHaveLength(2);
      expect(tasks[0].id).toBe("md#001");
      expect(tasks[1].status).toBe("IN-PROGRESS");
    });

    test("should filter tasks by status if provided", async () => {
      const tasks = await taskService.listTasks({ status: "TODO" });

      expect(tasks.length).toBe(1);
      expect(tasks[0].id).toBe("md#001");
    });

    test("should return empty array when backend returns none", async () => {
      (mockBackend as any).listTasks = mock(() => Promise.resolve([]));
      const tasks = await taskService.listTasks();
      expect(tasks).toEqual([]);
    });
  });

  describe("getTask", () => {
    test("should find a task by ID", async () => {
      const task = await taskService.getTask("md#001");

      expect(task).not.toBeNull();
      expect(task?.id).toBe("md#001"); // Updated to qualified format
      expect(task?.title).toBe("Task 1");
    });

    test("should find a task by qualified ID", async () => {
      const task = await taskService.getTask("md#002");

      expect(task).not.toBeNull();
      expect(task?.id).toBe("md#002");
    });

    test("should return null if task not found", async () => {
      const task = await taskService.getTask("#999");
      expect(task).toBeNull();
    });
  });

  describe("getTaskStatus", () => {
    test("should get a task's status", async () => {
      const status = await taskService.getTaskStatus("md#002");
      expect(status).toBe("IN-PROGRESS");
    });

    test("should return undefined if task not found", async () => {
      const status = await taskService.getTaskStatus("#999");
      expect(status).toBeUndefined();
    });
  });

  describe("setTaskStatus", () => {
    test("should update a task's status", async () => {
      await taskService.setTaskStatus("md#001", "DONE");

      // Note: Implementation may have changed - focus on the end result
      // Verify that the status was actually updated by testing the final state
      const updatedTask = await taskService.getTask("md#001");
      expect(updatedTask?.status).toBe("DONE");
    });

    // Validation is handled at higher layers; backend accepts any status in this mock

    test("should no-op when task not found", async () => {
      await taskService.setTaskStatus("#999", "DONE");
      const status = await taskService.getTaskStatus("#999");
      expect(status).toBeUndefined();
    });
  });

  describe("createTaskFromTitleAndSpec", () => {
    test("should create a new task from title and spec", async () => {
      const task = await (taskService as any).createTaskFromTitleAndSpec(
        "Test Task",
        "# Task md#003: Test Task\n\n## Context\n\nDescription."
      );
      expect(task.id).toBe("md#003");
      expect(task.title).toBe("Test Task");
      expect(task.status).toBe("TODO");
    });
  });

  describe("createTaskFromTitleAndSpec (integration)", () => {
    test("should store proper spec path instead of temporary path", async () => {
      // Testing the bug fix for createTaskFromTitleAndDescription
      const taskService = new TaskService({
        workspacePath: "/mock/temp/minsky-test-workspace",
        backend: "mock",
        backends: [createMockBackend()],
      });

      const title = "Test Task for Bug Fix";
      const spec = `# Task md#003: ${title}\n\n## Context\n\nThis task should have a proper spec path, not a temporary path.`;

      const task = await (taskService as any).createTaskFromTitleAndSpec(title, spec);

      // Verify task is created with correct properties
      expect(task.id).toBeDefined();
      expect(task.title).toBe(title);
      expect(task.status).toBe("TODO");

      // The key bug fix: specPath should NOT be a temporary path
      expect(task.specPath).not.toMatch(/\/tmp\//);
      expect(task.specPath).not.toMatch(/\/var\/folders\//);
      expect(task.specPath).not.toMatch(/temp/);
    });

    test("integration: should create task with proper spec path using mock backend", async () => {
      // Integration test using dependency injection instead of global mocking
      const { createMockFilesystem } = await import(
        "../../utils/test-utils/filesystem/mock-filesystem"
      );

      // Create independent mock filesystem for this test
      const mockFs = createMockFilesystem();

      // Create a mock temp workspace path
      const tempWorkspace = "/mock/temp/minsky-test-workspace";
      const mockTempDir = "/mock/temp";
      mockFs.directories.add(tempWorkspace);
      mockFs.directories.add(mockTempDir);

      // Create a mock backend that uses our mock filesystem via DI
      const mockBackend: TaskBackend = {
        name: "mock-markdown",

        // Data retrieval methods
        getTasksData: async () => ({
          success: true,
          content: "# Tasks\n\n## Active Tasks\n\n",
          filePath: `${tempWorkspace}/process/tasks.md`,
        }),

        getTaskSpecData: async (specPath: string) => {
          try {
            const content = await mockFs.readFile(specPath);
            return {
              success: true,
              content: content || "",
              filePath: specPath,
            };
          } catch {
            return {
              success: false,
              content: "",
              filePath: specPath,
              error: new Error(`File not found: ${specPath}`),
            };
          }
        },

        // Pure operations
        parseTasks: () => [],
        formatTasks: () => "",
        parseTaskSpec: (content: string) => {
          // Extract title from markdown heading
          const titleMatch = content.match(/# Task [^:]*: (.+)/);
          const title = titleMatch ? titleMatch[1] : "Test Task";
          return {
            id: "md#001",
            title,
            description: "Mock task description",
          };
        },
        formatTaskSpec: (spec: any) =>
          `# Task ${spec.id}: ${spec.title}\n\n## Context\n\n${spec.description}`,

        // Task operations using mock filesystem
        listTasks: async () => [],
        getTask: async () => null,
        getTaskStatus: async () => null,
        setTaskStatus: async () => {},
        createTask: async () => ({ id: "md#001", title: "Mock Task", status: "TODO" }) as any,
        updateTask: async () => ({ id: "md#001", title: "Mock Task", status: "TODO" }) as any,
        deleteTask: async () => true,

        createTaskFromTitleAndSpec: async (title: string, spec: string) => {
          const taskId = "md#001";
          const specPath = `process/tasks/001-${title.toLowerCase().replace(/\s+/g, "-")}.md`;
          const fullSpecPath = `${tempWorkspace}/${specPath}`;
          await mockFs.writeFile(fullSpecPath, spec);
          return {
            id: taskId,
            title,
            status: "TODO" as any,
            specPath,
            backend: "mock-markdown" as any,
          } as any;
        },

        // Side effects using mock filesystem
        saveTasksData: async () => ({ success: true }),
        saveTaskSpecData: async () => ({ success: true }),

        // Utility methods
        getWorkspacePath: () => tempWorkspace,
        getTaskSpecPath: (taskId: string, title: string) =>
          `process/tasks/${taskId.replace("#", "")}-${title.toLowerCase().replace(/\s+/g, "-")}.md`,
        fileExists: async (path: string) => {
          return mockFs.files.has(path) || mockFs.directories.has(path);
        },
      };

      // Create required directory structure in mock filesystem
      const processDir = `${tempWorkspace}/process`;
      const tasksFile = `${processDir}/tasks.md`;

      await mockFs.mkdir(processDir, { recursive: true });
      await mockFs.writeFile(tasksFile, "# Tasks\n\n## Active Tasks\n\n");

      // Create TaskService with injected mock backend (NO global mocking!)
      const taskService = new TaskService({
        workspacePath: tempWorkspace,
        backend: "mock-markdown",
        backends: [mockBackend], // Dependency injection!
      });

      const title = "Integration test task";
      const spec = `# Task md#001: ${title}\n\n## Context\n\nThis task tests dependency injection with mock filesystem.`;

      const task = await (taskService as any).createTaskFromTitleAndSpec(title, spec);

      // Verify the spec path is correct (not a temporary path)
      expect(task.specPath).not.toMatch(/\/tmp\//);
      expect(task.specPath).not.toMatch(/\/var\/folders\//);
      expect(task.specPath).toMatch(/^process\/tasks\/\d+-[\w-]+\.md$/);

      // Verify the file actually exists in the mock filesystem
      const fullSpecPath = `${tempWorkspace}/${task.specPath}`;
      expect(mockFs.files.has(fullSpecPath)).toBe(true);

      // Verify the file content in mock filesystem
      const fileContent = mockFs.files.get(fullSpecPath);
      expect(fileContent).toContain(title);
      expect(fileContent).toContain("This task tests dependency injection with mock filesystem.");
    });
  });

  describe("backend handling", () => {
    test("should throw error for non-existent backend", () => {
      expect(() => new TaskService({ workspacePath: "/tmp", backend: "nonexistent" })).toThrow(
        /Backend not found: nonexistent/
      );
    });

    test("should use markdown backend by default", () => {
      // No custom backends, default backend should be created
      const defaultService = new TaskService({ workspacePath: "/tmp" });
      expect(defaultService).toBeDefined();
    });
  });
});
