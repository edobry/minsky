import { describe, it, expect, beforeEach, mock } from "bun:test";

import {
  CommitMsgHook,
  type CommitMsgResult,
  type CommitMsgDeps,
} from "../../../src/hooks/commit-msg";

// Test constants to avoid magic string duplication
const TEST_BRANCH = "feature/test-branch";
const GIT_BRANCH_COMMAND = "git branch --show-current";
const COMMIT_MSG_FILE = "/tmp/test-commit-msg";
const DUPLICATION_ERROR = "appears to be duplicated";

// Global test state
let testCommitContent = "";
let currentExecSyncBehavior: (command: string) => string = (command: string) => {
  if (command.includes(GIT_BRANCH_COMMAND)) {
    return TEST_BRANCH;
  }
  return "unknown";
};

const mockExecSync = mock((command: string) => {
  return currentExecSyncBehavior(command);
});

const mockReadFileSync = mock((path: string) => {
  if (path === "/nonexistent/file") {
    throw new Error("ENOENT: no such file or directory");
  }
  return testCommitContent;
});

// Shared deps injected via constructor — no mock.module needed for fs/child_process
const testDeps: CommitMsgDeps = {
  readFileSync: mockReadFileSync as any,
  execSync: mockExecSync as any,
};

async function testCommit(message: string): Promise<CommitMsgResult> {
  testCommitContent = message;
  const hook = new CommitMsgHook(COMMIT_MSG_FILE, testDeps);
  return await hook.run();
}

