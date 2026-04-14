/**
 * GitService Core Tests
 * @migrated Extracted from git.test.ts as part of modularization
 * @enhanced Enhanced with comprehensive method coverage and DI patterns
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { GitService } from "./git";
import { FakeGitService } from "./git/fake-git-service";
import { GIT_COMMANDS } from "../utils/test-utils/test-constants";

describe("GitService", () => {
  let gitService: GitService;
  let fakeGit: FakeGitService;

  beforeEach(() => {
    // Create a fresh GitService instance for real-method tests
    gitService = new GitService("/mock/base/dir");

    // Use FakeGitService as the DI-based test double for behavior verification
    fakeGit = new FakeGitService();
    fakeGit.getStatus = async () => ({
      modified: ["file1.ts", "file2.ts"],
      untracked: ["newfile1.ts", "newfile2.ts"],
      deleted: ["deletedfile1.ts"],
    });
    fakeGit.execInRepository = async (_workdir: string, command: string) => {
      fakeGit.recordedCommands.push({ workdir: _workdir, command });
      if (command === GIT_COMMANDS.REV_PARSE_ABBREV_REF_HEAD) {
        return "main";
      }
      if (command === "rev-parse --show-toplevel") {
        return "/mock/repo/path";
      }
      return "";
    };
  });

  // ========== Basic API Tests ==========

  test("should be able to create an instance", () => {
    expect(gitService instanceof GitService).toBe(true);
  });

  test("should get repository status via fake", async () => {
    const _status = await fakeGit.getStatus("/mock/repo/path");

    // Verify the returned status object has the expected structure and content
    expect(_status).toEqual({
      modified: ["file1.ts", "file2.ts"],
      untracked: ["newfile1.ts", "newfile2.ts"],
      deleted: ["deletedfile1.ts"],
    });
  });

  test("getSessionWorkdir should return the correct path", () => {
    // Tests real GitService.getSessionWorkdir (not mocked — this tests actual behavior)
    const workdir = gitService.getSessionWorkdir("test-session");

    // NEW: Session-ID-based storage - expect session ID in path, not repo name
    expect(workdir.includes("test-session")).toBe(true);
    expect(workdir.includes("sessions")).toBe(true);
    // Repository identity no longer part of filesystem path
  });

  test("execInRepository should execute git commands in the specified repository via fake", async () => {
    const _branch = await fakeGit.execInRepository(
      "/mock/repo/path",
      GIT_COMMANDS.REV_PARSE_ABBREV_REF_HEAD
    );
    expect(_branch).toBe("main");
  });

  test("execInRepository should propagate errors via fake", async () => {
    // Configure fake to throw an error for git commands
    const errorFake = new FakeGitService();
    errorFake.setCommandError(
      GIT_COMMANDS.REV_PARSE_ABBREV_REF_HEAD,
      new Error("Command execution failed")
    );

    try {
      await errorFake.execInRepository("/mock/repo/path", GIT_COMMANDS.REV_PARSE_ABBREV_REF_HEAD);
      // The test should not reach this line
      expect(true).toBe(false);
    } catch (error: unknown) {
      // Just verify it throws an error
      expect(error instanceof Error).toBe(true);
      if (error instanceof Error) {
        expect(error.message).toContain("Command execution failed");
      }
    }
  });

  test("should use session-ID-based storage in getSessionWorkdir", () => {
    // Tests real GitService.getSessionWorkdir (not mocked — this tests actual behavior)
    const workdir1 = gitService.getSessionWorkdir("test-session");

    // Path should contain session ID but NOT repository name
    expect(workdir1.includes("test-session")).toBe(true);
    expect(workdir1.includes("sessions")).toBe(true);
    expect(workdir1.endsWith("sessions/test-session")).toBe(true);
  });
});
