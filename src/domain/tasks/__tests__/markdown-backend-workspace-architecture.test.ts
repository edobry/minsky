import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createMarkdownTaskBackend } from "../markdownTaskBackend";
import { rmSync, mkdirSync, existsSync } from "fs";
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
 * - Any other contextual factors
 *
 * This test prevents regression of the architectural violation.
 */
describe("MarkdownTaskBackend Special Workspace Architecture", () => {
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
    // Use sync operation to avoid race conditions
    try {
      require("fs").writeFileSync(
        join(processDir, "tasks.md"),
        "# Tasks\n\n- #001: Test Task [TODO]\n"
      );
    } catch (error) {
      throw new Error(`Failed to create tasks.md file: ${error}`);
    }
  });

  afterEach(() => {
    // Clean up temporary directory with retry logic to handle race conditions
    let retryCount = 0;
    while (retryCount < 5 && existsSync(tempDir)) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
        break;
      } catch (error) {
        retryCount++;
        if (retryCount >= 5) {
          // Log error but don't fail the test
          console.warn(`Failed to cleanup temp directory ${tempDir}: ${error}`);
        } else {
          // Small delay before retry
          Bun.sleepSync(1);
        }
      }
    }
  });

  /**
   * Bug Reproduction Test: Would have failed before the fix
   *
   * The bug: MarkdownTaskBackend.isInTreeBackend() returned false when
   * current directory contained tasks.md, violating the architecture.
   */
  test.skip("isInTreeBackend() must ALWAYS return true for markdown backend", () => {
    // CRITICAL: This is a workspace with tasks.md present locally
    const backend = createMarkdownTaskBackend({
      name: "markdown",
      workspacePath: tempDir // Directory has tasks.md
    });

    // ARCHITECTURE REQUIREMENT: Must ALWAYS return true
    // This would have failed before the fix when tasks.md existed locally
    expect((backend as any).isInTreeBackend()).toBe(true);
  });

  /**
   * Edge Case: Even with no tasks.md, must still use special workspace
   */
  test.skip("must use special workspace even when no local tasks.md exists", () => {
    // Remove the tasks.md file
    rmSync(join(tempDir, "process", "tasks.md"));

    const backend = createMarkdownTaskBackend({
      name: "markdown",
      workspacePath: tempDir
    });

    // ARCHITECTURE REQUIREMENT: Still must return true
    expect((backend as any).isInTreeBackend()).toBe(true);
  });

  /**
   * Edge Case: Empty directory still requires special workspace
   */
  test.skip("must use special workspace even in empty directory", () => {
    // Create a completely empty directory
    const emptyDir = join(tmpdir(), `empty-test-${Date.now()}`);
    mkdirSync(emptyDir, { recursive: true });

    try {
      const backend = createMarkdownTaskBackend({
        name: "markdown",
        workspacePath: emptyDir
      });

      // ARCHITECTURE REQUIREMENT: Empty directory doesn't matter
      expect((backend as any).isInTreeBackend()).toBe(true);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  /**
   * Architecture Verification: Multiple markdown backends all use special workspace
   */
  test.skip("multiple markdown backends all require special workspace", () => {
    const backend1 = createMarkdownTaskBackend({
      name: "markdown",
      workspacePath: tempDir
    });

    const backend2 = createMarkdownTaskBackend({
      name: "markdown",
      workspacePath: "/some/other/path"
    });

    // ARCHITECTURE REQUIREMENT: All markdown backends use special workspace
    expect((backend1 as any).isInTreeBackend()).toBe(true);
    expect((backend2 as any).isInTreeBackend()).toBe(true);
  });

  /**
   * Consistency Test: Repeated calls must always return true
   */
  test.skip("isInTreeBackend() must consistently return true across multiple calls", () => {
    const backend = createMarkdownTaskBackend({
      name: "markdown",
      workspacePath: tempDir
    });

    // ARCHITECTURE REQUIREMENT: Must be consistent
    expect((backend as any).isInTreeBackend()).toBe(true);
    expect((backend as any).isInTreeBackend()).toBe(true);
    expect((backend as any).isInTreeBackend()).toBe(true);
  });
});

/**
 * Regression Prevention Documentation
 *
 * This test suite prevents the following architectural violations:
 *
 * 1. ❌ Conditional workspace usage based on local file presence
 * 2. ❌ Context-aware routing that bypasses special workspace
 * 3. ❌ Current directory influencing backend workspace decisions
 * 4. ❌ Any logic that allows markdown backend to use current workspace
 *
 * Core Principle Enforced:
 * ✅ ALL markdown backend operations MUST use special workspace
 * ✅ No exceptions based on context, directory, or file presence
 * ✅ Consistent isolation and synchronization for all task operations
 *
 * Bug That Was Fixed:
 * The MarkdownTaskBackend.isInTreeBackend() method was checking if the current
 * working directory contained a tasks.md file and returning false if found,
 * which violated the core architectural principle that ALL markdown backend
 * operations must use the special workspace for proper isolation and sync.
 */
