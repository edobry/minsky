/**
 * Tests for session approval error handling bug fix (Task #300)
 *
 * Verifies that session approval correctly validates task existence
 * before checking for sessions and provides clear error messages.
 */

import { describe, test, expect } from "bun:test";
import { approveSessionImpl } from "./session-approve-operations";
import { ResourceNotFoundError } from "../../errors/index";

describe("Session Approval Error Handling Fix", () => {
  test("should validate task existence BEFORE checking for session", async () => {
    // Mock TaskService to ensure task "3283" doesn't exist
    const mockTaskService = {
      getTask: async (id: string) => {
        // Return null for the test task ID to simulate non-existent task
        if (id === "3283") return null;
        return { id, title: "Other Task", status: "TODO" };
      },
    };

    // Test Case 1: Non-existent task (like the reported bug with task 3283)
    await expect(
      approveSessionImpl(
        {
          task: "3283", // Non-existent task
          json: false,
        },
        { taskService: mockTaskService }
      )
    ).rejects.toThrow(ResourceNotFoundError);

    try {
      await approveSessionImpl(
        {
          task: "3283",
          json: false,
        },
        { taskService: mockTaskService }
      );
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        // Verify error message is clear and concise
        expect(error.message).toContain("❌ Task not found: 3283");
        expect(error.message).toContain("The specified task does not exist");
        expect(error.message).toContain("💡 Available options:");
        expect(error.message).toContain("Run 'minsky tasks list'");

        // Verify resource type is correct
        expect(error.resourceType).toBe("task");
        expect(error.resourceId).toBe("3283");

        // Verify error is NOT the old verbose message
        expect(error.message).not.toContain("Task 3283 exists but has no associated session");
        expect(error.message).not.toContain("1️⃣ Check if the task has a session");
      } else {
        throw new Error(`Expected ResourceNotFoundError, got ${error?.constructor?.name}`);
      }
    }
  });

  test("should provide different error for existing task without session", async () => {
    // Mock TaskService to return a task (simulate existing task)
    const mockTaskService = {
      getTask: async (id: string) => {
        // Return a task for ID "1234" to simulate existing task
        if (id === "1234") {
          return { id: "1234", title: "Existing Task", status: "TODO" };
        }
        return null;
      },
    };

    // Mock SessionDB to return null (no session)
    const mockSessionDB = {
      getSessionByTaskId: async () => null,
    } as any;

    await expect(
      approveSessionImpl(
        {
          task: "1234", // Existing task but no session
          json: false,
        },
        { taskService: mockTaskService, sessionDB: mockSessionDB }
      )
    ).rejects.toThrow(ResourceNotFoundError);

    try {
      await approveSessionImpl(
        {
          task: "1234",
          json: false,
        },
        { taskService: mockTaskService, sessionDB: mockSessionDB }
      );
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        // Should be different error message for existing task without session
        expect(error.message).toContain("❌ No session found for task 1234");
        expect(error.resourceType).toBe("session");
        expect(error.resourceId).toBe("1234");

        // Verify error is NOT the task not found message
        expect(error.message).not.toContain("❌ Task not found:");
        expect(error.message).not.toContain("The specified task does not exist");
      } else {
        throw new Error(`Expected ResourceNotFoundError, got ${error?.constructor?.name}`);
      }
    }
  });

  test("should have proper validation order", async () => {
    // Mock TaskService and SessionDB to test validation order
    const mockTaskService = {
      getTask: async (id: string) => {
        if (id === "5678") {
          return { id, title: "Valid Task", status: "TODO" };
        }
        return null;
      },
    };

    // Mock SessionDB with type assertion
    const mockSessionDB = {
      getSessionByTaskId: async () => null, // No session
    } as any;

    // Test 1: Invalid task (use numeric ID) should fail BEFORE session check
    await expect(
      approveSessionImpl(
        {
          task: "9999", // Use numeric task ID instead of "invalid-task"
          json: false,
        },
        { taskService: mockTaskService, sessionDB: mockSessionDB }
      )
    ).rejects.toThrow(ResourceNotFoundError);

    // Test 2: Valid task without session should reach session validation
    await expect(
      approveSessionImpl(
        {
          task: "5678", // Change to match the mock
          json: false,
        },
        { taskService: mockTaskService, sessionDB: mockSessionDB }
      )
    ).rejects.toThrow(ResourceNotFoundError);
  });

  test("should provide clear error message format", async () => {
    // Mock TaskService to ensure consistent behavior
    const mockTaskService = {
      getTask: async () => null, // Always return null
    };

    try {
      await approveSessionImpl(
        {
          task: "9999",
          json: false,
        },
        { taskService: mockTaskService }
      );
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        const message = error.message;

        // Should start with clear error indicator
        expect(message).toMatch(/^❌/);

        // Should have clear structure: error + explanation + options
        expect(message).toContain("❌ Task not found:");
        expect(message).toContain("The specified task does not exist");
        expect(message).toContain("💡 Available options:");
        expect(message).toContain("Run 'minsky tasks list'");

        // Should NOT contain verbose session-related guidance
        expect(message).not.toContain("1️⃣");
        expect(message).not.toContain("2️⃣");
        expect(message).not.toContain("exists but has no associated session");
      } else {
        throw new Error(`Expected ResourceNotFoundError, got ${error?.constructor?.name}`);
      }
    }
  });
});
