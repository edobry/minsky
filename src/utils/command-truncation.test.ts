/**
 * Tests for Command Truncation Utility
 */

import { describe, it, expect } from "bun:test";
import { truncateGitCommand, truncateWorkingDirectory } from "./command-truncation";

describe("truncateGitCommand", () => {
  it("should return short commands unchanged", () => {
    const command = "git status";
    const result = truncateGitCommand(command);
    expect(result).toBe(command);
  });

  it("should truncate long session workspace paths", () => {
    const command =
      "git -C /Users/edobry/.local/state/minsky/sessions/task362/very/long/path/to/some/deeply/nested/directory/structure/with/many/levels/and/subdirectories/containing/important/files/file.ts add . --verbose";
    const result = truncateGitCommand(command);

    expect(result).toContain("git -C");
    expect(result).toContain(".../sessions/task362");
    expect(result).toContain("add .");
    expect(result.length).toBeLessThanOrEqual(150);
  });

  it("should truncate long clone commands", () => {
    const command =
      "git clone https://github.com/very-long-organization-name/very-long-repository-name-with-many-words.git /Users/edobry/.local/state/minsky/sessions/task362/destination";
    const result = truncateGitCommand(command);

    expect(result).toContain("git clone");
    expect(result).toContain("github.com");
    expect(result.length).toBeLessThanOrEqual(150);
  });

  it("should handle working directory flag (-C) properly", () => {
    const command =
      "git -C /Users/edobry/.local/state/minsky/sessions/task123/src/domain/tasks/with/very/long/nested/path/structure/that/exceeds/normal/limits push origin main";
    const result = truncateGitCommand(command);

    expect(result).toContain("git -C");
    expect(result).toContain(".../sessions/task123");
    expect(result).toContain("push origin main");
    expect(result.length).toBeLessThanOrEqual(150);
  });

  it("should preserve essential git operations", () => {
    const command =
      "git -C /very/long/path/that/exceeds/normal/limits/and/should/be/truncated commit -m 'test message'";
    const result = truncateGitCommand(command);

    expect(result).toContain("git");
    expect(result).toContain("commit -m 'test message'");
    expect(result.length).toBeLessThanOrEqual(150);
  });

  it("should handle merge commands with long paths", () => {
    const command =
      "git -C /Users/edobry/.local/state/minsky/sessions/task362/some/deeply/nested/project/structure/with/additional/long/directory/names/that/create/a/very/verbose/path/structure merge --ff-only feature-branch";
    const result = truncateGitCommand(command);

    expect(result).toContain("git -C");
    expect(result).toContain(".../sessions/task362");
    expect(result).toContain("merge --ff-only feature-branch");
    expect(result.length).toBeLessThanOrEqual(150);
  });

  it("should preserve file extensions when truncating paths", () => {
    const command =
      "git add /Users/edobry/.local/state/minsky/sessions/task362/src/domain/tasks/task-service.ts";
    const result = truncateGitCommand(command);

    expect(result).toContain("git add");
    expect(result).toContain("task-service.ts");
    expect(result.length).toBeLessThanOrEqual(150);
  });

  it("should handle non-git commands gracefully", () => {
    const longCommand = `ls -la ${"/very/long/path/".repeat(20)}some-file.txt`;
    const result = truncateGitCommand(longCommand, { maxLength: 50 });

    expect(result.length).toBeLessThanOrEqual(50);
    expect(result).toContain("...");
  });

  it("should respect custom configuration", () => {
    const command = "git -C /Users/edobry/.local/state/minsky/sessions/task362/src add file.ts";
    const result = truncateGitCommand(command, {
      maxLength: 60,
      maxPathLength: 20,
      ellipsis: "…",
    });

    expect(result.length).toBeLessThanOrEqual(60);
    expect(result).toContain("…");
  });

  it("should handle multiple path arguments", () => {
    const command =
      "git diff /Users/edobry/.local/state/minsky/sessions/task362/src/file1.ts /Users/edobry/.local/state/minsky/sessions/task362/src/file2.ts";
    const result = truncateGitCommand(command);

    expect(result).toContain("git diff");
    expect(result.length).toBeLessThanOrEqual(150);
    // Should preserve both files if possible, or truncate appropriately
  });

  it("should handle push commands with remotes and branches", () => {
    const command =
      "git -C /Users/edobry/.local/state/minsky/sessions/task362/project push origin feature/very-long-feature-branch-name-that-might-be-verbose";
    const result = truncateGitCommand(command);

    expect(result).toContain("git -C");
    expect(result).toContain("push origin");
    expect(result.length).toBeLessThanOrEqual(150);
  });
});

describe("truncateWorkingDirectory", () => {
  it("should return short paths unchanged", () => {
    const path = "/Users/test";
    const result = truncateWorkingDirectory(path);
    expect(result).toBe(path);
  });

  it("should truncate long session workspace paths", () => {
    const path = "/Users/edobry/.local/state/minsky/sessions/task362/src/domain/tasks";
    const result = truncateWorkingDirectory(path);

    expect(result).toContain(".../sessions/task362");
    expect(result.length).toBeLessThanOrEqual(40);
  });

  it("should preserve file extensions in working directory paths", () => {
    const path =
      "/Users/edobry/.local/state/minsky/sessions/task362/src/very/deeply/nested/directory/structure/with/many/levels/file.ts";
    const result = truncateWorkingDirectory(path, { maxPathLength: 50 });

    expect(result).toContain("file.ts");
    expect(result.length).toBeLessThanOrEqual(50);
  });

  it("should handle very long directory names", () => {
    const path =
      "/Users/edobry/very-long-directory-name-that-exceeds-limits/another-long-directory/file.ts";
    const result = truncateWorkingDirectory(path);

    expect(result.length).toBeLessThanOrEqual(40);
    expect(result).toContain("...");
  });

  it("should respect custom configuration", () => {
    const path = "/Users/edobry/.local/state/minsky/sessions/task362/src/file.ts";
    const result = truncateWorkingDirectory(path, {
      maxPathLength: 25,
      ellipsis: "…",
      preserveExtensions: false,
    });

    expect(result.length).toBeLessThanOrEqual(25);
    expect(result).toContain("…");
  });
});

describe("edge cases", () => {
  it("should handle empty commands", () => {
    const result = truncateGitCommand("");
    expect(result).toBe("");
  });

  it("should handle commands with only spaces", () => {
    const result = truncateGitCommand("   ");
    expect(result).toBe("   ");
  });

  it("should handle very short maximum lengths", () => {
    const command = "git status";
    const result = truncateGitCommand(command, { maxLength: 5 });
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it("should handle commands without git", () => {
    const command = "npm install express react typescript";
    const result = truncateGitCommand(command, { maxLength: 20 });
    expect(result.length).toBeLessThanOrEqual(20);
  });

  it("should handle Windows-style paths", () => {
    const command = "git -C C:\\Users\\test\\project\\sessions\\task362\\src add file.ts";
    const result = truncateGitCommand(command);

    expect(result).toContain("git -C");
    expect(result.length).toBeLessThanOrEqual(150);
  });
});
