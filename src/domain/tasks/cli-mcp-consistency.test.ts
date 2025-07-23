/**
 * CLI-MCP Task Database Consistency Test
 *
 * Bug: CLI and MCP task operations use different databases, causing inconsistent results
 *
 * Steps to reproduce:
 * 1. CLI task commands fall back to local workspace (process.cwd())
 * 2. MCP task commands use special workspace
 * 3. This causes different task data to be returned for the same task ID
 *
 * Expected behavior: ALL task operations should use the same special workspace database
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { listTasksFromParams, getTaskFromParams } from "./taskCommands";
import { createSpecialWorkspaceManager } from "../workspace/special-workspace-manager";
import { join } from "path";
import { writeFile, mkdir, rm } from "fs/promises";
import { existsSync } from "fs";
import { createMarkdownTaskBackend } from "./markdownTaskBackend";
import type { BackendCapabilities } from "./types";

describe("CLI-MCP Task Database Consistency Bug", () => {
  const testRepoUrl = "https://github.com/test/minsky-consistency-test.git";
  let specialWorkspacePath: string;
  let localWorkspacePath: string;
  let cleanupPaths: string[] = [];

  beforeEach(async () => {
    // Set up test scenario with different task databases

    // 1. Create a mock special workspace path (simulate existing special workspace)
    specialWorkspacePath = join("/tmp", "minsky-special-workspace-test");
    cleanupPaths.push(specialWorkspacePath);

    // Create special workspace task database
    const specialTasksDir = join(specialWorkspacePath, "process");
    await mkdir(specialTasksDir, { recursive: true });

    const specialTasksContent = `# Tasks

## Active Tasks

- [x] Special workspace task [#999](process/tasks/999-special-workspace-task.md)
`;

    await writeFile(join(specialTasksDir, "tasks.md"), specialTasksContent);

    // 2. Create a local workspace with different tasks (simulating CLI fallback behavior)
    localWorkspacePath = join("/tmp", "minsky-cli-test-workspace");
    cleanupPaths.push(localWorkspacePath);

    const localTasksDir = join(localWorkspacePath, "process");
    await mkdir(localTasksDir, { recursive: true });

    const localTasksContent = `# Tasks

## Active Tasks

- [x] Local workspace task [#999](process/tasks/999-local-workspace-task.md)
`;

    await writeFile(join(localTasksDir, "tasks.md"), localTasksContent);
  });

  afterEach(async () => {
    // Clean up test workspaces
    for (const path of cleanupPaths) {
      if (existsSync(path)) {
        await rm(path, { recursive: true, force: true });
      }
    }
    cleanupPaths = [];
  });

  test("BUG: CLI and MCP should return identical task data for same task ID", async () => {
    // This test documents the bug where CLI and MCP return different task data

    const taskId = "999";

    // Mock dependencies to simulate CLI behavior (using local workspace)
    const cliDeps = {
      resolveRepoPath: async () => localWorkspacePath,
      resolveTaskWorkspacePath: async () => localWorkspacePath, // CLI fallback behavior
      createTaskService: async (options: any) => {
        const { MarkdownTaskBackend } = await import("./markdown-task-backend");
        const backend = new MarkdownTaskBackend(options.workspacePath);
        return {
          getTask: async (id: string) => backend.getTask(id),
          listTasks: async () => backend.listTasks(),
        } as any;
      },
    };

    // Mock dependencies to simulate MCP behavior (using special workspace)
    const mcpDeps = {
      resolveRepoPath: async () => testRepoUrl,
      resolveTaskWorkspacePath: async () => specialWorkspacePath, // MCP behavior
      createTaskService: async (options: any) => {
        const { MarkdownTaskBackend } = await import("./markdown-task-backend");
        const backend = new MarkdownTaskBackend(options.workspacePath);
        return {
          getTask: async (id: string) => backend.getTask(id),
          listTasks: async () => backend.listTasks(),
        } as any;
      },
    };

    // Get task data from CLI perspective
    const cliTask = await getTaskFromParams({ taskId }, cliDeps);

    // Get task data from MCP perspective
    const mcpTask = await getTaskFromParams({ taskId }, mcpDeps);

    // BUG: This test should fail because CLI and MCP return different data
    // Expected: Both should return identical task data from special workspace
    // Actual: CLI returns local workspace data, MCP returns special workspace data
    expect(cliTask.title).toBe(mcpTask.title); // This will FAIL until bug is fixed
    expect(cliTask.specPath).toBe(mcpTask.specPath); // This will FAIL until bug is fixed

    // Additional verification: Both should be using special workspace data
    expect(cliTask.title).toBe("Special workspace task"); // CLI should use special workspace
    expect(mcpTask.title).toBe("Special workspace task"); // MCP already uses special workspace
  });

  test("BUG: Task list should be identical between CLI and MCP", async () => {
    // This test verifies that task listings are consistent

    // Mock CLI dependencies (local workspace fallback)
    const cliDeps = {
      resolveRepoPath: async () => localWorkspacePath,
      resolveTaskWorkspacePath: async () => localWorkspacePath,
      createTaskService: async (options: any) => {
        const { MarkdownTaskBackend } = await import("./markdown-task-backend");
        const backend = new MarkdownTaskBackend(options.workspacePath);
        return {
          listTasks: async () => backend.listTasks(),
        } as any;
      },
    };

    // Mock MCP dependencies (special workspace)
    const mcpDeps = {
      resolveRepoPath: async () => testRepoUrl,
      resolveTaskWorkspacePath: async () => specialWorkspacePath,
      createTaskService: async (options: any) => {
        const { MarkdownTaskBackend } = await import("./markdown-task-backend");
        const backend = new MarkdownTaskBackend(options.workspacePath);
        return {
          listTasks: async () => backend.listTasks(),
        } as any;
      },
    };

    // Get task lists from both perspectives
    const cliTasks = await listTasksFromParams({ all: true }, cliDeps);
    const mcpTasks = await listTasksFromParams({ all: true }, mcpDeps);

    // BUG: This should fail because CLI and MCP return different task lists
    expect(cliTasks.length).toBe(mcpTasks.length); // Will FAIL - different number of tasks
    expect(cliTasks.map((t) => t.title)).toEqual(mcpTasks.map((t) => t.title)); // Will FAIL - different tasks
  });

  test("EXPECTED: All task operations should use special workspace path", async () => {
    // This test defines the expected behavior after the bug is fixed

    const params = { taskId: "999" };

    // Create deps that should force special workspace usage
    const fixedDeps = {
      resolveRepoPath: async () => testRepoUrl,
      resolveTaskWorkspacePath: async () => {
        // After fix: should ALWAYS return special workspace path
        return specialWorkspacePath;
      },
      createTaskService: async (options: any) => {
        // Verify that the workspace path is always special workspace
        expect(options.workspacePath).toBe(specialWorkspacePath);

        const { MarkdownTaskBackend } = await import("./markdown-task-backend");
        const backend = new MarkdownTaskBackend(options.workspacePath);
        return {
          getTask: async (id: string) => backend.getTask(id),
          listTasks: async () => backend.listTasks(),
        } as any;
      },
    };

    // This should work once the bug is fixed
    const task = await getTaskFromParams(params, fixedDeps);

    // Should return special workspace task data
    expect(task.title).toBe("Special workspace task");
    expect(task.specPath).toContain("999-special-workspace-task.md");
  });
});

describe("Backend Capabilities System (Task #315)", () => {
  describe("MarkdownTaskBackend capabilities", () => {
    test("should report accurate capabilities", () => {
      // Create markdown backend
      const backend = createMarkdownTaskBackend({
        name: "markdown",
        workspacePath: "/tmp/test",
      });

      // Get capabilities
      const capabilities: BackendCapabilities = backend.getCapabilities();

      // Verify capabilities are accurately reported
      expect(capabilities.supportsTaskCreation).toBe(true);
      expect(capabilities.supportsTaskUpdate).toBe(true);
      expect(capabilities.supportsTaskDeletion).toBe(true);
      expect(capabilities.supportsStatus).toBe(true);

      // Structural metadata not yet implemented
      expect(capabilities.supportsSubtasks).toBe(false);
      expect(capabilities.supportsDependencies).toBe(false);

      // Provenance metadata not yet implemented
      expect(capabilities.supportsOriginalRequirements).toBe(false);
      expect(capabilities.supportsAiEnhancementTracking).toBe(false);

      // Query capabilities
      expect(capabilities.supportsMetadataQuery).toBe(false);
      expect(capabilities.supportsFullTextSearch).toBe(true);

      // Update mechanism
      expect(capabilities.requiresSpecialWorkspace).toBe(true);
      expect(capabilities.supportsTransactions).toBe(false);
      expect(capabilities.supportsRealTimeSync).toBe(false);
    });

    test("should provide capabilities discovery for backend selection", () => {
      const backend = createMarkdownTaskBackend({
        name: "markdown",
        workspacePath: "/tmp/test",
      });

      const capabilities = backend.getCapabilities();

      // This test demonstrates how the capability system could be used
      // for intelligent backend selection based on requirements

      if (capabilities.supportsDependencies) {
        // This backend can handle task dependencies
        console.log("Backend supports dependencies");
      } else {
        // Need a different backend or upgrade this one
        console.log(
          "Backend does not support dependencies - use JSON backend or implement feature"
        );
      }

      if (capabilities.requiresSpecialWorkspace) {
        // Special handling needed for this backend
        console.log("Backend requires special workspace management");
      }
    });
  });
});
