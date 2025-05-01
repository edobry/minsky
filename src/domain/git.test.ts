import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { GitService } from "./git";
import { SessionDB } from "./session";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { normalizeRepoName } from "./repo-utils";
import { execAsync } from "./utils";

function run(cmd: string, cwd: string) {
  try {
    execSync(cmd, { cwd, stdio: "pipe" });
  } catch (error) {
    console.error(`Command failed: ${cmd}`);
    console.error(`Working directory: ${cwd}`);
    if (error instanceof Error) {
      console.error(error.message);
    }
    throw error;
  }
}

describe("GitService", () => {
  let tmpDir: string;
  let git: GitService;

  beforeEach(() => {
    tmpDir = mkdtempSync("/tmp/git-test-");
    git = new GitService();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("stashChanges", () => {
    test("should stash changes when there are modifications", async () => {
      const result = await git.stashChanges(tmpDir);
      expect(result.stashed).toBe(true);
    });

    test("should not stash when there are no changes", async () => {
      const result = await git.stashChanges(tmpDir);
      expect(result.stashed).toBe(false);
    });
  });

  describe("popStash", () => {
    test("should pop stashed changes", async () => {
      // First stash some changes
      await git.stashChanges(tmpDir);

      const result = await git.popStash(tmpDir);
      expect(result.stashed).toBe(true);
    });

    test("should handle no stash to pop", async () => {
      const result = await git.popStash(tmpDir);
      expect(result.stashed).toBe(false);
    });
  });

  describe("pullLatest", () => {
    test("should pull latest changes when available", async () => {
      const result = await git.pullLatest(tmpDir);
      expect(result.updated).toBe(true);
    });

    test("should handle no updates available", async () => {
      const result = await git.pullLatest(tmpDir);
      expect(result.updated).toBe(false);
    });
  });

  describe("mergeBranch", () => {
    test("should merge changes from another branch", async () => {
      const result = await git.mergeBranch(tmpDir, "main");
      expect(result.merged).toBe(true);
      expect(result.conflicts).toBe(false);
    });

    test("should handle merge conflicts", async () => {
      const result = await git.mergeBranch(tmpDir, "main");
      expect(result.merged).toBe(false);
      expect(result.conflicts).toBe(true);
    });
  });

  describe("pushBranch", () => {
    test("should push changes to remote", async () => {
      const result = await git.pushBranch(tmpDir);
      expect(result.pushed).toBe(true);
    });

    test("should handle push failure", async () => {
      const result = await git.pushBranch(tmpDir);
      expect(result.pushed).toBe(false);
    });
  });
}); 
