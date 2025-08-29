/**
 * Test for Prepared Merge Commit Workflow - Uncommitted Changes Handling
 *
 * CRITICAL REQUIREMENT: The workflow must handle uncommitted changes properly
 * to avoid "Your local changes would be overwritten by checkout" errors.
 *
 * Expected behavior:
 * 1. Check for uncommitted changes before any git checkout operations
 * 2. Stash uncommitted changes if they exist
 * 3. Perform the prepared merge commit workflow
 * 4. Restore stashed changes at the end (success or error)
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { GIT_TEST_PATTERNS } from "../../utils/test-utils/test-constants";
import {
  createPreparedMergeCommitPR,
  type PreparedMergeCommitOptions,
} from "./prepared-merge-commit-workflow";

// Mock git command results for verification
const gitCommands: Array<{ operation: string; command: string }> = [];
let mockGitExec: any;

describe("Prepared Merge Commit Workflow - Uncommitted Changes Handling", () => {
  beforeEach(async () => {
    gitCommands.length = 0; // Clear previous commands

    // Mock git execution to capture commands
    mockGitExec = async (operation: string, command: string, options: any) => {
      gitCommands.push({ operation, command });

      // Mock different git command responses
      if (operation === "status") {
        // Simulate uncommitted changes
        return { stdout: "M  src/file1.ts\nA  src/file2.ts\n", stderr: "" };
      } else if (operation === "stash-list") {
        // Simulate stash exists with dynamic name
        const stashEntries = gitCommands.filter((cmd) => cmd.command.startsWith("stash push -m"));
        if (stashEntries.length > 0) {
          const stashMessage =
            stashEntries[stashEntries.length - 1].command.match(/"([^"]+)"/)?.[1] ||
            "prepared-merge";
          return { stdout: `stash@{0}: On branch: ${stashMessage}`, stderr: "" };
        } else {
          return { stdout: "", stderr: "" };
        }
      } else {
        // Return successful response for all other commands
        return { stdout: "", stderr: "" };
      }
    };
  });

  test("should detect and stash uncommitted changes before checkout operations", async () => {
    const options: PreparedMergeCommitOptions = {
      title: "feat(#161): Test uncommitted changes handling",
      body: "This test verifies stash/restore behavior with uncommitted changes",
      sourceBranch: "task161",
      baseBranch: "main",
      workdir: "/tmp/test-repo",
    };

    await createPreparedMergeCommitPR(options, {
      execGitWithTimeout: mockGitExec,
    });

    // Verify git command sequence includes stash operations
    const commandSequence = gitCommands.map((cmd) => cmd.command);

    // Should check for uncommitted changes first
    expect(commandSequence).toContain("status --porcelain");

    // Should stash uncommitted changes
    expect(commandSequence.some((cmd) => cmd.startsWith("stash push -m"))).toBe(true);

    // Should perform normal workflow operations
    expect(commandSequence).toContain("switch task161");
    expect(commandSequence.some((cmd) => cmd.startsWith("branch pr/"))).toBe(true);
    expect(commandSequence.some((cmd) => cmd.startsWith("merge --no-ff"))).toBe(true);
    expect(commandSequence.some((cmd) => cmd.startsWith("push origin pr/"))).toBe(true);

    // Should restore stash at the end
    expect(commandSequence).toContain("stash list");
    expect(commandSequence).toContain(GIT_TEST_PATTERNS.STASH_POP);
  });

  test("should skip stashing when no uncommitted changes exist", async () => {
    // Mock no uncommitted changes
    mockGitExec = async (operation: string, command: string, options: any) => {
      gitCommands.push({ operation, command });

      if (operation === "status") {
        // No uncommitted changes
        return { stdout: "", stderr: "" };
      } else {
        return { stdout: "", stderr: "" };
      }
    };

    const options: PreparedMergeCommitOptions = {
      title: "feat(#161): Test clean working directory",
      body: "No uncommitted changes, should skip stashing",
      sourceBranch: "task161",
      baseBranch: "main",
      workdir: "/tmp/test-repo",
    };

    await createPreparedMergeCommitPR(options, {
      execGitWithTimeout: mockGitExec,
    });

    const commandSequence = gitCommands.map((cmd) => cmd.command);

    // Should check status
    expect(commandSequence).toContain("status --porcelain");

    // Should NOT stash anything
    expect(commandSequence.some((cmd) => cmd.startsWith("stash push"))).toBe(false);
    expect(commandSequence.some((cmd) => cmd.startsWith("stash pop"))).toBe(false);
  });

  test("should restore stash even if workflow fails", async () => {
    // Mock workflow failure after stashing
    mockGitExec = async (operation: string, command: string, options: any) => {
      gitCommands.push({ operation, command });

      if (operation === "status") {
        // Simulate uncommitted changes
        return { stdout: GIT_TEST_PATTERNS.GIT_STATUS_MODIFIED, stderr: "" };
      } else if (operation === "merge") {
        // Simulate merge conflict
        throw new Error("CONFLICT (content): Merge conflict in file.txt");
      } else if (operation === "stash-list") {
        const stashEntries = gitCommands.filter((cmd) => cmd.command.startsWith("stash push -m"));
        if (stashEntries.length > 0) {
          const stashMessage =
            stashEntries[stashEntries.length - 1].command.match(/"([^"]+)"/)?.[1] ||
            "prepared-merge";
          return { stdout: `stash@{0}: On branch: ${stashMessage}`, stderr: "" };
        } else {
          return { stdout: "", stderr: "" };
        }
      } else {
        return { stdout: "", stderr: "" };
      }
    };

    const options: PreparedMergeCommitOptions = {
      title: "feat(#161): Test error recovery with stash",
      body: "Should restore stash even if merge fails",
      sourceBranch: "task161",
      baseBranch: "main",
      workdir: "/tmp/test-repo",
    };

    // Expect the workflow to throw an error
    await expect(
      createPreparedMergeCommitPR(options, {
        execGitWithTimeout: mockGitExec,
      })
    ).rejects.toThrow("Failed to create prepared merge commit PR");

    const commandSequence = gitCommands.map((cmd) => cmd.command);

    // Should have stashed at the beginning
    expect(commandSequence.some((cmd) => cmd.startsWith("stash push"))).toBe(true);

    // Should attempt to restore stash even after error
    expect(commandSequence).toContain("stash list");
    expect(commandSequence).toContain(GIT_TEST_PATTERNS.STASH_POP);
  });

  test("should handle stash failures gracefully", async () => {
    // Mock stash operation failure
    mockGitExec = async (operation: string, command: string, options: any) => {
      gitCommands.push({ operation, command });

      if (operation === "status") {
        return { stdout: GIT_TEST_PATTERNS.GIT_STATUS_MODIFIED, stderr: "" };
      } else if (operation === "stash-push") {
        throw new Error("Stash failed - no local changes to save");
      } else {
        return { stdout: "", stderr: "" };
      }
    };

    const options: PreparedMergeCommitOptions = {
      title: "feat(#161): Test stash failure handling",
      body: "Should fail gracefully if stash operation fails",
      sourceBranch: "task161",
      baseBranch: "main",
      workdir: "/tmp/test-repo",
    };

    // Should throw error due to stash failure
    await expect(
      createPreparedMergeCommitPR(options, {
        execGitWithTimeout: mockGitExec,
      })
    ).rejects.toThrow("Failed to stash uncommitted changes");
  });

  test("should handle stash restoration failures gracefully", async () => {
    // Mock stash restore failure
    mockGitExec = async (operation: string, command: string, options: any) => {
      gitCommands.push({ operation, command });

      if (operation === "status") {
        return { stdout: GIT_TEST_PATTERNS.GIT_STATUS_MODIFIED, stderr: "" };
      } else if (operation === "stash-list") {
        const stashEntries = gitCommands.filter((cmd) => cmd.command.startsWith("stash push -m"));
        if (stashEntries.length > 0) {
          const stashMessage =
            stashEntries[stashEntries.length - 1].command.match(/"([^"]+)"/)?.[1] ||
            "prepared-merge";
          return { stdout: `stash@{0}: On branch: ${stashMessage}`, stderr: "" };
        } else {
          return { stdout: "", stderr: "" };
        }
      } else if (operation === "stash-pop") {
        throw new Error("Stash pop failed - merge conflicts");
      } else {
        return { stdout: "", stderr: "" };
      }
    };

    const options: PreparedMergeCommitOptions = {
      title: "feat(#161): Test stash restore failure handling",
      body: "Should not fail overall workflow if stash restore fails",
      sourceBranch: "task161",
      baseBranch: "main",
      workdir: "/tmp/test-repo",
    };

    // Should succeed despite stash restore failure
    const result = await createPreparedMergeCommitPR(options, {
      execGitWithTimeout: mockGitExec,
    });

    expect(result.state).toBe("open");
    expect(result.metadata?.workflow).toBe("prepared-merge-commit");

    // Should have attempted stash restore
    const commandSequence = gitCommands.map((cmd) => cmd.command);
    expect(commandSequence).toContain(GIT_TEST_PATTERNS.STASH_POP);
  });
});
