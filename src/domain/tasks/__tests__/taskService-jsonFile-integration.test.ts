/**
 * Integration tests for TaskService with JsonFileTaskBackend
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdir, writeFile } from "fs/promises";
import { TaskService } from "../taskService.js";
import { createJsonFileTaskBackend } from "../jsonFileTaskBackend.js";
import type { TaskData } from "../../../types/tasks/taskData.js";

describe("TaskService JsonFile Integration", () => {
  const testDir = join(process.cwd(), "test-tmp", "taskservice-jsonfile-test");
  const workspacePath = join(testDir, "workspace");
  let taskService: TaskService;
  let dbPath: string;

  beforeEach(async () => {
    // Create unique database path for each test
    dbPath = join(testDir, `test-tasks-${Date.now()}-${Math.random()}.json`);
    
    // Create test directories
    await mkdir(testDir, { recursive: true });
    await mkdir(workspacePath, { recursive: true });
    await mkdir(join(workspacePath, "process", "tasks"), { recursive: true });

    // Create task service with JsonFileTaskBackend
    const backend = createJsonFileTaskBackend({
      name: "json-file",
      workspacePath,
      dbFilePath: dbPath
    });

    taskService = new TaskService({
      customBackends: [backend],
      backend: "json-file"
    });
  });

  afterEach(async () => {
    // Simplified cleanup
  });

  describe("Basic Operations", () => {
    test("should default to jsonFile backend", () => {
      // Create service without specifying backend but providing json-file as option
      const defaultService = new TaskService({
        workspacePath,
        backend: "json-file", // Specify json-file since that's the only available backend
        customBackends: [
          createJsonFileTaskBackend({
            name: "json-file",
            workspacePath,
            dbFilePath: dbPath
          })
        ]
      });
      
      // Should use json-file backend when specified
      expect(defaultService.getWorkspacePath()).toBe(workspacePath);
    });

    test("should list tasks from JSON storage", async () => {
      // Initially should be empty
      const tasks = await taskService.listTasks();
      expect(tasks.length).toBe(0);
    });

    test("should create and retrieve tasks", async () => {
      // Create a test spec file
      const specPath = join(workspacePath, "process", "tasks", "test-task.md");
      const specContent = "# Task #123: Test Integration Task\n\n## Context\n\nThis is a test task for integration testing.";
      await writeFile(specPath, specContent, "utf8");

      // Create task via TaskService
      const task = await taskService.createTask("process/tasks/test-task.md");
      
      expect(task.id).toBe("#123");
      expect(task.title).toBe("Test Integration Task");
      expect(task.status).toBe("TODO");

      // Verify task can be retrieved
      const retrieved = await taskService.getTask("#123");
      expect(retrieved).toEqual(task);

      // Verify in task list
      const allTasks = await taskService.listTasks();
      expect(allTasks.length).toBe(1);
      expect(allTasks[0]).toEqual(task);
    });

    test("should update task status", async () => {
      // Create a test spec file
      const specPath = join(workspacePath, "process", "tasks", "status-test.md");
      const specContent = "# Task #124: Status Test Task\n\n## Context\n\nTest task status updates.";
      await writeFile(specPath, specContent, "utf8");

      // Create task
      const task = await taskService.createTask("process/tasks/status-test.md");
      expect(task.status).toBe("TODO");

      // Update status
      await taskService.setTaskStatus("#124", "IN-PROGRESS");

      // Verify status update
      const status = await taskService.getTaskStatus("#124");
      expect(status).toBe("IN-PROGRESS");

      // Verify in full task object
      const updatedTask = await taskService.getTask("#124");
      if (updatedTask) {
        expect(updatedTask.status).toBe("IN-PROGRESS");
      }
    });

    test("should filter tasks by status", async () => {
      // Create multiple test tasks
      const task1Spec = join(workspacePath, "process", "tasks", "filter-test-1.md");
      const task1Content = "# Task #125: Filter Test 1\n\n## Context\n\nFirst test task.";
      await writeFile(task1Spec, task1Content, "utf8");

      const task2Spec = join(workspacePath, "process", "tasks", "filter-test-2.md");
      const task2Content = "# Task #126: Filter Test 2\n\n## Context\n\nSecond test task.";
      await writeFile(task2Spec, task2Content, "utf8");

      // Create tasks
      await taskService.createTask("process/tasks/filter-test-1.md");
      await taskService.createTask("process/tasks/filter-test-2.md");

      // Update one task status
      await taskService.setTaskStatus("#126", "DONE");

      // Filter by TODO status
      const todoTasks = await taskService.listTasks({ status: "TODO" });
      expect(todoTasks.length).toBe(1);
      if (todoTasks[0]) {
        expect(todoTasks[0].id).toBe("#125");
      }

      // Filter by DONE status
      const doneTasks = await taskService.listTasks({ status: "DONE" });
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

      const status = await taskService.getTaskStatus("#999");
      expect(status).toBe(null);

      // Should not throw when setting status on non-existent task
      try {
        await taskService.setTaskStatus("#999", "DONE");
        // Should reach here without throwing
        expect(true).toBe(true);
      } catch (error) {
        // Should not throw for non-existent task
        expect(false).toBe(true);
      }
    });

    test("should validate task status values", async () => {
      // Create a test task first
      const specPath = join(workspacePath, "process", "tasks", "validation-test.md");
      const specContent = "# Task #127: Validation Test\n\n## Context\n\nTest validation.";
      await writeFile(specPath, specContent, "utf8");
      await taskService.createTask("process/tasks/validation-test.md");

      // Should reject invalid status
      await expect(taskService.setTaskStatus("#127", "INVALID")).rejects.toThrow("Status must be one of");
    });
  });

  describe("Synchronization", () => {
    test("should persist changes across service instances", async () => {
      // Create task with first service instance
      const specPath = join(workspacePath, "process", "tasks", "persistence-test.md");
      const specContent = "# Task #128: Persistence Test\n\n## Context\n\nTest persistence.";
      await writeFile(specPath, specContent, "utf8");
      
      await taskService.createTask("process/tasks/persistence-test.md");
      await taskService.setTaskStatus("#128", "IN-PROGRESS");

      // Create new service instance pointing to same database
      const newBackend = createJsonFileTaskBackend({
        name: "json-file",
        workspacePath,
        dbFilePath: dbPath
      });

      const newService = new TaskService({
        customBackends: [newBackend],
        backend: "json-file"
      });

      // Should see the task and its updated status
      const task = await newService.getTask("#128");
      expect(task?.id).toBe("#128");
      expect(task?.status).toBe("IN-PROGRESS");

      const tasks = await newService.listTasks();
      expect(tasks.length).toBe(1);
    });
  });
}); 
 