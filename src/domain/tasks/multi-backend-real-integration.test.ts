import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { join } from "path";
import { MultiBackendTaskServiceImpl } from "./multi-backend-service";
import { createMarkdownTaskBackend } from "./markdownTaskBackend";
import { TASK_STATUS } from "./taskConstants";
import { createMockFilesystem } from "../../utils/test-utils/filesystem/mock-filesystem";

describe("MultiBackendTaskService with Real MarkdownTaskBackend", () => {
  let service: MultiBackendTaskServiceImpl;
  let markdownBackend: any;
  let mockFs: ReturnType<typeof createMockFilesystem>;

  // Static mock paths to prevent environment dependencies
  const mockTempDir = "/mock/tmp/test-multi-backend";

  beforeEach(async () => {
    // Create isolated mock filesystem for each test
    mockFs = createMockFilesystem();

    // Use mock.module() to mock filesystem operations
    mock.module("fs", () => ({
      promises: {
        mkdir: mockFs.mkdir,
        rm: mockFs.rm,
        readFile: mockFs.readFile,
        writeFile: mockFs.writeFile,
        readdir: mockFs.readdir,
        stat: mockFs.stat,
      },
      existsSync: mockFs.existsSync,
      mkdirSync: mockFs.mkdirSync,
      rmSync: mockFs.rmSync,
      readFileSync: mockFs.readFileSync,
      writeFileSync: mockFs.writeFileSync,
    }));

    // Ensure mock directories exist
    mockFs.ensureDirectoryExists(mockTempDir);
    mockFs.ensureDirectoryExists(join(mockTempDir, "process"));

    // Initialize backends with mock filesystem
    markdownBackend = createMarkdownTaskBackend({
      name: "markdown",
      workspacePath: mockTempDir,
    });

    // Initialize service with real backend
    service = new MultiBackendTaskServiceImpl();
    service.registerBackend(markdownBackend);
  });

  afterEach(async () => {
    // Clean up using mock filesystem
    try {
      mockFs.cleanup();
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe("Backend Registration and Routing", () => {
    it("should register markdown backend correctly", () => {
      const backends = service.listBackends();
      expect(backends).toHaveLength(1);
      expect(backends[0].name).toBe("markdown");
    });

    it("should route qualified IDs to correct backend", async () => {
      // Test with qualified markdown ID
      const task = {
        id: "md#123",
        title: "Test Task",
        description: "A test task",
        status: TASK_STATUS.TODO,
        metadata: {
          created: new Date().toISOString(),
          workspace: mockTempDir,
        },
      };

      await service.createTask(task);
      const retrievedTask = await service.getTask("md#123");

      expect(retrievedTask).toBeDefined();
      expect(retrievedTask?.id).toBe("md#123");
      expect(retrievedTask?.title).toBe("Test Task");
    });

    it("should list tasks from all backends", async () => {
      // Create tasks through different backends
      const task1 = {
        id: "md#task1",
        title: "Markdown Task 1",
        description: "First markdown task",
        status: TASK_STATUS.TODO,
        metadata: {
          created: new Date().toISOString(),
          workspace: mockTempDir,
        },
      };

      const task2 = {
        id: "md#task2",
        title: "Markdown Task 2",
        description: "Second markdown task",
        status: TASK_STATUS.IN_PROGRESS,
        metadata: {
          created: new Date().toISOString(),
          workspace: mockTempDir,
        },
      };

      await service.createTask(task1);
      await service.createTask(task2);

      const allTasks = await service.listTasks();
      expect(allTasks).toHaveLength(2);
      expect(allTasks.map((t) => t.id)).toContain("md#task1");
      expect(allTasks.map((t) => t.id)).toContain("md#task2");
    });
  });

  describe("Cross-Backend Operations", () => {
    it("should handle task updates across backends", async () => {
      const task = {
        id: "md#update-test",
        title: "Update Test Task",
        description: "Task for testing updates",
        status: TASK_STATUS.TODO,
        metadata: {
          created: new Date().toISOString(),
          workspace: mockTempDir,
        },
      };

      await service.createTask(task);

      // Update the task
      const updatedTask = {
        ...task,
        status: TASK_STATUS.IN_PROGRESS,
        title: "Updated Task Title",
      };

      await service.updateTask("md#update-test", updatedTask);
      const retrievedTask = await service.getTask("md#update-test");

      expect(retrievedTask?.status).toBe(TASK_STATUS.IN_PROGRESS);
      expect(retrievedTask?.title).toBe("Updated Task Title");
    });

    it("should handle task status transitions correctly", async () => {
      const task = {
        id: "md#status-test",
        title: "Status Test Task",
        description: "Task for testing status transitions",
        status: TASK_STATUS.TODO,
        metadata: {
          created: new Date().toISOString(),
          workspace: mockTempDir,
        },
      };

      await service.createTask(task);

      // Transition through different statuses
      await service.updateTaskStatus("md#status-test", TASK_STATUS.IN_PROGRESS);
      let retrievedTask = await service.getTask("md#status-test");
      expect(retrievedTask?.status).toBe(TASK_STATUS.IN_PROGRESS);

      await service.updateTaskStatus("md#status-test", TASK_STATUS.DONE);
      retrievedTask = await service.getTask("md#status-test");
      expect(retrievedTask?.status).toBe(TASK_STATUS.DONE);
    });

    it("should handle task deletion across backends", async () => {
      const task = {
        id: "md#delete-test",
        title: "Delete Test Task",
        description: "Task for testing deletion",
        status: TASK_STATUS.TODO,
        metadata: {
          created: new Date().toISOString(),
          workspace: mockTempDir,
        },
      };

      await service.createTask(task);

      // Verify task exists
      let retrievedTask = await service.getTask("md#delete-test");
      expect(retrievedTask).toBeDefined();

      // Delete the task
      await service.deleteTask("md#delete-test");

      // Verify task is deleted
      retrievedTask = await service.getTask("md#delete-test");
      expect(retrievedTask).toBeNull();
    });
  });
});
