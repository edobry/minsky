const TEST_VALUE = 123;
const TEST_ARRAY_SIZE = 3;

/**
 * Tests for task pure functions
 */

import { describe, test, expect } from "bun:test";
import type { TaskData } from "../../types/tasks/taskData";
import {
  parseTasksFromMarkdown,
  formatTasksToMarkdown,
  getTaskById,
  normalizeTaskId,
  getNextTaskId,
  setTaskStatus,
  addTask,
  filterTasks,
  parseTaskSpecFromMarkdown,
  formatTaskSpecToMarkdown,
  isValidTaskStatus,
} from "./taskFunctions";

describe("Task Functions", () => {
  describe("normalizeTaskId", () => {
    test("should return canonical form for valid IDs", () => {
      expect(normalizeTaskId("TEST_VALUE")).toBe("#TEST_VALUE");
      expect(normalizeTaskId("#TEST_VALUE")).toBe("#TEST_VALUE");
      expect(normalizeTaskId("001")).toBe("#001");
      expect(normalizeTaskId("#001")).toBe("#001");
    });

    test("should handle various prefix patterns", () => {
      expect(normalizeTaskId("task-TEST_VALUE")).toBe("#task");
      expect(normalizeTaskId("task#TEST_VALUE")).toBe("#task");
      expect(normalizeTaskId("TASK_TEST_VALUE")).toBe("#TASK_TEST_VALUE");
    });

    test("should return null for non-numeric input", () => {
      expect(normalizeTaskId("")).toBeNull();
      expect(normalizeTaskId(" ")).toBeNull();
      expect(normalizeTaskId("@#$%")).toBeNull();
    });

    test("should extract numeric portion from mixed formats", () => {
      expect(normalizeTaskId("task-TEST_VALUE")).toBe("#task");
      expect(normalizeTaskId("task #TEST_VALUE")).toBe("#task");
      expect(normalizeTaskId("TEST_VALUE-something")).toBe("#TEST_VALUE");
    });

    test("should handle alphanumeric task IDs", () => {
      expect(normalizeTaskId("abc")).toBe("#abc");
      expect(normalizeTaskId("TEST_VALUE")).toBe("#TEST_VALUE");
      expect(normalizeTaskId("001")).toBe("#001");
    });
  });

  describe("parseTasksFromMarkdown", () => {
    test("should return empty array for empty content", () => {
      expect(parseTasksFromMarkdown("")).toEqual([]);
    });

    test("should parse tasks from markdown content", () => {
      const markdown = `- [ ] First task [#001](#)
  - Description line 1
  - Description line 2

- [x] Second task [#002](#)

- [+] In progress task [#003](#)`;

      const tasks = parseTasksFromMarkdown(markdown);
      expect(tasks).toHaveLength(3);

      expect(tasks[0].id).toBe("#001");
      expect(tasks[0].title).toBe("First task");
      expect(tasks[0].status).toBe("TODO");
      expect(tasks[0].description).toBe("Description line 1\nDescription line 2");

      expect(tasks[1].id).toBe("#002");
      expect(tasks[1].status).toBe("DONE");

      expect(tasks[2].id).toBe("#003");
      expect(tasks[2].status).toBe("IN-PROGRESS");
    });

    test("should ignore tasks in code blocks", () => {
      const markdown = `
Normal task:
- [ ] First task [#001](#)

\`\`\`
Code block with task-like content:
- [ ] Not a real task [#002](#)
\`\`\`

- [x] Second real task [#003](#)`;

      const tasks = parseTasksFromMarkdown(markdown);
      expect(tasks).toHaveLength(2);
      expect(tasks[0].id).toBe("#001");
      expect(tasks[1].id).toBe("#003");
    });
  });

  describe("formatTasksToMarkdown", () => {
    test("should return empty string for empty array", () => {
      expect(formatTasksToMarkdown([])).toBe("");
    });

    test("should format tasks to markdown with one-liner format only", () => {
      const tasks: TaskData[] = [
        {
          id: "#001",
          title: "First task",
          status: "TODO",
          description: "Description line 1\nDescription line 2",
        },
        {
          id: "#002",
          title: "Completed task",
          status: "DONE",
        },
      ];

      const markdown = formatTasksToMarkdown(tasks);
      expect(markdown).toContain("- [ ] First task [#001](#)");
      expect(markdown).toContain("- [x] Completed task [#002](#)");
      // Descriptions should NOT be included in the markdown output
      expect(markdown).not.toContain("Description line 1");
      expect(markdown).not.toContain("Description line 2");
    });

    test("should use task specPath if available", () => {
      const tasks: TaskData[] = [
        {
          id: "#001",
          title: "Task with spec",
          status: "TODO",
          specPath: "path/to/spec.md",
        },
      ];

      const markdown = formatTasksToMarkdown(tasks);
      expect(markdown).toBe("- [ ] Task with spec [#001](path/to/spec.md)");
    });
  });

  describe("getTaskById", () => {
    const testTasks: TaskData[] = [
      { id: "#001", title: "Task 1", status: "TODO" },
      { id: "#002", title: "Task 2", status: "IN-PROGRESS" },
      { id: "#003", title: "Task 3", status: "DONE" },
    ];

    test("should return null for empty input", () => {
      expect(getTaskById([], "TEST_VALUE")).toBeNull();
      expect(getTaskById(testTasks, "")).toBeNull();
    });

    test("should find task by exact ID match", () => {
      const task = getTaskById(testTasks, "#002");
      expect(task).not.toBeNull();
      expect(task?.id).toBe("#002");
      expect(task?.title).toBe("Task 2");
    });

    test("should find task by ID without # prefix", () => {
      const task = getTaskById(testTasks, "003");
      expect(task).not.toBeNull();
      expect(task?.id).toBe("#003");
    });

    test("should handle numeric equivalence", () => {
      // Test leading zeros are handled correctly
      const tasksWithLeadingZeros: TaskData[] = [{ id: "#001", title: "Task 1", status: "TODO" }];

      expect(getTaskById(tasksWithLeadingZeros, "1")?.id).toBe("#001");
      expect(getTaskById(tasksWithLeadingZeros, "01")?.id).toBe("#001");
      expect(getTaskById(tasksWithLeadingZeros, "001")?.id).toBe("#001");
      expect(getTaskById(tasksWithLeadingZeros, "#1")?.id).toBe("#001");
    });
  });

  describe("getNextTaskId", () => {
    test("should return #001 for empty tasks array", () => {
      expect(getNextTaskId([])).toBe("#001");
    });

    test("should find the maximum ID and increment it", () => {
      const tasks: TaskData[] = [
        { id: "#001", title: "Task 1", status: "TODO" },
        { id: "#005", title: "Task TEST_ARRAY_SIZE", status: "IN-PROGRESS" },
        { id: "#003", title: "Task 3", status: "DONE" },
      ];

      expect(getNextTaskId(tasks)).toBe("#006");
    });

    test("should handle non-sequential IDs", () => {
      const tasks: TaskData[] = [
        { id: "#010", title: "Task 10", status: "TODO" },
        { id: "#050", title: "Task 50", status: "IN-PROGRESS" },
        { id: "#030", title: "Task 30", status: "DONE" },
      ];

      expect(getNextTaskId(tasks)).toBe("#051");
    });

    test("should pad with zeros", () => {
      const tasks: TaskData[] = [{ id: "#9", title: "Task 9", status: "TODO" }];

      expect(getNextTaskId(tasks)).toBe("#010");
    });
  });

  describe("setTaskStatus", () => {
    const testTasks: TaskData[] = [
      { id: "#001", title: "Task 1", status: "TODO" },
      { id: "#002", title: "Task 2", status: "IN-PROGRESS" },
    ];

    test("should update a task's status", () => {
      const updatedTasks = setTaskStatus(testTasks, "#001", "DONE");
      expect(updatedTasks[0].status).toBe("DONE");
      expect(updatedTasks[1].status).toBe("IN-PROGRESS"); // unchanged
    });

    test("should work with task ID variations", () => {
      const updatedTasks = setTaskStatus(testTasks, "2", "DONE");
      expect(updatedTasks[1].status).toBe("DONE");
    });

    test("should return original array if task not found", () => {
      const updatedTasks = setTaskStatus(testTasks, "#999", "DONE");
      expect(updatedTasks).toEqual(testTasks);
    });

    test("should return original array if status is invalid", () => {
      const updatedTasks = setTaskStatus(testTasks, "#001", "INVALID" as unknown);
      expect(updatedTasks).toEqual(testTasks);
    });
  });

  describe("addTask", () => {
    const testTasks: TaskData[] = [
      { id: "#001", title: "Task 1", status: "TODO" },
      { id: "#002", title: "Task 2", status: "IN-PROGRESS" },
    ];

    test("should add a new task to the array", () => {
      const newTask: TaskData = { id: "#003", title: "Task 3", status: "TODO" };
      const updatedTasks = addTask(testTasks, newTask);

      expect(updatedTasks).toHaveLength(3);
      expect(updatedTasks[2]).toEqual(newTask);
    });

    test("should replace an existing task with the same ID", () => {
      const replacementTask: TaskData = { id: "#002", title: "Updated Task 2", status: "DONE" };
      const updatedTasks = addTask(testTasks, replacementTask);

      expect(updatedTasks).toHaveLength(2);
      expect(updatedTasks[1]).toEqual(replacementTask);
    });

    test("should generate an ID if not provided", () => {
      const taskWithoutId: TaskData = { id: "", title: "New Task", status: "TODO" };
      const updatedTasks = addTask(testTasks, taskWithoutId);

      expect(updatedTasks).toHaveLength(3);
      expect(updatedTasks[2].id).toBe("#003"); // Next available ID
      expect(updatedTasks[2].title).toBe("New Task");
    });
  });

  describe("filterTasks", () => {
    const testTasks: TaskData[] = [
      { id: "#001", title: "First task", status: "TODO" },
      { id: "#002", title: "Second task", status: "IN-PROGRESS" },
      { id: "#003", title: "Third task", status: "DONE" },
    ];

    test("should return all tasks if no filter provided", () => {
      expect(filterTasks(testTasks)).toEqual(testTasks);
    });

    test("should filter by status", () => {
      const filtered = filterTasks(testTasks, { status: "TODO" });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe("#001");
    });

    test("should filter by ID", () => {
      const filtered = filterTasks(testTasks, { id: "#002" });
      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.id).toBe("#002");
    });

    test("should filter by title (string match)", () => {
      const filtered = filterTasks(testTasks, { title: "Second" });
      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.id).toBe("#002");
    });

    test("should filter by title (regex match)", () => {
      const filtered = filterTasks(testTasks, { title: /task$/ });
      expect(filtered).toHaveLength(3);
    });

    test("should filter by specPath existence", () => {
      const tasksWithSpec: TaskData[] = [
        { id: "#001", title: "Task with spec", status: "TODO", specPath: "path/to/spec.md" },
        { id: "#002", title: "Task without spec", status: "IN-PROGRESS" },
      ];

      const filtered = filterTasks(tasksWithSpec, { hasSpecPath: true });
      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.id).toBe("#001");
    });

    test("should combine multiple filter criteria", () => {
      const combinedTasks: TaskData[] = [
        { id: "#001", title: "First task", status: "TODO" },
        { id: "#002", title: "Second task", status: "IN-PROGRESS" },
        { id: "#003", title: "Third task", status: "IN-PROGRESS" },
      ];

      const filtered = filterTasks(combinedTasks, {
        title: /task/,
        hasSpecPath: false,
        status: "IN-PROGRESS",
      });

      expect(filtered).toHaveLength(2);
      expect(filtered[0]?.id).toBe("#002");
      expect(filtered[1]?.id).toBe("#003");
    });
  });

  describe("parseTaskSpecFromMarkdown", () => {
    test("should parse task spec from markdown", () => {
      const markdown = `# Task #TEST_VALUE: Test Task Title

## Context

This is a test description.

## Requirements

1. Do something
`;

      const spec = parseTaskSpecFromMarkdown(markdown);
      expect(spec.title).toBe("Task #TEST_VALUE: Test Task Title");
      expect(spec.description).toBe("This is a test description.");
      // The function doesn't extract IDs from titles, so don't expect one
      expect(spec.id).toBeUndefined();
    });

    test("should handle specs without task ID", () => {
      const markdown = `# Task: No ID Task

## Context

Description here.
`;

      const spec = parseTaskSpecFromMarkdown(markdown);
      expect(spec.title).toBe("No ID Task");
      expect(spec.description).toBe("Description here.");
      expect(spec.id).toBeUndefined();
    });

    test("should handle general heading format", () => {
      const markdown = `# Just a general title

## Context

Description here.
`;

      const spec = parseTaskSpecFromMarkdown(markdown);
      expect(spec.title).toBe("Just a general title");
      expect(spec.description).toBe("Description here.");
    });

    test("should return empty values for invalid input", () => {
      expect(parseTaskSpecFromMarkdown("")).toEqual({
        title: "",
        description: "",
      });
      expect(parseTaskSpecFromMarkdown("No headers")).toEqual({
        title: "",
        description: "",
      });
    });
  });

  describe("formatTaskSpecToMarkdown", () => {
    test("should format task spec to markdown with ID", () => {
      const spec = {
        title: "Test Task",
        description: "This is a test description.",
        id: "#TEST_VALUE",
      };

      const markdown = formatTaskSpecToMarkdown(spec);
      expect(markdown).toContain("# Test Task");
      expect(markdown).toContain("This is a test description.");
    });

    test("should format task spec without ID", () => {
      const spec = {
        title: "Test Task Without ID",
        description: "Description here.",
      };

      const markdown = formatTaskSpecToMarkdown(spec);
      expect(markdown).toContain("# Test Task Without ID");
      expect(markdown).toContain("Description here.");
    });
  });

  describe("isValidTaskStatus", () => {
    test("should validate correct statuses", () => {
      expect(isValidTaskStatus("TODO")).toBe(true);
      expect(isValidTaskStatus("IN-PROGRESS")).toBe(true);
      expect(isValidTaskStatus("DONE")).toBe(true);
    });

    test("should reject invalid statuses", () => {
      expect(isValidTaskStatus("INVALID")).toBe(false);
      expect(isValidTaskStatus("")).toBe(false);
      expect(isValidTaskStatus("todo")).toBe(false);
    });
  });
});
