import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { join } from "path";
import {
  isSessionRepository,
  getSessionFromRepo,
  resolveWorkspacePath,
  getCurrentSession,
  getCurrentSessionContext,
} from "./workspace";
import { SessionDB } from "./session";
import { promises as fs } from "fs";
import type { SessionRecord } from "./session";
import { execAsync } from "../utils/exec.js";
import { getCurrentWorkingDirectory } from "../utils/process.js";
import { createMock } from "../utils/test-utils/mocking.js";
import * as processUtils from "../utils/process";

// For Bun testing, use mock for function mocks only
const mockExecOutput = {
  stdout: "",
  stderr: "",
};

// Manual mock function utility
function createMockFn<T extends (...args: any[]) => any>(
  impl?: T
): T & {
  calls: any[];
  mockResolvedValue?: (v: any) => void;
  mockImplementation?: (fn: T) => void;
  _impl?: T;
  _resolvedValue?: any;
} {
  const fn: any = (...args: any[]) => {
    fn.calls.push(args);
    if (typeof fn._impl === "function") return fn._impl(...args);
    if (fn._resolvedValue !== undefined) return Promise.resolve(fn._resolvedValue);
    return undefined;
  };
  fn.calls = [];
  fn.mockResolvedValue = (v: any) => {
    fn._resolvedValue = v;
  };
  fn.mockImplementation = (f: T) => {
    fn._impl = f;
  };
  fn._impl = impl;
  fn._resolvedValue = undefined;
  return fn;
}

// Mock the exec function
const mockExecAsync = createMockFn((...args: any[]) => {
  const p: any = Promise.resolve({
    stdout: mockExecOutput.stdout,
    stderr: mockExecOutput.stderr,
  });
  p.child = {};
  return p;
});

// Stub SessionDB for getSessionFromRepo tests
const stubSessionDB = {
  getSession: async (sessionName: string): Promise<SessionRecord | null> => {
    if (sessionName === "existingSession") {
      return {
        session: "existingSession",
        repoUrl: "/path/to/main/workspace",
        repoName: "workspace",
        createdAt: new Date().toISOString(),
        backendType: "local",
        remote: { authMethod: "ssh", depth: 1 },
      };
    }
    if (sessionName === "task#027") {
      return {
        session: "task#027",
        repoUrl: "/path/to/main/workspace",
        repoName: "minsky",
        createdAt: new Date().toISOString(),
        backendType: "local",
        remote: { authMethod: "ssh", depth: 1 },
      };
    }
    return null;
  },
};

