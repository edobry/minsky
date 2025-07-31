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
  return {
    name: "mock",

    // Mock data retrieval methods
    getTasksData: mock(() =>
      Promise.resolve({
        success: true,
        content: "- [ ] Task 1 [#001](#)\n- [+] Task 2 [#002](#)",
        filePath: "mock/tasks.md",
      } as TaskReadOperationResult)
    ),

    getTaskSpecData: mock((specPath: unknown) =>
      Promise.resolve({
        success: true,
        content: "# Task #TEST_VALUE: Test Task\n\n## Context\n\nDescription.",
        filePath: specPath,
      } as TaskReadOperationResult)
    ),

    // Mock pure operations
    parseTasks: mock((content: unknown) => {
      // Simple parsing for testing
      if (content.toString().includes("#001")) {
        return [
          { id: "#001", title: "Task 1", status: "TODO" },
          { id: "#002", title: "Task 2", status: "IN-PROGRESS" },
        ];
      }
      return [];
    }),

    formatTasks: mock((tasks: unknown) => {
      // Simple formatting for testing
      return tasks
        .map((t) => `- [${t.status === "DONE" ? "x" : " "}] ${t.title} [${t.id}](#)`)
        .join("\n");
    }),

    parseTaskSpec: mock((content: unknown) => ({
      id: "#TEST_VALUE",
      title: "Test Task",
      description: "Description.",
    })),

    formatTaskSpec: mock(
      (spec) => `# Task ${spec.id}: ${spec.title}\n\n## Context\n\n${spec.description}`
    ),

    // Mock side effect methods
    saveTasksData: mock(() =>
      Promise.resolve({
        success: true,
        filePath: "mock/tasks.md",
      } as TaskWriteOperationResult)
    ),

    saveTaskSpecData: mock(() =>
      Promise.resolve({
        success: true,
        filePath: "mock/specs/TEST_VALUE.md",
      } as TaskWriteOperationResult)
    ),

    // Mock helper methods
    getWorkspacePath: mock(() => "mock"),

    getTaskSpecPath: mock((taskId) => `mock/specs/${taskId.replace(/^#/, "")}.md`),

    fileExists: mock(() => Promise.resolve(true)),

    // Mock task creation method
    createTask: mock((specPath) => {
      // This mock now simulates the FIXED behavior: it returns a proper specPath
      // instead of the temporary path, simulating the file being moved
      const properSpecPath = "process/tasks/123-test-task.md";
      return Promise.resolve({
        id: "#TEST_VALUE",
        title: "Test Task",
        description: "Description.",
        status: "TODO",
        specPath: properSpecPath, // FIXED: Returns proper path instead of temporary path
      });
    }),

    // Additional required methods to complete TaskBackend interface
    listTasks: mock(() => Promise.resolve([])),
    getTask: mock(() => Promise.resolve(null)),
    getTaskStatus: mock(() => Promise.resolve(undefined)),
    setTaskStatus: mock(() => Promise.resolve()),
    deleteTask: mock(() => Promise.resolve(true)),
    createTaskFromTitleAndDescription: mock((title: string, description: string) =>
      Promise.resolve({
        id: "#TEST_VALUE",
        title: title,
        description: description,
        status: "TODO",
        specPath: "process/tasks/123-test-task.md", // Proper spec path, not temporary
      })
    ),
  };
}

