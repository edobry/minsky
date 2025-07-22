/**
 * Tests for session approval error handling bug fix (Task #300)
 * 
 * Verifies that session approval correctly validates task existence
 * before checking for sessions and provides clear error messages.
 */

import { describe, test, expect } from "bun:test";
import { approveSessionImpl } from "../session-approve-operations";
import { ResourceNotFoundError } from "../../../errors/index";

describe("Session Approval Error Handling Fix", () => {
  test("should validate task existence BEFORE checking for session", async () => {
    // Test Case 1: Non-existent task (like the reported bug with task 3283)
    await expect(
      approveSessionImpl({
        task: "3283", // Non-existent task
        json: false,
      })
    ).rejects.toThrow(ResourceNotFoundError);

    try {
      await approveSessionImpl({
        task: "3283",
        json: false,
      });
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
        if (id === "100") {
          return { id: "100", title: "Test Task", status: "TODO" };
        }
        return null;
      },
    };

    // Mock SessionDB to return no session
    const mockSessionDB = {
      getSessionByTaskId: async () => null,
    };

    // Test Case 2: Existing task but no session
    try {
      await approveSessionImpl(
        {
          task: "100", // Existing task
          json: false,
        },
        {
          taskService: mockTaskService as any,
          sessionDB: mockSessionDB as any,
        }
      );
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        // Verify error message is for missing session, not missing task
        expect(error.message).toContain("❌ No session found for task 100");
        expect(error.message).toContain("The task exists but has no associated session");
        expect(error.message).toContain("Run 'minsky session start --task 100'");
        
        // Verify resource type indicates session problem, not task problem
        expect(error.resourceType).toBe("session");
        expect(error.resourceId).toBe("100");

        // Verify it's NOT claiming the task doesn't exist
        expect(error.message).not.toContain("Task not found");
        expect(error.message).not.toContain("does not exist");
      } else {
        throw new Error(`Expected ResourceNotFoundError, got ${error?.constructor?.name}`);
      }
    }
  });

  test("should have proper validation order", async () => {
    // This test ensures the fix addresses the root cause:
    // validation order should be: task exists → session exists → approval logic
    
    let taskValidationCalled = false;
    let sessionValidationCalled = false;

    // Mock TaskService that tracks when it's called
    const mockTaskService = {
      getTask: async (id: string) => {
        taskValidationCalled = true;
        return null; // Simulate non-existent task
      },
    };

    // Mock SessionDB that tracks when it's called  
    const mockSessionDB = {
      getSessionByTaskId: async () => {
        sessionValidationCalled = true;
        return null;
      },
    };

    try {
      await approveSessionImpl(
        {
          task: "999",
          json: false,
        },
        {
          taskService: mockTaskService as any,
          sessionDB: mockSessionDB as any,
        }
      );
    } catch (error) {
      // Task validation should have been called
      expect(taskValidationCalled).toBe(true);
      
      // Session validation should NOT have been called for non-existent task
      expect(sessionValidationCalled).toBe(false);
      
      // Should be a task not found error
      expect(error).toBeInstanceOf(ResourceNotFoundError);
      expect((error as ResourceNotFoundError).resourceType).toBe("task");
    }
  });

  test("should provide clear error message format", async () => {
    // Test that error messages follow the expected clean format
    try {
      await approveSessionImpl({
        task: "9999",
        json: false,
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        const message = error.message;
        
        // Should start with clear error indicator
        expect(message).toMatch(/^❌/);
        
        // Should have clear structure: error + explanation + options
        expect(message).toContain("❌ Task not found:");
        expect(message).toContain("The specified task does not exist.");
        expect(message).toContain("💡 Available options:");
        
        // Should provide actionable guidance
        expect(message).toContain("minsky tasks list");
        expect(message).toContain("Check your task ID for typos");
        
        // Should NOT be overly verbose like the old error
        expect(message.split("\n").length).toBeLessThan(15); // Reasonable line count
        expect(message).not.toContain("1️⃣"); // No numbered lists
        expect(message).not.toContain("2️⃣");
        expect(message).not.toContain("3️⃣");
      }
    }
  });
}); 
