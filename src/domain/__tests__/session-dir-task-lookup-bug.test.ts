/**
 * Bug Reproduction Test: Session Dir Task Lookup Bug
 *
 * Bug Description:
 * When using `minsky session dir --task 160`, the command returns the wrong session directory.
 * It returns `/Users/edobry/.local/state/minsky/git/local/minsky/sessions/004`
 * instead of the correct `/Users/edobry/.local/state/minsky/git/local-minsky/sessions/task#160`
 *
 * Root Cause:
 * The JsonFileStorage.getEntities() method fails when filtering by taskId because
 * it calls s.taskId.replace(/^#/, "") on sessions where taskId is null.
 * This causes a TypeError which breaks the filtering logic.
 *
 * This test reproduces the bug by directly testing the problematic filtering logic.
 */

import { describe, test, expect } from "bun:test";
import { getSessionDirFromParams } from "../session.js";
import { createSessionProvider } from "../session.js";
import { setupTestMocks } from "../../utils/test-utils/mocking.js";

// Set up automatic mock cleanup
setupTestMocks();

describe("Session Dir Task Lookup Bug", () => {
  test("BUG: getSessionDirFromParams should return task#160 session, not session 004", async () => {
    // This test uses the REAL session database to reproduce the bug
    const sessionDB = createSessionProvider();

    const result = await getSessionDirFromParams(
      {
        task: "160",
      },
      {
        sessionDB,
      }
    );

    console.log("Result from getSessionDirFromParams:", result);

    // This should return task#160 session dir, not session 004 dir
    // The bug causes it to return the wrong session directory
    expect(result).toContain("task#160");
    expect(result).not.toContain("/004");
  });

  test("BUG: sessionDB.getSessionByTaskId should return task#160 session, not session 004", async () => {
    // Test the underlying database method directly
    const sessionDB = createSessionProvider();

    const session = await sessionDB.getSessionByTaskId("#160");

    console.log("Session found by task ID:", session);

    // This should return task#160 session, not session 004
    expect(session).toBeDefined();
    expect(session?.session).toBe("task#160");
    expect(session?.taskId).toBe("#160");
  });

  test("Verify bug is in JsonFileStorage.getEntities filtering logic", async () => {
    // This test simulates the exact problematic filtering logic
    const testSessions = [
      {
        session: "004",
        repoName: "local/minsky",
        repoUrl: "file:///Users/edobry/Projects/minsky",
        createdAt: "2024-04-29T15:01:00.000Z",
        taskId: null, // null taskId causes the bug
        branch: "004",
        repoPath: "/Users/edobry/.local/state/minsky/git/local/minsky/sessions/004",
      },
      {
        session: "task#160",
        repoName: "local/minsky",
        repoUrl: "/Users/edobry/Projects/minsky",
        createdAt: "2025-06-25T18:54:44.999Z",
        taskId: "#160",
        branch: "task#160",
        repoPath: "/Users/edobry/.local/state/minsky/git/local-minsky/sessions/task#160",
      },
    ];

    // Simulate the exact buggy filtering logic from JsonFileStorage.getEntities()
    const options = { taskId: "160" };
    let sessions = testSessions;

    if (options.taskId) {
      const normalizedTaskId = options.taskId.replace(/^#/, "");

      // This is the buggy line - it calls .replace() on null
      expect(() => {
        sessions = sessions.filter((s) => s.taskId!.replace(/^#/, "") === normalizedTaskId);
      }).toThrow(); // This should throw TypeError because s.taskId is null for session 004
    }
  });

  test("BUG REPRODUCTION: filtering fails with null taskId", () => {
    // Direct test of the problematic code pattern
    const session: { taskId: string | null } = { taskId: null };

    // This is exactly what happens in JsonFileStorage.getEntities()
    expect(() => {
      (session.taskId as any).replace(/^#/, ""); // TypeError: Cannot read property 'replace' of null
    }).toThrow(TypeError);
  });
});
