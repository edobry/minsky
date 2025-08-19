import { describe, test, expect } from "bun:test";
import type { TaskData } from "../../types/tasks/taskData";
import {
  getTaskById,
  getNextTaskId,
  setTaskStatus,
  addTask,
  filterTasks,
  isValidTaskStatus,
} from "./taskFunctions";

describe("Task Functions", () => {
  const sampleTasks: TaskData[] = [
    {
      id: "#001",
      title: "First task",
      description: "First description",
      status: "TODO",
      specPath: "path/to/spec1.md",
    },
    {
      id: "#002",
      title: "Second task",
      description: "Second description",
      status: "IN-PROGRESS",
      specPath: "path/to/spec2.md",
    },
    {
      id: "#003",
      title: "Third task",
      description: "Third description",
      status: "DONE",
      specPath: "path/to/spec3.md",
    },
  ];

  describe("getTaskById", () => {
    test("should find task by ID", () => {
      const task = getTaskById(sampleTasks, "#002");
      expect(task).toBeDefined();
      expect(task?.id).toBe("#002");
      expect(task?.title).toBe("Second task");
    });

    test("should return undefined if task not found", () => {
      const task = getTaskById(sampleTasks, "#999");
      expect(task).toBeUndefined();
    });

    test("should handle empty array", () => {
      const task = getTaskById([], "#001");
      expect(task).toBeUndefined();
    });
  });

  describe("getNextTaskId", () => {
    test("should return #001 for empty array", () => {
      const nextId = getNextTaskId([]);
      expect(nextId).toBe("#001");
    });

    test("should return next sequential ID", () => {
      const nextId = getNextTaskId(sampleTasks);
      expect(nextId).toBe("#004");
    });

    test("should handle non-sequential IDs", () => {
      const tasks = [
        { id: "#001", title: "Task 1", description: "", status: "TODO", specPath: "" },
        { id: "#005", title: "Task 5", description: "", status: "TODO", specPath: "" },
        { id: "#003", title: "Task 3", description: "", status: "TODO", specPath: "" },
      ];
      const nextId = getNextTaskId(tasks);
      expect(nextId).toBe("#006");
    });
  });

  describe("setTaskStatus", () => {
    test("should update task status", () => {
      const tasks = [...sampleTasks];
      const result = setTaskStatus(tasks, "#002", "DONE");

      expect(result).toBe(true);
      expect(tasks[1].status).toBe("DONE");
    });

    test("should return false if task not found", () => {
      const tasks = [...sampleTasks];
      const result = setTaskStatus(tasks, "#999", "DONE");

      expect(result).toBe(false);
      // Original tasks should be unchanged
      expect(tasks).toEqual(sampleTasks);
    });
  });

  describe("addTask", () => {
    test("should add new task to array", () => {
      const tasks = [...sampleTasks];
      const newTask: TaskData = {
        id: "#004",
        title: "New task",
        description: "New description",
        status: "TODO",
        specPath: "path/to/spec4.md",
      };

      addTask(tasks, newTask);

      expect(tasks).toHaveLength(4);
      expect(tasks[3]).toEqual(newTask);
    });

    test("should handle adding to empty array", () => {
      const tasks: TaskData[] = [];
      const newTask: TaskData = {
        id: "#001",
        title: "First task",
        description: "Description",
        status: "TODO",
        specPath: "path/to/spec.md",
      };

      addTask(tasks, newTask);

      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toEqual(newTask);
    });
  });

  describe("filterTasks", () => {
    test("should filter by status", () => {
      const filtered = filterTasks(sampleTasks, { status: "TODO" });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].status).toBe("TODO");
    });

    test("should filter by multiple statuses", () => {
      const filtered = filterTasks(sampleTasks, { status: ["TODO", "IN-PROGRESS"] });
      expect(filtered).toHaveLength(2);
      expect(filtered.every((t) => ["TODO", "IN-PROGRESS"].includes(t.status))).toBe(true);
    });

    test("should filter by title search", () => {
      const filtered = filterTasks(sampleTasks, { search: "First" });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].title).toBe("First task");
    });

    test("should filter by description search", () => {
      const filtered = filterTasks(sampleTasks, { search: "Second description" });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].description).toBe("Second description");
    });

    test("should return all tasks when no filter provided", () => {
      const filtered = filterTasks(sampleTasks);
      expect(filtered).toEqual(sampleTasks);
    });

    test("should return all tasks when empty filter provided", () => {
      const filtered = filterTasks(sampleTasks, {});
      expect(filtered).toEqual(sampleTasks);
    });

    test("should handle case-insensitive search", () => {
      const filtered = filterTasks(sampleTasks, { search: "FIRST" });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].title).toBe("First task");
    });

    test("should combine multiple filters", () => {
      const filtered = filterTasks(sampleTasks, {
        status: ["TODO", "IN-PROGRESS"],
        search: "Second",
      });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].title).toBe("Second task");
    });
  });

  describe("isValidTaskStatus", () => {
    test("should validate correct status values", () => {
      expect(isValidTaskStatus("TODO")).toBe(true);
      expect(isValidTaskStatus("IN-PROGRESS")).toBe(true);
      expect(isValidTaskStatus("IN-REVIEW")).toBe(true);
      expect(isValidTaskStatus("DONE")).toBe(true);
      expect(isValidTaskStatus("BLOCKED")).toBe(true);
      expect(isValidTaskStatus("CLOSED")).toBe(true);
    });

    test("should reject invalid status values", () => {
      expect(isValidTaskStatus("invalid")).toBe(false);
      expect(isValidTaskStatus("todo")).toBe(false);
      expect(isValidTaskStatus("")).toBe(false);
      expect(isValidTaskStatus("UNKNOWN")).toBe(false);
    });

    test("should handle null and undefined", () => {
      expect(isValidTaskStatus(null as any)).toBe(false);
      expect(isValidTaskStatus(undefined as any)).toBe(false);
    });
  });
});

// ... keep any remaining code ...
