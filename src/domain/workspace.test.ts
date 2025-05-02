import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { isSessionRepository, getSessionFromRepo, resolveWorkspacePath } from "./workspace";
import { SessionDB } from "./session";
import { promises as fs } from "fs";
import type { SessionRecord } from "./session";

// For Bun testing, use mock for function mocks only
const mockExecOutput = {
  stdout: "",
  stderr: "",
};

function createMockExecAsync(): any {
  const fn: any = async (...args: any[]) => {
    fn.calls.push(args);
    if (fn._impl) return fn._impl(...args);
    return { stdout: mockExecOutput.stdout, stderr: mockExecOutput.stderr, child: null };
  };
  fn.calls = [] as any[];
  fn.mockImplementation = (impl: any) => { fn._impl = impl; };
  fn._impl = null;
  fn.toHaveBeenCalledWith = (...expected: any[]) => {
    expect(fn.calls.some((call: any) => JSON.stringify(call) === JSON.stringify(expected))).toBe(true);
  };
  return fn;
}
const mockExecAsync: any = createMockExecAsync();

// Stub SessionDB for getSessionFromRepo tests
const stubSessionDB = {
  getSession: async (sessionName: string): Promise<SessionRecord | null> => {
    if (sessionName === "existingSession") {
      return {
        session: "existingSession",
        repoUrl: "/path/to/main/workspace",
        repoName: "workspace",
        createdAt: new Date().toISOString()
      };
    }
    return null;
  }
};

