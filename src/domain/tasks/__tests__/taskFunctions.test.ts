/**
 * Tests for task pure functions
 */

import { describe, test, expect } from "bun:test";
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
} from "../taskFunctions.js";
import type {TaskSpecData } from "../../../types/tasks/taskData.js";

describe("Task Functions", () => {
  describe("normalizeTaskId", () => {
    test("should return null for empty input", () => {
      expect(normalizeTaskId("")).toBeNull();
    });

    test("should return the ID as-is if already in #XXX format", () => {
      expect(normalizeTaskId("#123")).toBe("#123");
    });

    test("should convert numeric string to #XXX format", () => {
      expect(normalizeTaskId("123")).toBe("#123");
    });

    test("should extract numeric portion from mixed formats", () => {
      expect(normalizeTaskId("task-123")).toBe("#123");
      expect(normalizeTaskId("task #123")).toBe("#123");
      expect(normalizeTaskId("123-something")).toBe("#123");
    });

    test("should return null for non-numeric input", () => {
      expect(normalizeTaskId("abc")).toBeNull();
    });
  });

  describe("parseTasksFromMarkdown", () => {
    test("should return empty array for empty content", () => {
      expect(parseTasksFromMarkdown("")).toEqual([]);
    });

    test("should parse tasks from markdown content", () => {
      const markdown = `
- [ ] First task [#001](#)
  - Description line 1
  - Description line 2
- [x] Completed task [#002](#)
- [+] In progress task [#003](#)`;

      const _tasks = parseTasksFromMarkdown(markdown);
      expect(_tasks).toHaveLength(3);

      expect(tasks[0].id).toBe("#001");
      expect(tasks[0]._title).toBe("First task");
      expect(tasks[0]._status).toBe("TODO");
      expect(tasks[0].description).toBe("Description line 1\nDescription line 2");

      expect(tasks[1].id).toBe("#002");
      expect(tasks[1]._status).toBe("DONE");

      expect(tasks[2].id).toBe("#003");
      expect(tasks[2]._status).toBe("IN-PROGRESS");
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

      const _tasks = parseTasksFromMarkdown(markdown);
      expect(_tasks).toHaveLength(2);
      expect(tasks[0].id).toBe("#001");
      expect(tasks[1].id).toBe("#003");
    });
  });

  describe("formatTasksToMarkdown", () => {
    test("should return empty string for empty array", () => {
      expect(formatTasksToMarkdown([])).toBe("");
    });

    test("should format tasks to markdown with one-liner format only", () => {
      const _tasks: TaskData[] = [
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

      const markdown = formatTasksToMarkdown(_tasks);
      expect(markdown).toContain("- [ ] First task [#001](#)");
      expect(markdown).toContain("- [x] Completed task [#002](#)");
      // Descriptions should NOT be included in the markdown output
      expect(markdown).not.toContain("Description line 1");
      expect(markdown).not.toContain("Description line 2");
    });

    test("should use task specPath if available", () => {
      const _tasks: TaskData[] = [
        {
          id: "#001",
          title: "Task with spec",
          status: "TODO",
          specPath: "path/to/spec.md",
        },
      ];

      const markdown = formatTasksToMarkdown(_tasks);
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
      expect(getTaskById([], "123")).toBeNull();
      expect(getTaskById(testTasks, "")).toBeNull();
    });

    test("should find task by exact ID match", () => {
      const task = getTaskById(testTasks, "#002");
      expect(task).not.toBeNull();
      expect(task?.id).toBe("#002");
      expect(task?._title).toBe("Task 2");
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
      const _tasks: TaskData[] = [
        { id: "#001", title: "Task 1", status: "TODO" },
        { id: "#005", title: "Task 5", status: "IN-PROGRESS" },
        { id: "#003", title: "Task 3", status: "DONE" },
      ];

      expect(getNextTaskId(_tasks)).toBe("#006");
    });

    test("should handle non-sequential IDs", () => {
      const _tasks: TaskData[] = [
        { id: "#010", title: "Task 10", status: "TODO" },
        { id: "#050", title: "Task 50", status: "IN-PROGRESS" },
        { id: "#030", title: "Task 30", status: "DONE" },
      ];

      expect(getNextTaskId(_tasks)).toBe("#051");
    });

    test("should pad with zeros", () => {
      const _tasks: TaskData[] = [{ id: "#9", title: "Task 9", status: "TODO" }];

      expect(getNextTaskId(_tasks)).toBe("#010");
    });
  });

  describe("setTaskStatus", () => {
    const testTasks: TaskData[] = [
      { id: "#001", title: "Task 1", status: "TODO" },
      { id: "#002", title: "Task 2", status: "IN-PROGRESS" },
    ];

    test("should update a task's status", () => {
      const updatedTasks = setTaskStatus(testTasks, "#001", "DONE");
      expect(updatedTasks[0]._status).toBe("DONE");
      expect(updatedTasks[1]._status).toBe("IN-PROGRESS"); // unchanged
    });

    test("should work with task ID variations", () => {
      const updatedTasks = setTaskStatus(testTasks, "2", "DONE");
      expect(updatedTasks[1]._status).toBe("DONE");
    });

    test("should return original array if task not found", () => {
      const updatedTasks = setTaskStatus(testTasks, "#999", "DONE");
      expect(updatedTasks).toEqual(testTasks);
    });

    test("should return original array if status is invalid", () => {
      const updatedTasks = setTaskStatus(testTasks, "#001", "INVALID");
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
      expect(updatedTasks[2]._title).toBe("New Task");
    });
  });

  describe("filterTasks", () => {
    const testTasks: TaskData[] = [
      { id: "#001", title: "First task", status: "TODO" },
      { id: "#002", title: "Second task", status: "IN-PROGRESS" },
      { id: "#003", title: "Third task", status: "DONE", specPath: "path/to/spec.md" },
    ];

    test("should return all tasks if no filter provided", () => {
      expect(filterTasks(testTasks)).toEqual(testTasks);
    });

    test("should filter by status", () => {
      const filtered = filterTasks(testTasks, { _status: "TODO" });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe("#001");
    });

    test("should filter by ID", () => {
      const filtered = filterTasks(testTasks, { id: "2" });
      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.id).toBe("#002");
    });

    test("should filter by title (string match)", () => {
      const filtered = filterTasks(testTasks, { _title: "Second" });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe("#002");
    });

    test("should filter by title (regex match)", () => {
      const filtered = filterTasks(testTasks, { _title: /task$/ });
      expect(filtered).toHaveLength(3); // All titles end with "task"
    });

    test("should filter by specPath existence", () => {
      const withSpec = filterTasks(testTasks, { hasSpecPath: true });
      expect(withSpec).toHaveLength(1);
      expect(withSpec[0].id).toBe("#003");

      const withoutSpec = filterTasks(testTasks, { hasSpecPath: false });
      expect(withoutSpec).toHaveLength(2);
      expect(withoutSpec.map((t) => t.id)).toEqual(["#001", "#002"]);
    });

    test("should combine multiple filter criteria", () => {
      const filtered = filterTasks(testTasks, {
        _title: /task/,
        hasSpecPath: false,
        _status: "IN-PROGRESS",
      });

      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe("#002");
    });
  });

  describe("parseTaskSpecFromMarkdown", () => {
    test("should parse task spec from markdown", () => {
      const markdown = `# Task #123: Test Task Title

## Context

This is a test task description.
It has multiple lines.

## Requirements

1. Do something
`;

      const _spec = parseTaskSpecFromMarkdown(markdown);
      expect(spec._title).toBe("Test Task Title");
      expect(spec.id).toBe("#123");
      expect(spec.description).toBe("This is a test task description.\nIt has multiple lines.");
    });

    test("should handle specs without task ID", () => {
      const markdown = `# Task: No ID Task

## Context

Description here.
`;

      const _spec = parseTaskSpecFromMarkdown(markdown);
      expect(spec._title).toBe("No ID Task");
      expect(spec.id).toBeUndefined();
      expect(spec.description).toBe("Description here.");
    });

    test("should handle general heading format", () => {
      const markdown = `# Just a general title

## Context

Description here.
`;

      const _spec = parseTaskSpecFromMarkdown(markdown);
      expect(spec._title).toBe("Just a general title");
      expect(spec.description).toBe("Description here.");
    });

    test("should return empty values for invalid input", () => {
      expect(parseTaskSpecFromMarkdown("")).toEqual({
        _title: "",
        description: "",
      });

      expect(parseTaskSpecFromMarkdown("No headings here")).toEqual({
        _title: "",
        description: "",
      });
    });
  });

  describe("formatTaskSpecToMarkdown", () => {
    test("should format task spec to markdown with ID", () => {
      const _spec: TaskSpecData = {
        title: "Test Task",
        description: "This is a test description.",
        id: "#123",
      };

      const markdown = formatTaskSpecToMarkdown(_spec);
      expect(markdown).toContain("# Task #123: Test Task");
      expect(markdown).toContain("## Context");
      expect(markdown).toContain("This is a test description.");
      expect(markdown).toContain("## Requirements");
      expect(markdown).toContain("## Implementation Steps");
    });

    test("should format task spec without ID", () => {
      const _spec: TaskSpecData = {
        title: "Test Task Without ID",
        description: "Description here.",
      };

      const markdown = formatTaskSpecToMarkdown(_spec);
      expect(markdown).toContain("# Task: Test Task Without ID");
      expect(markdown).toContain("Description here.");
    });
  });

  describe("isValidTaskStatus", () => {
    test("should validate correct statuses", () => {
      expect(isValidTaskStatus("TODO")).toBe(true);
      expect(isValidTaskStatus("IN-PROGRESS")).toBe(true);
      expect(isValidTaskStatus("IN-REVIEW")).toBe(true);
      expect(isValidTaskStatus("DONE")).toBe(true);
    });

    test("should reject invalid statuses", () => {
      expect(isValidTaskStatus("INVALID")).toBe(false);
      expect(isValidTaskStatus("")).toBe(false);
      expect(isValidTaskStatus("todo")).toBe(false); // case-sensitive
    });
  });
});
