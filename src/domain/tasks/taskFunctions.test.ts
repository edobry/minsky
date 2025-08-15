const TEST_VALUE = 123;
const TEST_ARRAY_SIZE = 3;

/**
 * Tests for task pure functions (updated for strict qualified IDs)
 */

import { describe, test, expect } from "bun:test";
import type { TaskData } from "../../types/tasks/taskData";
import {
  parseTasksFromMarkdown,
  formatTasksToMarkdown,
  getTaskById,
  getNextTaskId,
  setTaskStatus,
  addTask,
  filterTasks,
  parseTaskSpecFromMarkdown,
  formatTaskSpecToMarkdown,
  isValidTaskStatus,
} from "./taskFunctions";

const QUAL = (n: string) => `md#${n}`;

describe("Task Functions", () => {
  describe("parseTasksFromMarkdown", () => {
    test("should return empty array for empty content", () => {
      expect(parseTasksFromMarkdown("")).toEqual([]);
    });

    test("should parse tasks from markdown content", () => {
      const markdown = `- [ ] First task [md#001](#)
  - Description line 1
  - Description line 2

- [x] Second task [md#002](#)

- [+] In progress task [md#003](#)`;

      const tasks = parseTasksFromMarkdown(markdown);
      expect(tasks).toHaveLength(3);

      expect(tasks[0].id).toBe(QUAL("001"));
      expect(tasks[0].title).toBe("First task");
      expect(tasks[0].status).toBe("TODO");
      expect(tasks[0].description).toBe("Description line 1\nDescription line 2");

      expect(tasks[1].id).toBe(QUAL("002"));
      expect(tasks[1].status).toBe("DONE");

      expect(tasks[2].id).toBe(QUAL("003"));
      expect(tasks[2].status).toBe("IN-PROGRESS");
    });

    test("should ignore tasks in code blocks", () => {
      const markdown = `
Normal task:
- [ ] First task [md#001](#)

\`\`\`
Code block with task-like content:
- [ ] Not a real task [md#002](#)
\`\`\`

- [x] Second real task [md#003](#)`;

      const tasks = parseTasksFromMarkdown(markdown);
      expect(tasks).toHaveLength(2);
      expect(tasks[0].id).toBe(QUAL("001"));
      expect(tasks[1].id).toBe(QUAL("003"));
    });
  });

  describe("formatTasksToMarkdown", () => {
    test("should return empty string for empty array", () => {
      expect(formatTasksToMarkdown([])).toBe("");
    });

    test("should format tasks to markdown with one-liner format only", () => {
      const tasks: TaskData[] = [
        {
          id: QUAL("001"),
          title: "First task",
          status: "TODO",
          description: "Description line 1\nDescription line 2",
        },
        {
          id: QUAL("002"),
          title: "Completed task",
          status: "DONE",
        },
      ];

      const markdown = formatTasksToMarkdown(tasks);
      expect(markdown).toContain("- [ ] First task [md#001](#)");
      expect(markdown).toContain("- [x] Completed task [md#002](#)");
      expect(markdown).not.toContain("Description line 1");
      expect(markdown).not.toContain("Description line 2");
    });

    test("should use task specPath if available", () => {
      const tasks: TaskData[] = [
        {
          id: QUAL("001"),
          title: "Task with spec",
          status: "TODO",
          specPath: "path/to/spec.md",
        },
      ];

      const markdown = formatTasksToMarkdown(tasks);
      expect(markdown).toBe("- [ ] Task with spec [md#001](path/to/spec.md)");
    });
  });

  describe("getTaskById", () => {
    const testTasks: TaskData[] = [
      { id: QUAL("001"), title: "Task 1", status: "TODO" },
      { id: QUAL("002"), title: "Task 2", status: "IN-PROGRESS" },
      { id: QUAL("003"), title: "Task 3", status: "DONE" },
    ];

    test("should return null for empty input", () => {
      expect(getTaskById([], QUAL("001"))).toBeNull();
      expect(getTaskById(testTasks, "")).toBeNull();
    });

    test("should find task by exact ID match", () => {
      const task = getTaskById(testTasks, QUAL("002"));
      expect(task).not.toBeNull();
      expect(task?.id).toBe(QUAL("002"));
      expect(task?.title).toBe("Task 2");
    });

    test("should return null for unqualified IDs", () => {
      const task = getTaskById(testTasks, "003");
      expect(task).toBeNull();
    });
  });

  describe("getNextTaskId", () => {
    test("should return 001 for empty tasks array", () => {
      expect(getNextTaskId([])).toBe("001");
    });

    test("should find the maximum ID and increment it", () => {
      const tasks: TaskData[] = [
        { id: QUAL("001"), title: "Task 1", status: "TODO" },
        { id: QUAL("005"), title: "Task TEST_ARRAY_SIZE", status: "IN-PROGRESS" },
        { id: QUAL("003"), title: "Task 3", status: "DONE" },
      ];

      expect(getNextTaskId(tasks)).toBe("006");
    });

    test("should handle non-sequential IDs", () => {
      const tasks: TaskData[] = [
        { id: QUAL("010"), title: "Task 10", status: "TODO" },
        { id: QUAL("050"), title: "Task 50", status: "IN-PROGRESS" },
        { id: QUAL("030"), title: "Task 30", status: "DONE" },
      ];

      expect(getNextTaskId(tasks)).toBe("051");
    });

    test("should pad with zeros when needed", () => {
      const tasks: TaskData[] = [{ id: QUAL("009"), title: "Task 9", status: "TODO" }];

      expect(getNextTaskId(tasks)).toBe("010");
    });
  });

  describe("setTaskStatus", () => {
    const testTasks: TaskData[] = [
      { id: QUAL("001"), title: "Task 1", status: "TODO" },
      { id: QUAL("002"), title: "Task 2", status: "IN-PROGRESS" },
    ];

    test("should update a task's status", () => {
      const updatedTasks = setTaskStatus(testTasks, QUAL("001"), "DONE");
      expect(updatedTasks[0].status).toBe("DONE");
      expect(updatedTasks[1].status).toBe("IN-PROGRESS");
    });

    test("should not update when ID is unqualified", () => {
      const updatedTasks = setTaskStatus(testTasks, "2", "DONE");
      expect(updatedTasks).toEqual(testTasks);
    });

    test("should return original array if task not found", () => {
      const updatedTasks = setTaskStatus(testTasks, QUAL("999"), "DONE");
      expect(updatedTasks).toEqual(testTasks);
    });

    test("should return original array if status is invalid", () => {
      const updatedTasks = setTaskStatus(testTasks, QUAL("001"), "INVALID" as any);
      expect(updatedTasks).toEqual(testTasks);
    });
  });

  describe("addTask", () => {
    const testTasks: TaskData[] = [
      { id: QUAL("001"), title: "Task 1", status: "TODO" },
      { id: QUAL("002"), title: "Task 2", status: "IN-PROGRESS" },
    ];

    test("should add a new task to the array", () => {
      const newTask: TaskData = { id: QUAL("003"), title: "Task 3", status: "TODO" };
      const updatedTasks = addTask(testTasks, newTask);

      expect(updatedTasks).toHaveLength(3);
      expect(updatedTasks[2]).toEqual(newTask);
    });

    test("should replace an existing task with the same ID", () => {
      const replacementTask: TaskData = {
        id: QUAL("002"),
        title: "Updated Task 2",
        status: "DONE",
      };
      const updatedTasks = addTask(testTasks, replacementTask);

      expect(updatedTasks).toHaveLength(2);
      expect(updatedTasks[1]).toEqual(replacementTask);
    });

    test("should generate an ID if not provided (plain storage format)", () => {
      const taskWithoutId: TaskData = { id: "", title: "New Task", status: "TODO" };
      const updatedTasks = addTask(testTasks, taskWithoutId);

      expect(updatedTasks).toHaveLength(3);
      expect(updatedTasks[2].id).toBe("003");
      expect(updatedTasks[2].title).toBe("New Task");
    });
  });

  describe("filterTasks", () => {
    const testTasks: TaskData[] = [
      { id: QUAL("001"), title: "First task", status: "TODO" },
      { id: QUAL("002"), title: "Second task", status: "IN-PROGRESS" },
      { id: QUAL("003"), title: "Third task", status: "DONE" },
    ];

    test("should return all tasks if no filter provided", () => {
      expect(filterTasks(testTasks)).toEqual(testTasks);
    });

    test("should filter by status", () => {
      const filtered = filterTasks(testTasks, { status: "TODO" });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe(QUAL("001"));
    });

    test("should filter by ID", () => {
      const filtered = filterTasks(testTasks, { id: QUAL("002") });
      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.id).toBe(QUAL("002"));
    });

    test("should filter by title (string match)", () => {
      const filtered = filterTasks(testTasks, { title: "Second" });
      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.id).toBe(QUAL("002"));
    });

    test("should filter by title (regex match)", () => {
      const filtered = filterTasks(testTasks, { title: /task$/ });
      expect(filtered).toHaveLength(3);
    });

    test("should filter by specPath existence", () => {
      const tasksWithSpec: TaskData[] = [
        { id: QUAL("001"), title: "Task with spec", status: "TODO", specPath: "path/to/spec.md" },
        { id: QUAL("002"), title: "Task without spec", status: "IN-PROGRESS" },
      ];

      const filtered = filterTasks(tasksWithSpec, { hasSpecPath: true });
      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.id).toBe(QUAL("001"));
    });

    test("should combine multiple filter criteria", () => {
      const combinedTasks: TaskData[] = [
        { id: QUAL("001"), title: "First task", status: "TODO" },
        { id: QUAL("002"), title: "Second task", status: "IN-PROGRESS" },
        { id: QUAL("003"), title: "Third task", status: "IN-PROGRESS" },
      ];

      const filtered = filterTasks(combinedTasks, {
        title: /task/,
        hasSpecPath: false,
        status: "IN-PROGRESS",
      });

      expect(filtered).toHaveLength(2);
      expect(filtered[0]?.id).toBe(QUAL("002"));
      expect(filtered[1]?.id).toBe(QUAL("003"));
    });
  });

  describe("parseTaskSpecFromMarkdown", () => {
    test("should parse task spec from markdown", () => {
      const markdown = `# Task md#TEST_VALUE: Test Task Title

## Context

This is a test description.

## Requirements

1. Do something
`;

      const spec = parseTaskSpecFromMarkdown(markdown);
      expect(spec.title).toBe("Test Task Title");
      expect(spec.description).toBe("This is a test description.");
      expect(spec.id).toBe("md#TEST_VALUE");
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
    test("should format task spec to markdown without ID in title", () => {
      const spec = {
        title: "Test Task",
        description: "This is a test description.",
        id: "md#TEST_VALUE",
      };

      const markdown = formatTaskSpecToMarkdown(spec);
      expect(markdown).toContain("# Test Task");
      expect(markdown).toContain("This is a test description.");
      expect(markdown).not.toContain("md#TEST_VALUE");
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
