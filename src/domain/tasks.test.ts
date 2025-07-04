import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { MarkdownTaskBackend, TaskService, TASK_STATUS } from "./tasks";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import path from "path";
const COMMIT_HASH_SHORT_LENGTH = 7;

const SAMPLE_TASKS_MD = `
# Tasks

## Example

\`\`\`markdown
- [ ] Example Task [#999](tasks/999-example.md)
\`\`\`

- [ ] First Task [#001](tasks/001-first.md)
  - This is the first task description
- [x] Second Task [#002](tasks/002-second.md)
- [ ] Third Task [#003](tasks/003-third.md)

- [ ] Malformed Task #004 (no link)
- [ ] Not a real task
`;

describe("MarkdownTaskBackend", () => {
  let tmpDir: string;
  let tasksPath: string;
  let backend: MarkdownTaskBackend;

  beforeEach(() => {
    tmpDir = mkdtempSync("/tmp/minsky-tasks-test-");
    const processDir = join(tmpDir, "process");
    mkdirSync(processDir);
    tasksPath = join(processDir, "tasks.md");
    writeFileSync(tasksPath, SAMPLE_TASKS_MD);
    // Create expected spec files for tasks 001, 002, 003 (matching SAMPLE_TASKS_MD)
    const tasksDir = join(processDir, "tasks");
    mkdirSync(tasksDir);
    writeFileSync(
      join(tasksDir, "001-first.md"),
      "# Task #001: First Task\n\n## Context\n\nThis is the first task description."
    );
    writeFileSync(
      join(tasksDir, "002-second.md"),
      "# Task #002: Second Task\n\n## Context\n\nThis is the second task description."
    );
    writeFileSync(
      join(tasksDir, "003-third.md"),
      "# Task #003: Third Task\n\n## Context\n\nThis is the third task description."
    );
    backend = new MarkdownTaskBackend(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("lists all real tasks, ignoring code blocks and malformed lines", async () => {
    const tasks = await backend.listTasks();
    expect(tasks.length).toBe(3);
    expect(tasks.map((t) => t.id)).toEqual(["#001", "#002", "#003"]);
    expect(tasks.map((t) => t.title)).toContain("First Task");
    expect(tasks.map((t) => t.title)).toContain("Second Task");
    expect(tasks.map((t) => t.title)).toContain("Third Task");
  });

  it("filters tasks by status", async () => {
    const done = await backend.listTasks({ status: "DONE" });
    expect(done.length).toBe(1);
    expect(done[0]?.id).toBe("#002");
    const todo = await backend.listTasks({ status: "TODO" });
    expect(todo.length).toBe(2);
    expect(todo.map((t) => t.id)).toEqual(["#001", "#003"]);
  });

  it("gets a task by id", async () => {
    const task = await backend.getTask("#001");
    expect(task).toBeTruthy();
    expect(task?._title).toBe("First Task");
    expect(task?.description).toContain("first task description");
  });

  it("gets a task status", async () => {
    expect(await backend.getTaskStatus("#002")).toBe("DONE");
    expect(await backend.getTaskStatus("#003")).toBe("TODO");
  });

  it("sets a task status and persists the change", async () => {
    await backend.setTaskStatus("#003", "DONE");
    let task = await backend.getTask("#003");
    expect(task?._status).toBe("DONE");
    // Check file content
    const file = readFileSync(tasksPath, "utf-8");
    expect(file).toMatch(/- \[x\] Third Task \[#003\]/);
    // Set back to TODO
    await backend.setTaskStatus("#003", "TODO");
    task = await backend.getTask("#003");
    expect(task?._status).toBe("TODO");
    const file2 = readFileSync(tasksPath, "utf-8");
    expect(file2).toMatch(/- \[ \] Third Task \[#003\]/);
  });

  it("sets a task status to IN-PROGRESS and persists the change", async () => {
    await backend.setTaskStatus("#003", "IN-PROGRESS");
    let task = await backend.getTask("#003");
    expect(task?._status).toBe("IN-PROGRESS");
    // Check file content
    const file = readFileSync(tasksPath, "utf-8");
    expect(file).toMatch(/- \[-\] Third Task \[#003\]/);
    // Set back to TODO
    await backend.setTaskStatus("#003", "TODO");
    task = await backend.getTask("#003");
    expect(task?._status).toBe("TODO");
    const file2 = readFileSync(tasksPath, "utf-8");
    expect(file2).toMatch(/- \[ \] Third Task \[#003\]/);
  });

  it("sets a task status to IN-REVIEW and persists the change", async () => {
    await backend.setTaskStatus("#003", "IN-REVIEW");
    let task = await backend.getTask("#003");
    expect(task?._status).toBe("IN-REVIEW");
    // Check file content
    const file = readFileSync(tasksPath, "utf-8");
    expect(file).toMatch(/- \[\+\] Third Task \[#003\]/);
    // Set back to TODO
    await backend.setTaskStatus("#003", "TODO");
    task = await backend.getTask("#003");
    expect(task?._status).toBe("TODO");
    const file2 = readFileSync(tasksPath, "utf-8");
    expect(file2).toMatch(/- \[ \] Third Task \[#003\]/);
  });

  it("ignores tasks in code blocks", async () => {
    const tasks = await backend.listTasks();
    expect(tasks.find((t) => t.id === "#999")).toBeUndefined();
  });

  it("ignores malformed lines", async () => {
    const tasks = await backend.listTasks();
    expect(tasks.find((t) => t.title && t.title.includes("Malformed"))).toBeUndefined();
    expect(tasks.find((t) => t.title && t.title.includes("Not a real task"))).toBeUndefined();
  });

  it("throws on invalid status for setTaskStatus", async () => {
    await expect(backend.setTaskStatus("#001", "INVALID")).rejects.toThrow();
  });

  it("does nothing if task id does not exist for setTaskStatus", async () => {
    // Should not throw, should not change file
    const before = readFileSync(tasksPath, "utf-8");
    await backend.setTaskStatus("#999", "DONE");
    const after = readFileSync(tasksPath, "utf-8");
    expect(after).toBe(before);
  });

  it("returns null for getTask/getTaskStatus on missing id", async () => {
    expect(await backend.getTask("#999")).toBeNull();
    expect(await backend.getTaskStatus("#999")).toBeNull();
  });

  it("handles multiple code blocks and tasks in between", async () => {
    const md = `
# Tasks
\n\`\`\`markdown\n- [ ] In code block [#100](tasks/100.md)\n\`\`\`\n- [ ] Real Task [#101](tasks/101.md)\n\`\`\`\n- [ ] Also in code block [#102](tasks/102.md)\n\`\`\`\n- [x] Real Done [#103](tasks/103.md)\n`;
    writeFileSync(tasksPath, md);
    const tasks = await backend.listTasks();
    expect(tasks.length).toBe(2);
    expect(tasks.map((t) => t.id)).toEqual(["#101", "#103"]);
  });
});

describe("TaskService", () => {
  let tmpDir: string;
  let tasksPath: string;
  let service: TaskService;

  beforeEach(() => {
    tmpDir = mkdtempSync("/tmp/minsky-tasks-test-");
    const processDir = join(tmpDir, "process");
    mkdirSync(processDir);
    tasksPath = join(processDir, "tasks.md");
    writeFileSync(tasksPath, SAMPLE_TASKS_MD);
    // Create expected spec files for tasks 001, 002, 003 (matching SAMPLE_TASKS_MD)
    const tasksDir = join(processDir, "tasks");
    mkdirSync(tasksDir);
    writeFileSync(
      join(tasksDir, "001-first.md"),
      "# Task #001: First Task\n\n## Context\n\nThis is the first task description."
    );
    writeFileSync(
      join(tasksDir, "002-second.md"),
      "# Task #002: Second Task\n\n## Context\n\nThis is the second task description."
    );
    writeFileSync(
      join(tasksDir, "003-third.md"),
      "# Task #003: Third Task\n\n## Context\n\nThis is the third task description."
    );
    service = new TaskService({ _workspacePath: tmpDir });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("lists tasks via TaskService", async () => {
    const tasks = await service.listTasks();
    expect(tasks.length).toBe(3);
  });

  it("gets and sets task status via TaskService", async () => {
    expect(await service.getTaskStatus("#001")).toBe("TODO");
    await service.setTaskStatus("#001", "DONE");
    expect(await service.getTaskStatus("#001")).toBe("DONE");
  });

  it("throws if backend is not found", () => {
    expect(() => new TaskService({ _workspacePath: tmpDir, backend: "notreal" })).toThrow();
  });
});

// Mock fs with better in-memory handling
const mockFileSystem = new Map<string, string>();
const mockDirs = new Set<string>();

// Mock the implementation with in-memory operations
mock.module("fs", () => {
  return {
    promises: {
      readFile: async (path: unknown) => {
        if (mockFileSystem.has(path)) {
          return mockFileSystem.get(path);
        }

        // Default content
        if (path.endsWith("tasks.md")) {
          const content =
            "# Tasks\n\n- [ ] First Task [#001](process/tasks/001-first.md)\n- [x] Second Task [#002](process/tasks/002-second.md)\n- [ ] Third Task [#003](process/tasks/003-third.md)\n";
          mockFileSystem.set(path, content);
          return content;
        }
        if (path.endsWith("spec.md")) {
          return "# Task #999: Test Task\n\n## Context\n\nThis is a test task context.\n\n## Requirements\n\n- Do something\n";
        }
        if (path.includes("001-first")) {
          return "# Task #001: First Task\n\n## Context\n\nThis is the first task description.\n";
        }
        if (path.includes("002-second")) {
          return "# Task #002: Second Task\n\n## Context\n\nThis is the second task description.\n";
        }
        if (path.includes("003-third")) {
          return "# Task #003: Third Task\n\n## Context\n\nThis is the third task description.\n";
        }
        return "";
      },
      writeFile: async (path: unknown) => {
        mockFileSystem.set(path, content);
      },
      mkdir: async (path: unknown) => {
        mockDirs.add(path.toString());
      },
      access: async (path: unknown) => {
        if (
          path.includes("001-first") ||
          path.includes("002-second") ||
          path.includes("003-third") ||
          path.includes("spec.md") ||
          path.endsWith("tasks.md") ||
          mockFileSystem.has(path) ||
          mockDirs.has(path)
        ) {
          return;
        }
        throw new Error("File not found");
      },
      readdir: async (path: unknown) => {
        if (path.includes("tasks")) {
          return ["001-first.md", "002-second.md", "003-third.md"];
        }
        return [];
      },
    },
    // Add sync versions too for readFileSync used in tests
    mkdtempSync: (prefix: unknown) => prefix + Date.now(),
    mkdirSync: (path: unknown) => {
      mockDirs.add(path.toString());
    },
    rmSync: () => {},
    writeFileSync: (path: unknown) => {
      mockFileSystem.set(path.toString(), content.toString());
    },
    readFileSync: (path: unknown) => {
      if (mockFileSystem.has(path.toString())) {
        return mockFileSystem.get(path.toString());
      }
      // Default content same as async version
      if (path.toString().endsWith("tasks.md")) {
        const content =
          "# Tasks\n\n- [ ] First Task [#001](process/tasks/001-first.md)\n- [x] Second Task [#002](process/tasks/002-second.md)\n- [ ] Third Task [#003](process/tasks/003-third.md)\n";
        mockFileSystem.set(path.toString(), content);
        return content;
      }
      return "";
    },
  };
});

// Add createTask tests
describe("createTask", () => {
  const _workspacePath = "/test/workspace";
  let taskBackend: MarkdownTaskBackend;
  let taskService: TaskService;

  beforeEach(() => {
    taskBackend = new MarkdownTaskBackend(_workspacePath);
    taskService = new TaskService({ _workspacePath });
    // Reset mock filesystem
    mockFileSystem.clear();
    mockDirs.clear();
  });

  it("should parse spec file and create a new task", async () => {
    const _specPath = path.join(_workspacePath, "process/tasks/spec.md");

    // Mock parseTasks to return tasks with ID 001
    spyOn(taskBackend, "parseTasks").mockImplementation(async () => [
      {
        id: "#001",
        title: "First Task",
        description: "",
        status: TASK_STATUS.TODO,
        _specPath: "process/tasks/001-first.md",
      },
    ]);

    // Mock fs.promises.unlink to do nothing
    mock.module("fs", () => ({
      promises: {
        readFile: async () =>
          "# Task #002: Test Task\n\n## Context\n\nThis is a test task context.\n\n## Requirements\n\n- Do something\n",
        access: async () => {},
        writeFile: async (path: unknown) => {
          mockFileSystem.set(path, content);
        },
        mkdir: async () => {},
        unlink: async () => {},
        readdir: async () => [],
      },
    }));

    // Mock getTask to return null (no existing task with this ID)
    spyOn(taskBackend, "getTask").mockImplementation(async () => null);

    const task = await taskBackend.createTask(_specPath);

    expect(task).toBeDefined();
    expect(task.id).toBe("#002");
    expect(task._title).toBe("Test Task");
    expect(task._status).toBe(TASK_STATUS.TODO);
    expect(task.description).toBeTruthy();
    expect(task._specPath).toBe("process/tasks/002-test-task.md");
  });

  it("should throw error if spec file does not exist", async () => {
    const invalidPath = "/invalid/path.md";

    // Mock fs.access to throw an error
    mock.module("fs", () => ({
      promises: {
        access: async () => {
          throw new Error("File not found");
        },
      },
    }));

    await expect(taskBackend.createTask(invalidPath)).rejects.toThrow("Spec file not found");
  });

  it("should throw error if spec file has invalid format", async () => {
    const _specPath = path.join(_workspacePath, "process/tasks/invalid-spec.md");

    // Mock fs.readFile to return invalid content
    mock.module("fs", () => ({
      promises: {
        readFile: async () => "Invalid spec content",
        access: async () => {},
      },
    }));

    await expect(taskBackend.createTask(_specPath)).rejects.toThrow("Invalid spec file");
  });

  it("should support spec file with \"# Task: Title\" format", async () => {
    const _specPath = path.join(_workspacePath, "process/tasks/no-id-spec.md");
    const newSpecPath = path.join(_workspacePath, "process/tasks/003-new-feature.md");

    // Mock fs.readFile to return content without task ID
    mock.module("fs", () => ({
      promises: {
        readFile: async () =>
          "# Task: New Feature\n\n## Context\n\nThis is a new feature without ID.\n",
        access: async () => {},
        writeFile: async (path: unknown) => {
          mockFileSystem.set(path, content);
        },
        mkdir: async () => {},
        unlink: async () => {},
        readdir: async () => [],
      },
    }));

    // Mock parseTasks to return tasks with ID 001 and 002
    spyOn(taskBackend, "parseTasks").mockImplementation(async () => [
      { id: "#001", title: "First Task", description: "", status: TASK_STATUS.TODO },
      { id: "#002", title: "Second Task", description: "", status: TASK_STATUS.TODO },
    ]);

    const task = await taskBackend.createTask(_specPath);

    expect(task).toBeDefined();
    expect(task.id).toBe("#003"); // Should get next available ID
    expect(task._title).toBe("New Feature");
    expect(task._status).toBe(TASK_STATUS.TODO);

    // Check that the title was updated in the file
    const updatedContent = mockFileSystem.get(newSpecPath);
    expect(updatedContent).toBeDefined();
    expect(typeof updatedContent === "string").toBe(true);
    if (updatedContent && typeof updatedContent === "string") {
      expect(updatedContent.includes("# Task #003: New Feature")).toBe(true);
    }
  });

  it("should support spec file with \"# Task #XXX: Title\" format", async () => {
    const _specPath = path.join(_workspacePath, "process/tasks/with-id-spec.md");
    const newSpecPath = path.join(_workspacePath, "process/tasks/042-existing-id-feature.md");

    // Mock fs.readFile to return content with task ID
    mock.module("fs", () => ({
      promises: {
        readFile: async () =>
          "# Task #042: Existing ID Feature\n\n## Context\n\nThis is a feature with existing ID.\n",
        access: async () => {},
        writeFile: async (path: unknown) => {
          mockFileSystem.set(path, content);
        },
        mkdir: async () => {},
        unlink: async () => {},
        readdir: async () => [],
      },
    }));

    // Mock parseTasks to return tasks with other IDs
    spyOn(taskBackend, "parseTasks").mockImplementation(async () => [
      { id: "#001", title: "First Task", description: "", status: TASK_STATUS.TODO },
      { id: "#002", title: "Second Task", description: "", status: TASK_STATUS.TODO },
    ]);

    // Mock getTask to return null (no existing task with this ID)
    spyOn(taskBackend, "getTask").mockImplementation(async () => null);

    const task = await taskBackend.createTask(_specPath);

    expect(task).toBeDefined();
    expect(task.id).toBe("#042"); // Should keep the specified ID
    expect(task.title).toBe("Existing ID Feature");
    expect(task.status).toBe(TASK_STATUS.TODO);

    // Check that the title was not modified in the file
    const updatedContent = mockFileSystem.get(newSpecPath);
    expect(updatedContent).toBeDefined();
    expect(typeof updatedContent === "string").toBe(true);
    if (updatedContent && typeof updatedContent === "string") {
      expect(updatedContent.includes("# Task #042: Existing ID Feature")).toBe(true);
    }
  });

  it("should throw error if task ID already exists", async () => {
    const _specPath = path.join(_workspacePath, "process/tasks/duplicate-id-spec.md");

    // Mock fs.readFile to return content with task ID
    mock.module("fs", () => ({
      promises: {
        readFile: async () =>
          "# Task #001: Duplicate ID\n\n## Context\n\nThis has a duplicate ID.\n",
        access: async () => {},
      },
    }));

    // Mock getTask to return an existing task with this ID
    spyOn(taskBackend, "getTask").mockImplementation(async () => ({
      id: "#001",
      title: "Existing Task",
      description: "",
      status: TASK_STATUS.TODO,
    }));

    await expect(taskBackend.createTask(_specPath)).rejects.toThrow("Task #001 already exists");
  });

  it("should allow force creation even if task ID already exists", async () => {
    const _specPath = path.join(_workspacePath, "process/tasks/force-duplicate-spec.md");

    // Mock fs.readFile to return content with task ID
    mock.module("fs", () => ({
      promises: {
        readFile: async () =>
          "# Task #001: Force Duplicate\n\n## Context\n\nThis has a duplicate ID but force is used.\n",
        access: async () => {},
        writeFile: async () => {},
        mkdir: async () => {},
        unlink: async () => {},
        readdir: async () => [],
      },
    }));

    // Mock getTask to return an existing task with this ID
    spyOn(taskBackend, "getTask").mockImplementation(async () => ({
      id: "#001",
      title: "Existing Task",
      description: "",
      status: TASK_STATUS.TODO,
    }));

    const task = await taskBackend.createTask(_specPath, { force: true });

    expect(task).toBeDefined();
    expect(task.id).toBe("#001"); // Should keep the specified ID despite conflict
    expect(task._title).toBe("Force Duplicate");
  });
});
