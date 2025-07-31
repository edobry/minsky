import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { promises as fs } from "fs";
import { MultiBackendTaskServiceImpl } from "./multi-backend-service";
import { MarkdownTaskBackend } from "./markdown-task-backend";
import { TASK_STATUS } from "./taskConstants";

describe("MultiBackendTaskService with Real MarkdownTaskBackend", () => {
  let service: MultiBackendTaskServiceImpl;
  let markdownBackend: MarkdownTaskBackend;
  let tempDir: string;

  beforeEach(async () => {
    // Create temporary workspace
    tempDir = join("/tmp", `test-multi-backend-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
    await fs.mkdir(join(tempDir, "process"), { recursive: true });

    // Initialize backends
    markdownBackend = new MarkdownTaskBackend(tempDir);

    // Initialize service with real backend
    service = new MultiBackendTaskServiceImpl();
    service.registerBackend(markdownBackend);
  });

  afterEach(async () => {
    // Clean up
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe("Backend Registration and Routing", () => {
    it("should register markdown backend correctly", () => {
      const backends = service.listBackends();
      expect(backends).toHaveLength(1);
      expect(backends[0]?.prefix).toBe("md");
    });

    it("should get backend by name", () => {
      const backend = service.getBackend("md");
      expect(backend).toBe(markdownBackend);
    });

    it("should return null for unknown backend", () => {
      const backend = service.getBackend("unknown");
      expect(backend).toBeNull();
    });
  });

  describe("Task Operations via MultiBackendTaskService", () => {
    it("should create tasks with qualified IDs", async () => {
      const task = await service.createTask(
        {
          title: "Multi-Backend Test Task",
          description: "Created via service",
        },
        "md"
      );

      expect(task.id).toMatch(/^md#\d+$/);
      expect(task.title).toBe("Multi-Backend Test Task");
      expect(task.description).toBe("Created via service");
    });

    it("should retrieve tasks via qualified IDs", async () => {
      const createdTask = await service.createTask(
        {
          title: "Retrieve Test",
        },
        "md"
      );

      const retrievedTask = await service.getTask(createdTask.id);
      expect(retrievedTask).not.toBeNull();
      expect(retrievedTask!.id).toBe(createdTask.id);
      expect(retrievedTask!.title).toBe("Retrieve Test");
    });

    it("should update tasks via service", async () => {
      const task = await service.createTask(
        {
          title: "Original Title",
          status: TASK_STATUS.TODO,
        },
        "md"
      );

      const updatedTask = await service.updateTask(task.id, {
        title: "Updated Title",
        status: TASK_STATUS.DONE,
      });

      expect(updatedTask.id).toBe(task.id);
      expect(updatedTask.title).toBe("Updated Title");
      expect(updatedTask.status).toBe(TASK_STATUS.DONE);
    });

    it("should delete tasks via service", async () => {
      const task = await service.createTask({ title: "To Delete" }, "md");

      await service.deleteTask(task.id);

      const deletedTask = await service.getTask(task.id);
      expect(deletedTask).toBeNull();
    });

    it("should list tasks from backend", async () => {
      await service.createTask({ title: "MD Task 1" }, "md");
      await service.createTask({ title: "MD Task 2" }, "md");

      const allTasks = await service.listAllTasks();
      expect(allTasks).toHaveLength(2);

      allTasks.forEach((task) => {
        expect(task.id).toMatch(/^md#\d+$/);
      });

      const mdTasks = await service.listAllTasks({ backend: "md" });
      expect(mdTasks).toHaveLength(2);

      const ghTasks = await service.listAllTasks({ backend: "gh" });
      expect(ghTasks).toHaveLength(0);
    });
  });

  describe("Legacy ID Compatibility", () => {
    it("should handle legacy task IDs through service", async () => {
      // Create a task
      const task = await service.createTask({ title: "Legacy Test" }, "md");
      expect(task.id).toBe("md#1");

      // Should retrieve with qualified ID
      const retrieved = await service.getTask("md#1");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe("md#1");
      expect(retrieved!.title).toBe("Legacy Test");
    });

    it("should route unqualified IDs to default backend", async () => {
      const task = await service.createTask({ title: "Default Backend Test" }, "md");

      // Should retrieve with unqualified ID
      const retrieved = await service.getTask("1");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe("md#1");
      expect(retrieved!.title).toBe("Default Backend Test");
    });
  });

  describe("Collision Detection", () => {
    it("should detect collisions between backends", async () => {
      // Create some tasks
      await service.createTask({ title: "Task 1" }, "md");
      await service.createTask({ title: "Task 2" }, "md");

      const collisionReport = await service.detectCollisions();
      expect(collisionReport).toBeDefined();
      expect(Array.isArray(collisionReport.collisions)).toBe(true);
      expect(typeof collisionReport.total).toBe("number");
      expect(collisionReport.summary).toBeDefined();
    });
  });

  describe("Search Operations", () => {
    it("should search tasks across backends", async () => {
      await service.createTask({ title: "Searchable Task", description: "Find me" }, "md");
      await service.createTask({ title: "Other Task", description: "Different content" }, "md");

      const results = await service.searchTasks("Searchable");
      expect(results).toHaveLength(1);
      expect(results[0]?.title).toBe("Searchable Task");
    });
  });
});
