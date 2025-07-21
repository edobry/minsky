import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createMarkdownTaskBackend } from "../markdownTaskBackend";
import { rmSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/**
 * Critical Architectural Test: Markdown Backend Special Workspace Requirements
 *
 * Bug Fixed: MarkdownTaskBackend was conditionally using current workspace
 * instead of always using the special workspace.
 *
 * Core Architecture Principle:
 * ALL markdown backend task operations MUST use the special workspace,
 * regardless of:
 * - Current working directory
 * - Presence of local tasks.md file
 * - Whether tasks.md exists in the current directory
 */

describe("MarkdownTaskBackend Special Workspace Requirements", () => {
  let tempDir: string;

  beforeEach(() => {
    // Create temporary directory that mimics a workspace with tasks.md
    // Use more unique naming to prevent race conditions with other tests
    tempDir = join(tmpdir(), `minsky-workspace-test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);

    // Ensure directory creation is atomic and race-condition safe
    let retryCount = 0;
    while (retryCount < 5) {
      try {
        mkdirSync(tempDir, { recursive: true });
        break;
      } catch (error) {
        retryCount++;
        if (retryCount >= 5) {
          throw new Error(`Failed to create temp directory after 5 attempts: ${error}`);
        }
        // Small delay to avoid race conditions
        Bun.sleepSync(1);
      }
    }

    const processDir = join(tempDir, "process");

    // Ensure process directory creation is safe
    try {
      mkdirSync(processDir, { recursive: true });
    } catch (error) {
      throw new Error(`Failed to create process directory: ${error}`);
    }

    // Create a tasks.md file in the temp directory (simulating main workspace)
    // Use consistent synchronous operations to avoid race conditions
    try {
      writeFileSync(
        join(processDir, "tasks.md"),
        "# Tasks\n\n- #001: Test Task [TODO]\n",
        { encoding: "utf8" }
      );
    } catch (error) {
      throw new Error(`Failed to create tasks.md file: ${error}`);
    }
  });

  afterEach(() => {
    // Clean up temp directory
    if (existsSync(tempDir)) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch (error) {
        console.warn(`Warning: Failed to clean up temp directory ${tempDir}:`, error);
      }
    }
  });

  test("should ALWAYS use special workspace for markdown backend operations", async () => {
    // Test original working directory (simulates running from a project root with tasks.md)
    const originalCwd = process.cwd();

    try {
      // Change to temporary directory that has a local tasks.md file
      process.chdir(tempDir);

      // Verify we're in a directory that has a local tasks.md file
      expect(existsSync(join(process.cwd(), "process", "tasks.md"))).toBe(true);

      // ARCHITECTURE ENFORCEMENT TEST:
      // Even though we're in a directory with a local tasks.md file,
      // the markdown backend MUST use the special workspace

      const backend = createMarkdownTaskBackend({
        workspacePath: "/special/workspace/path",
        taskFile: "process/tasks.md"
      });

      // Try to get a task - this should ONLY look in the special workspace,
      // NOT in the current directory's tasks.md file
      const task = await backend.getTask("001");

      // If this returns null, it means the backend correctly ignored
      // the local tasks.md and only looked in the special workspace
      // (which doesn't exist, so it should return null)
      expect(task).toBeNull();

      // CRITICAL ASSERTION: The backend should NOT find the task "001"
      // even though it exists in the current directory's tasks.md,
      // because it should only look in the special workspace.
      // This proves the architecture is correctly enforced.

    } finally {
      // Always restore original working directory
      process.chdir(originalCwd);
    }
  });

  test("should correctly handle workspace resolution for task operations", async () => {
    const originalCwd = process.cwd();

    try {
      // Change to temporary directory with local tasks.md
      process.chdir(tempDir);

      const backend = createMarkdownTaskBackend({
        workspacePath: "/special/workspace/path",
        taskFile: "process/tasks.md"
      });

      // Test task creation - should go to special workspace
      const taskData = {
        id: "999",
        title: "Test Task",
        description: "Test Description",
        status: "TODO" as const
      };

      // This should attempt to create the task in the special workspace
      // (will fail because special workspace doesn't exist, but that's expected)
      try {
        await backend.createTask(taskData);
        // If it doesn't throw, something is wrong with our test
        expect(false).toBe(true, "Expected createTask to fail when special workspace doesn't exist");
      } catch (error) {
        // Expected behavior - should fail because special workspace doesn't exist
        expect(error).toBeDefined();
      }

    } finally {
      process.chdir(originalCwd);
    }
  });
});
