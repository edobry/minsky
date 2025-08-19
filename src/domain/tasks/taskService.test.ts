import { describe, test, expect, mock, beforeEach } from "bun:test";
import { TaskService } from "./taskService";
import type {
  TaskBackend,
  Task,
  TaskListOptions,
  CreateTaskOptions,
  DeleteTaskOptions,
  BackendCapabilities,
  TaskMetadata,
} from "./types";

// Mock task data
let currentTasks: any[] = [
  {
    id: "md#001",
    title: "First task",
    description: "First description",
    status: "TODO",
    specPath: "path/to/spec1.md",
    backend: "markdown",
  },
  {
    id: "md#002",
    title: "Second task",
    description: "Second description",
    status: "IN-PROGRESS",
    specPath: "path/to/spec2.md",
    backend: "markdown",
  },
];

// Create mock backend with only the new clean interface
const mockBackend: TaskBackend = {
  name: "mock",

  // User-facing operations
  listTasks: mock((options?: TaskListOptions) => {
    let filtered = [...currentTasks];

    if (options?.status && options.status !== "all") {
      filtered = filtered.filter((task) => task.status === options.status);
    }
    if (options?.backend) {
      filtered = filtered.filter((task) => task.backend === options.backend);
    }

    return Promise.resolve(filtered);
  }),

  getTask: mock((id: string) => {
    const task = currentTasks.find((t) => t.id === id);
    return Promise.resolve(task || null);
  }),

  getTaskStatus: mock((id: string) => {
    const task = currentTasks.find((t) => t.id === id);
    return Promise.resolve(task?.status);
  }),

  setTaskStatus: mock((id: string, status: string) => {
    const task = currentTasks.find((t) => t.id === id);
    if (!task) {
      throw new Error(`Task ${id} not found`);
    }
    task.status = status;
    return Promise.resolve();
  }),

  createTaskFromTitleAndDescription: mock(
    (title: string, description: string, options?: CreateTaskOptions) => {
      const newTask = {
        id: "#test",
        title,
        description,
        status: "TODO",
        specPath: "path/to/new-spec.md",
        backend: "mock",
      };
      currentTasks.push(newTask);
      return Promise.resolve(newTask);
    }
  ),

  deleteTask: mock((id: string, options?: DeleteTaskOptions) => {
    const index = currentTasks.findIndex((t) => t.id === id);
    if (index === -1) {
      return Promise.resolve(false);
    }
    currentTasks.splice(index, 1);
    return Promise.resolve(true);
  }),

  getWorkspacePath: mock(() => "/mock/workspace"),

  getCapabilities: mock(
    (): BackendCapabilities => ({
      canCreate: true,
      canUpdate: true,
      canDelete: true,
      canList: true,
      supportsMetadata: true,
      supportsSearch: false,
    })
  ),

  // Optional metadata methods
  getTaskMetadata: mock((id: string) => {
    const task = currentTasks.find((t) => t.id === id);
    if (!task) return Promise.resolve(null);

    return Promise.resolve({
      id: task.id,
      title: task.title,
      spec: task.description,
      status: task.status,
      backend: task.backend,
      createdAt: undefined,
      updatedAt: undefined,
    });
  }),

  setTaskMetadata: mock((id: string, metadata: TaskMetadata) => {
    const task = currentTasks.find((t) => t.id === id);
    if (!task) {
      throw new Error(`Task ${id} not found`);
    }
    task.title = metadata.title;
    task.status = metadata.status;
    task.description = metadata.spec;
    return Promise.resolve();
  }),
};

