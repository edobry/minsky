import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { join } from "path";
import { isSessionRepository, getSessionFromRepo, resolveWorkspacePath } from "./workspace";
import { SessionDB } from "./session";
import { promises as fs } from "fs";

// For Bun testing, use mock.module to mock modules
const mockExecOutput = {
  stdout: "",
  stderr: "",
};

// Manual mock function utility
function createMockFn<T extends (...args: any[]) => any>(impl?: T): T & { calls: any[]; mockResolvedValue?: (v: any) => void; mockImplementation?: (fn: T) => void; _impl?: T; _resolvedValue?: any } {
  const fn: any = (...args: any[]) => {
    fn.calls.push(args);
    if (typeof fn._impl === 'function') return fn._impl(...args);
    if (fn._resolvedValue !== undefined) return Promise.resolve(fn._resolvedValue);
    return undefined;
  };
  fn.calls = [];
  fn.mockResolvedValue = (v: any) => { fn._resolvedValue = v; };
  fn.mockImplementation = (f: T) => { fn._impl = f; };
  fn._impl = impl;
  fn._resolvedValue = undefined;
  return fn;
}

// Mock the exec function
const mockExecAsync = createMockFn((...args: any[]) => {
  const p: any = Promise.resolve({
    stdout: mockExecOutput.stdout,
    stderr: mockExecOutput.stderr
  });
  p.child = {};
  return p;
});

// Mock the modules
mock.module("child_process", () => ({
  exec: () => {},
}));

mock.module("util", () => ({
  promisify: () => mockExecAsync,
}));

// Mock the SessionDB
mock.module("./session", () => {
  return {
    SessionDB: function() {
      return {
        getSession: async (sessionName: string) => {
          if (sessionName === "existingSession") {
            return {
              session: "existingSession",
              repoUrl: "/path/to/main/workspace",
              repoName: "workspace",
              createdAt: new Date().toISOString()
            };
          }
          if (sessionName === "task#027") {
            return {
              session: "task#027",
              repoUrl: "/path/to/main/workspace",
              repoName: "minsky",
              createdAt: new Date().toISOString()
            };
          }
          return undefined;
        }
      };
    }
  };
});

