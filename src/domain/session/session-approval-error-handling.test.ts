/**
 * Tests for session approval error handling (Updated for Task #358)
 *
 * Verifies that session approval correctly handles missing sessions
 * and provides clear error messages for the new approve-only workflow.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { approveSessionPr } from "./session-approval-operations";
import { ResourceNotFoundError } from "../../errors/index";
import { initializeConfiguration, CustomConfigFactory } from "../../domain/configuration";

describe("Session Approval Error Handling (Task #358 Updated)", () => {
  beforeEach(async () => {
    // Initialize configuration system for each test
    await initializeConfiguration(new CustomConfigFactory(), {
      workingDirectory: "/mock/workspace",
    });
  });

  test("should handle missing session for task", async () => {
    // Test Case 1: Task with no associated session (like task 3283)
    await expect(
      approveSessionPr({
        task: "md#3283", // Task with no session
        json: false,
      })
    ).rejects.toThrow(ResourceNotFoundError);

    try {
      await approveSessionPr({
        task: "md#3283",
        json: false,
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        // Verify error message is clear and indicates missing session
        expect(error.message).toContain("No session found for task md#3283");

        // Verify resource type is correct
        expect(error.resourceType).toBe("session");
        expect(error.resourceId).toBe("md#3283");
      } else {
        throw new Error(`Expected ResourceNotFoundError, got ${error?.constructor?.name}`);
      }
    }
  });

  test("should handle task without session using mocked sessionDB", async () => {
    // Mock SessionDB to return no session for the task
    const mockSessionDB = {
      getSessionByTaskId: async () => null,
      getSession: async () => null,
    };

    // Test Case 2: Task without session (using mocked sessionDB)
    try {
      await approveSessionPr(
        {
          task: "md#100", // Task without session
          json: false,
        },
        {
          sessionDB: mockSessionDB as any,
        }
      );
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        // Verify error message indicates missing session for task
        expect(error.message).toContain("No session found for task md#100");

        // Verify resource type indicates session problem
        expect(error.resourceType).toBe("session");
        expect(error.resourceId).toBe("md#100");
      } else {
        throw new Error(`Expected ResourceNotFoundError, got ${error?.constructor?.name}`);
      }
    }
  });

  test("should require session name or task ID", async () => {
    // Test Case 3: No session name or task ID provided
    await expect(
      approveSessionPr({
        json: false,
        // No session or task provided
      })
    ).rejects.toThrow("No session detected. Please provide a session name or task ID");
  });

  test("should provide clear error message for missing session", async () => {
    // Test that error messages are clear and concise for the new approve function
    try {
      await approveSessionPr({
        task: "md#9999",
        json: false,
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        const message = error.message;

        // Should indicate no session found for task
        expect(message).toContain("No session found for task md#9999");

        // Should be concise (not overly verbose)
        expect(message.split("\n").length).toBeLessThan(5); // Keep it simple

        // Should have correct resource type
        expect((error as ResourceNotFoundError).resourceType).toBe("session");
        expect((error as ResourceNotFoundError).resourceId).toBe("md#9999");
      }
    }
  });
});