describe("TaskService", () => {
  let taskService: TaskService;

  beforeEach(() => {
    // Reset mock state
    currentTasks = [
      {
        id: "md#001",
        title: "First task",
        description: "First description",
        status: "TODO",
        specPath: "path/to/spec1.md",
        backend: "markdown",
      },
      {
        id: "md#002",
        title: "Second task",
        description: "Second description",
        status: "IN-PROGRESS",
        specPath: "path/to/spec2.md",
        backend: "markdown",
      },
    ];

    // Create task service with mock backend
    taskService = new TaskService({
      workspacePath: "/mock/workspace",
      backend: "mock",
    });

    // Override with our mock backend
    (taskService as any).currentBackend = mockBackend;
    (taskService as any).backends = [mockBackend];
  });

  describe("listTasks", () => {
    test("should list tasks from backend", async () => {
      const tasks = await taskService.listTasks();

      expect(mockBackend.listTasks).toHaveBeenCalled();
      expect(tasks).toHaveLength(2);
      expect(tasks[0].id).toBe("md#001");
      expect(tasks[1].status).toBe("IN-PROGRESS");
    });

    test("should filter tasks by status if provided", async () => {
      const tasks = await taskService.listTasks({ status: "TODO" });

      expect(mockBackend.listTasks).toHaveBeenCalledWith({ status: "TODO" });
      expect(tasks).toHaveLength(1);
      expect(tasks[0].status).toBe("TODO");
    });

    test("should filter out DONE tasks by default", async () => {
      // Add a DONE task
      currentTasks.push({
        id: "md#003",
        title: "Done task",
        description: "Done description",
        status: "DONE",
        specPath: "path/to/spec3.md",
        backend: "markdown",
      });

      const tasks = await taskService.listTasks();

      // Should filter out DONE tasks by default
      expect(tasks).toHaveLength(2);
      expect(tasks.every((t) => t.status !== "DONE")).toBe(true);
    });
  });

  describe("getTask", () => {
    test("should find a task by ID", async () => {
      const task = await taskService.getTask("md#001");

      expect(mockBackend.getTask).toHaveBeenCalledWith("md#001");
      expect(task).not.toBeNull();
      expect(task?.id).toBe("md#001");
      expect(task?.title).toBe("First task");
    });

    test("should return null if task not found", async () => {
      const task = await taskService.getTask("md#999");

      expect(mockBackend.getTask).toHaveBeenCalledWith("md#999");
      expect(task).toBeNull();
    });
  });

  describe("getTaskStatus", () => {
    test("should get a task's status", async () => {
      const status = await taskService.getTaskStatus("md#001");

      expect(mockBackend.getTaskStatus).toHaveBeenCalledWith("md#001");
      expect(status).toBe("TODO");
    });

    test("should return undefined if task not found", async () => {
      const status = await taskService.getTaskStatus("md#999");

      expect(mockBackend.getTaskStatus).toHaveBeenCalledWith("md#999");
      expect(status).toBeUndefined();
    });
  });

  describe("setTaskStatus", () => {
    test("should update a task's status", async () => {
      await taskService.setTaskStatus("md#001", "DONE");

      expect(mockBackend.setTaskStatus).toHaveBeenCalledWith("md#001", "DONE");

      // Verify the status was actually updated in our mock
      const task = currentTasks.find((t) => t.id === "md#001");
      expect(task?.status).toBe("DONE");
    });

    test("should throw error if task not found", async () => {
      await expect(taskService.setTaskStatus("md#999", "DONE")).rejects.toThrow("not found");
      expect(mockBackend.setTaskStatus).toHaveBeenCalledWith("md#999", "DONE");
    });
  });

  describe("createTask", () => {
    test("should create a new task from title", async () => {
      const task = await taskService.createTask("New Task Title");

      expect(mockBackend.createTaskFromTitleAndDescription).toHaveBeenCalledWith(
        "New Task Title",
        "",
        undefined
      );
      expect(task.id).toBe("#test");
      expect(task.title).toBe("New Task Title");
      expect(task.status).toBe("TODO");
    });

    test("should create a new task with description", async () => {
      const task = await taskService.createTask("New Task", { description: "New description" });

      expect(mockBackend.createTaskFromTitleAndDescription).toHaveBeenCalledWith(
        "New Task",
        "New description",
        { description: "New description" }
      );
      expect(task.title).toBe("New Task");
    });
  });

  describe("deleteTask", () => {
    test("should delete a task", async () => {
      const result = await taskService.deleteTask("md#001");

      expect(mockBackend.deleteTask).toHaveBeenCalledWith("md#001", undefined);
      expect(result).toBe(true);
    });

    test("should return false if task not found", async () => {
      const result = await taskService.deleteTask("md#999");

      expect(mockBackend.deleteTask).toHaveBeenCalledWith("md#999", undefined);
      expect(result).toBe(false);
    });
  });

  describe("updateTask", () => {
    test("should update task status", async () => {
      const task = await taskService.updateTask("md#001", { status: "DONE" });

      expect(mockBackend.setTaskStatus).toHaveBeenCalledWith("md#001", "DONE");
      expect(task.status).toBe("DONE");
    });

    test("should update task metadata", async () => {
      const task = await taskService.updateTask("md#001", { title: "Updated Title" });

      expect(mockBackend.setTaskMetadata).toHaveBeenCalled();
      expect(task.title).toBe("Updated Title");
    });
  });

  describe("getTaskSpecContent", () => {
    test("should get spec content for db backend", async () => {
      // Mock db backend
      (taskService as any).currentBackend = {
        ...mockBackend,
        name: "db",
        getTaskMetadata: mock(() =>
          Promise.resolve({
            id: "md#001",
            title: "Test",
            spec: "# Test Spec Content",
            status: "TODO",
            backend: "db",
          })
        ),
      };

      const result = await taskService.getTaskSpecContent("md#001");

      expect(result.content).toBe("# Test Spec Content");
      expect(result.specPath).toBe("db:md#001");
    });

    test("should throw error if task not found", async () => {
      await expect(taskService.getTaskSpecContent("md#999")).rejects.toThrow("Task not found");
    });
  });

  describe("backend handling", () => {
    test("should throw error for non-existent backend", () => {
      expect(() => {
        new TaskService({
          workspacePath: "/test/workspace",
          backend: "non-existent" as any,
        });
      }).toThrow("Backend not found: non-existent");
    });

    test("should use markdown backend by default", () => {
      const service = new TaskService({
        workspacePath: "/test/workspace",
      });
      expect((service as any).currentBackend.name).toBe("markdown");
    });
  });
});
