/**
 * Bug Reproduction Test: Session Dir Task Lookup Bug
 *
 * Bug Description:
 * When using `minsky session dir --task 160`, the command returns the wrong session directory.
 * It returns `/Users/edobry/.local/state/minsky/git/local/minsky/sessions/004`
 * instead of the correct `/Users/edobry/.local/state/minsky/git/local-minsky/sessions/task#160`
 *
 * Root Cause Investigation:
 * - The getSessionByTaskId method should work correctly (confirmed via debugging)
 * - The issue appears to be in the actual CLI execution or command parsing
 *
 * This test reproduces the bug by directly testing the CLI command execution.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { getSessionDirFromParams } from "../session.js";
import { createSessionProvider } from "../session.js";
import { setupTestMocks } from "../../utils/test-utils/mocking.js";

// Set up automatic mock cleanup
setupTestMocks();

describe("Session Dir Task Lookup Bug", () => {
  test("getSessionDirFromParams should return correct session for task #160", async () => {
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

    // The bug: This should return task#160 session dir, not session 004 dir
    expect(result).toContain("task#160");
    expect(result).not.toContain("/004");
  });

  test("session database getSessionByTaskId should find correct session", async () => {
    // Test the underlying database method directly
    const sessionDB = createSessionProvider();

    const session = await sessionDB.getSessionByTaskId("#160");

    console.log("Session found by task ID:", session);

    expect(session).toBeDefined();
    expect(session?.session).toBe("task#160");
    expect(session?.taskId).toBe("#160");
  });

  test("verify database has both sessions but they are different", async () => {
    const sessionDB = createSessionProvider();

    // Get session 004
    const session004 = await sessionDB.getSession("004");
    console.log("Session 004:", session004);

    // Get session task#160
    const sessionTask160 = await sessionDB.getSession("task#160");
    console.log("Session task#160:", sessionTask160);

    // Verify they exist and are different
    expect(session004).toBeDefined();
    expect(sessionTask160).toBeDefined();

    expect(session004?.session).toBe("004");
    expect(session004?.taskId).toBeNull();

    expect(sessionTask160?.session).toBe("task#160");
    expect(sessionTask160?.taskId).toBe("#160");

    // Verify their directories are different
    expect(session004?.repoPath).not.toBe(sessionTask160?.repoPath);
  });
});
