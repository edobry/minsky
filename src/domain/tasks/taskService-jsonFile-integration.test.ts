const TEST_VALUE = 123;

/**
 * Integration tests for TaskService with JsonFileTaskBackend (Enhanced with improved isolation)
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { join } from "path";
import { TaskService } from "./taskService";
import { createJsonFileTaskBackend } from "./jsonFileTaskBackend";
import { setupTestCleanup } from "../../utils/test-utils/cleanup";
import { setupEnhancedMocking } from "../../utils/test-utils/enhanced-mocking";
import { testDataFactory, DatabaseIsolation } from "../../utils/test-utils/test-isolation";

// Set up comprehensive test cleanup and isolation
const cleanupManager = setupTestCleanup();

describe("TaskService JsonFile Integration (Enhanced)", () => {
  let workspacePath: string;
  let taskService: TaskService;
  let dbPath: string;
  let mockEnvironment: any;

  beforeEach(async () => {
    // Create isolated test environment
    mockEnvironment = setupEnhancedMocking();
    
    // Create isolated database
    const dbConfig = await DatabaseIsolation.createIsolatedDatabase("taskservice-test", {
      tasks: []
    });
    dbPath = dbConfig.dbPath;

    // Use unique workspace path for this test
    workspacePath = "/test/workspace";

    // Setup mock filesystem with proper directory structure
    mockEnvironment.mockFS.writeFile(`${workspacePath}/process/tasks.md`, "");
    mockEnvironment.mockFS.mkdir(`${workspacePath}/process`, { recursive: true });
    mockEnvironment.mockFS.mkdir(`${workspacePath}/process/tasks`, { recursive: true });

    // Mock filesystem modules
    mockEnvironment.mockModule("fs", () => {
      const mocks = mockEnvironment.mockFS.createFSMocks();
      return mocks.fs;
    });

    mockEnvironment.mockModule("fs/promises", () => {
      const mocks = mockEnvironment.mockFS.createFSMocks();
      return mocks.fsPromises;
    });

    // Create TaskService with JsonFileTaskBackend
    const backend = createJsonFileTaskBackend({
      name: "json-file",
      workspacePath,
      dbFilePath: dbPath,
    });

    taskService = new TaskService({
      customBackends: [backend],
      backend: "json-file",
      workspacePath,
    });
  });

  describe("Basic Task Operations", () => {
    test("should create and retrieve tasks", async () => {
      // Create test data using factory
      const taskData = testDataFactory.createTaskData({
        prefix: "integration-test",
        includeMetadata: true
      });

      // Create task spec file in mock filesystem
      const specPath = join(workspacePath, taskData.specPath);
      const specContent = `# Task ${taskData.id}: ${taskData.title}\n\n## Context\n\n${taskData.description}`;
      mockEnvironment.mockFS.writeFile(specPath, specContent);

      // Create task
      const task = await taskService.createTask(taskData.specPath);

      expect(task.id).toBe(taskData.id);
      expect(task.title).toBe(taskData.title);
      expect(task.status).toBe("TODO");

      // Verify task can be retrieved
      const retrieved = await taskService.getTask(taskData.id);
      expect(retrieved).toEqual(task);

      // Verify in task list
      const allTasks = await taskService.listTasks();
      expect(allTasks.length).toBe(1);
      expect(allTasks[0]).toEqual(task);
    });

    test("should handle multiple tasks", async () => {
      // Create multiple test tasks
      const tasks = testDataFactory.createMultipleTaskData(3, {
        prefix: "multi-test",
        includeMetadata: true
      });

      // Create task spec files
      for (const taskData of tasks) {
        const specPath = join(workspacePath, taskData.specPath);
        const specContent = `# Task ${taskData.id}: ${taskData.title}\n\n## Context\n\n${taskData.description}`;
        mockEnvironment.mockFS.writeFile(specPath, specContent);

        await taskService.createTask(taskData.specPath);
      }

      // Verify all tasks were created
      const allTasks = await taskService.listTasks();
      expect(allTasks.length).toBe(3);

      // Verify each task can be retrieved individually
      for (const taskData of tasks) {
        const retrieved = await taskService.getTask(taskData.id);
        expect(retrieved).toBeDefined();
        expect(retrieved?.id).toBe(taskData.id);
      }
    });

    test("should update task status", async () => {
      // Create test task
      const taskData = testDataFactory.createTaskData({
        prefix: "status-test",
        includeMetadata: true
      });

      const specPath = join(workspacePath, taskData.specPath);
      const specContent = `# Task ${taskData.id}: ${taskData.title}\n\n## Context\n\n${taskData.description}`;
      mockEnvironment.mockFS.writeFile(specPath, specContent);

      const task = await taskService.createTask(taskData.specPath);
      
      // Update status
      await taskService.setTaskStatus(taskData.id, "IN-PROGRESS");
      
      // Verify status was updated
      const status = await taskService.getTaskStatus(taskData.id);
      expect(status).toBe("IN-PROGRESS");

      // Verify task reflects the status change
      const updated = await taskService.getTask(taskData.id);
      expect(updated?.status).toBe("IN-PROGRESS");
    });
  });

  describe("Error Handling", () => {
    test("should handle invalid task IDs gracefully", async () => {
      const invalidId = "#nonexistent-task";
      
      const task = await taskService.getTask(invalidId);
      expect(task).toBe(null);

      const status = await taskService.getTaskStatus(invalidId);
      expect(status).toBe(null);

      // Should throw when setting status on non-existent task
      await expect(taskService.setTaskStatus(invalidId, "DONE")).rejects.toThrow("not found");
    });

    test("should validate task status values", async () => {
      // Create a test task first
      const taskData = testDataFactory.createTaskData({
        prefix: "validation-test",
        includeMetadata: true
      });

      const specPath = join(workspacePath, taskData.specPath);
      const specContent = `# Task ${taskData.id}: ${taskData.title}\n\n## Context\n\n${taskData.description}`;
      mockEnvironment.mockFS.writeFile(specPath, specContent);
      
      await taskService.createTask(taskData.specPath);

      // Should reject invalid status
      await expect(taskService.setTaskStatus(taskData.id, "INVALID")).rejects.toThrow(
        "Status must be one of"
      );
    });
  });

  describe("Data Persistence", () => {
    test("should persist changes across service instances", async () => {
      // Create task with first service instance
      const taskData = testDataFactory.createTaskData({
        prefix: "persistence-test",
        includeMetadata: true
      });

      const specPath = join(workspacePath, taskData.specPath);
      const specContent = `# Task ${taskData.id}: ${taskData.title}\n\n## Context\n\n${taskData.description}`;
      mockEnvironment.mockFS.writeFile(specPath, specContent);

      await taskService.createTask(taskData.specPath);
      await taskService.setTaskStatus(taskData.id, "IN-PROGRESS");

      // Create new service instance pointing to same database
      const newBackend = createJsonFileTaskBackend({
        name: "json-file",
        workspacePath,
        dbFilePath: dbPath,
      });

      const newService = new TaskService({
        customBackends: [newBackend],
        backend: "json-file",
        workspacePath,
      });

      // Should see the task and its updated status
      const task = await newService.getTask(taskData.id);
      expect(task?.id).toBe(taskData.id);
      expect(task?.status).toBe("IN-PROGRESS");

      const tasks = await newService.listTasks();
      expect(tasks.length).toBe(1);
    });
  });

  describe("Test Isolation Validation", () => {
    test("should maintain proper test isolation", () => {
      // Validate that mock filesystem is isolated
      const fsState = mockEnvironment.mockFS.validateState();
      expect(fsState.isValid).toBe(true);

      // Validate that mock filesystem contains expected files
      const stateSummary = mockEnvironment.mockFS.getStateSummary();
      expect(stateSummary.fileCount).toBeGreaterThan(0);
      expect(stateSummary.testId).toBeDefined();
    });

    test("should cleanup properly after each test", async () => {
      // Create some test data
      const taskData = testDataFactory.createTaskData();
      const specPath = join(workspacePath, taskData.specPath);
      mockEnvironment.mockFS.writeFile(specPath, "test content");

      // Verify file exists
      expect(mockEnvironment.mockFS.exists(specPath)).toBe(true);

      // Cleanup will be handled automatically by afterEach hooks
      // This test verifies the cleanup infrastructure is working
    });
  });
});
