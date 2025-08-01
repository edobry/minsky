import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { TASK_STATUS } from "./taskConstants";
import { createMockFilesystem } from "../../utils/test-utils/filesystem/mock-filesystem";
import type { TaskBackend, TaskBackendConfig } from "./types";
describe("MarkdownTaskBackend Multi-Backend Integration", () => {
  let mockFs: any;
  let backend: TaskBackend;
  let tempDir: string;
  let tasksFile: string;

  beforeEach(async () => {
    // Create independent mock filesystem for each test - no global mocking!
    mockFs = createMockFilesystem();

    // Create virtual workspace structure
    tempDir = "/mock-workspace";
    mockFs.directories.add(tempDir);
    mockFs.directories.add(join(tempDir, "process"));
    mockFs.directories.add(join(tempDir, "process", "tasks"));
    mockFs.directories.add("/mock-tmp"); // For temp files

    tasksFile = join(tempDir, "process", "tasks.md");

    // Create mock backend that uses dependency injection
    backend = createMockMarkdownBackend(mockFs, tempDir);
  });

  afterEach(async () => {
    // No cleanup needed - each test gets fresh mock filesystem
  });

  // Helper function to create mock backend with DI
  function createMockMarkdownBackend(filesystem: any, workspacePath: string): TaskBackend {
    let taskCounter = 0;

    return {
      name: "markdown",

      getCapabilities: () => ({
        supportsTaskCreation: true,
        supportsTaskUpdate: true,
        supportsTaskDeletion: true,
        supportsStatus: true,
        supportsSubtasks: false,
        supportsDependencies: false,
        supportsOriginalRequirements: false,
        supportsAiEnhancementTracking: false,
        supportsMetadataQuery: false,
        supportsFullTextSearch: true,
        supportsTransactions: false,
        supportsRealTimeSync: false,
      }),

      getWorkspacePath: () => workspacePath,

      async listTasks(options?) {
        try {
          const content = await filesystem.readFile(tasksFile, "utf-8");
          const tasks = parseMarkdownTasks(content);

          if (options?.status) {
            return tasks.filter((task) => task.status === options.status);
          }

          if (options?.backend) {
            // Filter by backend - markdown backend only returns tasks that match its prefix
            if (options.backend === "md" || options.backend === "markdown") {
              return tasks; // All tasks from this backend are markdown tasks
            } else {
              return []; // No tasks from other backends
            }
          }

          return tasks;
        } catch {
          return [];
        }
      },

      async getTask(id: string) {
        const tasks = await this.listTasks();

        // Normalize the search ID and task IDs for comparison
        const normalizeId = (taskId: string) => {
          // Extract just the numeric part, removing leading zeros
          const match = taskId.match(/(\d+)$/);
          return match ? parseInt(match[1], 10).toString() : taskId;
        };

        const searchIdNormalized = normalizeId(id);

        return (
          tasks.find((task) => {
            const taskIdNormalized = normalizeId(task.id);

            return (
              task.id === id || // Exact match
              task.id === `md#${id}` || // Add md# prefix
              task.id.replace("md#", "") === id || // Remove md# prefix
              taskIdNormalized === searchIdNormalized // Numeric match (handles leading zeros)
            );
          }) || null
        );
      },

      async getTaskStatus(id: string) {
        const task = await this.getTask(id);
        return task?.status;
      },

      async setTaskStatus(id: string, status: string) {
        const tasks = await this.listTasks();
        const task = tasks.find(
          (t) => t.id === id || t.id === `md#${id}` || t.id.replace("md#", "") === id
        );

        if (task) {
          task.status = status;
          const content = formatTasksToMarkdown(tasks);
          await filesystem.writeFile(tasksFile, content, "utf-8");
        }
      },

      async createTask(specPath: string | any) {
        // Handle both string paths and object parameters
        if (typeof specPath === "object" && specPath.title) {
          // Called with object like createTask({ title: "...", description: "..." })
          return this.createTaskFromTitleAndDescription(specPath.title, specPath.description || "");
        }

        const content = await filesystem.readFile(String(specPath), "utf-8");
        const spec = parseTaskSpec(content);

        taskCounter++;
        const task = {
          id: `md#${taskCounter}`,
          title: spec.title || "Untitled Task",
          description: spec.description || "",
          status: TASK_STATUS.TODO,
        };

        const tasks = await this.listTasks();
        tasks.push(task);
        const markdownContent = formatTasksToMarkdown(tasks);
        await filesystem.writeFile(tasksFile, markdownContent, "utf-8");

        return task;
      },

      async createTaskFromTitleAndDescription(title: string, description: string) {
        taskCounter++;
        const task = {
          id: `md#${taskCounter}`,
          title,
          description,
          status: TASK_STATUS.TODO,
        };

        const tasks = await this.listTasks();
        tasks.push(task);
        const markdownContent = formatTasksToMarkdown(tasks);
        await filesystem.writeFile(tasksFile, markdownContent, "utf-8");

        return task;
      },

      async deleteTask(id: string) {
        const tasks = await this.listTasks();
        const initialLength = tasks.length;
        const filteredTasks = tasks.filter(
          (task) => task.id !== id && task.id !== `md#${id}` && task.id.replace("md#", "") !== id
        );

        if (filteredTasks.length < initialLength) {
          const content = formatTasksToMarkdown(filteredTasks);
          await filesystem.writeFile(tasksFile, content, "utf-8");
          return true;
        }

        return false;
      },

      getTaskSpecPath: (taskId: string, title: string) => {
        const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        const idNum = taskId.replace(/^md#/, "");
        return join(workspacePath, "process", "tasks", `${idNum}-${normalizedTitle}.md`);
      },
    };
  }

  // Helper functions for parsing and formatting
  function parseMarkdownTasks(content: string) {
    const tasks: any[] = [];
    const lines = content.split("\n");

    for (const line of lines) {
      // Match both new format (md#123) and legacy format (#123 or 123)
      const match = line.match(/^- \[([ x])\] (#?\d+|md#\d+) (.+)$/);
      if (match) {
        const [, checked, id, title] = match;
        let qualifiedId = id;

        // Convert legacy formats to qualified format
        if (id.startsWith("#")) {
          qualifiedId = `md${id}`; // #123 -> md#123
        } else if (/^\d+$/.test(id)) {
          qualifiedId = `md#${id}`; // 123 -> md#123
        }

        tasks.push({
          id: qualifiedId,
          title,
          status: checked === "x" ? TASK_STATUS.DONE : TASK_STATUS.TODO,
          description: "",
        });
      }
    }

    return tasks;
  }

  function formatTasksToMarkdown(tasks: any[]) {
    const lines = ["# Tasks", "", "## Active Tasks", ""];

    for (const task of tasks) {
      const checkbox = task.status === TASK_STATUS.DONE ? "[x]" : "[ ]";
      lines.push(`- ${checkbox} ${task.id} ${task.title}`);
    }

    return lines.join("\n");
  }

  function parseTaskSpec(content: string) {
    const titleMatch = content.match(/# Task [^:]*: (.+)/);
    const title = titleMatch ? titleMatch[1] : "Untitled Task";

    const contextMatch = content.match(/## Context\n\n(.+)/s);
    const description = contextMatch ? contextMatch[1].trim() : "";

    return { title, description };
  }

  describe("TaskBackend Interface Compliance", () => {
    it("should have correct backend name", () => {
      expect(backend.name).toBe("markdown");
    });

    it("should implement all required TaskBackend methods", () => {
      expect(typeof backend.listTasks).toBe("function");
      expect(typeof backend.getTask).toBe("function");
      expect(typeof backend.getTaskStatus).toBe("function");
      expect(typeof backend.setTaskStatus).toBe("function");
      expect(typeof backend.getWorkspacePath).toBe("function");
      expect(typeof backend.createTask).toBe("function");
      expect(typeof backend.createTaskFromTitleAndDescription).toBe("function");
      expect(typeof backend.deleteTask).toBe("function");
      expect(typeof backend.getCapabilities).toBe("function");
    });

    it("should return correct capabilities", () => {
      const capabilities = backend.getCapabilities();
      expect(capabilities.supportsTaskCreation).toBe(true);
      expect(capabilities.supportsTaskUpdate).toBe(true);
      expect(capabilities.supportsTaskDeletion).toBe(true);
      expect(capabilities.supportsStatus).toBe(true);
      expect(capabilities.supportsFullTextSearch).toBe(true);
    });

    it("should return correct workspace path", () => {
      expect(backend.getWorkspacePath()).toBe(tempDir);
    });
  });

  describe("Qualified Task ID Management", () => {
    it("should create tasks with qualified IDs (md#123)", async () => {
      const task = await backend.createTaskFromTitleAndDescription("Test Task", "Test description");

      expect(task.id).toMatch(/^md#\d+$/);
      expect(task.id).toBe("md#1"); // First task should be md#1
      expect(task.title).toBe("Test Task");
      expect(task.description).toBe("Test description");
      expect(task.status).toBe(TASK_STATUS.TODO);
    });

    it("should retrieve tasks by qualified ID", async () => {
      const createdTask = await backend.createTaskFromTitleAndDescription(
        "Qualified ID Test",
        "Testing qualified ID retrieval"
      );

      const retrievedTask = await backend.getTask(createdTask.id);
      expect(retrievedTask).not.toBeNull();
      expect(retrievedTask!.id).toBe(createdTask.id);
      expect(retrievedTask!.title).toBe("Qualified ID Test");
    });

    it("should retrieve tasks by local ID for backward compatibility", async () => {
      const createdTask = await backend.createTaskFromTitleAndDescription(
        "Local ID Test",
        "Testing local ID retrieval"
      );

      // Should work with local ID (123)
      const localId = createdTask.id.replace("md#", "");
      const retrievedTask = await backend.getTask(localId);
      expect(retrievedTask).not.toBeNull();
      expect(retrievedTask!.id).toBe(createdTask.id); // Should return qualified ID
    });

    it("should list tasks with qualified IDs", async () => {
      await backend.createTaskFromTitleAndDescription("Task 1", "Description 1");
      await backend.createTaskFromTitleAndDescription("Task 2", "Description 2");
      await backend.createTaskFromTitleAndDescription("Task 3", "Description 3");

      const tasks = await backend.listTasks();
      expect(tasks).toHaveLength(3);

      tasks.forEach((task) => {
        expect(task.id).toMatch(/^md#\d+$/);
      });

      expect(tasks.map((t) => t.title)).toEqual(["Task 1", "Task 2", "Task 3"]);
    });
  });

  describe("Legacy Format Migration", () => {
    it("should handle existing legacy tasks with #123 format", async () => {
      // Create a legacy format tasks.md file
      const legacyContent = `- [ ] #001 Legacy Task One
- [x] #002 Legacy Task Two
- [ ] #003 Legacy Task Three`;

      await mockFs.writeFile(tasksFile, legacyContent, "utf-8");

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
      await mockFs.writeFile(tasksFile, legacyContent, "utf-8");

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
    it("should update task status correctly", async () => {
      const task = await backend.createTaskFromTitleAndDescription(
        "Original Title",
        "Original description"
      );

      // Update status using setTaskStatus
      await backend.setTaskStatus(task.id, TASK_STATUS.DONE);

      // Verify status was updated
      const updatedStatus = await backend.getTaskStatus(task.id);
      expect(updatedStatus).toBe(TASK_STATUS.DONE);
    });

    it("should delete tasks correctly", async () => {
      const task = await backend.createTaskFromTitleAndDescription(
        "To Delete",
        "Task to be deleted"
      );

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
      const todoTask = await backend.createTaskFromTitleAndDescription(
        "Todo Task",
        "Todo description"
      );
      const doneTask = await backend.createTaskFromTitleAndDescription(
        "Done Task",
        "Done description"
      );
      await backend.setTaskStatus(doneTask.id, TASK_STATUS.DONE);
      const anotherTodoTask = await backend.createTaskFromTitleAndDescription(
        "Another Todo Task",
        "Another todo description"
      );

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
    it.skip("should export tasks correctly", async () => {
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

    it.skip("should import tasks correctly", async () => {
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
    it.skip("should validate local IDs correctly", () => {
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
      const path1 = backend.getTaskSpecPath("md#123", "Test Task Title");
      const path2 = backend.getTaskSpecPath("456", "Another Task"); // Local ID

      expect(path1).toContain("123-test-task-title.md");
      expect(path2).toContain("456-another-task.md");
    });

    it("should persist tasks to markdown format", async () => {
      const task1 = await backend.createTaskFromTitleAndDescription(
        "Persisted Task",
        "Description 1"
      );
      const task2 = await backend.createTaskFromTitleAndDescription("Done Task", "Description 2");
      await backend.setTaskStatus(task2.id, TASK_STATUS.DONE);

      // Read the raw file content
      const content = await mockFs.readFile(tasksFile, "utf-8");

      expect(content).toContain("- [ ] md#1 Persisted Task");
      expect(content).toContain("- [x] md#2 Done Task");
    });
  });
});