describe("CommitMsgHook", () => {
  beforeEach(() => {
    testCommitContent = "";

    // Reset git command behavior
    currentExecSyncBehavior = (command: string) => {
      if (command.includes(GIT_BRANCH_COMMAND)) {
        return TEST_BRANCH;
      }
      return "unknown";
    };
  });

  describe("Basic Functionality", () => {
    it("should accept valid conventional commit messages", async () => {
      const result = await testCommit("feat(auth): add user authentication");

      expect(result.success).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.message).toBe("All validations passed");
    });

    it("rejects an empty commit message instead of skipping validation (mt#2821 PR #1976 R1)", async () => {
      // Previously this short-circuited to a pass-through success — an
      // escape hatch for `git commit --allow-empty-message`. The whole
      // point of a commit-msg validator is to be the backstop for exactly
      // that kind of deliberate bypass.
      const result = await testCommit("");

      expect(result.success).toBe(false);
      expect(result.errors[0]).toContain("cannot be empty");
    });

    it("should parse commit messages correctly", async () => {
      const result = await testCommit(
        "feat: add new feature\n\nThis is the body of the commit\nwith multiple lines"
      );

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
        "FEAT: uppercase type not allowed",
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
        "revert: undo previous change",
      ];

      for (const message of validTypes) {
        const result = await testCommit(message);
        expect(result.success).toBe(true);
      }
    });
  });

  describe("Title Duplication Validation", () => {
    it("should detect title duplication in commit body", async () => {
      const commitMsg =
        "feat: add new feature\n\nfeat: add new feature\n\nSome additional details here";
      const result = await testCommit(commitMsg);

      expect(result.success).toBe(false);
      expect(result.errors[0]).toContain(DUPLICATION_ERROR);
    });

    it("should detect title duplication with formatting variations", async () => {
      const commitMsg =
        "feat(auth): add user login\n\n# feat: add user login\n\nImplementation details here";
      const result = await testCommit(commitMsg);

      expect(result.success).toBe(false);
      expect(result.errors[0]).toContain(DUPLICATION_ERROR);
    });

    it("should allow similar but not duplicate content", async () => {
      const commitMsg =
        "feat: add authentication\n\n## Authentication System\n\nDetails about the auth implementation";
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
      currentExecSyncBehavior = (command: string) => {
        if (command.includes(GIT_BRANCH_COMMAND)) {
          return TEST_BRANCH;
        }
        return TEST_BRANCH;
      };

      const result = await testCommit("Merge branch 'main' into feature/test-branch");

      expect(result.success).toBe(true);
    });

    it("should reject merge commits on main branch", async () => {
      currentExecSyncBehavior = (command: string) => {
        if (command.includes(GIT_BRANCH_COMMAND)) {
          return "main";
        }
        return "main";
      };

      const result = await testCommit("Merge branch 'feature' into main");

      expect(result.success).toBe(false);
      expect(result.errors[0]).toContain(
        "Merge commits into main must use conventional commit format"
      );
    });

    it("should reject merge commits on master branch", async () => {
      currentExecSyncBehavior = (command: string) => {
        if (command.includes(GIT_BRANCH_COMMAND)) {
          return "master";
        }
        return "master";
      };

      const result = await testCommit("Merge branch 'feature' into master");

      expect(result.success).toBe(false);
      expect(result.errors[0]).toContain(
        "Merge commits into master must use conventional commit format"
      );
    });

    it("should handle git command failures gracefully", async () => {
      currentExecSyncBehavior = () => {
        throw new Error("Git command failed");
      };

      const result = await testCommit("Merge branch 'feature'");

      // Should still work, defaulting to "unknown" branch and allowing merge
      expect(result.success).toBe(true);
    });
  });

  describe("Error Handling", () => {
    it("should handle file read errors gracefully", async () => {
      const hook = new CommitMsgHook("/nonexistent/file", testDeps);
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
      expect(result.errors.some((e) => e.includes("Forbidden placeholder message"))).toBe(true);
    });
  });

  describe("Edge Cases", () => {
    it("rejects a whitespace-only commit message (mt#2821 PR #1976 R1)", async () => {
      const result = await testCommit("   \n\n  \t  ");

      expect(result.success).toBe(false);
      expect(result.errors[0]).toContain("cannot be empty");
    });

    it("should handle very long commit messages", async () => {
      const longTitle = `feat: ${"x".repeat(100)}`;
      const result = await testCommit(longTitle);

      // CONVENTIONAL_COMMIT_SUBJECT_MAX_LEN allows up to 100 characters AFTER
      // the colon (packages/domain/src/git/commit-message-format.ts), so this
      // exactly-100-char description passes.
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
      const commitMsg =
        "feat(mt#123): implement feature\n\n# feat: implement feature\n\nDetails here";
      const result = await testCommit(commitMsg);

      expect(result.success).toBe(false);
      expect(result.errors[0]).toContain(DUPLICATION_ERROR);
    });

    it("should handle task ID normalization like PR validation", async () => {
      const commitMsg =
        "feat(md#456): update system\n\n# feat: update system\n\nImplementation notes";
      const result = await testCommit(commitMsg);

      expect(result.success).toBe(false);
      expect(result.errors[0]).toContain(DUPLICATION_ERROR);
    });
  });

  describe("[no-deploy-impact] claim verification (mt#4397)", () => {
    const STAGED_FILES_COMMAND = "git diff --cached --name-only";
    const DEPLOY_SURFACE_FILE = "packages/domain/src/composition/container.ts";
    const NON_DEPLOY_FILE = ".minsky/hooks/some-guard.ts";
    /** Shared so the claiming fixtures cannot drift apart. */
    const CLAIMING_MESSAGE = "fix(mt#1): a change\n\n[no-deploy-impact]";

    /** Records every command issued, and serves a staged list for the diff read. */
    function withStagedFiles(files: string[]): string[] {
      const issued: string[] = [];
      currentExecSyncBehavior = (command: string) => {
        issued.push(command);
        if (command.includes(GIT_BRANCH_COMMAND)) return TEST_BRANCH;
        if (command.includes(STAGED_FILES_COMMAND)) return files.join("\n");
        return "unknown";
      };
      return issued;
    }

    it("does NOT shell out to git when the message makes no claim (PR #3221 R1)", async () => {
      // This hook runs on EVERY commit and the vast majority never mention the
      // tag; paying a subprocess for those bought an answer the message alone
      // already determines.
      const issued = withStagedFiles([DEPLOY_SURFACE_FILE]);

      const result = await testCommit("fix(mt#1): an ordinary change");

      expect(result.success).toBe(true);
      expect(issued.some((c) => c.includes(STAGED_FILES_COMMAND))).toBe(false);
    });

    it("enumerates staged files including DELETIONS (PR #3221 R1)", async () => {
      // Deleting a deploy-surface file IS a deploy impact. The sibling
      // pre-commit steps can omit `D` because they read staged CONTENT; this
      // check reads only PATHS, so a deletion is both readable and meaningful.
      const issued = withStagedFiles([NON_DEPLOY_FILE]);

      await testCommit(CLAIMING_MESSAGE);

      const diffCommand = issued.find((c) => c.includes(STAGED_FILES_COMMAND));
      expect(diffCommand).toContain("--diff-filter=");
      for (const letter of ["A", "C", "M", "R", "D"]) {
        expect(diffCommand).toContain(letter);
      }
    });

    it("rejects a claim the staged set contradicts, naming the file", async () => {
      withStagedFiles([DEPLOY_SURFACE_FILE, NON_DEPLOY_FILE]);

      const result = await testCommit(CLAIMING_MESSAGE);

      expect(result.success).toBe(false);
      expect(result.errors.join("\n")).toContain(DEPLOY_SURFACE_FILE);
      expect(result.errors.join("\n")).toContain("cannot be edited");
    });

    it("accepts a claim the staged set supports", async () => {
      withStagedFiles([NON_DEPLOY_FILE]);

      const result = await testCommit(CLAIMING_MESSAGE);

      expect(result.success).toBe(true);
    });
  });
});
