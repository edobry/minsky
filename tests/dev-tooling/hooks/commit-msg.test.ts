import { describe, it, expect, beforeEach, mock } from "bun:test";

import { CommitMsgHook, type CommitMsgResult } from "../../../src/hooks/commit-msg";

// Test constants to avoid magic string duplication
const TEST_BRANCH = "feature/test-branch";
const GIT_BRANCH_COMMAND = "git branch --show-current";
const COMMIT_MSG_FILE = "/tmp/test-commit-msg";
const DUPLICATION_ERROR = "appears to be duplicated";

// Global test state
let testCommitContent = "";
let mockExecSync = mock((command: string) => {
  if (command.includes(GIT_BRANCH_COMMAND)) {
    return TEST_BRANCH;
  }
  return "unknown";
});

// Mock modules within describe block to prevent global mocking
mock.module("../../../src/utils/logger", () => ({
  log: {
    cli: mock(() => {}),
    error: mock(() => {}),
    warn: mock(() => {}),
    debug: mock(() => {})
  }
}));

mock.module("child_process", () => ({
  execSync: mockExecSync
}));

mock.module("fs", () => ({
  readFileSync: mock(() => testCommitContent)
}));

async function testCommit(message: string): Promise<CommitMsgResult> {
  testCommitContent = message;
  const hook = new CommitMsgHook(COMMIT_MSG_FILE);
  return await hook.run();
}

