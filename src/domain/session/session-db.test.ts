/**
 * Test suite for SessionDB functional implementation
 */

import { describe, it, expect } from "bun:test";
import {
  addSessionFn,
  deleteSessionFn,
  getRepoPathFn,
  getSessionByTaskIdFn,
  getSessionFn,
  getSessionWorkdirFn,
  initializeSessionDbState,
  listSessionsFn,
  updateSessionFn,
  type SessionDbState,
  type SessionRecord,
} from "./session-db";

describe("SessionDB Functional Implementation", () => {
  // Helper function to create a test state
  const createTestState = (): SessionDbState => {
    const state = initializeSessionDbState({ baseDir: "/test/base/dir" });
    const testSessions: SessionRecord[] = [
      {
        session: "test-session-1",
        repoName: "local/minsky",
        repoUrl: "local/minsky",
        createdAt: "2023-01-01T00:00:00.000Z",
        taskId: "#101",
        branch: "test-branch-1",
      },
      {
        session: "test-session-2",
        repoName: "github/user/repo",
        repoUrl: "https://github.com/user/repo",
        createdAt: "2023-01-02T00:00:00.000Z",
        taskId: "#102",
        branch: "test-branch-2",
      },
    ];
    return {
      ...state,
      sessions: testSessions,
    };
  };

  describe("initializeSessionDbState", () => {
    it("should initialize state with default values", () => {
      const state = initializeSessionDbState();
      expect(state).toHaveProperty("sessions");
      expect(state.sessions).toEqual([]);
      expect(state).toHaveProperty("baseDir");
    });

    it("should initialize state with custom baseDir", () => {
      const customBaseDir = "/custom/base/dir";
      const state = initializeSessionDbState({ baseDir: customBaseDir });
      expect(state.baseDir).toBe(customBaseDir);
    });

    // Regression test for Task #166: Fix options.baseDir runtime error
    it("should handle undefined options parameter without throwing runtime error", () => {
      // This test covers the specific scenario that caused the runtime error:
      // "undefined is not an object (evaluating 'options.baseDir')"
      expect(() => {
        const state = initializeSessionDbState(undefined as unknown);
        expect(state).toHaveProperty("sessions");
        expect(state.sessions).toEqual([]);
        expect(state).toHaveProperty("baseDir");
        expect(typeof state.baseDir).toBe("string");
      }).not.toThrow();
    });

    // Regression test for Task #166: Fix options.baseDir runtime error
    it("should handle null options parameter without throwing runtime error", () => {
      // Additional edge case to ensure robustness
      expect(() => {
        const state = initializeSessionDbState(null as unknown);
        expect(state).toHaveProperty("sessions");
        expect(state.sessions).toEqual([]);
        expect(state).toHaveProperty("baseDir");
        expect(typeof state.baseDir).toBe("string");
      }).not.toThrow();
    });

    // Regression test for Task #166: Fix options.baseDir runtime error
    it("should handle options with undefined baseDir property", () => {
      // Test the case where options object exists but baseDir is explicitly undefined
      const options = { baseDir: undefined };
      expect(() => {
        const state = initializeSessionDbState(options);
        expect(state).toHaveProperty("sessions");
        expect(state.sessions).toEqual([]);
        expect(state).toHaveProperty("baseDir");
        expect(typeof state.baseDir).toBe("string");
      }).not.toThrow();
    });
  });

  describe("listSessionsFn", () => {
    it("should return all sessions", () => {
      const state = createTestState();
      const sessions = listSessionsFn(state);
      expect(sessions).toHaveLength(2);
      expect(sessions[0]!.session).toBe("test-session-1");
      expect(sessions[1]!.session).toBe("test-session-2");
    });
  });

  describe("getSessionFn", () => {
    it("should return the session by name", () => {
      const state = createTestState();
      const session = getSessionFn(state, "test-session-1");
      expect(session).not.toBeNull();
      expect(session?.session).toBe("test-session-1");
      expect(session?.taskId).toBe("#101");
    });

    it("should return null if session not found", () => {
      const state = createTestState();
      const session = getSessionFn(state, "non-existent-session");
      expect(session).toBeNull();
    });
  });

  describe("getSessionByTaskIdFn", () => {
    it("should return the session by task ID", () => {
      const state = createTestState();
      const session = getSessionByTaskIdFn(state, "101");
      expect(session).not.toBeNull();
      expect(session?.session).toBe("test-session-1");
    });

    it("should return the session when task ID includes #", () => {
      const state = createTestState();
      const session = getSessionByTaskIdFn(state, "#101");
      expect(session).not.toBeNull();
      expect(session?.session).toBe("test-session-1");
    });

    it("should return null if no session exists for the task ID", () => {
      const state = createTestState();
      const session = getSessionByTaskIdFn(state, "999");
      expect(session).toBeNull();
    });
  });

  describe("addSessionFn", () => {
    it("should add a new session to the state", () => {
      const state = createTestState();
      const newSession: SessionRecord = {
        session: "test-session-3",
        repoName: "local/new-repo",
        repoUrl: "local/new-repo",
        createdAt: "2023-01-03T00:00:00.000Z",
        taskId: "#103",
        branch: "test-branch-3",
      };

      const newState = addSessionFn(state, newSession);
      expect(newState.sessions).toHaveLength(3);
      expect(newState.sessions[2]!.session).toBe("test-session-3");
      expect(newState.sessions[2]!.taskId).toBe("#103");
    });
  });

  describe("updateSessionFn", () => {
    it("should update an existing session", () => {
      const state = createTestState();
      const updates = {
        branch: "updated-branch",
        taskId: "#999",
      };

      const newState = updateSessionFn(state, "test-session-1", updates);
      const updatedSession = getSessionFn(newState, "test-session-1");
      expect(updatedSession?.branch).toBe("updated-branch");
      expect(updatedSession?.taskId).toBe("#999");
      expect(updatedSession?.repoName).toBe("local/minsky"); // Original value preserved
    });

    it("should not modify state if session not found", () => {
      const state = createTestState();
      const originalSessions = [...state.sessions];
      const newState = updateSessionFn(state, "non-existent-session", { branch: "new-branch" });
      expect(newState.sessions).toEqual(originalSessions);
    });

    it("should ignore session property in updates", () => {
      const state = createTestState();
      const updates = {
        session: "attempted-rename",
        branch: "updated-branch",
      } as unknown;

      const newState = updateSessionFn(state, "test-session-1", updates);
      expect(getSessionFn(newState, "test-session-1")).not.toBeNull();
      expect(getSessionFn(newState, "attempted-rename")).toBeNull();
    });
  });

  describe("deleteSessionFn", () => {
    it("should delete an existing session", () => {
      const state = createTestState();
      const newState = deleteSessionFn(state, "test-session-1");
      expect(newState.sessions).toHaveLength(1);
      expect(getSessionFn(newState, "test-session-1")).toBeNull();
      // Check that only test-session-2 remains
      expect(newState.sessions[0]!.session).toBe("test-session-2");
    });

    it("should not modify state if session not found", () => {
      const state = createTestState();
      const originalSessions = [...state.sessions];
      const newState = deleteSessionFn(state, "non-existent-session");
      expect(newState.sessions).toEqual(originalSessions);
    });
  });

  describe("getRepoPathFn", () => {
    it("should return the repository path for a session record", () => {
      const state = createTestState();
      const session = getSessionFn(state, "test-session-1")!;
      const repoPath = getRepoPathFn(state, session);
      expect(repoPath).toBe("/test/base/dir/sessions/test-session-1");
    });

    it("should handle session records with repoPath already set", () => {
      const state = createTestState();
      const session = { ...getSessionFn(state, "test-session-1")!, repoPath: "/custom/path" };
      const repoPath = getRepoPathFn(state, session);
      expect(repoPath).toBe("/custom/path");
    });

    it("should throw error for invalid input", () => {
      const state = createTestState();
      expect(() => getRepoPathFn(state, null as unknown)).toThrow("Session record is required");
    });
  });

  describe("getSessionWorkdirFn", () => {
    it("should return the working directory for a session", () => {
      const state = createTestState();
      const workdir = getSessionWorkdirFn(state, "test-session-1");
      expect(workdir).toBe("/test/base/dir/sessions/test-session-1");
    });

    it("should return null if session not found", () => {
      const state = createTestState();
      const workdir = getSessionWorkdirFn(state, "non-existent-session");
      expect(workdir).toBeNull();
    });
  });
});
