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

    // Mock data retrieval methods
    getTasksData: mock(() => {
      const content = currentTasks
        .map((t) => `- [${t.status === "DONE" ? "x" : " "}] ${t.title} [${t.id}](#)`)
        .join("\n");
      return Promise.resolve({
        success: true,
        content,
        filePath: "mock/tasks.md",
      } as TaskReadOperationResult);
    }),

    getTaskSpecData: mock((specPath: unknown) =>
      Promise.resolve({
        success: true,
        content: "# Task md#TEST_VALUE: Test Task\n\n## Context\n\nDescription.",
        filePath: specPath,
      } as TaskReadOperationResult)
    ),

    // Mock pure operations
    parseTasks: mock((content: unknown) => [...currentTasks]),

    formatTasks: mock((tasks: unknown) => {
      currentTasks = [...(tasks as any[])];
      return currentTasks
        .map((t) => `- [${t.status === "DONE" ? "x" : " "}] ${t.title} [${t.id}](#)`)
        .join("\n");
    }),

    parseTaskSpec: mock((content: unknown) => ({
      id: "md#TEST_VALUE",
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

    getTaskSpecPath: mock((taskId) => `mock/specs/${taskId.replace(/^.*#/, "")}.md`),

    fileExists: mock(() => Promise.resolve(true)),

    // Mock task creation method
    createTask: mock((specPath) => {
      const properSpecPath = "process/tasks/123-test-task.md";
      return Promise.resolve({
        id: "md#TEST_VALUE",
        title: "Test Task",
        description: "Description.",
        status: "TODO",
        specPath: properSpecPath,
      });
    }),

    // Additional required methods to complete TaskBackend interface
    listTasks: mock(() => Promise.resolve(currentTasks)),
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
    createTaskFromTitleAndDescription: mock((title: string, description: string) =>
      Promise.resolve({
        id: "md#TEST_VALUE",
        title: title,
        description: description,
        status: "TODO",
        specPath: "process/tasks/123-test-task.md",
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
      expect(tasks[0].id).toBe("md#001");
      expect(tasks[1].status).toBe("IN-PROGRESS");
    });

    test("should filter tasks by status if provided", async () => {
      const tasks = await taskService.listTasks({ status: "TODO" });

      expect(tasks.length).toBe(1);
      expect(tasks[0].id).toBe("md#001");
    });

    test("should return empty array if data retrieval fails", async () => {
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
      const task = await taskService.getTask("md#001");

      expect(task).not.toBeNull();
      expect(task?.id).toBe("md#001");
      expect(task?.title).toBe("Task 1");
    });

    test("should return null for unqualified IDs", async () => {
      const task = await taskService.getTask("002");
      expect(task).toBeNull();
    });

    test("should return null if task not found", async () => {
      const task = await taskService.getTask("md#999");
      expect(task).toBeNull();
    });
  });

  describe("getTaskStatus", () => {
    test("should get a task's status", async () => {
      const status = await taskService.getTaskStatus("md#002");
      expect(status).toBe("IN-PROGRESS");
    });

    test("should return null if task not found", async () => {
      const status = await taskService.getTaskStatus("md#999");
      expect(status).toBeNull();
    });
  });

  describe("setTaskStatus", () => {
    test("should update a task's status", async () => {
      await taskService.setTaskStatus("md#001", "DONE");

      const updatedTask = await taskService.getTask("md#001");
      expect(updatedTask?.status).toBe("DONE");
    });

    test("should throw error for invalid status", async () => {
      await expect(taskService.setTaskStatus("md#001", "INVALID")).rejects.toThrow(
        /Status must be one of/
      );
    });

    test("should throw error if task not found", async () => {
      await expect(taskService.setTaskStatus("md#999", "DONE")).rejects.toThrow("not found");
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

      expect(task.id).toBe("md#TEST_VALUE");
      expect(task.title).toBe("Test Task");
      expect(task.status).toBe("TODO");
    });

    test("should throw error if spec file read fails", async () => {
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
      const taskService = new TaskService({
        backend: "mock",
        customBackends: [createMockBackend()],
      });

      const title = "Test Task for Bug Fix";
      const description = "This task should have a proper spec path, not a temporary path.";

      const task = await taskService.createTaskFromTitleAndDescription(title, description);

      expect(task.id).toBeDefined();
      expect(task.title).toBe(title);
      expect(task.description).toBe(description);
      expect(task.status).toBe("TODO");

      expect(task.specPath).not.toMatch(/\/tmp\//);
      expect(task.specPath).not.toMatch(/\/var\/folders\//);
      expect(task.specPath).not.toMatch(/temp/);
    });
  });

  describe("backend handling", () => {
    test("should throw error for non-existent backend", () => {
      expect(() => new TaskService({ backend: "nonexistent" })).toThrow(
        /Backend 'nonexistent' not found/
      );
    });

    test("should use markdown backend by default", () => {
      const defaultService = new TaskService({ workspacePath: "/tmp" });
      expect(defaultService).toBeDefined();
    });
  });
});