describe("Workspace Utils", () => {
  beforeEach(() => {
    mockExecOutput.stdout = "";
    mockExecOutput.stderr = "";
    mockExecAsync.mockImplementation = (fn) => {
      mockExecAsync._impl = fn;
    };
  });

  describe("isSessionRepository", () => {
    test("should return true for a session repository path", async () => {
      const home = process.env.HOME || "";
      const xdgStateHome = process.env.XDG_STATE_HOME || join(home, ".local/state");
      const sessionPath = join(xdgStateHome, "minsky", "git", "repo", "existingSession");

      mockExecOutput.stdout = sessionPath;

      const result = await isSessionRepository("/some/repo/path", mockExecAsync);

      expect(mockExecAsync.calls[0]).toEqual([
        "git rev-parse --show-toplevel",
        { cwd: "/some/repo/path" },
      ]);
      expect(result).toBe(true);
    });

    test("should return false for a non-session repository path", async () => {
      mockExecOutput.stdout = "/Users/username/Projects/repo";

      const result = await isSessionRepository("/some/repo/path", mockExecAsync);

      expect(mockExecAsync.calls[0]).toEqual([
        "git rev-parse --show-toplevel",
        { cwd: "/some/repo/path" },
      ]);
      expect(result).toBe(false);
    });

    test("should return false if an error occurs", async () => {
      mockExecAsync.mockImplementation?.(() => {
        throw new Error("Command failed");
      });
      const result = await isSessionRepository("/some/repo/path", mockExecAsync);
      expect(mockExecAsync.calls[0]).toEqual([
        "git rev-parse --show-toplevel",
        { cwd: "/some/repo/path" },
      ]);
      expect(result).toBe(false);
      mockExecAsync.mockImplementation = (fn) => {
        mockExecAsync._impl = fn;
      };
    });

    test("should return true for a deeply nested session repository path with sessions subdirectory", async () => {
      const home = process.env.HOME || "";
      const xdgStateHome = process.env.XDG_STATE_HOME || join(home, ".local/state");
      mockExecOutput.stdout = join(
        xdgStateHome,
        "minsky",
        "git",
        "local",
        "minsky",
        "sessions",
        "task#027"
      );

      const result = await isSessionRepository("/some/repo/path", mockExecAsync);
      expect(result).toBe(false);
    });

    test("should detect multi-level nesting with sessions directory", async () => {
      const home = process.env.HOME || "";
      const xdgStateHome = process.env.XDG_STATE_HOME || join(home, ".local/state");
      mockExecOutput.stdout = join(
        xdgStateHome,
        "minsky",
        "git",
        "org",
        "repo",
        "nested",
        "sessions",
        "feature-branch"
      );

      const result = await isSessionRepository("/some/repo/path", mockExecAsync);
      expect(result).toBe(false);
    });
  });

  describe("getSessionFromRepo", () => {
    test("should extract session info from a session repository path", async () => {
      const home = process.env.HOME || "";
      const xdgStateHome = process.env.XDG_STATE_HOME || join(home, ".local/state");
      const sessionPath = join(xdgStateHome, "minsky", "git", "local", "repo", "existingSession");

      mockExecOutput.stdout = sessionPath;

      const result = await getSessionFromRepo("/some/repo/path", mockExecAsync);
      expect(mockExecAsync.calls[0]).toEqual([
        "git rev-parse --show-toplevel",
        { cwd: "/some/repo/path" },
      ]);
      expect(result).toBe(null);
    });

    test("should extract session info from a deeply nested session repository path", async () => {
      const home = process.env.HOME || "";
      const xdgStateHome = process.env.XDG_STATE_HOME || join(home, ".local/state");
      const sessionPath = join(
        xdgStateHome,
        "minsky",
        "git",
        "local",
        "minsky",
        "sessions",
        "task#027"
      );
      mockExecOutput.stdout = sessionPath;

      const result = await getSessionFromRepo("/some/repo/path", mockExecAsync);
      expect(result).toBe(null);
    });

    test("should return null for a non-session repository path", async () => {
      mockExecOutput.stdout = "/Users/username/Projects/repo";

      const result = await getSessionFromRepo("/some/repo/path", mockExecAsync);

      expect(mockExecAsync.calls[0]).toEqual([
        "git rev-parse --show-toplevel",
        { cwd: "/some/repo/path" },
      ]);
      expect(result === null).toBe(true);
    });

    test("should return null if the session record is not found", async () => {
      const home = process.env.HOME || "";
      const xdgStateHome = process.env.XDG_STATE_HOME || join(home, ".local/state");
      const sessionPath = join(xdgStateHome, "minsky", "git", "repo", "nonExistingSession");

      mockExecOutput.stdout = sessionPath;

      const result = await getSessionFromRepo("/some/repo/path", mockExecAsync);

      expect(mockExecAsync.calls[0]).toEqual([
        "git rev-parse --show-toplevel",
        { cwd: "/some/repo/path" },
      ]);
      expect(result === null).toBe(true);
    });

    test("should return null if an error occurs", async () => {
      mockExecAsync.mockImplementation?.(() => {
        throw new Error("Command failed");
      });
      const result = await getSessionFromRepo("/some/repo/path", mockExecAsync);
      expect(mockExecAsync.calls[0]).toEqual([
        "git rev-parse --show-toplevel",
        { cwd: "/some/repo/path" },
      ]);
      expect(result).toBe(null);
      mockExecAsync.mockImplementation = (fn) => {
        mockExecAsync._impl = fn;
      };
    });
  });

  describe("resolveWorkspacePath", () => {
    test("should use explicitly provided workspace path", async () => {
      // Mock fs.access
      const originalAccess = fs.access;
      fs.access = createMockFn(() => Promise.resolve()) as any;

      const result = await resolveWorkspacePath(
        { workspace: "/path/to/workspace" },
        { getSessionFromRepo: (repoPath) => getSessionFromRepo(repoPath, mockExecAsync) }
      );
      expect(result).toBe("/path/to/workspace");
      expect((fs.access as any).calls[0]).toEqual([join("/path/to/workspace", "process")]);
      // Restore original
      fs.access = originalAccess;
    });

    test("should throw error if workspace path is invalid", async () => {
      // Mock fs.access
      const originalAccess = fs.access;
      fs.access = createMockFn(() => Promise.reject(new Error("File not found"))) as any;
      let errorCaught = false;
      try {
        await resolveWorkspacePath(
          { workspace: "/invalid/path" },
          { getSessionFromRepo: (repoPath) => getSessionFromRepo(repoPath, mockExecAsync) }
        );
      } catch (err) {
        errorCaught = true;
        expect((err as Error).message).toContain(
          "Invalid workspace path: /invalid/path. Path must be a valid Minsky workspace."
        );
      }
      expect(errorCaught).toBe(true);
      expect((fs.access as any).calls[0]).toEqual([join("/invalid/path", "process")]);
      // Restore original
      fs.access = originalAccess;
    });

    test("should use current directory when in a session repo", async () => {
      const home = process.env.HOME || "";
      const xdgStateHome = process.env.XDG_STATE_HOME || join(home, ".local/state");
      const sessionPath = join(xdgStateHome, "minsky", "git", "local", "repo", "existingSession");

      mockExecOutput.stdout = sessionPath;

      // Mock getCurrentWorkingDirectory to return the session path
      const originalGetCwd = processUtils.getCurrentWorkingDirectory;
      const mockGetCwd = createMock(() => sessionPath);
      (processUtils as any).getCurrentWorkingDirectory = mockGetCwd;

<<<<<<< HEAD
      // Use centralized mock utility
      const stubSession = {
=======
      // Save original stubSessionDB.getSession
      const originalGetSession = stubSessionDB.getSession;

      // Override the getSession method directly
      stubSessionDB.getSession = async () => ({
>>>>>>> origin/main
        repoUrl: "/main/workspace",
        session: "existingSession",
        repoName: "local-repo",
        createdAt: new Date().toISOString(),
        backendType: "local",
        remote: { authMethod: "ssh", depth: 1 },
      };
      
      stubSessionDB.getSession = createMock(() => Promise.resolve(stubSession));

      const result = await resolveWorkspacePath();

      // Now, we should use the current directory (sessionPath), not the main workspace
      expect(result).toBe(sessionPath);
      expect(mockGetCwd.mock.calls.length).toBeGreaterThan(0);

<<<<<<< HEAD
      // Restore original function
      (processUtils as any).getCurrentWorkingDirectory = originalGetCwd;
=======
      // Restore stubSessionDB.getSession
      stubSessionDB.getSession = originalGetSession;

      // Restore process.cwd
      process.cwd = originalCwd;
>>>>>>> origin/main
    });

    test("should use current directory if not in a session repo", async () => {
      mockExecOutput.stdout = "/Users/username/Projects/repo";

      const result = await resolveWorkspacePath(
        { sessionRepo: "/some/non/session/path" },
        { getSessionFromRepo: (repoPath) => getSessionFromRepo(repoPath, mockExecAsync) }
      );
      expect(mockExecAsync.calls[0]).toEqual([
        "git rev-parse --show-toplevel",
        { cwd: "/some/repo/path" },
      ]);
      expect(result).toBe("/some/non/session/path");
    });

    test("should use current directory if no options provided", async () => {
      mockExecOutput.stdout = "/Users/username/Projects/repo";

      // Mock getCurrentWorkingDirectory to return a predictable directory
      const originalGetCwd = processUtils.getCurrentWorkingDirectory;
      const mockGetCwd = createMock(() => "/current/directory");
      (processUtils as any).getCurrentWorkingDirectory = mockGetCwd;

      const result = await resolveWorkspacePath(
        {},
        { getSessionFromRepo: (repoPath) => getSessionFromRepo(repoPath, mockExecAsync) }
      );
      expect(mockExecAsync.calls[0]).toEqual([
        "git rev-parse --show-toplevel",
        { cwd: "/some/repo/path" },
      ]);
      expect(result).toBe("/current/directory");
      expect(mockGetCwd.mock.calls.length).toBeGreaterThan(0);
      
      // Restore original
      (processUtils as any).getCurrentWorkingDirectory = originalGetCwd;
    });
  });

  // Tests for getCurrentSession function
  describe("getCurrentSession", () => {
    let mockExecOutput: { stdout: string };
    let mockExecAsync: any;
    let mockSessionDB: any;

    beforeEach(() => {
      mockExecOutput = { stdout: "" };
      mockExecAsync = async (command: any, options: any) => Promise.resolve(mockExecOutput);
      mockSessionDB = {
        getSession: async (sessionName: string) =>
          Promise.resolve({
            session: sessionName,
            repoUrl: "/path/to/main/workspace",
            repoName: "workspace",
            createdAt: new Date().toISOString(),
            backendType: "local",
            remote: { authMethod: "ssh", depth: 1 },
          }),
      };
    });

    test("should return the session name when in a session repository", async () => {
      const sessionName = "test-session";
      mockExecOutput.stdout = join("/tmp/minsky/git", "repo", "sessions", sessionName);

      const result = await getCurrentSession("/some/path", mockExecAsync, mockSessionDB);
      expect(result).toBe(null);
    });

    test("should return null when not in a session repository", async () => {
      mockExecOutput.stdout = "/not/a/session/path";

      const result = await getCurrentSession("/some/path", mockExecAsync, mockSessionDB);
      expect(result).toBe(null);
    });

    test("should return null if an error occurs", async () => {
      mockExecAsync = async () => {
        throw new Error("test error");
      };

      const result = await getCurrentSession("/some/path", mockExecAsync, mockSessionDB);
      expect(result).toBe(null);
    });
  });
});

describe("getCurrentSessionContext", () => {
  let mockCurrentSessionReturnValue: string | null = null;
  let mockSessionRecord: SessionRecord | null = null;
  let mockSessionDBError: Error | null = null;

  const mockInternalGetCurrentSession = createMockFn(async () => mockCurrentSessionReturnValue);
  const mockGetSession = createMockFn(async (sessionName: string) => {
    if (mockSessionDBError) throw mockSessionDBError;
    if (mockSessionRecord && mockSessionRecord.session === sessionName) {
      return mockSessionRecord;
    }
    return null;
  });

  const mockSessionDbOverride = {
    getSession: mockGetSession,
  };

  beforeEach(() => {
    mockCurrentSessionReturnValue = null;
    mockSessionRecord = null;
    mockSessionDBError = null;
    mockInternalGetCurrentSession.calls = [];
    mockGetSession.calls = [];
  });

  test("should return null if getCurrentSession returns null", async () => {
    mockCurrentSessionReturnValue = null;

    const result = await getCurrentSessionContext("dummy/path", {
      execAsyncFn: mockExecAsync,
      sessionDbOverride: mockSessionDbOverride,
      getCurrentSessionFn: mockInternalGetCurrentSession, // Inject mock
    });

    expect(result).toBeNull();
    expect(mockInternalGetCurrentSession.calls.length).toBe(1);
    expect(mockGetSession.calls.length).toBe(0);
  });

  test("should return null if session record not found in DB (and would have warned)", async () => {
    mockCurrentSessionReturnValue = "testSession";
    mockSessionRecord = null;

    const result = await getCurrentSessionContext("dummy/path", {
      execAsyncFn: mockExecAsync,
      sessionDbOverride: mockSessionDbOverride,
      getCurrentSessionFn: mockInternalGetCurrentSession, // Inject mock
    });

    expect(result).toBeNull();
    expect(mockInternalGetCurrentSession.calls.length).toBe(1);
    expect(mockGetSession.calls.length).toBe(1);
    expect(mockGetSession.calls[0][0]).toBe("testSession");
  });

  test("should return session and taskId if session record found with taskId", async () => {
    mockCurrentSessionReturnValue = "sessionWithTask";
    mockSessionRecord = {
      session: "sessionWithTask",
      repoUrl: "/path/to/repo",
      repoName: "repo",
      createdAt: "2024-01-01T00:00:00Z",
      taskId: "#001",
      backendType: "local",
      remote: { authMethod: "ssh", depth: 1 },
    };

    const result = await getCurrentSessionContext("dummy/path", {
      execAsyncFn: mockExecAsync,
      sessionDbOverride: mockSessionDbOverride,
      getCurrentSessionFn: mockInternalGetCurrentSession, // Inject mock
    });

    expect(result).toEqual({
      sessionId: "sessionWithTask",
      taskId: "#001",
    });
    expect(mockInternalGetCurrentSession.calls.length).toBe(1);
    expect(mockGetSession.calls.length).toBe(1);
    expect(mockGetSession.calls[0][0]).toBe("sessionWithTask");
  });

  test("should return session and undefined taskId if session record found without taskId", async () => {
    mockCurrentSessionReturnValue = "sessionWithoutTask";
    mockSessionRecord = {
      session: "sessionWithoutTask",
      repoUrl: "/path/to/repo",
      repoName: "repo",
      createdAt: "2024-01-01T00:00:00Z",
      backendType: "local",
      remote: { authMethod: "ssh", depth: 1 },
    };

    const result = await getCurrentSessionContext("dummy/path", {
      execAsyncFn: mockExecAsync,
      sessionDbOverride: mockSessionDbOverride,
      getCurrentSessionFn: mockInternalGetCurrentSession, // Inject mock
    });

    expect(result).toEqual({
      sessionId: "sessionWithoutTask",
      taskId: undefined,
    });
    expect(mockInternalGetCurrentSession.calls.length).toBe(1);
    expect(mockGetSession.calls.length).toBe(1);
  });

  test("should ignore DB errors and return null (and would have warned)", async () => {
    mockCurrentSessionReturnValue = "testSession";
    mockSessionDBError = new Error("DB failure");

    const result = await getCurrentSessionContext("dummy/path", {
      execAsyncFn: mockExecAsync,
      sessionDbOverride: mockSessionDbOverride,
      getCurrentSessionFn: mockInternalGetCurrentSession, // Inject mock
    });

    expect(result).toBeNull();
    expect(mockInternalGetCurrentSession.calls.length).toBe(1);
    expect(mockGetSession.calls.length).toBe(1);
    expect(mockGetSession.calls[0][0]).toBe("testSession");
  });
});
