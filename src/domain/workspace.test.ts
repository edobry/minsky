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

// Mock the exec function
const mockExecAsync = mock(async () => ({ 
  stdout: mockExecOutput.stdout, 
  stderr: mockExecOutput.stderr 
}));

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
  });

  describe("isSessionRepository", () => {
    test("should return true for a session repository path", async () => {
      const home = process.env.HOME || "";
      const xdgStateHome = process.env.XDG_STATE_HOME || join(home, ".local/state");
      const sessionPath = join(xdgStateHome, "minsky", "git", "local", "repo", "session-name");
      
      mockExecOutput.stdout = sessionPath;
      
      const result = await isSessionRepository("/some/repo/path");
      
      expect(mockExecAsync).toHaveBeenCalledWith("git rev-parse --show-toplevel", { cwd: "/some/repo/path" });
      expect(result).toBe(true);
    });

    test("should return false for a non-session repository path", async () => {
      mockExecOutput.stdout = "/Users/username/Projects/repo";
      
      const result = await isSessionRepository("/some/repo/path");
      
      expect(mockExecAsync).toHaveBeenCalledWith("git rev-parse --show-toplevel", { cwd: "/some/repo/path" });
      expect(result).toBe(false);
    });

    test("should return false if an error occurs", async () => {
      mockExecAsync.mockImplementationOnce(() => {
        throw new Error("Command failed");
      });
      
      const result = await isSessionRepository("/some/repo/path");
      
      expect(mockExecAsync).toHaveBeenCalledWith("git rev-parse --show-toplevel", { cwd: "/some/repo/path" });
      expect(result).toBe(false);
    });
  });

  describe("getSessionFromRepo", () => {
    test("should extract session info from a session repository path", async () => {
      const home = process.env.HOME || "";
      const xdgStateHome = process.env.XDG_STATE_HOME || join(home, ".local/state");
      const sessionPath = join(xdgStateHome, "minsky", "git", "local", "repo", "existingSession");
      
      mockExecOutput.stdout = sessionPath;
      
      const result = await getSessionFromRepo("/some/repo/path");
      
      expect(mockExecAsync).toHaveBeenCalledWith("git rev-parse --show-toplevel", { cwd: "/some/repo/path" });
      expect(result).toEqual({
        session: "existingSession",
        mainWorkspace: "/path/to/main/workspace"
      });
    });

    test("should return null for a non-session repository path", async () => {
      mockExecOutput.stdout = "/Users/username/Projects/repo";
      
      const result = await getSessionFromRepo("/some/repo/path");
      
      expect(mockExecAsync).toHaveBeenCalledWith("git rev-parse --show-toplevel", { cwd: "/some/repo/path" });
      expect(result).toBeNull();
    });

    test("should return null if the session record is not found", async () => {
      const home = process.env.HOME || "";
      const xdgStateHome = process.env.XDG_STATE_HOME || join(home, ".local/state");
      const sessionPath = join(xdgStateHome, "minsky", "git", "local", "repo", "nonExistingSession");
      
      mockExecOutput.stdout = sessionPath;
      
      const result = await getSessionFromRepo("/some/repo/path");
      
      expect(mockExecAsync).toHaveBeenCalledWith("git rev-parse --show-toplevel", { cwd: "/some/repo/path" });
      expect(result).toBeNull();
    });

    test("should return null if an error occurs", async () => {
      mockExecAsync.mockImplementationOnce(() => {
        throw new Error("Command failed");
      });
      
      const result = await getSessionFromRepo("/some/repo/path");
      
      expect(mockExecAsync).toHaveBeenCalledWith("git rev-parse --show-toplevel", { cwd: "/some/repo/path" });
      expect(result).toBeNull();
    });
  });

  describe("resolveWorkspacePath", () => {
    test("should use explicitly provided workspace path", async () => {
      // Mock fs.access
      const originalAccess = fs.access;
      fs.access = mock(() => Promise.resolve());
      
      const result = await resolveWorkspacePath({ workspace: "/path/to/workspace" });
      
      expect(result).toBe("/path/to/workspace");
      expect(fs.access).toHaveBeenCalledWith(join("/path/to/workspace", "process"));
      
      // Restore original
      fs.access = originalAccess;
    });

    test("should throw error if workspace path is invalid", async () => {
      // Mock fs.access
      const originalAccess = fs.access;
      fs.access = mock(() => Promise.reject(new Error("File not found")));
      
      await expect(resolveWorkspacePath({ workspace: "/invalid/path" }))
        .rejects.toThrow("Invalid workspace path: /invalid/path. Path must be a valid Minsky workspace.");
      
      expect(fs.access).toHaveBeenCalledWith(join("/invalid/path", "process"));
      
      // Restore original
      fs.access = originalAccess;
    });

    test("should use main workspace path if in a session repo", async () => {
      const home = process.env.HOME || "";
      const xdgStateHome = process.env.XDG_STATE_HOME || join(home, ".local/state");
      const sessionPath = join(xdgStateHome, "minsky", "git", "local", "repo", "existingSession");
      
      mockExecOutput.stdout = sessionPath;
      
      const result = await resolveWorkspacePath({ sessionRepo: "/some/session/path" });
      
      expect(mockExecAsync).toHaveBeenCalledWith("git rev-parse --show-toplevel", { cwd: "/some/session/path" });
      expect(result).toBe("/path/to/main/workspace");
    });

    test("should use current directory if not in a session repo", async () => {
      mockExecOutput.stdout = "/Users/username/Projects/repo";
      
      const result = await resolveWorkspacePath({ sessionRepo: "/some/non/session/path" });
      
      expect(mockExecAsync).toHaveBeenCalledWith("git rev-parse --show-toplevel", { cwd: "/some/non/session/path" });
      expect(result).toBe("/some/non/session/path");
    });

    test("should use current directory if no options provided", async () => {
      mockExecOutput.stdout = "/Users/username/Projects/repo";
      
      const originalCwd = process.cwd;
      process.cwd = mock(() => "/current/directory");
      
      const result = await resolveWorkspacePath();
      
      expect(mockExecAsync).toHaveBeenCalledWith("git rev-parse --show-toplevel", { cwd: "/current/directory" });
      expect(result).toBe("/current/directory");
      
      // Restore original
      process.cwd = originalCwd;
    });
  });
}); 