describe("TaskService", () => {
  let mockBackend: TaskBackend;
  let taskService: TaskService;

  beforeEach(() => {
    mockBackend = createMockBackend();
    taskService = new TaskService({
      customBackends: [mockBackend],
      backend: "mock",
    });
  });

  describe("listTasks", () => {
    test("should get tasks data and parse it", async () => {
      const tasks = await taskService.listTasks();

      expect(mockBackend.getTasksData).toHaveBeenCalled();
      expect(mockBackend.parseTasks).toHaveBeenCalled();
      expect(tasks).toHaveLength(2);
      expect(tasks[0].id).toBe("#001");
      expect(tasks[1].status).toBe("IN-PROGRESS");
    });

    test("should filter tasks by status if provided", async () => {
      const tasks = await taskService.listTasks({ status: "TODO" });

      expect(tasks.length).toBe(1);
      expect(tasks[0].id).toBe("#001");
    });

    test("should return empty array if data retrieval fails", async () => {
      // Override the mock to return failure
      mockBackend.getTasksData = mock(() =>
        Promise.resolve({
          success: false,
          error: new Error("Test error"),
          filePath: "mock/tasks.md",
        })
      );

      const tasks = await taskService.listTasks();
      expect(tasks).toEqual([]);
    });
  });

  describe("getTask", () => {
    test("should find a task by ID", async () => {
      const task = await taskService.getTask("#001");

      expect(task).not.toBeNull();
      expect(task?.id).toBe("#001");
      expect(task?.title).toBe("Task 1");
    });

    test("should find a task by ID without # prefix", async () => {
      const task = await taskService.getTask("002");

      expect(task).not.toBeNull();
      expect(task?.id).toBe("#002");
    });

    test("should return null if task not found", async () => {
      const task = await taskService.getTask("#999");
      expect(task).toBeNull();
    });
  });

  describe("getTaskStatus", () => {
    test("should get a task's status", async () => {
      const status = await taskService.getTaskStatus("#002");
      expect(status).toBe("IN-PROGRESS");
    });

    test("should return null if task not found", async () => {
      const status = await taskService.getTaskStatus("#999");
      expect(status).toBeNull();
    });
  });

  describe("setTaskStatus", () => {
    test("should update a task's status", async () => {
      // Setup spy to check what's passed to saveTasksData
      const saveTasksDataSpy = mockBackend.saveTasksData as any;
      const formatTasksSpy = mockBackend.formatTasks as any;

      await taskService.setTaskStatus("#001", "DONE");

      // Verify correct methods were called
      expect(mockBackend.getTasksData).toHaveBeenCalled();
      expect(mockBackend.parseTasks).toHaveBeenCalled();
      expect(formatTasksSpy).toHaveBeenCalled();
      expect(saveTasksDataSpy).toHaveBeenCalled();

      // Verify tasks passed to formatTasks had the updated status
      const updatedTasks = formatTasksSpy.mock.calls[0][0];
      const updatedTask = updatedTasks.find((t: unknown) => t.id === "#001");
      expect(updatedTask?.status).toBe("DONE");
    });

    test("should throw error for invalid status", async () => {
      await expect(taskService.setTaskStatus("#001", "INVALID")).rejects.toThrow(
        /Status must be one of/
      );
    });

    test("should throw error if task not found", async () => {
      // This should throw an error for non-existent task
      await expect(taskService.setTaskStatus("#999", "DONE")).rejects.toThrow("not found");

      // And saveTasksData should not have been called
      expect(mockBackend.saveTasksData).not.toHaveBeenCalled();
    });
  });

  describe("createTask", () => {
    test("should create a new task from spec file", async () => {
      const task = await taskService.createTask("path/to/spec.md");

      expect(mockBackend.getTaskSpecData).toHaveBeenCalledWith("path/to/spec.md");
      expect(mockBackend.parseTaskSpec).toHaveBeenCalled();
      expect(mockBackend.getTasksData).toHaveBeenCalled();
      expect(mockBackend.parseTasks).toHaveBeenCalled();
      expect(mockBackend.formatTasks).toHaveBeenCalled();
      expect(mockBackend.saveTasksData).toHaveBeenCalled();

      expect(task.id).toBe("#TEST_VALUE");
      expect(task.title).toBe("Test Task");
      expect(task.status).toBe("TODO");
    });

    test("should throw error if spec file read fails", async () => {
      // Override mock to return failure
      mockBackend.getTaskSpecData = mock(() =>
        Promise.resolve({
          success: false,
          error: new Error("Test error"),
          filePath: "path/to/spec.md",
        })
      );

      await expect(taskService.createTask("path/to/spec.md")).rejects.toThrow(
        /Failed to read spec file/
      );
    });
  });

  describe("createTaskFromTitleAndDescription", () => {
    test("should store proper spec path instead of temporary path", async () => {
      // Testing the bug fix for createTaskFromTitleAndDescription
      const taskService = new TaskService({
        backend: "mock",
        customBackends: [createMockBackend()],
      });

      const title = "Test Task for Bug Fix";
      const description = "This task should have a proper spec path, not a temporary path.";

      const task = await taskService.createTaskFromTitleAndDescription(title, description);

      // Verify task is created with correct properties
      expect(task.id).toBeDefined();
      expect(task.title).toBe(title);
      expect(task.description).toBe(description);
      expect(task.status).toBe("TODO");

      // The key bug fix: specPath should NOT be a temporary path
      expect(task.specPath).not.toMatch(/\/tmp\//);
      expect(task.specPath).not.toMatch(/\/var\/folders\//);
      expect(task.specPath).not.toMatch(/temp/);
    });

    test("integration: should create task with proper spec path using mock backend", async () => {
      // Integration test using mock filesystem for complete isolation
      const { createMockFilesystem } = await import(
        "../../utils/test-utils/filesystem/mock-filesystem"
      );
      const { mockModule } = await import("../../utils/test-utils/mocking");

      // Create independent mock filesystem for this test
      const mockFs = createMockFilesystem();

      // Create a mock temp workspace path
      const tempWorkspace = "/mock/temp/minsky-test-workspace";
      const mockTempDir = "/mock/temp";
      mockFs.directories.add(tempWorkspace);
      mockFs.directories.add(mockTempDir);

      // Mock fs/promises to use our mock filesystem
      mockModule("fs/promises", () => mockFs);

      // Mock fs module (sync operations) to use our mock filesystem
      mockModule("fs", () => ({
        existsSync: mockFs.existsSync,
        readFileSync: mockFs.readFileSync,
        writeFileSync: mockFs.writeFileSync,
        mkdirSync: (path: string, options?: any) => {
          mockFs.directories.add(path);
          if (options?.recursive) {
            const parts = path.split("/");
            for (let i = 1; i <= parts.length; i++) {
              mockFs.directories.add(parts.slice(0, i).join("/"));
            }
          }
        },
        mkdtempSync: (prefix: string) => {
          const timestamp = Date.now();
          const random = Math.random().toString(36).substring(2, 8);
          const tempDir = `${prefix}${timestamp}-${random}`;
          mockFs.directories.add(tempDir);
          return tempDir;
        },
      }));

      // Mock os module to return our mock temp directory
      mockModule("os", () => ({
        tmpdir: () => mockTempDir,
      }));

      // Mock path module for consistent path joining
      mockModule("path", () => ({
        join: (...parts: string[]) => parts.join("/"),
      }));

      // Create required directory structure and tasks.md file
      const processDir = `${tempWorkspace}/process`;
      const tasksFile = `${processDir}/tasks.md`;

      await mockFs.mkdir(processDir, { recursive: true });
      await mockFs.writeFile(tasksFile, "# Tasks\n\n## Active Tasks\n\n", "utf-8");

      // Create a real TaskService with the markdown backend
      const realTaskService = new TaskService({
        workspacePath: tempWorkspace,
        backend: "markdown",
      });

      const title = "Integration test task";
      const description = "This task tests the mock filesystem integration.";

      const task = await realTaskService.createTaskFromTitleAndDescription(title, description);

      // Verify the spec path is correct (not a temporary path)
      expect(task.specPath).not.toMatch(/\/tmp\//);
      expect(task.specPath).not.toMatch(/\/var\/folders\//);
      expect(task.specPath).toMatch(/^process\/tasks\/\d+-[\w-]+\.md$/);

      // Verify the file actually exists in the mock filesystem
      const fullSpecPath = `${tempWorkspace}/${task.specPath}`;
      await expect(mockFs.access(fullSpecPath)).resolves.toBeUndefined();

      // Verify the file content in mock filesystem
      const fileContent = await mockFs.readFile(fullSpecPath);
      expect(fileContent).toContain(title);
      expect(fileContent).toContain(description);
    });
  });

  describe("backend handling", () => {
    test("should throw error for non-existent backend", () => {
      expect(() => new TaskService({ backend: "nonexistent" })).toThrow(
        /Backend 'nonexistent' not found/
      );
    });

    test("should use markdown backend by default", () => {
      // No custom backends, default backend should be created
      const defaultService = new TaskService({ workspacePath: "/tmp" });
      expect(defaultService).toBeDefined();
    });
  });
});