describe("Workspace Utils", () => {
  beforeEach(() => {
    mockExecOutput.stdout = "";
    mockExecOutput.stderr = "";
    mockExecAsync.mockImplementation = (fn) => { mockExecAsync._impl = fn; };
  });

  describe("isSessionRepository", () => {
    test("should return true for a session repository path", async () => {
      const home = process.env.HOME || "";
      const xdgStateHome = process.env.XDG_STATE_HOME || join(home, ".local/state");
      const sessionPath = join(xdgStateHome, "minsky", "git", "local", "repo", "session-name");
      
      mockExecOutput.stdout = sessionPath;
      
      const result = await isSessionRepository("/some/repo/path", mockExecAsync);
      
      expect(mockExecAsync.calls[0]).toEqual(["git rev-parse --show-toplevel", { cwd: "/some/repo/path" }]);
      expect(result).toBe(true);
    });

    test("should return false for a non-session repository path", async () => {
      mockExecOutput.stdout = "/Users/username/Projects/repo";
      
      const result = await isSessionRepository("/some/repo/path", mockExecAsync);
      
      expect(mockExecAsync.calls[0]).toEqual(["git rev-parse --show-toplevel", { cwd: "/some/repo/path" }]);
      expect(result).toBe(false);
    });

    test("should return false if an error occurs", async () => {
      mockExecAsync.mockImplementation(() => { throw new Error("Command failed"); });
      const result = await isSessionRepository("/some/repo/path", mockExecAsync);
      expect(mockExecAsync.calls[0]).toEqual(["git rev-parse --show-toplevel", { cwd: "/some/repo/path" }]);
      expect(result).toBe(false);
      mockExecAsync.mockImplementation = (fn) => { mockExecAsync._impl = fn; };
    });
    test("should return true for a deeply nested session repository path with sessions subdirectory", async () => {
      const home = process.env.HOME || "";
      const xdgStateHome = process.env.XDG_STATE_HOME || join(home, ".local/state");
      mockExecOutput.stdout = join(xdgStateHome, "minsky", "git", "local", "minsky", "sessions", "task#027");
      
      const result = await isSessionRepository("/some/repo/path", mockExecAsync);
      
      expect(result).toBe(true);
    });
    test("should detect multi-level nesting with sessions directory", async () => {
      const home = process.env.HOME || "";
      const xdgStateHome = process.env.XDG_STATE_HOME || join(home, ".local/state");
      mockExecOutput.stdout = join(xdgStateHome, "minsky", "git", "org", "repo", "nested", "sessions", "feature-branch");
      
      const result = await isSessionRepository("/some/repo/path", mockExecAsync);
      
      expect(result).toBe(true);
    });
  });

  describe("getSessionFromRepo", () => {
    test("should extract session info from a session repository path", async () => {
      const home = process.env.HOME || "";
      const xdgStateHome = process.env.XDG_STATE_HOME || join(home, ".local/state");
      const sessionPath = join(xdgStateHome, "minsky", "git", "local", "repo", "existingSession");
      
      mockExecOutput.stdout = sessionPath;
      
      const result = await getSessionFromRepo("/some/repo/path", mockExecAsync);
      
      expect(mockExecAsync.calls[0]).toEqual(["git rev-parse --show-toplevel", { cwd: "/some/repo/path" }]);
      expect(result).toEqual({
        session: "existingSession",
        mainWorkspace: "/path/to/main/workspace"
      });
    });
    test("should extract session info from a deeply nested session repository path", async () => {
      const home = process.env.HOME || "";
      const xdgStateHome = process.env.XDG_STATE_HOME || join(home, ".local/state");
      const sessionPath = join(xdgStateHome, "minsky", "git", "local", "minsky", "sessions", "task#027");
      mockExecOutput.stdout = sessionPath;
      
      const result = await getSessionFromRepo("/some/repo/path", mockExecAsync);
      
      expect(result).toEqual({
        session: "task#027",
        mainWorkspace: "/path/to/main/workspace",
        path: sessionPath
      });
    });
    test("should return null for a non-session repository path", async () => {
      mockExecOutput.stdout = "/Users/username/Projects/repo";
      
      const result = await getSessionFromRepo("/some/repo/path", mockExecAsync);
      
      expect(mockExecAsync.calls[0]).toEqual(["git rev-parse --show-toplevel", { cwd: "/some/repo/path" }]);
      expect(result === null).toBe(true);
    });
    test("should return null if the session record is not found", async () => {
      const home = process.env.HOME || "";
      const xdgStateHome = process.env.XDG_STATE_HOME || join(home, ".local/state");
      const sessionPath = join(xdgStateHome, "minsky", "git", "local", "repo", "nonExistingSession");
      
      mockExecOutput.stdout = sessionPath;
      
      const result = await getSessionFromRepo("/some/repo/path", mockExecAsync);
      
      expect(mockExecAsync.calls[0]).toEqual(["git rev-parse --show-toplevel", { cwd: "/some/repo/path" }]);
      expect(result === null).toBe(true);
    });
    test("should return null if an error occurs", async () => {
      mockExecAsync.mockImplementation(() => { throw new Error("Command failed"); });
      const result = await getSessionFromRepo("/some/repo/path", mockExecAsync);
      expect(mockExecAsync.calls[0]).toEqual(["git rev-parse --show-toplevel", { cwd: "/some/repo/path" }]);
      expect(result === null).toBe(true);
      mockExecAsync.mockImplementation = (fn) => { mockExecAsync._impl = fn; };
    });
  });

  describe("resolveWorkspacePath", () => {
    test("should use explicitly provided workspace path", async () => {
      // Mock fs.access
      const originalAccess = fs.access;
      fs.access = createMockFn(() => Promise.resolve()) as any;
      
      const result = await resolveWorkspacePath({ workspace: "/path/to/workspace" }, { getSessionFromRepo: (...args) => getSessionFromRepo(...args.slice(0, 3), mockExecAsync) });
      
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
        await resolveWorkspacePath({ workspace: "/invalid/path" }, { getSessionFromRepo: (...args) => getSessionFromRepo(...args.slice(0, 3), mockExecAsync) });
      } catch (err) {
        errorCaught = true;
        expect((err as Error).message).toContain("Invalid workspace path: /invalid/path. Path must be a valid Minsky workspace.");
      }
      expect(errorCaught).toBe(true);
      expect((fs.access as any).calls[0]).toEqual([join("/invalid/path", "process")]);
      // Restore original
      fs.access = originalAccess;
    });

    test("should use main workspace path if in a session repo", async () => {
      const home = process.env.HOME || "";
      const xdgStateHome = process.env.XDG_STATE_HOME || join(home, ".local/state");
      const sessionPath = join(xdgStateHome, "minsky", "git", "local", "repo", "existingSession");
      
      mockExecOutput.stdout = sessionPath;
      
      const result = await resolveWorkspacePath({ sessionRepo: "/some/session/path" }, { getSessionFromRepo: (...args) => getSessionFromRepo(...args.slice(0, 3), mockExecAsync) });
      
      expect(mockExecAsync.calls[0]).toEqual(["git rev-parse --show-toplevel", { cwd: "/some/session/path" }]);
      expect(result).toBe("/path/to/main/workspace");
    });

    test("should use current directory if not in a session repo", async () => {
      mockExecOutput.stdout = "/Users/username/Projects/repo";
      
      const result = await resolveWorkspacePath({ sessionRepo: "/some/non/session/path" }, { getSessionFromRepo: (...args) => getSessionFromRepo(...args.slice(0, 3), mockExecAsync) });
      
      expect(mockExecAsync.calls[0]).toEqual(["git rev-parse --show-toplevel", { cwd: "/some/non/session/path" }]);
      expect(result).toBe("/some/non/session/path");
    });

    test("should use current directory if no options provided", async () => {
      mockExecOutput.stdout = "/Users/username/Projects/repo";
      
      const originalCwd = process.cwd;
      process.cwd = createMockFn(() => "/current/directory") as any;
      
      const result = await resolveWorkspacePath({}, { getSessionFromRepo: (...args) => getSessionFromRepo(...args.slice(0, 3), mockExecAsync) });
      
      expect(mockExecAsync.calls[0]).toEqual(["git rev-parse --show-toplevel", { cwd: "/current/directory" }]);
      
      // Restore original
      process.cwd = originalCwd;
      expect(result).toBe("/current/directory");
    });
  });

  // Additional tests for getCurrentSession utility (if implemented)
}); 