describe("Workspace Utils", () => {
  beforeEach(() => {
    mockExecOutput.stdout = "";
    mockExecOutput.stderr = "";
    mockExecAsync.calls = [];
    mockExecAsync._impl = null;
    if ((fs.access as any).calls) (fs.access as any).calls = [];
  });

  describe("isSessionRepository", () => {
    test("should return true for a session repository path", async () => {
      const home = process.env.HOME || "";
      const xdgStateHome = process.env.XDG_STATE_HOME || join(home, ".local/state");
      const sessionPath = join(xdgStateHome, "minsky", "git", "repo", "existingSession");
      
      mockExecOutput.stdout = sessionPath;
      
      const result = await isSessionRepository("/some/repo/path", mockExecAsync as any);
      
      expect(mockExecAsync.calls.some((x: any) => JSON.stringify(x) === JSON.stringify(["git rev-parse --show-toplevel", { cwd: "/some/repo/path" }]))).toBe(true);
      expect(result).toBe(true);
    });

    test("should return false for a non-session repository path", async () => {
      mockExecOutput.stdout = "/Users/username/Projects/repo";
      
      const result = await isSessionRepository("/some/repo/path", mockExecAsync as any);
      
      expect(mockExecAsync.calls.some((x: any) => JSON.stringify(x) === JSON.stringify(["git rev-parse --show-toplevel", { cwd: "/some/repo/path" }]))).toBe(true);
      expect(result).toBe(false);
    });

    test("should return false if an error occurs", async () => {
      const originalImpl = mockExecAsync.mockImplementation;
      mockExecAsync.mockImplementation(() => { throw new Error("Command failed"); });
      
      const result = await isSessionRepository("/some/repo/path", mockExecAsync as any);
      
      expect(mockExecAsync.calls.some((x: any) => JSON.stringify(x) === JSON.stringify(["git rev-parse --show-toplevel", { cwd: "/some/repo/path" }]))).toBe(true);
      expect(result).toBe(false);
      
      mockExecAsync.mockImplementation(originalImpl);
    });
  });

  describe("getSessionFromRepo", () => {
    test("should extract session info from a session repository path", async () => {
      const home = process.env.HOME || "";
      const xdgStateHome = process.env.XDG_STATE_HOME || join(home, ".local/state");
      const sessionPath = join(xdgStateHome, "minsky", "git", "repo", "existingSession");
      
      mockExecOutput.stdout = sessionPath;
      
      const result = await getSessionFromRepo("/some/repo/path", mockExecAsync as any, stubSessionDB);
      
      expect(mockExecAsync.calls.some((x: any) => JSON.stringify(x) === JSON.stringify(["git rev-parse --show-toplevel", { cwd: "/some/repo/path" }]))).toBe(true);
      expect(result).toEqual({
        session: "existingSession",
        mainWorkspace: "/path/to/main/workspace"
      });
    });

    test("should return null for a non-session repository path", async () => {
      mockExecOutput.stdout = "/Users/username/Projects/repo";
      
      const result = await getSessionFromRepo("/some/repo/path", mockExecAsync as any, stubSessionDB);
      
      expect(mockExecAsync.calls.some((x: any) => JSON.stringify(x) === JSON.stringify(["git rev-parse --show-toplevel", { cwd: "/some/repo/path" }]))).toBe(true);
      expect(result).toBe(null);
    });

    test("should return null if the session record is not found", async () => {
      const home = process.env.HOME || "";
      const xdgStateHome = process.env.XDG_STATE_HOME || join(home, ".local/state");
      const sessionPath = join(xdgStateHome, "minsky", "git", "repo", "nonExistingSession");
      
      mockExecOutput.stdout = sessionPath;
      
      const result = await getSessionFromRepo("/some/repo/path", mockExecAsync as any, stubSessionDB);
      
      expect(mockExecAsync.calls.some((x: any) => JSON.stringify(x) === JSON.stringify(["git rev-parse --show-toplevel", { cwd: "/some/repo/path" }]))).toBe(true);
      expect(result).toBe(null);
    });

    test("should return null if an error occurs", async () => {
      const originalImpl = mockExecAsync.mockImplementation;
      mockExecAsync.mockImplementation(() => { throw new Error("Command failed"); });
      
      const result = await getSessionFromRepo("/some/repo/path", mockExecAsync as any, stubSessionDB);
      
      expect(mockExecAsync.calls.some((x: any) => JSON.stringify(x) === JSON.stringify(["git rev-parse --show-toplevel", { cwd: "/some/repo/path" }]))).toBe(true);
      expect(result).toBe(null);
      
      mockExecAsync.mockImplementation(originalImpl);
    });
  });

  describe("resolveWorkspacePath", () => {
    test("should use explicitly provided workspace path", async () => {
      // Mock fs.access
      (fs.access as any) = async (...args: any[]) => {
        (fs.access as any).calls.push(args);
        return Promise.resolve();
      };
      (fs.access as any).calls = [];
      
      const result = await resolveWorkspacePath({ workspace: "/path/to/workspace" });
      
      expect(result).toBe("/path/to/workspace");
      expect(((fs.access as any).calls || []).some((x: any) => JSON.stringify(x) === JSON.stringify([join("/path/to/workspace", "process")]))).toBe(true);
      
      // Restore original
      (fs.access as any) = async (...args: any[]) => {
        (fs.access as any).calls.push(args);
        return Promise.resolve();
      };
      (fs.access as any).calls = [];
    });

    test("should throw error if workspace path is invalid", async () => {
      // Mock fs.access
      (fs.access as any) = async (...args: any[]) => {
        (fs.access as any).calls.push(args);
        return Promise.reject(new Error("File not found"));
      };
      (fs.access as any).calls = [];
      
      let error;
      try {
        await resolveWorkspacePath({ workspace: "/invalid/path" });
      } catch (e) {
        error = e;
      }
      expect(error !== undefined).toBe(true);
      expect((error as Error).message).toContain("Invalid workspace path: /invalid/path. Path must be a valid Minsky workspace.");
      
      expect(((fs.access as any).calls || []).some((x: any) => JSON.stringify(x) === JSON.stringify([join("/invalid/path", "process")]))).toBe(true);
      
      // Restore original
      (fs.access as any) = async (...args: any[]) => {
        (fs.access as any).calls.push(args);
        return Promise.resolve();
      };
      (fs.access as any).calls = [];
    });

    test("should use main workspace path if in a session repo", async () => {
      const home = process.env.HOME || "";
      const xdgStateHome = process.env.XDG_STATE_HOME || join(home, ".local/state");
      const sessionPath = join(xdgStateHome, "minsky", "git", "repo", "existingSession");
      
      mockExecOutput.stdout = sessionPath;
      
      const result = await resolveWorkspacePath({ sessionRepo: "/some/session/path" }, { getSessionFromRepo: (repoPath: string) => getSessionFromRepo(repoPath, mockExecAsync as any, stubSessionDB) });
      
      expect(mockExecAsync.calls.some((x: any) => JSON.stringify(x) === JSON.stringify(["git rev-parse --show-toplevel", { cwd: "/some/session/path" }]))).toBe(true);
      expect(result).toBe("/path/to/main/workspace");
    });

    test("should use current directory if not in a session repo", async () => {
      mockExecOutput.stdout = "/Users/username/Projects/repo";
      
      const result = await resolveWorkspacePath({ sessionRepo: "/some/non/session/path" }, { getSessionFromRepo: (repoPath: string) => getSessionFromRepo(repoPath, mockExecAsync as any, stubSessionDB) });
      
      expect(mockExecAsync.calls.some((x: any) => JSON.stringify(x) === JSON.stringify(["git rev-parse --show-toplevel", { cwd: "/some/non/session/path" }]))).toBe(true);
      expect(result).toBe("/some/non/session/path");
    });

    test("should use current directory if no options provided", async () => {
      mockExecOutput.stdout = "/Users/username/Projects/repo";
      
      const originalCwd = process.cwd;
      process.cwd = () => "/current/directory";
      
      const result = await resolveWorkspacePath(undefined, { getSessionFromRepo: (repoPath: string) => getSessionFromRepo(repoPath, mockExecAsync as any, stubSessionDB) });
      
      expect(mockExecAsync.calls.some((x: any) => JSON.stringify(x) === JSON.stringify(["git rev-parse --show-toplevel", { cwd: "/current/directory" }]))).toBe(true);
      expect(result).toBe("/current/directory");
      
      // Restore original
      process.cwd = originalCwd;
    });
  });
}); 
