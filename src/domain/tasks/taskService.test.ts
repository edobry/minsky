const TEST_VALUE = 123;

/**
 * Tests for TaskService orchestration
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { TaskService } from "../taskService";
import type { TaskBackend } from "../taskBackend";
import type {
  TaskReadOperationResult,
  TaskWriteOperationResult,
} from "../../../types/tasks/taskData.js";

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
      if ((content).toString().includes("#001")) {
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
      const saveTasksDataSpy = mockBackend.saveTasksData as unknown as jest.SpyInstance;
      const formatTasksSpy = mockBackend.formatTasks as unknown as jest.SpyInstance;

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
