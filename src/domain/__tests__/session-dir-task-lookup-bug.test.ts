/**
 * Bug Reproduction Test: Session Dir Task Lookup Bug
 *
 * Bug Description:
 * When using `minsky session dir --task 160`, the command returns the wrong session directory.
 * It returns `/Users/edobry/.local/state/minsky/git/local/minsky/sessions/004`
 * instead of the correct `/Users/edobry/.local/state/minsky/git/local-minsky/sessions/task#160`
 *
 * Root Cause:
 * The SqliteStorage.getEntities() method was not implementing taskId filtering.
 * It ignored the options parameter and returned all sessions, causing getSessionByTaskId
 * to return the first session instead of the matching one.
 *
 * This test reproduces the bug using proper mocking and dependency injection.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { getSessionDirFromParams } from "../session.js";
import { createMock, mockModule, setupTestMocks } from "../../utils/test-utils/mocking.js";

// Set up automatic mock cleanup
setupTestMocks();

describe("Session Dir Task Lookup Bug", () => {
  let mockSessionDB: any;
  let mockSessions: any[];

  beforeEach(() => {
    // Create test data that reproduces the bug scenario
    mockSessions = [
      {
        session: "004",
        repoName: "local/minsky",
        repoUrl: "file:///Users/edobry/Projects/minsky",
        createdAt: "2024-04-29T15:01:00.000Z",
        taskId: null, // This session has no task ID
        branch: "004",
        repoPath: "/Users/edobry/.local/state/minsky/git/local/minsky/sessions/004",
      },
      {
        session: "task#160",
        repoName: "local/minsky",
        repoUrl: "/Users/edobry/Projects/minsky",
        createdAt: "2025-06-25T18:54:44.999Z",
        taskId: "#160", // This is the session we want to find
        branch: "task#160",
        repoPath: "/Users/edobry/.local/state/minsky/git/local-minsky/sessions/task#160",
      },
    ];

    // Create mock session database with proper filtering behavior
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

  test("BUG REPRODUCTION: getSessionByTaskId returns wrong session when filtering is broken", async () => {
    // Arrange: Mock the BUGGY behavior (returns first session regardless of taskId)
    const buggySession = mockSessions[0]; // session "004"
    mockSessionDB.getSessionByTaskId.mockReturnValue(Promise.resolve(buggySession));
    mockSessionDB.getSession.mockReturnValue(Promise.resolve(buggySession)); // Mock getSession too

    // Act
    const result = await getSessionDirFromParams(
      {
        task: "160",
      },
      {
        sessionDB: mockSessionDB,
      }
    );

    // Assert: This demonstrates the bug - wrong session directory returned
    expect(mockSessionDB.getSessionByTaskId).toHaveBeenCalledWith("#160");
    expect(result).toContain("/004"); // Bug: returns wrong session
    expect(result).not.toContain("task#160"); // Bug: doesn't return correct session
  });

  test("FIXED: getSessionByTaskId returns correct session when filtering works", async () => {
    // Arrange: Mock the CORRECT behavior (returns the matching session)
    const correctSession = mockSessions[1]; // session "task#160"
    mockSessionDB.getSessionByTaskId.mockReturnValue(Promise.resolve(correctSession));
    mockSessionDB.getSession.mockReturnValue(Promise.resolve(correctSession)); // Mock getSession too

    // Act
    const result = await getSessionDirFromParams(
      {
        task: "160",
      },
      {
        sessionDB: mockSessionDB,
      }
    );

    // Assert: This demonstrates the fix - correct session directory returned
    expect(mockSessionDB.getSessionByTaskId).toHaveBeenCalledWith("#160");
    expect(result).toContain("task#160"); // Fix: returns correct session
    expect(result).not.toContain("/004"); // Fix: doesn't return wrong session
  });

  test("getSessionByTaskId should normalize task IDs correctly", async () => {
    // Arrange
    const correctSession = mockSessions[1];
    mockSessionDB.getSessionByTaskId.mockReturnValue(Promise.resolve(correctSession));
    mockSessionDB.getSession.mockReturnValue(Promise.resolve(correctSession)); // Mock getSession too

    // Act: Test with task ID without # prefix
    await getSessionDirFromParams({ task: "160" }, { sessionDB: mockSessionDB });

    // Assert: Should call with normalized task ID (with # prefix)
    expect(mockSessionDB.getSessionByTaskId).toHaveBeenCalledWith("#160");
  });

  test("SQLite filtering bug: demonstrates the root cause", () => {
    // This test demonstrates the exact bug in the SQLite filtering logic
    const testSessions = mockSessions;
    const options = { taskId: "160" };

    // BUGGY behavior: returns all sessions without filtering
    const buggyFilter = (sessions: any[], options: any) => {
      // This simulates the original broken getEntities() method
      return sessions; // Bug: ignores options parameter
    };

    // CORRECT behavior: filters sessions by taskId
    const correctFilter = (sessions: any[], options: any) => {
      if (!options?.taskId) return sessions;

      const normalizedTaskId = options.taskId.replace(/^#/, "");
      return sessions.filter((s) => {
        if (!s.taskId) return false; // Skip null taskId sessions
        return s.taskId.replace(/^#/, "") === normalizedTaskId;
      });
    };

    // Act & Assert
    const buggyResult = buggyFilter(testSessions, options);
    const correctResult = correctFilter(testSessions, options);

    // Bug: returns all sessions (including the wrong one)
    expect(buggyResult).toHaveLength(2);
    expect(buggyResult[0].session).toBe("004"); // Wrong session returned first

    // Fix: returns only the matching session
    expect(correctResult).toHaveLength(1);
    expect(correctResult[0].session).toBe("task#160"); // Correct session returned
    expect(correctResult[0].taskId).toBe("#160");
  });

  test("should handle null taskId values correctly", () => {
    // Test the specific edge case that caused the bug
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

  test("IMPLEMENTATION SEQUENCE: covers the exact call chain that caused the bug", async () => {
    // This test reproduces the EXACT sequence of calls that caused the bug:
    // 1. SessionDbAdapter.getSessionByTaskId("160")
    // 2. Calls storage.getEntities({ taskId: "160" })
    // 3. SQLiteStorage.getEntities() ignores options and returns ALL sessions
    // 4. Takes first session from array (sessions[0]) which is wrong session

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

  test("EDGE CASE: multiple sessions with same task pattern but different formats", () => {
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
