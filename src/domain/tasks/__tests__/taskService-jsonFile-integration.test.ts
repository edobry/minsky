/**
 * Integration tests for TaskService with JsonFileTaskBackend
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdir, writeFile } from "fs/promises";
import { randomUUID } from "crypto";
import { TaskService } from "../taskService";
import { createJsonFileTaskBackend } from "../jsonFileTaskBackend";
import type { TaskData } from "../../../types/tasks/taskData";

describe("TaskService JsonFile Integration", () => {
  let testDir: string;
  let workspacePath: string;
  let taskService: TaskService;
  let dbPath: string;

  beforeEach(async () => {
    // Create unique test directory path to avoid conflicts
    const timestamp = Date.now();
    const uuid = randomUUID();
    testDir = join(process.cwd(), "test-tmp", `taskservice-jsonfile-test-${timestamp}-${uuid}`);
    workspacePath = join(testDir, "workspace");
    dbPath = join(testDir, "test-tasks.json");

    // Create test directories
    await mkdir(join(workspacePath, "process", "tasks"), { recursive: true });

    // Create the task backend and service
    const backend = createJsonFileTaskBackend({
      name: "json-file",
      workspacePath,
      dbFilePath: dbPath,
    });

    taskService = new TaskService({
      workspacePath,
      backend: "json-file",
      customBackends: [backend],
    });
  });

  afterEach(async () => {
    // Clean up test directories
    try {
      const { rmSync } = await import("fs");
      if (testDir) {
        rmSync(testDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors - OS will clean up temp files
    }
  });

  describe("Basic Operations", () => {
    test("should default to jsonFile backend", () => {
      expect(taskService).toBeDefined();
      expect(taskService.getWorkspacePath()).toBe(workspacePath);
    });

    test("should list tasks from JSON storage", async () => {
      const tasks = await taskService.listTasks();
      expect(tasks).toEqual([]);
    });

    test("should create and retrieve tasks", async () => {
      // Create a test spec file
      const specPath = join(workspacePath, "process", "tasks", "test-task.md");
      const specContent = `# Task #001: Test Task

## Description
This is a test task for integration testing.

## Requirements
- Test requirement 1
- Test requirement 2

## Acceptance Criteria
- [ ] Criterion 1
- [ ] Criterion 2
`;
      await writeFile(specPath, specContent, "utf8");

      // Create task
      const task = await taskService.createTask("process/tasks/test-task.md");
      expect(task.id).toBe("#001");
      expect(task.title).toBe("Test Task");
      expect(task.status).toBe("TODO");

      // Retrieve task
      const retrievedTask = await taskService.getTask("#001");
      expect(retrievedTask).toEqual(task);
    });

    test("should update task status", async () => {
      // Create a test spec file
      const specPath = join(workspacePath, "process", "tasks", "status-test.md");
      const specContent = `# Task #002: Status Test Task

## Description
This task tests status updates.
`;
      await writeFile(specPath, specContent, "utf8");

      // Create task
      const task = await taskService.createTask("process/tasks/status-test.md");
      expect(task.status).toBe("TODO");

      // Update status
      await taskService.setTaskStatus("#002", "IN-PROGRESS");

      // Verify status update
      const status = await taskService.getTaskStatus("#002");
      expect(status).toBe("IN-PROGRESS");
    });

    test("should filter tasks by status", async () => {
      // Create multiple test spec files
      const specs = [
        { id: "001", title: "Filter Test 1", file: "filter-test-1.md" },
        { id: "002", title: "Filter Test 2", file: "filter-test-2.md" },
      ];

      for (const spec of specs) {
        const specPath = join(workspacePath, "process", "tasks", spec.file);
        const specContent = `# Task #${spec.id}: ${spec.title}

## Description
This is a test task for filtering.
`;
        await writeFile(specPath, specContent, "utf8");
        await taskService.createTask(`process/tasks/${spec.file}`);
      }

      // Update one task status
      await taskService.setTaskStatus("#002", "IN-PROGRESS");

      // Filter by TODO status
      const todoTasks = await taskService.listTasks({ status: "TODO" });
      expect(todoTasks.length).toBe(1);
      expect(todoTasks[0]?.id).toBe("#001");

      // Filter by IN-PROGRESS status
      const inProgressTasks = await taskService.listTasks({ status: "IN-PROGRESS" });
      expect(inProgressTasks.length).toBe(1);
      expect(inProgressTasks[0]?.id).toBe("#002");
    });
  });

  describe("Error Handling", () => {
    test("should handle invalid task IDs gracefully", async () => {
      const task = await taskService.getTask("#999");
      expect(task).toBeNull();

      const status = await taskService.getTaskStatus("#999");
      expect(status).toBeNull();
    });

    test("should validate task status values", async () => {
      // Create a test spec file
      const specPath = join(workspacePath, "process", "tasks", "validation-test.md");
      const specContent = `# Task #003: Validation Test

## Description
This task tests validation.
`;
      await writeFile(specPath, specContent, "utf8");

      const task = await taskService.createTask("process/tasks/validation-test.md");

      // Try to set invalid status
      await expect(taskService.setTaskStatus("#003", "INVALID" as any)).rejects.toThrow();
    });
  });

  describe("Synchronization", () => {
    test("should persist changes across service instances", async () => {
      // Create a test spec file
      const specPath = join(workspacePath, "process", "tasks", "persistence-test.md");
      const specContent = `# Task #004: Persistence Test

## Description
This task tests persistence across instances.
`;
      await writeFile(specPath, specContent, "utf8");

      // Create task with first service instance
      const task = await taskService.createTask("process/tasks/persistence-test.md");
      expect(task.id).toBe("#004");

      // Create new service instance with same backend
      const backend2 = createJsonFileTaskBackend({
        name: "json-file",
        workspacePath,
        dbFilePath: dbPath,
      });
      const taskService2 = new TaskService({
        workspacePath,
        backend: "json-file",
        customBackends: [backend2],
      });

      // Verify task exists in new instance
      const retrievedTask = await taskService2.getTask("#004");
      expect(retrievedTask).toEqual(task);

      // Update status in second instance
      await taskService2.setTaskStatus("#004", "DONE");

      // Verify update is visible in first instance
      const status = await taskService.getTaskStatus("#004");
      expect(status).toBe("DONE");
    });
  });
});
