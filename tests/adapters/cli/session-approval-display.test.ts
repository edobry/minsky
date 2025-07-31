/**
 * Test-Driven Bug Fix: Session Approval Display
 *
 * Bug: Session approval command displays "Session: Unknown" instead of actual session name
 * Root Cause: Output formatter accesses result.result instead of result.data
 * Test verifies the formatter correctly displays session information
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as log from "../../../src/utils/logger";

// Mock the logger to capture CLI output
const mockCliOutput: string[] = [];
let logSpy: any;

describe("Session Approval Display Bug Fix", () => {
  beforeEach(() => {
    // Mock the CLI logger to capture output
    mockCliOutput.length = 0;
    logSpy = spyOn(log, "cli").mockImplementation((message: string) => {
      mockCliOutput.push(message);
    });
  });

  afterEach(() => {
    // Restore original logger
    logSpy.mockRestore();
  });

  test("REGRESSION TEST: session approval should display actual session name, not 'Unknown'", () => {
    // Bug Documentation:
    // The session approval formatter was accessing result.result instead of result.data
    // This caused the session name to display as "Unknown" instead of the actual session name
    //
    // Steps to reproduce the original bug:
    // 1. Run: minsky session approve --task 335
    // 2. Observe output shows "Session: Unknown"
    // 3. Expected: Should show "Session: <actual-session-name>"

    // Arrange: Create the actual data structure returned by approveSessionSubcommand
    const mockApprovalResult = {
      success: true,
      message: "Session approved and merged successfully",
      data: {
        // ← The session data is in .data, not .result
        session: "task335-session",
        taskId: "335",
        commitHash: "abc123def456",
        mergeDate: "2025-01-31T19:02:53.000Z",
        mergedBy: "Eugene Dobry",
        baseBranch: "main",
        prBranch: "pr/task335-session",
        isNewlyApproved: true,
      },
    };

    // Import the session customizations to test the actual formatter
    const {
      getSessionCustomizations,
    } = require("../../../src/adapters/cli/customizations/session-customizations");
    const sessionCustomizations = getSessionCustomizations();
    const approveCommand = sessionCustomizations.options.commandOptions["session.approve"];

    // Act: Execute the output formatter with the mock result
    approveCommand.outputFormatter(mockApprovalResult);

    // Assert: Verify the session name is displayed correctly
    console.log("Captured output:", mockCliOutput);
    const sessionDetailsLine = mockCliOutput.find((line) => line.includes("Session:"));
    expect(sessionDetailsLine).toBeDefined();
    expect(sessionDetailsLine).toContain("Session: task335-session");

    // Additional assertions to ensure the fix is complete
    expect(sessionDetailsLine).not.toContain("Session: Unknown");
    expect(sessionDetailsLine).not.toContain("Session: undefined");

    // Verify other fields are also displayed correctly
    const taskLine = mockCliOutput.find((line) => line.includes("Task:"));
    expect(taskLine).toContain("Task: #335");

    const mergedByLine = mockCliOutput.find((line) => line.includes("Merged by:"));
    expect(mergedByLine).toContain("Merged by: Eugene Dobry");
  });

  test("EDGE CASE: should handle missing session data gracefully", () => {
    // Test edge case where data might be undefined or malformed
    const mockApprovalResultWithoutData = {
      success: true,
      message: "Session approved",
      data: null, // This could happen in error scenarios
    };

    const {
      getSessionCustomizations,
    } = require("../../../src/adapters/cli/customizations/session-customizations");
    const sessionCustomizations = getSessionCustomizations();
    const approveCommand = sessionCustomizations.options.commandOptions["session.approve"];

    // Should not crash and should provide meaningful output
    expect(() => {
      approveCommand.outputFormatter(mockApprovalResultWithoutData);
    }).not.toThrow();

    // Should display a warning about unexpected structure
    const warningLine = mockCliOutput.find((line) => line.includes("unexpected"));
    expect(warningLine).toBeDefined();
  });

  test("EDGE CASE: should handle the old incorrect data structure", () => {
    // Test what would happen with the old incorrect structure (accessing .result)
    // This simulates the bug scenario to ensure our fix handles both cases
    const mockApprovalResultOldStructure = {
      success: true,
      message: "Session approved and merged successfully",
      result: {
        // ← Old incorrect structure that caused the bug
        session: "task335-session",
        taskId: "335",
        commitHash: "abc123def456",
        mergeDate: "2025-01-31T19:02:53.000Z",
        mergedBy: "Eugene Dobry",
        baseBranch: "main",
        prBranch: "pr/task335-session",
        isNewlyApproved: true,
      },
      // Note: No .data property, only .result
    };

    const {
      getSessionCustomizations,
    } = require("../../../src/adapters/cli/customizations/session-customizations");
    const sessionCustomizations = getSessionCustomizations();
    const approveCommand = sessionCustomizations.options.commandOptions["session.approve"];

    // Act: Execute with old structure
    approveCommand.outputFormatter(mockApprovalResultOldStructure);

    // Assert: Should now show warning since we fixed the formatter to use .data
    const warningLine = mockCliOutput.find((line) => line.includes("unexpected"));
    expect(warningLine).toBeDefined();
  });
});
