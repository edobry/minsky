import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createMarkdownTaskBackend } from "./markdownTaskBackend";
import { TASK_STATUS } from "./taskConstants";
// Use mock.module() to mock filesystem operations
import { promises as fs } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("MarkdownTaskBackend filtering regression test", () => {
  let backend: any;
  let testDir: string;
  let tasksFile: string;

  beforeEach(async () => {
    // Create temporary directory for test
    testDir = join(
      tmpdir(),
      `minsky-test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    );
    await fs.mkdir(testDir, { recursive: true });
    await fs.mkdir(join(testDir, "process"), { recursive: true });

    tasksFile = join(testDir, "process", "tasks.md");

    // Create test tasks file with mixed statuses
    const tasksContent = `- [x] Task 1 DONE [md#001](process/tasks/md#001-task-1.md)
- [ ] Task 2 TODO [md#002](process/tasks/md#002-task-2.md)
- [+] Task 3 IN-PROGRESS [md#003](process/tasks/md#003-task-3.md)
- [x] Task 4 DONE [md#004](process/tasks/md#004-task-4.md)
- [!] Task 5 CLOSED [md#005](process/tasks/md#005-task-5.md)
- [~] Task 6 BLOCKED [md#006](process/tasks/md#006-task-6.md)
`;

    await fs.writeFile(tasksFile, tasksContent);

    backend = createMarkdownTaskBackend({
      name: "markdown",
      workspacePath: testDir,
    });
  });

  afterEach(async () => {
    // Clean up
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  it("should filter out DONE and CLOSED tasks by default (FIXED)", async () => {
    // REGRESSION FIX: The markdown backend now properly filters out DONE/CLOSED tasks by default
    // using the shared filterTasksByStatus function for consistent behavior across backends

    const tasks = await backend.listTasks(); // No options = should filter by default

    // Expected: Only TODO, IN-PROGRESS, and BLOCKED tasks (not DONE/CLOSED)
    const expectedStatuses = [TASK_STATUS.TODO, TASK_STATUS.IN_PROGRESS, TASK_STATUS.BLOCKED];
    const actualStatuses = tasks.map((t: any) => t.status);

    // This test now passes after implementing the fix
    expect(actualStatuses).toEqual(expectedStatuses);
    expect(actualStatuses).not.toContain(TASK_STATUS.DONE);
    expect(actualStatuses).not.toContain(TASK_STATUS.CLOSED);
    expect(tasks).toHaveLength(3); // Should be 3 tasks, not 6
  });

  it("should include all tasks when all=true", async () => {
    const tasks = await backend.listTasks({ all: true });

    // With all=true, should get all 6 tasks including DONE/CLOSED
    expect(tasks).toHaveLength(6);
    const statuses = tasks.map((t: any) => t.status);
    expect(statuses).toContain(TASK_STATUS.DONE);
    expect(statuses).toContain(TASK_STATUS.CLOSED);
  });

  it("should filter to specific status when requested", async () => {
    const doneTasks = await backend.listTasks({ status: TASK_STATUS.DONE });

    expect(doneTasks).toHaveLength(2);
    doneTasks.forEach((task: any) => {
      expect(task.status).toBe(TASK_STATUS.DONE);
    });
  });
});
