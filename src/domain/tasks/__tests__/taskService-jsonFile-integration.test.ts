const TEST_VALUE = 123;

/**
 * Integration tests for TaskService with JsonFileTaskBackend (v2 - with mocking)
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { join } from "path";
import { TaskService } from "../taskService";
import { createJsonFileTaskBackend } from "../jsonFileTaskBackend";
import {
  createMockFileSystem,
  setupTestMocks,
  mockModule,
} from "../../../utils/test-utils/mocking";

// Set up automatic mock cleanup to prevent race conditions
setupTestMocks();

describe("TaskService JsonFile Integration (v2)", () => {
  let workspacePath: string;
  let taskService: TaskService;
  let dbPath: string;
  let mockFS: ReturnType<typeof createMockFileSystem>;

  beforeEach(async () => {
    // Use consistent test paths
    workspacePath = "/test/workspace";
    dbPath = "/test/tasks.json";

    // Create mock filesystem with initial directory structure
    mockFS = createMockFileSystem({
      [workspacePath]: "", // Directory marker
      [`${workspacePath}/process`]: "", // Directory marker
      [`${workspacePath}/process/tasks`]: "", // Directory marker
    });

    // Mock both fs and fs/promises modules
    mockModule("fs", () => ({
      existsSync: mockFS.existsSync,
      readFileSync: mockFS.readFileSync,
      writeFileSync: mockFS.writeFileSync,
      mkdirSync: mockFS.mkdirSync,
      rmSync: mockFS.rmSync,
    }));

    mockModule("fs/promises", () => ({
      readFile: mockFS.readFile,
      writeFile: mockFS.writeFile,
      mkdir: mockFS.mkdir,
      access: async (path: unknown) => {
        if (!mockFS._files.has(path) && !mockFS._directories.has(path)) {
          throw new Error(`ENOENT: no such file or directory, access '${path}'`);
        }
      },
      unlink: async (path: unknown) => {
        if (!mockFS._files.has(path)) {
          throw new Error(`ENOENT: no such file or directory, unlink '${path}'`);
        }
        mockFS._files.delete(path);
      },
    }));

    // Create task service with JsonFileTaskBackend
    const backend = createJsonFileTaskBackend({
      name: "json-file",
      workspacePath,
      dbFilePath: dbPath,
    });

    taskService = new TaskService({
      customBackends: [backend],
      backend: "json-file",
    });

    // Ensure the backend storage is ready
    await taskService.listTasks();
  });

  describe("Basic Operations", () => {
    test("should default to jsonFile backend", () => {
      // Create service with json-file backend specified
      const defaultService = new TaskService({
        workspacePath,
        backend: "json-file",
        customBackends: [
          createJsonFileTaskBackend({
            name: "json-file",
            workspacePath,
            dbFilePath: dbPath,
          }),
        ],
      });

      expect(defaultService.getWorkspacePath()).toBe(workspacePath);
    });

    test("should list tasks from JSON storage", async () => {
      // Initially should be empty
      const _tasks = await taskService.listTasks();
      expect(tasks.length).toBe(0);
    });

    test("should create and retrieve tasks", async () => {
      // Create a test spec file using mock filesystem
      const _specPath = join(_workspacePath, "process", "tasks", "test-task.md");
      const specContent =
        "# Task #TEST_VALUE: Test Integration Task\n\n## Context\n\nThis is a test task for integration testing.";

      // Write file to mock filesystem
      mockFS.files.set(_specPath, specContent);

      // Use relative path from workspace for task creation
      const relativeSpecPath = "process/tasks/test-task.md";

      const task = await taskService.createTask(relativeSpecPath);

      expect(task.id).toBe("#TEST_VALUE");
      expect(task._title).toBe("Test Integration Task");
      expect(task._status).toBe("TODO");

      // Verify task can be retrieved
      const retrieved = await taskService.getTask("#TEST_VALUE");
      expect(retrieved).toEqual(task);

      // Verify in task list
      const allTasks = await taskService.listTasks();
      expect(allTasks.length).toBe(1);
      expect(allTasks[0]).toEqual(task);
    });

    test("should update task status", async () => {
      // Create a test spec file
      const _specPath = join(_workspacePath, "process", "tasks", "status-test.md");
      const specContent =
        "# Task #124: Status Test Task\n\n## Context\n\nTest task status updates.";

      mockFS.files.set(_specPath, specContent);

      // Create task using relative path
      const relativeSpecPath = "process/tasks/status-test.md";
      const task = await taskService.createTask(relativeSpecPath);
      expect(task._status).toBe("TODO");

      // Update status
      await taskService.setTaskStatus("#124", "IN-PROGRESS");

      // Verify status update
      const _status = await taskService.getTaskStatus("#124");
      expect(_status).toBe("IN-PROGRESS");

      // Verify in full task object
      const updatedTask = await taskService.getTask("#124");
      if (updatedTask) {
        expect(updatedTask._status).toBe("IN-PROGRESS");
      }
    });

    test("should filter tasks by status", async () => {
      // Create multiple test tasks
      const task1Spec = join(_workspacePath, "process", "tasks", "filter-test-1.md");
      const task1Content = "# Task #125: Filter Test 1\n\n## Context\n\nFirst test task.";
      mockFS.files.set(task1Spec, task1Content);

      const task2Spec = join(_workspacePath, "process", "tasks", "filter-test-2.md");
      const task2Content = "# Task #126: Filter Test 2\n\n## Context\n\nSecond test task.";
      mockFS.files.set(task2Spec, task2Content);

      // Create tasks using relative paths
      await taskService.createTask("process/tasks/filter-test-1.md");
      await taskService.createTask("process/tasks/filter-test-2.md");

      // Update one task status
      await taskService.setTaskStatus("#126", "DONE");

      // Filter by TODO status
      const todoTasks = await taskService.listTasks({ _status: "TODO" });
      expect(todoTasks.length).toBe(1);
      if (todoTasks[0]) {
        expect(todoTasks[0].id).toBe("#125");
      }

      // Filter by DONE status
      const doneTasks = await taskService.listTasks({ _status: "DONE" });
      expect(doneTasks.length).toBe(1);
      if (doneTasks[0]) {
        expect(doneTasks[0].id).toBe("#126");
      }

      // All tasks
      const allTasks = await taskService.listTasks();
      expect(allTasks.length).toBe(2);
    });
  });

  describe("Error Handling", () => {
    test("should handle invalid task IDs gracefully", async () => {
      const task = await taskService.getTask("#999");
      expect(task).toBe(null);

      const _status = await taskService.getTaskStatus("#999");
      expect(_status).toBe(null);

      // Should not throw when setting status on non-existent task
      try {
        await taskService.setTaskStatus("#999", "DONE");
        // Should reach here without throwing
        expect(true).toBe(true);
      } catch {
        // Should not throw for non-existent task
        expect(false).toBe(true);
      }
    });

    test("should validate task status values", async () => {
      // Create a test task first
      const _specPath = join(_workspacePath, "process", "tasks", "validation-test.md");
      const specContent = "# Task #127: Validation Test\n\n## Context\n\nTest validation.";
      mockFS.files.set(_specPath, specContent);
      await taskService.createTask("process/tasks/validation-test.md");

      // Should reject invalid status
      await expect(taskService.setTaskStatus("#127", "INVALID")).rejects.toThrow(
        "Status must be one of"
      );
    });
  });

  describe("Synchronization", () => {
    test("should persist changes across service instances", async () => {
      // Create task with first service instance
      const _specPath = join(_workspacePath, "process", "tasks", "persistence-test.md");
      const specContent = "# Task #128: Persistence Test\n\n## Context\n\nTest persistence.";
      mockFS.files.set(_specPath, specContent);

      await taskService.createTask("process/tasks/persistence-test.md");
      await taskService.setTaskStatus("#128", "IN-PROGRESS");

      // Create new service instance pointing to same database
      const newBackend = createJsonFileTaskBackend({
        name: "json-file",
        _workspacePath,
        dbFilePath: dbPath,
      });

      const newService = new TaskService({
        customBackends: [newBackend],
        backend: "json-file",
      });

      // Should see the task and its updated status
      const task = await newService.getTask("#128");
      expect(task?.id).toBe("#128");
      expect(task?._status).toBe("IN-PROGRESS");

      const _tasks = await newService.listTasks();
      expect(tasks.length).toBe(1);
    });
  });
});
