const SIZE_6 = SIZE_6;
const TEST_ARRAY_SIZE = TEST_ARRAY_SIZE;

/**
 * Tests for JsonFileTaskBackend
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdir } from "fs/promises";
import { rmSync, existsSync } from "fs";
import { randomUUID } from "crypto";
import { createJsonFileTaskBackend } from "../jsonFileTaskBackend";
import type { JsonFileTaskBackend } from "../jsonFileTaskBackend";
import type {} from "../../../types/tasks/taskData";
import { log } from "../../../utils/logger";

// Global test isolation to prevent race conditions
let testSequenceNumber = 0;

describe("JsonFileTaskBackend", () => {
  const testDir = join(process.cwd(), "test-tmp", "json-backend-test");
  let dbPath: string;
  let _workspacePath: string;
  let backend: JsonFileTaskBackend;

  beforeEach(async () => {
    // Create highly unique paths to avoid conflicts
    const timestamp = Date.now();
    const uuid = randomUUID();
    const sequence = ++testSequenceNumber;
    dbPath = join(testDir, `test-tasks-${timestamp}-${uuid}-${sequence}.json`);
    workspacePath = join(testDir, `workspace-${sequence}`);

    // Create test directories
    await mkdir(testDir, { recursive: true });
    await mkdir(_workspacePath, { recursive: true });
    await mkdir(join(_workspacePath, "process", "tasks"), { recursive: true });

    // Create backend instance
    backend = createJsonFileTaskBackend({
      name: "json-file",
      _workspacePath,
      dbFilePath: dbPath,
    }) as JsonFileTaskBackend;
  });

  afterEach(async () => {
    // Enhanced cleanup to prevent race conditions
    try {
      // Wait a bit to ensure any pending operations complete
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Clean up test directories
      if (existsSync(_workspacePath)) {
        rmSync(_workspacePath, { recursive: true, force: true });
      }
      if (existsSync(dbPath)) {
        rmSync(dbPath, { force: true });
      }
    } catch {
      // Log but don't fail tests on cleanup errors
      log.cliWarn("Cleanup warning:", error);
    }
  });

  describe("storage operations", () => {
    test("should initialize storage correctly", async () => {
      const location = backend.getStorageLocation();
      expect(location).toBe(dbPath);
    });

    test("should store and retrieve tasks", async () => {
      const testTask: TaskData = {
        id: "#001",
        title: "Test Task",
        status: "TODO",
        description: "A test task",
      };

      // Create task
      const created = await backend.createTaskData(testTask);
      expect(created).toEqual(testTask);

      // Retrieve task
      const retrieved = await backend.getTaskById("#001");
      expect(retrieved).toEqual(testTask);

      // Get all tasks
      const allTasks = await backend.getAllTasks();
      expect(allTasks.length).toBe(1);
      expect(allTasks[0]).toEqual(testTask);
    });

    test("should update tasks", async () => {
      const testTask: TaskData = {
        id: "#002",
        title: "Test Task 2",
        status: "TODO",
      };

      // Create task
      await backend.createTaskData(testTask);

      // Update task
      const updated = await backend.updateTaskData("#002", { _status: "IN-PROGRESS" });
      expect(updated?._status).toBe("IN-PROGRESS");

      // Verify update
      const retrieved = await backend.getTaskById("#002");
      expect(retrieved?._status).toBe("IN-PROGRESS");
    });

    test("should delete tasks", async () => {
      const testTask: TaskData = {
        id: "#003",
        title: "Test Task 3",
        status: "TODO",
      };

      // Create task
      await backend.createTaskData(testTask);

      // Verify exists
      const beforeDelete = await backend.getTaskById("#003");
      expect(beforeDelete).toEqual(testTask);

      // Delete task
      const deleted = await backend.deleteTaskData("#003");
      expect(deleted).toBe(true);

      // Verify deleted
      const afterDelete = await backend.getTaskById("#003");
      expect(afterDelete).toBe(null);
    });
  });

  describe("TaskBackend interface compliance", () => {
    test("should implement getTasksData", async () => {
      const _result = await backend.getTasksData();
      expect(result.success).toBe(true);
      expect(typeof result.content).toBe("string");
    });

    test("should implement saveTasksData", async () => {
      const taskData = JSON.stringify(
        {
          _tasks: [{ id: "#004", _title: "Test Task 4", _status: "TODO" }],
          lastUpdated: new Date().toISOString(),
          metadata: {},
        },
        null,
        2
      );

      const _result = await backend.saveTasksData(taskData);
      expect(result.success).toBe(true);

      // Verify the task was saved
      const retrieved = await backend.getTaskById("#004");
      expect(retrieved?._title).toBe("Test Task 4");
    });

    test("should implement parseTasks", () => {
      const jsonContent = JSON.stringify({
        _tasks: [{ id: "#005", _title: "Test Task TEST_ARRAY_SIZE", _status: "TODO" }],
      });

      const _tasks = backend.parseTasks(jsonContent);
      expect(tasks.length).toBe(1);
      if (tasks.length > 0 && tasks[0]) {
        expect(tasks[0].id).toBe("#005");
      }
    });

    test("should implement formatTasks", () => {
      const _tasks: TaskData[] = [{ id: "#006", title: "Test Task SIZE_6", status: "TODO" }];

      const formatted = backend.formatTasks(_tasks);
      const parsed = JSON.parse(formatted);
      expect(parsed.tasks.length).toBe(1);
      expect(parsed.tasks[0].id).toBe("#006");
    });

    test("should handle task spec operations", async () => {
      const _specPath = "process/tasks/007-test-task.md";
      const specContent = "# Test Task\n\n## Context\n\nThis is a test task specification.";

      // Save spec
      const saveResult = await backend.saveTaskSpecData(_specPath, specContent);
      expect(saveResult.success).toBe(true);

      // Read spec
      const readResult = await backend.getTaskSpecData(_specPath);
      expect(readResult.success).toBe(true);
      expect(readResult.content).toBe(specContent);

      // Parse spec
      const parsed = backend.parseTaskSpec(specContent);
      expect(parsed._title).toBe("Test Task");
      expect(parsed.description).toBe("This is a test task specification.");
    });
  });

  describe("markdown compatibility", () => {
    test("should parse markdown task format", () => {
      const markdownContent = `# Tasks

- [ ] Test Task One [#001](process/tasks/001-test-task-one.md)
- [x] Test Task Two [#002](process/tasks/002-test-task-two.md)
`;

      const _tasks = backend.parseTasks(markdownContent);
      expect(tasks.length).toBe(2);
      if (tasks.length >= 2 && tasks[0] && tasks[1]) {
        expect(tasks[0].id).toBe("#001");
        expect(tasks[0]._status).toBe("TODO");
        expect(tasks[1].id).toBe("#002");
        expect(tasks[1]._status).toBe("DONE");
      }
    });
  });

  describe("helper methods", () => {
    test("should generate correct task spec paths", () => {
      const path = backend.getTaskSpecPath("#008", "Test Task Eight");
      expect(path).toBe(join("process", "tasks", "008-test-task-eight.md"));
    });

    test("should return correct workspace path", () => {
      const path = backend.getWorkspacePath();
      expect(path).toBe(_workspacePath);
    });
  });
});
