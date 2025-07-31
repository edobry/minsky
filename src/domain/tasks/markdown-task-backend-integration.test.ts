import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { promises as fs } from "fs";
import { MarkdownTaskBackend } from "./markdown-task-backend";
import { TASK_STATUS } from "./taskConstants";

describe("MarkdownTaskBackend Multi-Backend Integration", () => {
  let backend: MarkdownTaskBackend;
  let tempDir: string;
  let tasksFile: string;

  beforeEach(async () => {
    // Create temporary workspace
    tempDir = join("/tmp", `test-workspace-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
    await fs.mkdir(join(tempDir, "process"), { recursive: true });
    
    tasksFile = join(tempDir, "process", "tasks.md");
    
    // Initialize backend
    backend = new MarkdownTaskBackend(tempDir);
  });

  afterEach(async () => {
    // Clean up
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe("Multi-Backend Interface Compliance", () => {
    it("should have correct prefix property", () => {
      expect(backend.prefix).toBe("md");
      expect(backend.name).toBe("markdown");
    });

    it("should implement all required multi-backend methods", () => {
      expect(typeof backend.createTask).toBe("function");
      expect(typeof backend.getTask).toBe("function");
      expect(typeof backend.updateTask).toBe("function");
      expect(typeof backend.deleteTask).toBe("function");
      expect(typeof backend.listTasks).toBe("function");
      expect(typeof backend.getTaskSpecPath).toBe("function");
      expect(typeof backend.supportsFeature).toBe("function");
      expect(typeof backend.exportTask).toBe("function");
      expect(typeof backend.importTask).toBe("function");
      expect(typeof backend.validateLocalId).toBe("function");
    });

    it("should support expected features", () => {
      expect(backend.supportsFeature("create")).toBe(true);
      expect(backend.supportsFeature("read")).toBe(true);
      expect(backend.supportsFeature("update")).toBe(true);
      expect(backend.supportsFeature("delete")).toBe(true);
      expect(backend.supportsFeature("list")).toBe(true);
      expect(backend.supportsFeature("export")).toBe(true);
      expect(backend.supportsFeature("import")).toBe(true);
      expect(backend.supportsFeature("unsupported")).toBe(false);
    });
  });

  describe("Qualified Task ID Management", () => {
    it("should create tasks with qualified IDs (md#123)", async () => {
      const task = await backend.createTask({
        title: "Test Task",
        description: "Test description",
        status: TASK_STATUS.TODO,
      });

      expect(task.id).toMatch(/^md#\d+$/);
      expect(task.id).toBe("md#1"); // First task should be md#1
      expect(task.title).toBe("Test Task");
      expect(task.description).toBe("Test description");
      expect(task.status).toBe(TASK_STATUS.TODO);
    });

    it("should retrieve tasks by qualified ID", async () => {
      const createdTask = await backend.createTask({
        title: "Qualified ID Test",
        description: "Testing qualified ID retrieval",
      });

      const retrievedTask = await backend.getTask(createdTask.id);
      expect(retrievedTask).not.toBeNull();
      expect(retrievedTask!.id).toBe(createdTask.id);
      expect(retrievedTask!.title).toBe("Qualified ID Test");
    });

    it("should retrieve tasks by local ID for backward compatibility", async () => {
      const createdTask = await backend.createTask({
        title: "Local ID Test",
        description: "Testing local ID retrieval",
      });

      // Should work with local ID (123)
      const localId = createdTask.id.replace("md#", "");
      const retrievedTask = await backend.getTask(localId);
      expect(retrievedTask).not.toBeNull();
      expect(retrievedTask!.id).toBe(createdTask.id); // Should return qualified ID
    });

    it("should list tasks with qualified IDs", async () => {
      await backend.createTask({ title: "Task 1" });
      await backend.createTask({ title: "Task 2" });
      await backend.createTask({ title: "Task 3" });

      const tasks = await backend.listTasks();
      expect(tasks).toHaveLength(3);
      
      tasks.forEach(task => {
        expect(task.id).toMatch(/^md#\d+$/);
      });

      expect(tasks.map(t => t.title)).toEqual(["Task 1", "Task 2", "Task 3"]);
    });
  });

  describe("Legacy Format Migration", () => {
    it("should handle existing legacy tasks with #123 format", async () => {
      // Create a legacy format tasks.md file
      const legacyContent = `- [ ] #001 Legacy Task One
- [x] #002 Legacy Task Two  
- [ ] #003 Legacy Task Three`;

      await fs.writeFile(tasksFile, legacyContent, "utf-8");

      const tasks = await backend.listTasks();
      expect(tasks).toHaveLength(3);

      // Should convert to qualified IDs
      expect(tasks[0]).toBeDefined();
      expect(tasks[0]!.id).toBe("md#001");
      expect(tasks[0]!.title).toBe("Legacy Task One");
      expect(tasks[0]!.status).toBe(TASK_STATUS.TODO);

      expect(tasks[1]).toBeDefined();
      expect(tasks[1]!.id).toBe("md#002");
      expect(tasks[1]!.title).toBe("Legacy Task Two");
      expect(tasks[1]!.status).toBe(TASK_STATUS.DONE);

      expect(tasks[2]).toBeDefined();
      expect(tasks[2]!.id).toBe("md#003");
      expect(tasks[2]!.title).toBe("Legacy Task Three");
      expect(tasks[2]!.status).toBe(TASK_STATUS.TODO);
    });

    it("should retrieve legacy tasks by various ID formats", async () => {
      const legacyContent = `- [ ] #042 Legacy Task`;
      await fs.writeFile(tasksFile, legacyContent, "utf-8");

      // Should work with all these formats
      const formats = ["md#042", "042", "#042", "md#42", "42"];
      
      for (const format of formats) {
        const task = await backend.getTask(format);
        expect(task).not.toBeNull();
        expect(task!.id).toBe("md#042");
        expect(task!.title).toBe("Legacy Task");
      }
    });
  });

  describe("Task Operations", () => {
    it("should update tasks correctly", async () => {
      const task = await backend.createTask({
        title: "Original Title",
        description: "Original description",
        status: TASK_STATUS.TODO,
      });

      const updatedTask = await backend.updateTask(task.id, {
        title: "Updated Title",
        status: TASK_STATUS.DONE,
      });

      expect(updatedTask.id).toBe(task.id);
      expect(updatedTask.title).toBe("Updated Title");
      expect(updatedTask.description).toBe("Original description"); // Should be trimmed
      expect(updatedTask.status).toBe(TASK_STATUS.DONE);
    });

    it("should delete tasks correctly", async () => {
      const task = await backend.createTask({ title: "To Delete" });
      
      // Verify task exists
      const beforeDelete = await backend.getTask(task.id);
      expect(beforeDelete).not.toBeNull();

      // Delete task
      await backend.deleteTask(task.id);

      // Verify task is gone
      const afterDelete = await backend.getTask(task.id);
      expect(afterDelete).toBeNull();
    });

    it("should filter tasks by status", async () => {
      await backend.createTask({ title: "Todo Task", status: TASK_STATUS.TODO });
      await backend.createTask({ title: "Done Task", status: TASK_STATUS.DONE });
      await backend.createTask({ title: "Another Todo Task", status: TASK_STATUS.TODO });

      const allTasks = await backend.listTasks();
      expect(allTasks).toHaveLength(3);

      const todoTasks = await backend.listTasks({ status: TASK_STATUS.TODO });
      const doneTasks = await backend.listTasks({ status: TASK_STATUS.DONE });
      const inProgressTasks = await backend.listTasks({ status: TASK_STATUS.IN_PROGRESS });

      expect(todoTasks).toHaveLength(2);
      expect(todoTasks[0]).toBeDefined();
      expect(todoTasks[0]!.title).toBe("Todo Task");
      expect(todoTasks[1]).toBeDefined();
      expect(todoTasks[1]!.title).toBe("Another Todo Task");

      expect(doneTasks).toHaveLength(1);
      expect(doneTasks[0]).toBeDefined();
      expect(doneTasks[0]!.title).toBe("Done Task");

      // IN-PROGRESS not supported in markdown format
      expect(inProgressTasks).toHaveLength(0);
    });

    it("should filter tasks by backend", async () => {
      await backend.createTask({ title: "Markdown Task" });

      const mdTasks = await backend.listTasks({ backend: "md" });
      const ghTasks = await backend.listTasks({ backend: "gh" });

      expect(mdTasks).toHaveLength(1);
      expect(mdTasks[0]).toBeDefined();
      expect(mdTasks[0]!.title).toBe("Markdown Task");

      expect(ghTasks).toHaveLength(0);
    });
  });

  describe("Export/Import Operations", () => {
    it("should export tasks correctly", async () => {
      const task = await backend.createTask({
        title: "Export Test Task",
        description: "Testing export functionality",
        status: TASK_STATUS.TODO,
      });

      const exportData = await backend.exportTask(task.id);

      expect(exportData.backend).toBe("md");
      expect(exportData.spec.title).toBe("Export Test Task");
      expect(exportData.spec.description).toBe("Testing export functionality"); // Should be trimmed
      expect(exportData.spec.status).toBe(TASK_STATUS.TODO);
      expect(exportData.metadata.originalId).toBe(task.id);
      expect(exportData.exportedAt).toBeDefined();
    });

    it("should import tasks correctly", async () => {
      const importData = {
        spec: {
          title: "Imported Task",
          description: "This task was imported",
          status: TASK_STATUS.IN_PROGRESS,
        },
        metadata: { originalId: "gh#456" },
        backend: "gh",
        exportedAt: new Date().toISOString(),
      };

      const importedTask = await backend.importTask(importData);

      expect(importedTask.id).toMatch(/^md#\d+$/);
      expect(importedTask.title).toBe("Imported Task");
      expect(importedTask.description).toBe("This task was imported");
      expect(importedTask.status).toBe(TASK_STATUS.IN_PROGRESS);
    });
  });

  describe("Local ID Validation", () => {
    it("should validate local IDs correctly", () => {
      expect(backend.validateLocalId("123")).toBe(true);
      expect(backend.validateLocalId("1")).toBe(true);
      expect(backend.validateLocalId("999")).toBe(true);

      expect(backend.validateLocalId("0")).toBe(false); // Zero not allowed
      expect(backend.validateLocalId("-1")).toBe(false); // Negative not allowed
      expect(backend.validateLocalId("abc")).toBe(false); // Non-numeric
      expect(backend.validateLocalId("12.5")).toBe(false); // Decimal
      expect(backend.validateLocalId("")).toBe(false); // Empty
      expect(backend.validateLocalId("1a")).toBe(false); // Mixed
    });
  });

  describe("File System Integration", () => {
    it("should generate correct task spec paths", () => {
      const path1 = backend.getTaskSpecPath("md#123");
      const path2 = backend.getTaskSpecPath("456"); // Local ID

      expect(path1).toBe(join(tempDir, "process", "tasks", "123.md"));
      expect(path2).toBe(join(tempDir, "process", "tasks", "456.md"));
    });

    it("should persist tasks to markdown format", async () => {
      await backend.createTask({ title: "Persisted Task", status: TASK_STATUS.TODO });
      await backend.createTask({ title: "Done Task", status: TASK_STATUS.DONE });

      // Read the raw file content
      const content = await fs.readFile(tasksFile, "utf-8");
      
      expect(content).toContain("- [ ] #1 Persisted Task");
      expect(content).toContain("- [x] #2 Done Task");
    });
  });
}); 
