/**
 * Tests for task command functions
 * 
 * This test reproduces the bug where getTaskStatusFromParams returns null
 * instead of "BLOCKED" for task 155 which has [~] status in the file.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { getTaskStatusFromParams } from "../taskCommands";
import { TASK_STATUS } from "../taskConstants";
import path from "path";
import fs from "fs/promises";

describe("getTaskStatusFromParams", () => {
  const testWorkspacePath = "/tmp/test-minsky-workspace";
  const testTasksFile = path.join(testWorkspacePath, "process", "tasks.md");
  
  // Helper function to create a complete mock TaskService
  const createMockTaskService = (mockGetTask: (taskId: unknown) => Promise<any>) => ({
    getTask: mockGetTask,
    backends: [],
    currentBackend: "test",
    listTasks: async () => [],
    getTaskStatus: async () => null,
    setTaskStatus: async () => {},
    createTask: async () => ({}),
    deleteTask: async () => {},
    updateTaskSpecContent: async () => {},
    getTaskSpecContent: async () => ({ task: {}, specPath: "", content: "" }),
    exportTasks: async () => ({}),
    importTasks: async () => ({})
  } as any);

  beforeEach(async () => {
    // Create test workspace structure
    await fs.mkdir(path.join(testWorkspacePath, "process"), { recursive: true });
    
    // Create a test tasks.md file with task 155 having BLOCKED status
    const tasksContent = `# Tasks

## Active Tasks

- [~] Add BLOCKED Status Support [#155](process/tasks/155-add-blocked-status-support.md)
- [ ] Some other task [#156](process/tasks/156-other-task.md)
- [+] In progress task [#157](process/tasks/157-in-progress.md)
- [x] Done task [#158](process/tasks/158-done-task.md)
`;
    
    await fs.writeFile(testTasksFile, tasksContent, "utf8");
  });
  
  afterEach(async () => {
    // Clean up test workspace
    try {
      await fs.rm(testWorkspacePath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  test("should return BLOCKED status for task 155 with [~] checkbox", async () => {
    const params = {
      taskId: "155",
      json: false,
    };

    const mockDeps = {
      resolveRepoPath: async (options: any) => testWorkspacePath,
      resolveMainWorkspacePath: async () => testWorkspacePath,
      createTaskService: async (options: any) => createMockTaskService(async (taskId: unknown) => {
        // taskId comes in as "#155" after normalization
        const tasksContent = await fs.readFile(testTasksFile, "utf8");
        const lines = tasksContent.split("\n");
        
        for (const line of lines) {
          if (line.includes(`[${taskId}]`)) { // taskId already includes the #
            const checkboxMatch = line.match(/- \[(.)\]/);
            if (checkboxMatch) {
              const checkbox = checkboxMatch[1];
              let status: string;
              switch (checkbox) {
              case " ": status = TASK_STATUS.TODO; break;
              case "+": status = TASK_STATUS.IN_PROGRESS; break;
              case "-": status = TASK_STATUS.IN_REVIEW; break;
              case "x": status = TASK_STATUS.DONE; break;
              case "~": status = TASK_STATUS.BLOCKED; break;
              default: return null;
              }
              return { id: taskId, status };
            }
          }
        }
        return null;
      })
    };

    const result = await getTaskStatusFromParams(params, mockDeps);
    expect(result).toBe(TASK_STATUS.BLOCKED);
  });

  test("should return TODO status for task with [ ] checkbox", async () => {
    const params = {
      taskId: "156",
      json: false,
    };

    const mockDeps = {
      resolveRepoPath: async (options: any) => testWorkspacePath,
      resolveMainWorkspacePath: async () => testWorkspacePath,
      createTaskService: async (options: any) => createMockTaskService(async (taskId: unknown) => {
        const tasksContent = await fs.readFile(testTasksFile, "utf8");
        const lines = tasksContent.split("\n");
        
        for (const line of lines) {
          if (line.includes(`[${taskId}]`)) {
            const checkboxMatch = line.match(/- \[(.)\]/);
            if (checkboxMatch) {
              const checkbox = checkboxMatch[1];
              let status: string;
              switch (checkbox) {
              case " ": status = TASK_STATUS.TODO; break;
              case "+": status = TASK_STATUS.IN_PROGRESS; break;
              case "-": status = TASK_STATUS.IN_REVIEW; break;
              case "x": status = TASK_STATUS.DONE; break;
              case "~": status = TASK_STATUS.BLOCKED; break;
              default: return null;
              }
              return { id: taskId, status };
            }
          }
        }
        return null;
      })
    };

    const result = await getTaskStatusFromParams(params, mockDeps);
    expect(result).toBe(TASK_STATUS.TODO);
  });

  test("should return IN_PROGRESS status for task with [+] checkbox", async () => {
    const params = {
      taskId: "157",
      json: false,
    };

    const mockDeps = {
      resolveRepoPath: async (options: any) => testWorkspacePath,
      resolveMainWorkspacePath: async () => testWorkspacePath,
      createTaskService: async (options: any) => createMockTaskService(async (taskId: unknown) => {
        const tasksContent = await fs.readFile(testTasksFile, "utf8");
        const lines = tasksContent.split("\n");
        
        for (const line of lines) {
          if (line.includes(`[${taskId}]`)) {
            const checkboxMatch = line.match(/- \[(.)\]/);
            if (checkboxMatch) {
              const checkbox = checkboxMatch[1];
              let status: string;
              switch (checkbox) {
              case " ": status = TASK_STATUS.TODO; break;
              case "+": status = TASK_STATUS.IN_PROGRESS; break;
              case "-": status = TASK_STATUS.IN_REVIEW; break;
              case "x": status = TASK_STATUS.DONE; break;
              case "~": status = TASK_STATUS.BLOCKED; break;
              default: return null;
              }
              return { id: taskId, status };
            }
          }
        }
        return null;
      })
    };

    const result = await getTaskStatusFromParams(params, mockDeps);
    expect(result).toBe(TASK_STATUS.IN_PROGRESS);
  });

  test("should return DONE status for task with [x] checkbox", async () => {
    const params = {
      taskId: "158",
      json: false,
    };

    const mockDeps = {
      resolveRepoPath: async (options: any) => testWorkspacePath,
      resolveMainWorkspacePath: async () => testWorkspacePath,
      createTaskService: async (options: any) => createMockTaskService(async (taskId: unknown) => {
        const tasksContent = await fs.readFile(testTasksFile, "utf8");
        const lines = tasksContent.split("\n");
        
        for (const line of lines) {
          if (line.includes(`[${taskId}]`)) {
            const checkboxMatch = line.match(/- \[(.)\]/);
            if (checkboxMatch) {
              const checkbox = checkboxMatch[1];
              let status: string;
              switch (checkbox) {
              case " ": status = TASK_STATUS.TODO; break;
              case "+": status = TASK_STATUS.IN_PROGRESS; break;
              case "-": status = TASK_STATUS.IN_REVIEW; break;
              case "x": status = TASK_STATUS.DONE; break;
              case "~": status = TASK_STATUS.BLOCKED; break;
              default: return null;
              }
              return { id: taskId, status };
            }
          }
        }
        return null;
      })
    };

    const result = await getTaskStatusFromParams(params, mockDeps);
    expect(result).toBe(TASK_STATUS.DONE);
  });

  test("should throw ResourceNotFoundError for non-existent task", async () => {
    const params = {
      taskId: "999",
      json: false,
    };

    const mockDeps = {
      resolveRepoPath: async (options: any) => testWorkspacePath,
      resolveMainWorkspacePath: async () => testWorkspacePath,
      createTaskService: async (options: any) => createMockTaskService(async () => null) // Task not found
    };

    await expect(getTaskStatusFromParams(params, mockDeps)).rejects.toThrow("Task #999 not found or has no status");
  });
}); 
