// Mock ALL git-related modules FIRST before any imports
import { mockModule } from "../../utils/test-utils/mocking";
import { mock } from "bun:test";

// Mock the exec utility that conflict-detection uses
mockModule("../../utils/exec", () => ({
  execAsync: mock(async () => ({ stdout: "0\t1", stderr: "" })),
}));

// Mock git-exec module
mockModule("../../utils/git-exec", () => ({
  execGitWithTimeout: mock(async () => ({ stdout: "task/md-123", stderr: "" })),
  gitFetchWithTimeout: mock(async () => ({ stdout: "", stderr: "" })),
  gitPushWithTimeout: mock(async () => ({ stdout: "", stderr: "" })),
}));

// Mock child_process directly to catch any remaining shell commands
mockModule("node:child_process", () => ({
  exec: mock((command: string, callback: any) => {
    // Mock all git commands to return success
    process.nextTick(() => callback(null, { stdout: "0\t1", stderr: "" }));
  }),
}));

import { describe, it, expect } from "bun:test";
import { preparePrImpl } from "./prepare-pr-operations";
import { MinskyError } from "../../errors/index";
import type { SessionProviderInterface, SessionRecord } from "../session/types";

const TEST_UUID = "550e8400-e29b-41d4-a716-446655440000";

// Mock dependencies for testing
function createMockDependencies() {
  const mockSessionDb: SessionProviderInterface = {
    listSessions: mock(async () => []),
    getSession: mock(async () => null),
    getSessionByTaskId: mock(async () => null),
    addSession: mock(async (record: SessionRecord) => {}),
    updateSession: mock(async () => {}),
    deleteSession: mock(async () => true),
    getRepoPath: mock(async () => "/mock/repo/path"),
    getSessionWorkdir: mock(async () => "/mock/session/workdir"),
  };

  const mockExecInRepository = mock(async (workdir: string, command: string) => {
    if (command === "git remote get-url origin") {
      return "https://github.com/test/repo.git";
    }
    if (command === "git rev-parse --show-toplevel") {
      return "/mock/repo/path";
    }
    if (command === "git symbolic-ref --short HEAD") {
      return "task/md-123";
    }
    if (command === "git rev-parse --abbrev-ref HEAD") {
      return "task/md-123";
    }
    if (command.startsWith("git rev-parse")) {
      return "abc123def456"; // Mock commit hash
    }
    return "";
  });

  return {
    sessionDb: mockSessionDb,
    execInRepository: mockExecInRepository,
    getSessionWorkdir: mock((sessionId: string) => `/mock/sessions/${sessionId}`),
    gitFetch: mock(async () => {}),
    gitPush: mock(async () => {}),
    execAsync: mock(async () => ({ stdout: "0\t1", stderr: "" })),
  };
}

describe("Git Operations Multi-Backend Integration", () => {
  describe("Prepare PR session lookup", () => {
    it("should throw an error when session is not found (no self-repair)", async () => {
      const deps = createMockDependencies();
      // sessionDb.getSession returns null by default

      await expect(
        preparePrImpl(
          {
            session: TEST_UUID,
            baseBranch: "main",
          },
          deps
        )
      ).rejects.toThrow(MinskyError);

      // Should NOT try to register a session — auto-repair is handled at DB layer
      expect(deps.sessionDb.addSession).not.toHaveBeenCalled();
    });

    it("should not modify existing qualified session records", async () => {
      const deps = createMockDependencies();

      // Mock existing session record
      deps.sessionDb.getSession = mock(async (sessionId: string) => {
        if (sessionId === TEST_UUID) {
          return {
            session: TEST_UUID,
            repoName: "test/repo",
            repoUrl: "https://github.com/test/repo.git",
            createdAt: "2024-01-01T00:00:00Z",
            taskId: "md#123",
          } as SessionRecord;
        }
        return null;
      });

      await preparePrImpl(
        {
          session: TEST_UUID,
          baseBranch: "main",
        },
        deps
      );

      // Should not try to create a new session record
      expect(deps.sessionDb.addSession).not.toHaveBeenCalled();
    });
  });

  describe("Backward compatibility", () => {
    it("should continue working with existing legacy session records", async () => {
      const deps = createMockDependencies();

      // Mock existing legacy session
      deps.sessionDb.getSession = mock(async (sessionId: string) => {
        if (sessionId === "task123") {
          return {
            session: "task123",
            repoName: "test/repo",
            repoUrl: "https://github.com/test/repo.git",
            createdAt: "2024-01-01T00:00:00Z",
            taskId: "123", // Legacy format
          } as SessionRecord;
        }
        return null;
      });

      await preparePrImpl(
        {
          session: "task123",
          baseBranch: "main",
        },
        deps
      );

      // Should work with existing legacy session
      expect(deps.sessionDb.getSession).toHaveBeenCalledWith("task123");
      expect(deps.sessionDb.addSession).not.toHaveBeenCalled();
    });

    it("should handle mixed session database (legacy + modern)", async () => {
      const deps = createMockDependencies();

      const testSessions = [
        { session: "task123", taskId: "123" },
        { session: "task-md#456", taskId: "md#456" },
        { session: "task-gh#789", taskId: "gh#789" },
        { session: "custom-session", taskId: undefined },
      ];

      for (const { session, taskId } of testSessions) {
        const sessionDeps = createMockDependencies();
        sessionDeps.sessionDb.getSession = mock(async (name: string) => {
          if (name === session) {
            return {
              session,
              repoName: "test/repo",
              repoUrl: "https://github.com/test/repo.git",
              createdAt: "2024-01-01T00:00:00Z",
              taskId,
            } as SessionRecord;
          }
          return null;
        });

        const result = await preparePrImpl(
          {
            session,
            baseBranch: "main",
          },
          sessionDeps
        );

        expect(result).toBeDefined();
        expect(sessionDeps.sessionDb.addSession).not.toHaveBeenCalled();
      }
    });
  });
});