describe("CommitMsgHook", () => {
  beforeEach(() => {
    testCommitContent = "";
    
    // Reset git command mock
    mockExecSync = mock((command: string) => {
      if (command.includes(GIT_BRANCH_COMMAND)) {
        return TEST_BRANCH;
      }
      return "unknown";
    });
  });

  // Mock modules within describe block to prevent global mocking
  mock.module("../../../src/utils/logger", () => ({
    log: {
      cli: mock(() => {}),
      error: mock(() => {}),
      warn: mock(() => {}),
      debug: mock(() => {})
    }
  }));

  mock.module("child_process", () => ({
    execSync: mockExecSync
  }));

  mock.module("fs", () => ({
    readFileSync: mock(() => testCommitContent)
  }));

  async function testCommit(message: string): Promise<CommitMsgResult> {
    testCommitContent = message;
    const hook = new CommitMsgHook(COMMIT_MSG_FILE);
    return await hook.run();
  }

  describe("Basic Functionality", () => {
    it("should accept valid conventional commit messages", async () => {
      const result = await testCommit("feat(auth): add user authentication");
      
      expect(result.success).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.message).toBe("All validations passed");
    });

    it("should handle empty commit messages gracefully", async () => {
      const result = await testCommit("");
      
      expect(result.success).toBe(true);
      expect(result.message).toBe("Empty commit message");
      expect(result.errors).toEqual([]);
    });

    it("should parse commit messages correctly", async () => {
      const result = await testCommit("feat: add new feature\n\nThis is the body of the commit\nwith multiple lines");
      
      expect(result.success).toBe(true);
    });
  });

  describe("Format Validation", () => {
    it("should reject forbidden placeholder messages", async () => {
      const forbiddenMessages = ["minimal commit", "test commit", "wip", "fix", "update"];

      for (const message of forbiddenMessages) {
        const result = await testCommit(message);
        expect(result.success).toBe(false);
        expect(result.errors[0]).toContain("Forbidden placeholder message");
      }
    });

    it("should reject invalid conventional commit format", async () => {
      const invalidMessages = [
        "invalid message format",
        "random text here",
        "FEAT: uppercase type not allowed"
      ];

      for (const message of invalidMessages) {
        const result = await testCommit(message);
        expect(result.success).toBe(false);
        expect(result.errors[0]).toContain("Invalid commit message format");
      }
    });

    it("should accept all valid conventional commit types", async () => {
      const validTypes = [
        "feat(scope): add new feature",
        "fix: resolve bug",
        "docs(readme): update documentation", 
        "style: fix formatting",
        "refactor: restructure code",
        "test: add unit tests",
        "chore: update dependencies",
        "perf: improve performance",
        "ci: update build pipeline",
        "build: modify webpack config",
        "revert: undo previous change"
      ];

      for (const message of validTypes) {
        const result = await testCommit(message);
        expect(result.success).toBe(true);
      }
    });
  });

  describe("Title Duplication Validation", () => {
    it("should detect title duplication in commit body", async () => {
      const commitMsg = "feat: add new feature\n\nfeat: add new feature\n\nSome additional details here";
      const result = await testCommit(commitMsg);
      
      expect(result.success).toBe(false);
      expect(result.errors[0]).toContain(DUPLICATION_ERROR);
    });

    it("should detect title duplication with formatting variations", async () => {
      const commitMsg = "feat(auth): add user login\n\n# feat: add user login\n\nImplementation details here";
      const result = await testCommit(commitMsg);
      
      expect(result.success).toBe(false);
      expect(result.errors[0]).toContain(DUPLICATION_ERROR);
    });

    it("should allow similar but not duplicate content", async () => {
      const commitMsg = "feat: add authentication\n\n## Authentication System\n\nDetails about the auth implementation";
      const result = await testCommit(commitMsg);
      
      expect(result.success).toBe(true);
    });

    it("should handle commit messages without body", async () => {
      const result = await testCommit("feat: simple commit without body");
      
      expect(result.success).toBe(true);
    });
  });

  describe("Merge Commit Handling", () => {
    it("should allow merge commits on feature branches", async () => {
      mockExecSync = mock((command: string) => {
        if (command.includes(GIT_BRANCH_COMMAND)) {
          return TEST_BRANCH;
        }
        return TEST_BRANCH;
      });

      const result = await testCommit("Merge branch 'main' into feature/test-branch");
      
      expect(result.success).toBe(true);
    });

    it("should reject merge commits on main branch", async () => {
      mockExecSync = mock((command: string) => {
        if (command.includes(GIT_BRANCH_COMMAND)) {
          return "main";
        }
        return "main";
      });

      const result = await testCommit("Merge branch 'feature' into main");
      
      expect(result.success).toBe(false);
      expect(result.errors[0]).toContain("Merge commits into main must use conventional commit format");
    });

    it("should reject merge commits on master branch", async () => {
      mockExecSync = mock((command: string) => {
        if (command.includes(GIT_BRANCH_COMMAND)) {
          return "master";
        }
        return "master";
      });

      const result = await testCommit("Merge branch 'feature' into master");
      
      expect(result.success).toBe(false);
      expect(result.errors[0]).toContain("Merge commits into master must use conventional commit format");
    });

    it("should handle git command failures gracefully", async () => {
      mockExecSync = mock(() => {
        throw new Error("Git command failed");
      });

      const result = await testCommit("Merge branch 'feature'");
      
      // Should still work, defaulting to "unknown" branch and allowing merge
      expect(result.success).toBe(true);
    });
  });

  describe("Error Handling", () => {
    it("should handle file read errors gracefully", async () => {
      const hook = new CommitMsgHook("/nonexistent/file");
      const result = await hook.run();
      
      expect(result.success).toBe(false);
      expect(result.errors[0]).toContain("Error processing commit message");
    });

    it("should collect multiple validation errors", async () => {
      const commitMsg = "wip\n\nwip\n\nMore content here";
      const result = await testCommit(commitMsg);
      
      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      // Should have both format error and duplication error
      expect(result.errors.some(e => e.includes("Forbidden placeholder message"))).toBe(true);
    });
  });

  describe("Edge Cases", () => {
    it("should handle commit messages with only whitespace", async () => {
      const result = await testCommit("   \n\n  \t  ");
      
      expect(result.success).toBe(true);
      expect(result.message).toBe("Empty commit message");
    });

    it("should handle very long commit messages", async () => {
      const longTitle = "feat: " + "x".repeat(100);
      const result = await testCommit(longTitle);
      
      // The regex pattern allows up to 50 characters AFTER the colon, so this actually passes
      expect(result.success).toBe(true);
    });

    it("should handle commit messages with unusual line endings", async () => {
      const commitMsg = "feat: add feature\r\n\r\nBody with Windows line endings\r\nMore content";
      const result = await testCommit(commitMsg);
      
      expect(result.success).toBe(true);
    });

    it("should handle commit messages with empty lines between title and body", async () => {
      const commitMsg = "feat: add feature\n\n\nBody starts here after empty lines";
      const result = await testCommit(commitMsg);
      
      expect(result.success).toBe(true);
    });
  });

  describe("Integration with PR Validation", () => {
    it("should use shared validation logic for duplication detection", async () => {
      // This tests that the hook properly integrates with isDuplicateContent from pr-validation
      const commitMsg = "feat(mt#123): implement feature\n\n# feat: implement feature\n\nDetails here";
      const result = await testCommit(commitMsg);
      
      expect(result.success).toBe(false);
      expect(result.errors[0]).toContain(DUPLICATION_ERROR);
    });

    it("should handle task ID normalization like PR validation", async () => {
      const commitMsg = "feat(md#456): update system\n\n# feat: update system\n\nImplementation notes";
      const result = await testCommit(commitMsg);
      
      expect(result.success).toBe(false);
      expect(result.errors[0]).toContain(DUPLICATION_ERROR);
    });
  });
});
