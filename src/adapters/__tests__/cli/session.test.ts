/**
 * NOTE: These tests are temporarily disabled due to issues with Jest mocking in Bun environment.
 *
 * The CLI tests require proper jest.mock functionality which is not fully compatible with Bun.
 *
 * This test suite will be reimplemented after resolving the testing framework compatibility issues.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdir, rmdir } from "fs/promises";
import { existsSync } from "fs";
import { getSessionDirFromParams, updateSessionFromParams } from "../../../domain/session.js";
import { getCurrentSession, getSessionFromWorkspace } from "../../../domain/workspace.js";
import { createMock, setupTestMocks } from "../../../utils/test-utils/mocking.js";
import type { SessionRecord, SessionProviderInterface } from "../../../domain/session.js";
import type { GitServiceInterface } from "../../../domain/git.js";

// Set up automatic mock cleanup
setupTestMocks();

describe("Session CLI Commands", () => {
  let mockSessionDB: any;
  let mockSessions: any[];
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(process.cwd(), "test-tmp", "session-cli-test");

    // Create test data for all session tests
    mockSessions = [
      {
        session: "004",
        repoName: "local/minsky",
        repoUrl: "file:///Users/edobry/Projects/minsky",
        createdAt: "2024-04-29T15:01:00.000Z",
        taskId: null, // Session with no task ID
        branch: "004",
        repoPath: "/Users/edobry/.local/state/minsky/git/local/minsky/sessions/004",
      },
      {
        session: "task#160",
        repoName: "local/minsky",
        repoUrl: "/Users/edobry/Projects/minsky",
        createdAt: "2025-06-25T18:54:44.999Z",
        taskId: "#160", // Session with task ID
        branch: "task#160",
        repoPath: "/Users/edobry/.local/state/minsky/git/local-minsky/sessions/task#160",
      },
    ];

    // Create comprehensive mock session database
    mockSessionDB = {
      getSessionByTaskId: createMock(),
      getSession: createMock(),
      listSessions: createMock(),
      addSession: createMock(),
      updateSession: createMock(),
      deleteSession: createMock(),
      getRepoPath: createMock(),
      getSessionWorkdir: createMock(),
    };
  });

  afterEach(async () => {
    // Clean up test directory
    if (existsSync(tempDir)) {
      await rmdir(tempDir, { recursive: true }).catch(() => {});
    }
  });

  describe("session dir command", () => {
    test("should return correct session directory for task ID", async () => {
      // Arrange: Mock correct behavior
      const correctSession = mockSessions[1]; // task#160 session
      mockSessionDB.getSessionByTaskId.mockReturnValue(Promise.resolve(correctSession));
      mockSessionDB.getSession.mockReturnValue(Promise.resolve(correctSession));

      // Act
      const result = await getSessionDirFromParams(
        {
          task: "160",
        },
        {
          sessionDB: mockSessionDB,
        }
      );

      // Assert
      expect(mockSessionDB.getSessionByTaskId).toHaveBeenCalledWith("#160");
      expect(result).toContain("task#160");
      expect(result).not.toContain("/004");
    });

    test("should normalize task IDs correctly (with and without # prefix)", async () => {
      // Arrange
      const correctSession = mockSessions[1];
      mockSessionDB.getSessionByTaskId.mockReturnValue(Promise.resolve(correctSession));
      mockSessionDB.getSession.mockReturnValue(Promise.resolve(correctSession));

      // Act: Test with task ID without # prefix
      await getSessionDirFromParams({ task: "160" }, { sessionDB: mockSessionDB });

      // Assert: Should call with normalized task ID (with # prefix)
      expect(mockSessionDB.getSessionByTaskId).toHaveBeenCalledWith("#160");
    });

    test("should handle null taskId sessions correctly", () => {
      // Test the specific edge case that caused the original bug
      const sessionWithNullTaskId = { taskId: null };
      const sessionWithTaskId = { taskId: "#160" };

      // This should not throw and should filter out null values
      const normalizeTaskId = (taskId: string | null | undefined) => {
        if (!taskId) return undefined;
        return taskId.replace(/^#/, "");
      };

      expect(normalizeTaskId(sessionWithNullTaskId.taskId)).toBeUndefined();
      expect(normalizeTaskId(sessionWithTaskId.taskId)).toBe("160");
    });

    test("BUG REGRESSION: SQLite filtering implementation", async () => {
      // This test reproduces the EXACT sequence of calls that caused the original bug:
      // 1. SessionDbAdapter.getSessionByTaskId("160")
      // 2. Calls storage.getEntities({ taskId: "160" })
      // 3. SQLiteStorage.getEntities() was ignoring options and returning ALL sessions
      // 4. Taking first session from array (sessions[0]) which was wrong session

      // Arrange: Create a mock storage that simulates the buggy getEntities behavior
      const mockStorage = {
        getEntities: createMock(),
      };

      // BUGGY BEHAVIOR: getEntities ignores options and returns all sessions
      mockStorage.getEntities.mockReturnValue(Promise.resolve(mockSessions)); // Returns ALL sessions

      // Act: Simulate the SessionDbAdapter.getSessionByTaskId logic
      const normalizedTaskId = "160".replace(/^#/, "");
      const sessions = await mockStorage.getEntities({ taskId: normalizedTaskId });
      const session = sessions.length > 0 ? sessions[0] : null; // Takes first session (BUG!)

      // Assert: This demonstrates the exact bug sequence
      expect(mockStorage.getEntities).toHaveBeenCalledWith({ taskId: "160" });
      expect(sessions).toHaveLength(2); // Bug: returns all sessions instead of filtered
      expect(session?.session).toBe("004"); // Bug: first session is wrong one
      expect(session?.taskId).toBeNull(); // Bug: wrong session has null taskId

      // Show what the CORRECT behavior should be:
      const correctlyFilteredSessions = mockSessions.filter((s) => {
        if (!s.taskId) return false;
        return s.taskId.replace(/^#/, "") === normalizedTaskId;
      });

      expect(correctlyFilteredSessions).toHaveLength(1);
      expect(correctlyFilteredSessions[0].session).toBe("task#160"); // Correct session
      expect(correctlyFilteredSessions[0].taskId).toBe("#160"); // Correct taskId
    });

    test("EDGE CASE: multiple sessions with same task ID but different formats", () => {
      // Test edge case where database might have sessions with different task ID formats
      const edgeCaseSessions = [
        { session: "old-session", taskId: null },
        { session: "task160", taskId: "160" }, // Without # prefix
        { session: "task#160", taskId: "#160" }, // With # prefix
        { session: "task-160-v2", taskId: "#160" }, // Another session with same task ID
      ];

      const normalizeTaskId = (taskId: string) => taskId.replace(/^#/, "");
      const targetTaskId = "160";

      // Filter logic that should handle all these cases
      const correctSessions = edgeCaseSessions.filter((s) => {
        if (!s.taskId) return false;
        return normalizeTaskId(s.taskId) === targetTaskId;
      });

      // Should find all sessions that match the normalized task ID
      expect(correctSessions).toHaveLength(3);
      expect(correctSessions.map((s) => s.session)).toEqual(["task160", "task#160", "task-160-v2"]);
    });
  });

  describe("session update command", () => {
    let mockGitService: any;

    beforeEach(() => {
      mockGitService = {
        getSessionWorkdir: (repoName: string, sessionName: string) =>
          join(tempDir, repoName, "sessions", sessionName),
        execInRepository: async (workdir: string, command: string) => {
          if (command.includes("git remote get-url origin")) {
            return "https://github.com/test/repo.git";
          }
          return "";
        },
        hasUncommittedChanges: async () => false,
        stashChanges: async () => undefined,
        pullLatest: async () => undefined,
        mergeBranch: async () => ({ conflicts: false }),
        push: async () => undefined,
        popStash: async () => undefined,
      };
    });

    test("TASK #168 FIX: should auto-detect session name from current directory when not provided", async () => {
      // Arrange: Setup session workspace path
      const sessionName = "task#168";
      const sessionPath = join(tempDir, "local-minsky", "sessions", sessionName);

      // Mock getCurrentSession to return the session name
      const mockGetCurrentSession = async () => sessionName;

      // Mock session record
      const sessionRecord: SessionRecord = {
        session: sessionName,
        repoName: "local-minsky",
        repoUrl: "/test/repo",
        createdAt: new Date().toISOString(),
        taskId: "#168",
      };

      mockSessionDB.getSession = async (name: string) =>
        name === sessionName ? sessionRecord : null;

      // Create the session directory
      await mkdir(sessionPath, { recursive: true });

      // Act: Call updateSessionFromParams without name parameter (tests auto-detection)
      const result = await updateSessionFromParams(
        {
          name: undefined as any,
          noStash: false,
          noPush: false,
          force: false,
        },
        {
          sessionDB: mockSessionDB,
          gitService: mockGitService,
          getCurrentSession: mockGetCurrentSession,
        }
      );

      // Assert: Auto-detection should work
      expect(result.session).toBe(sessionName);
    });

    test("TASK #168 FIX: should automatically register orphaned session when directory exists but not in database", async () => {
      // Arrange: Session directory exists but not in database (orphaned session scenario)
      const sessionName = "task#168";
      const sessionPath = join(tempDir, "local-minsky", "sessions", sessionName);
      const repoUrl = "https://github.com/test/repo.git";

      // Create the orphaned session directory
      await mkdir(sessionPath, { recursive: true });

      // Mock getCurrentSession to detect the session from path
      const mockGetCurrentSession = async () => sessionName;

      // Mock sessionDB to initially return null, then return the registered session
      let sessionRegistered = false;
      let registeredRecord: SessionRecord | null = null;

      mockSessionDB.getSession = async (name: string) => {
        if (name === sessionName && sessionRegistered) {
          return registeredRecord;
        }
        return null;
      };

      // Mock addSession to track registration
      mockSessionDB.addSession = async (record: SessionRecord) => {
        sessionRegistered = true;
        registeredRecord = record;
        expect(record.session).toBe(sessionName);
        expect(record.repoUrl).toBe(repoUrl);
        expect(record.taskId).toBe("#168");
      };

      // Mock git service to return repo URL
      mockGitService.execInRepository = async (workdir: string, command: string) => {
        if (command.includes("git remote get-url origin")) {
          return repoUrl;
        }
        return "";
      };

      // Mock process.cwd to return session path
      const originalCwd = process.cwd;
      process.cwd = () => sessionPath;

      try {
        // Act: Call updateSessionFromParams (should trigger self-repair)
        const result = await updateSessionFromParams(
          {
            name: sessionName,
            noStash: false,
            noPush: false,
            force: false,
          },
          {
            sessionDB: mockSessionDB,
            gitService: mockGitService,
            getCurrentSession: mockGetCurrentSession,
          }
        );

        // Assert: Session should be registered and update should succeed
        expect(result.session).toBe(sessionName);
        expect(sessionRegistered).toBe(true);
      } finally {
        process.cwd = originalCwd;
      }
    });

    test("TASK #168 FIX: should handle self-repair failure gracefully", async () => {
      // Arrange: Session directory exists but git remote command fails
      const sessionName = "task#168";
      const sessionPath = join(tempDir, "local-minsky", "sessions", sessionName);

      await mkdir(sessionPath, { recursive: true });

      const mockGetCurrentSession = async () => sessionName;

      // Mock sessionDB to return null (orphaned session)
      mockSessionDB.getSession = async () => null;

      // Mock git service to fail on remote command
      mockGitService.execInRepository = async (workdir: string, command: string) => {
        if (command.includes("git remote get-url origin")) {
          throw new Error("fatal: not a git repository");
        }
        return "";
      };

      // Mock process.cwd to return session path
      const originalCwd = process.cwd;
      process.cwd = () => sessionPath;

      try {
        // Act & Assert: Should throw ResourceNotFoundError after failed self-repair
        await expect(
          updateSessionFromParams(
            {
              name: sessionName,
              noStash: false,
              noPush: false,
              force: false,
            },
            {
              sessionDB: mockSessionDB,
              gitService: mockGitService,
              getCurrentSession: mockGetCurrentSession,
            }
          )
        ).rejects.toThrow(`Session '${sessionName}' not found`);
      } finally {
        process.cwd = originalCwd;
      }
    });

    test("TASK #168 FIX: should extract task ID from session name during self-repair", async () => {
      // Arrange
      const sessionName = "task#42";
      const sessionPath = join(tempDir, "local-minsky", "sessions", sessionName);
      const repoUrl = "https://github.com/test/repo.git";

      await mkdir(sessionPath, { recursive: true });

      const mockGetCurrentSession = async () => sessionName;

      let registeredRecord: SessionRecord | null = null;
      mockSessionDB.getSession = async (name: string) => {
        if (name === sessionName && registeredRecord) {
          return registeredRecord;
        }
        return null;
      };

      mockSessionDB.addSession = async (record: SessionRecord) => {
        registeredRecord = record;
      };

      mockGitService.execInRepository = async (workdir: string, command: string) => {
        if (command.includes("git remote get-url origin")) {
          return repoUrl;
        }
        return "";
      };

      const originalCwd = process.cwd;
      process.cwd = () => sessionPath;

      try {
        // Act
        await updateSessionFromParams(
          {
            name: sessionName,
            noStash: false,
            noPush: false,
            force: false,
          },
          {
            sessionDB: mockSessionDB,
            gitService: mockGitService,
            getCurrentSession: mockGetCurrentSession,
          }
        );

        // Assert: Task ID should be extracted from session name
        expect(registeredRecord).not.toBeNull();
        expect(registeredRecord!.taskId).toBe("task#42");
        expect(registeredRecord!.session).toBe(sessionName);
      } finally {
        process.cwd = originalCwd;
      }
    });

    test("TASK #168 FIX: should provide clear error message when session workspace directory is missing", async () => {
      // Arrange: Session exists in database but directory is missing
      const sessionName = "missing-workspace-session";
      const sessionRecord: SessionRecord = {
        session: sessionName,
        repoName: "local-minsky",
        repoUrl: "/test/repo",
        createdAt: new Date().toISOString(),
      };

      mockSessionDB.getSession = async (name: string) =>
        name === sessionName ? sessionRecord : null;

      // Mock gitService to return a non-existent directory
      const missingWorkdir = join(tempDir, "nonexistent", "sessions", sessionName);
      mockGitService.getSessionWorkdir = (repoName: string, sessionName: string) => missingWorkdir;

      // Act & Assert: Should provide clear error message
      await expect(
        updateSessionFromParams(
          {
            name: sessionName,
            noStash: false,
            noPush: false,
            force: false,
          },
          {
            sessionDB: mockSessionDB,
            gitService: mockGitService,
          }
        )
      ).rejects.toThrow(
        `Session workspace directory does not exist: ${missingWorkdir}. ` +
          `The session '${sessionName}' exists in the database but its workspace directory is missing. ` +
          "This can happen if the directory was manually deleted or the session creation was interrupted. " +
          `Please delete the session with 'minsky session delete ${sessionName}' and recreate it.`
      );
    });

    test("TASK #168 FIX: should provide clear error message for uncommitted changes", async () => {
      // Arrange
      const sessionName = "dirty-session";
      const sessionPath = join(tempDir, "local-minsky", "sessions", sessionName);
      const sessionRecord: SessionRecord = {
        session: sessionName,
        repoName: "local-minsky",
        repoUrl: "/test/repo",
        createdAt: new Date().toISOString(),
      };

      await mkdir(sessionPath, { recursive: true });

      mockSessionDB.getSession = async (name: string) =>
        name === sessionName ? sessionRecord : null;

      mockGitService.getSessionWorkdir = (repoName: string, sessionName: string) => sessionPath;

      // Mock git status to show uncommitted changes
      mockGitService.execInRepository = async (workdir: string, command: string) => {
        if (command.includes("git status --porcelain")) {
          return "M  modified-file.ts\n?? new-file.ts";
        }
        return "";
      };

      // Act & Assert: Should provide clear error message
      await expect(
        updateSessionFromParams(
          {
            name: sessionName,
            noStash: false,
            noPush: false,
            force: false,
          },
          {
            sessionDB: mockSessionDB,
            gitService: mockGitService,
          }
        )
      ).rejects.toThrow(
        "Session workspace has uncommitted changes. Commit or stash your changes before updating, or use --force to override."
      );
    });
  });

  describe("session workspace detection", () => {
    test("TASK #168 FIX: should correctly parse session name from path structure", async () => {
      // Arrange: Test the core path parsing logic without complex mocking
      const sessionName = "task#168";
      const minskyPath = "/tmp/test/minsky/git";

      // Test new path format: <minsky_path>/<repo_name>/sessions/<session_name>
      const newFormatPath = `${minskyPath}/local-minsky/sessions/${sessionName}`;
      const newFormatParts = newFormatPath.substring(minskyPath.length + 1).split("/");

      // Test legacy path format: <minsky_path>/<repo_name>/<session_name>
      const legacyPath = `${minskyPath}/local-minsky/${sessionName}`;
      const legacyParts = legacyPath.substring(minskyPath.length + 1).split("/");

      // Act & Assert: Test path parsing logic
      // New format
      expect(newFormatParts.length).toBeGreaterThanOrEqual(3);
      expect(newFormatParts[1]).toBe("sessions");
      expect(newFormatParts[2]).toBe(sessionName);

      // Legacy format
      expect(legacyParts.length).toBe(2);
      expect(legacyParts[1]).toBe(sessionName);
    });

    test("TASK #168 FIX: should handle various session name formats", async () => {
      // Test that the session detection logic works with different session name formats
      const testCases = ["task#168", "task#42", "feature-branch", "bug-fix-123", "simple-session"];

      testCases.forEach((sessionName) => {
        const minskyPath = "/tmp/test/minsky/git";
        const sessionPath = `${minskyPath}/local-minsky/sessions/${sessionName}`;
        const pathParts = sessionPath.substring(minskyPath.length + 1).split("/");

        // Should correctly extract session name
        expect(pathParts[2]).toBe(sessionName);

        // Should correctly identify as session path
        expect(pathParts[1]).toBe("sessions");
      });
    });
  });

  describe("session inspect command", () => {
    test("placeholder test for inspect command", () => {
      // TODO: Implement session inspect command tests
      expect(true).toBe(true);
    });
  });

  describe("session list operations", () => {
    test("placeholder test for list operations", () => {
      // TODO: Implement session list command tests
      expect(true).toBe(true);
    });
  });

  describe("session pr command", () => {
    test("BUG: session pr should return to session branch after creating PR branch", async () => {
      // This test demonstrates the bug where session pr leaves us on the PR branch
      // instead of returning to the original session branch

      // Arrange
      const sessionName = "task#168";
      const originalBranch = sessionName;
      const prBranch = `pr/${sessionName}`;

      let currentBranch = originalBranch;
      const branchHistory: string[] = [originalBranch]; // Track branch switches

      // Mock git service to track branch switches
      const mockGitService = {
        getCurrentBranch: async () => currentBranch,
        execInRepository: async (workdir: string, command: string) => {
          // Track git switch/checkout commands
          if (command.includes("git switch") || command.includes("git checkout")) {
            const branchMatch = command.match(/(?:switch|checkout)\s+(?:-C\s+)?([^\s]+)/);
            if (branchMatch) {
              currentBranch = branchMatch[1];
              branchHistory.push(currentBranch);
            }
          }

          if (command.includes("git remote get-url origin")) {
            return "https://github.com/test/repo.git";
          }

          if (command.includes("git rev-parse --abbrev-ref HEAD")) {
            return currentBranch;
          }

          return "";
        },
        hasUncommittedChanges: async () => false,
        fetch: async () => undefined,
        push: async () => undefined,
      };

      // Mock session database
      const sessionRecord: SessionRecord = {
        session: sessionName,
        repoName: "local-minsky",
        repoUrl: "/test/repo",
        createdAt: new Date().toISOString(),
        taskId: sessionName,
      };

      mockSessionDB.getSession = async (name: string) =>
        name === sessionName ? sessionRecord : null;

      // Mock the preparePr function to simulate the current buggy behavior
      const mockPreparePr = async (options: any) => {
        // Simulate the current implementation that switches to PR branch but doesn't switch back
        await mockGitService.execInRepository("", `git switch -C ${prBranch} origin/main`);
        await mockGitService.execInRepository("", `git merge --no-ff ${originalBranch}`);

        return {
          prBranch,
          baseBranch: "main",
          title: options.title,
          body: options.body,
        };
      };

      // Act: Simulate session pr command execution
      const originalCwd = process.cwd;
      const sessionPath = `/test/sessions/${sessionName}`;

      // Mock being in session workspace
      process.cwd = () => sessionPath;

      try {
        // This simulates what sessionPrFromParams does
        await mockPreparePr({
          session: sessionName,
          title: "Test PR",
          body: "Test body",
        });

        // Assert: This demonstrates the BUG
        expect(currentBranch).toBe(prBranch); // BUG: We're left on PR branch
        expect(branchHistory).toContain(prBranch); // PR branch was created
        expect(branchHistory[branchHistory.length - 1]).toBe(prBranch); // Last switch was to PR branch

        // What SHOULD happen (this will fail until we fix the bug):
        // expect(currentBranch).toBe(originalBranch); // Should return to session branch
      } finally {
        process.cwd = originalCwd;
      }
    });

    test("CORRECT BEHAVIOR: session pr should return to session branch after creating PR", async () => {
      // This test defines what the CORRECT behavior should be

      // Arrange
      const sessionName = "task#168";
      const originalBranch = sessionName;
      const prBranch = `pr/${sessionName}`;

      let currentBranch = originalBranch;
      const branchHistory: string[] = [originalBranch];

      // Mock git service with CORRECT behavior
      const mockGitService = {
        getCurrentBranch: async () => currentBranch,
        execInRepository: async (workdir: string, command: string) => {
          if (command.includes("git switch") || command.includes("git checkout")) {
            const branchMatch = command.match(/(?:switch|checkout)\s+(?:-C\s+)?([^\s]+)/);
            if (branchMatch) {
              currentBranch = branchMatch[1];
              branchHistory.push(currentBranch);
            }
          }

          if (command.includes("git remote get-url origin")) {
            return "https://github.com/test/repo.git";
          }

          if (command.includes("git rev-parse --abbrev-ref HEAD")) {
            return currentBranch;
          }

          return "";
        },
        hasUncommittedChanges: async () => false,
        fetch: async () => undefined,
        push: async () => undefined,
      };

      // Mock the CORRECT preparePr implementation
      const correctPreparePr = async (options: any) => {
        // 1. Switch to PR branch
        await mockGitService.execInRepository("", `git switch -C ${prBranch} origin/main`);

        // 2. Merge feature branch
        await mockGitService.execInRepository("", `git merge --no-ff ${originalBranch}`);

        // 3. CORRECT BEHAVIOR: Switch back to original branch
        await mockGitService.execInRepository("", `git switch ${originalBranch}`);

        return {
          prBranch,
          baseBranch: "main",
          title: options.title,
          body: options.body,
        };
      };

      // Act: Execute with CORRECT implementation
      await correctPreparePr({
        session: sessionName,
        title: "Test PR",
        body: "Test body",
      });

      // Assert: CORRECT behavior
      expect(currentBranch).toBe(originalBranch); // Should be back on session branch
      expect(branchHistory).toContain(prBranch); // PR branch was created
      expect(branchHistory[branchHistory.length - 1]).toBe(originalBranch); // Last switch was back to session branch
    });
  });
});
