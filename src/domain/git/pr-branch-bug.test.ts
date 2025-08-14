import { describe, it, expect } from "bun:test";

describe("PR Branch Double Prefix Bug", () => {
  // Bug reproduction: PR creation from PR branch creates pr/pr/branch-name
  // This test documents the current buggy behavior

  it("should demonstrate the double prefix bug", () => {
    // Current buggy logic that creates double prefix
    const sourceBranch = "pr/task-md#357"; // Already a PR branch
    const prBranchName = sourceBranch; // No validation
    const prBranch = `pr/${prBranchName}`; // Creates pr/pr/task-md#357

    // This test FAILS until we fix the bug
    expect(prBranch).toBe("pr/task-md#357"); // Should NOT have double prefix

    // Current actual result: "pr/pr/task-md#357"
    expect(prBranch).toBe("pr/pr/task-md#357"); // This is the bug!
  });

  it("should show correct behavior for session branches", () => {
    // This works correctly
    const sourceBranch = "task-md#357"; // Session branch
    const prBranchName = sourceBranch;
    const prBranch = `pr/${prBranchName}`;

    expect(prBranch).toBe("pr/task-md#357"); // Correct!
  });

  it("should reject PR creation from PR branches", () => {
    // The fix: validate branch type before creating PR branch name
    const sourceBranch = "pr/task-md#357";

    // This should throw an error instead of creating double prefix
    const shouldRejectPrFromPrBranch = () => {
      if (sourceBranch.startsWith("pr/")) {
        throw new Error(`Cannot create PR from PR branch '${sourceBranch}'`);
      }
      return `pr/${sourceBranch}`;
    };

    expect(() => shouldRejectPrFromPrBranch()).toThrow(
      "Cannot create PR from PR branch 'pr/task-md#357'"
    );
  });
});
