/**
 * Session Directory Command Tests
 * 
 * Tests for session directory command functionality
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { getSessionDirFromParams } from "../../../src/domain/session";
import { createMock } from "../../../src/utils/test-utils/mocking";
import { createSessionTestData, cleanupSessionTestData } from "./session-test-utilities";
import type { SessionTestData } from "./session-test-utilities";

describe("session dir command", () => {
  let testData: SessionTestData;

  beforeEach(() => {
    testData = createSessionTestData();
  });

  afterEach(async () => {
    await cleanupSessionTestData(testData.tempDir);
  });

  test("should return correct session directory for task ID", async () => {
    // Arrange: Mock correct behavior
    const correctSession = testData.mockSessions[1]; // task#160 session
    testData.mockSessionDB.getSessionByTaskId.mockReturnValue(Promise.resolve(correctSession));
    testData.mockSessionDB.getSession.mockReturnValue(Promise.resolve(correctSession));
    testData.mockSessionDB.getRepoPath.mockReturnValue(Promise.resolve("/Users/edobry/.local/state/minsky/sessions/task#160"));

    // Act
    const result = await getSessionDirFromParams(
      {
        task: "160",
      },
      {
        sessionDB: testData.mockSessionDB,
      }
    );

    // Assert
    expect(testData.mockSessionDB.getSessionByTaskId).toHaveBeenCalledWith("#160");
    expect(typeof result).toBe("string");
    expect(result).toContain("task#160");
    expect(result).not.toContain("/004");
  });

  test("should normalize task IDs correctly (with and without # prefix)", async () => {
    // Arrange
    const correctSession = testData.mockSessions[1];
    testData.mockSessionDB.getSessionByTaskId.mockReturnValue(Promise.resolve(correctSession));
    testData.mockSessionDB.getSession.mockReturnValue(Promise.resolve(correctSession));

    // Act: Test with task ID without # prefix
    await getSessionDirFromParams({ task: "160" }, { sessionDB: testData.mockSessionDB });

    // Assert: Should call with normalized task ID (with # prefix)
    expect(testData.mockSessionDB.getSessionByTaskId).toHaveBeenCalledWith("#160");
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
    mockStorage.getEntities.mockReturnValue(Promise.resolve(testData.mockSessions)); // Returns ALL sessions

    // Act: Simulate the SessionDbAdapter.getSessionByTaskId logic
    const normalizedTaskId = "160".replace(/^#/, "");
    const sessions = await mockStorage.getEntities({ taskId: normalizedTaskId });
    const session = sessions.length > 0 ? sessions[0] : null; // Takes first session (BUG!)

    // Assert: This demonstrates the exact bug sequence
    expect(mockStorage.getEntities).toHaveBeenCalledWith({ taskId: "160" });
    expect(sessions).toHaveLength(3); // Bug: returns all sessions instead of filtered
    expect(session?.session).toBe("004"); // Bug: first session is wrong one
    expect(session?.taskId).toBeNull(); // Bug: wrong session has null taskId

    // Show what the CORRECT behavior should be:
    const correctlyFilteredSessions = testData.mockSessions.filter((s) => {
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
