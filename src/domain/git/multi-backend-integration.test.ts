// Mock ALL git-related modules FIRST before any imports
import { mockModule, createMock } from "../../utils/test-utils/mocking";

// Mock the exec utility that conflict-detection uses
mockModule("../../utils/exec", () => ({
  execAsync: createMock(async () => ({ stdout: "0\t1", stderr: "" })),
}));

// Mock git-exec module
mockModule("../../utils/git-exec", () => ({
  execGitWithTimeout: createMock(async () => ({ stdout: "task-md#123", stderr: "" })),
  gitFetchWithTimeout: createMock(async () => ({ stdout: "", stderr: "" })),
  gitPushWithTimeout: createMock(async () => ({ stdout: "", stderr: "" })),
}));

// Mock child_process directly to catch any remaining shell commands
mockModule("node:child_process", () => ({
  exec: createMock((command: string, callback: any) => {
    // Mock all git commands to return success
    process.nextTick(() => callback(null, { stdout: "0\t1", stderr: "" }));
  }),
}));

import { describe, it, expect, mock } from "bun:test";
import { preparePrImpl } from "./prepare-pr-operations";
import type { SessionProviderInterface, SessionRecord } from "../session/types";

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
      return "task-md#123";
    }
    if (command === "git rev-parse --abbrev-ref HEAD") {
      return "task-md#123";
    }
    if (command.startsWith("git rev-parse")) {
      return "abc123def456"; // Mock commit hash
    }
    return "";
  });

  return {
    sessionDb: mockSessionDb,
    execInRepository: mockExecInRepository,
    getSessionWorkdir: mock((sessionName: string) => `/mock/sessions/${sessionName}`),
    gitFetch: mock(async () => {}),
    gitPush: mock(async () => {}),
    execAsync: mock(async () => ({ stdout: "0\t1", stderr: "" })),
  };
}

describe("Git Operations Multi-Backend Integration", () => {
  describe("Prepare PR with qualified session names", () => {
    it("should handle qualified session names (task-md#123)", async () => {
      const deps = createMockDependencies();

      // Mock being in a session workspace directory
      const originalCwd = process.cwd;
      process.cwd = mock(() => "/mock/sessions/task-md#123");

      try {
        await preparePrImpl(
          {
            session: "task-md#123",
            baseBranch: "main",
          },
          deps
        );

        // Should have attempted session auto-repair with qualified ID extraction
        expect(deps.sessionDb.addSession).toHaveBeenCalledWith(
          expect.objectContaining({
            session: "task-md#123",
            taskId: "md#123", // Should extract qualified task ID
            taskBackend: "md", // Should add backend information
            legacyTaskId: undefined, // No legacy ID for qualified format
          })
        );
      } finally {
        process.cwd = originalCwd;
      }
    });

    it("should handle legacy session names (task123)", async () => {
      const deps = createMockDependencies();

      // Mock being in a legacy session workspace directory
      const originalCwd = process.cwd;
      process.cwd = mock(() => "/mock/sessions/task123");

      try {
        await preparePrImpl(
          {
            session: "task123",
            baseBranch: "main",
          },
          deps
        );

        // Should have migrated legacy format to qualified format
        expect(deps.sessionDb.addSession).toHaveBeenCalledWith(
          expect.objectContaining({
            session: "task123", // Original session name preserved
            taskId: "md#123", // Should migrate to qualified format
            taskBackend: "md", // Should default to markdown backend
            legacyTaskId: "123", // Should preserve original task ID
          })
        );
      } finally {
        process.cwd = originalCwd;
      }
    });

    it("should handle legacy task# format (task#456)", async () => {
      const deps = createMockDependencies();

      const originalCwd = process.cwd;
      process.cwd = mock(() => "/mock/sessions/task#456");

      try {
        await preparePrImpl(
          {
            session: "task#456",
            baseBranch: "main",
          },
          deps
        );

        expect(deps.sessionDb.addSession).toHaveBeenCalledWith(
          expect.objectContaining({
            session: "task#456",
            taskId: "md#456", // Should migrate task# format
            taskBackend: "md",
            legacyTaskId: "456",
          })
        );
      } finally {
        process.cwd = originalCwd;
      }
    });

    it("should handle GitHub backend sessions (task-gh#789)", async () => {
      const deps = createMockDependencies();

      const originalCwd = process.cwd;
      process.cwd = mock(() => "/mock/sessions/task-gh#789");

      try {
        await preparePrImpl(
          {
            session: "task-gh#789",
            baseBranch: "main",
          },
          deps
        );

        expect(deps.sessionDb.addSession).toHaveBeenCalledWith(
          expect.objectContaining({
            session: "task-gh#789",
            taskId: "gh#789", // Should preserve GitHub backend
            taskBackend: "gh", // Should detect GitHub backend
          })
        );
      } finally {
        process.cwd = originalCwd;
      }
    });

    it("should handle custom sessions without task IDs", async () => {
      const deps = createMockDependencies();

      const originalCwd = process.cwd;
      process.cwd = mock(() => "/mock/sessions/custom-session");

      try {
        await preparePrImpl(
          {
            session: "custom-session",
            baseBranch: "main",
          },
          deps
        );

        expect(deps.sessionDb.addSession).toHaveBeenCalledWith(
          expect.objectContaining({
            session: "custom-session",
            taskId: undefined, // No task ID for custom sessions
            // No backend information for non-task sessions
          })
        );
      } finally {
        process.cwd = originalCwd;
      }
    });

    it("should not modify existing qualified session records", async () => {
      const deps = createMockDependencies();

      // Mock existing session record
      deps.sessionDb.getSession = mock(async (sessionName: string) => {
        if (sessionName === "task-md#123") {
          return {
            session: "task-md#123",
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
          session: "task-md#123",
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
      deps.sessionDb.getSession = mock(async (sessionName: string) => {
        if (sessionName === "task123") {
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

      // Test both legacy and modern sessions work
      const testCases = [
        { session: "task123", shouldWork: true },
        { session: "task-md#456", shouldWork: true },
        { session: "task-gh#789", shouldWork: true },
        { session: "custom-session", shouldWork: true },
      ];

      for (const testCase of testCases) {
        const originalCwd = process.cwd;
        process.cwd = mock(() => `/mock/sessions/${testCase.session}`);

        try {
          const result = await preparePrImpl(
            {
              session: testCase.session,
              baseBranch: "main",
            },
            deps
          );

          if (testCase.shouldWork) {
            expect(result).toBeDefined();
          }
        } finally {
          process.cwd = originalCwd;
        }
      }
    });
  });
});
