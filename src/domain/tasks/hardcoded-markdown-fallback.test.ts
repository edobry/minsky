/**
 * Focused test for hardcoded markdown fallback bug
 * 
 * This test isolates the specific issue: hardcoded || "markdown" fallbacks
 * that bypass proper backend detection and configuration.
 */

import { describe, test, expect, mock } from "bun:test";
import type { TaskServiceInterface } from "./taskService";
import { TASK_STATUS } from "./taskConstants";

describe("Hardcoded Markdown Fallback Bug - Isolated Test", () => {
  test("should demonstrate hardcoded markdown fallback in dependency injection", async () => {
    // Mock factory that captures what backend was requested
    let capturedBackend: string | undefined = undefined;
    
    const mockCreateTaskService = mock(async (options: { workspacePath: string; backend?: string }) => {
      capturedBackend = options.backend;
      return {
        getTask: async () => ({ id: "test#123", title: "Test", status: TASK_STATUS.TODO }),
        setTaskStatus: async () => {},
      } as TaskServiceInterface;
    });

    // Simulate the current taskCommands.ts pattern
    const simulateTaskCommandPattern = async (params: { taskId: string; backend?: string }, workspacePath: string) => {
      // This is the EXACT pattern used in taskCommands.ts that we want to fix:
      await mockCreateTaskService({
        workspacePath,
        backend: params.backend || "markdown", // <- BUG: Hardcoded fallback
      });
    };

    // Test Case 1: No backend specified should NOT default to "markdown"
    await simulateTaskCommandPattern({ taskId: "test#123" }, "/tmp/workspace");
    
    // BUG DEMONSTRATION: This will fail because the current code forces "markdown"
    expect(capturedBackend).not.toBe("markdown");
    expect(capturedBackend).toBe(undefined); // Should let service determine backend
  });

  test("should demonstrate BaseTaskOperation hardcoded markdown fallback", async () => {
    // Mock factory that captures what backend was requested
    let capturedBackend: string | undefined = undefined;
    
    const mockCreateTaskService = mock(async (options: { workspacePath: string; backend?: string }) => {
      capturedBackend = options.backend;
      return {} as TaskServiceInterface;
    });

    // Simulate the current base-task-operation.ts pattern
    const simulateBaseOperationPattern = async (params: { taskId: string; backend?: string }, workspacePath: string) => {
      // This is the EXACT pattern used in base-task-operation.ts:
      await mockCreateTaskService({
        workspacePath,
        backend: params.backend || "markdown", // <- BUG: Comment says "Use markdown as default to avoid config lookup"
      });
    };

    // Test Case: No backend specified should NOT default to "markdown"
    await simulateBaseOperationPattern({ taskId: "gh#789" }, "/tmp/workspace");
    
    // BUG DEMONSTRATION: This will fail because the current code forces "markdown"
    // even when the qualified ID suggests a different backend
    expect(capturedBackend).not.toBe("markdown");
    expect(capturedBackend).toBe(undefined); // Should let service determine backend
  });

  test("should show that qualified IDs suggest specific backends but get overridden", async () => {
    let capturedBackend: string | undefined = undefined;
    
    const mockCreateTaskService = mock(async (options: { workspacePath: string; backend?: string }) => {
      capturedBackend = options.backend;
      return {} as TaskServiceInterface;
    });

    const simulateHardcodedFallback = async (taskId: string) => {
      const params = { taskId }; // No backend specified
      
      // Current problematic pattern:
      await mockCreateTaskService({
        workspacePath: "/tmp",
        backend: params.backend || "markdown", // Forces markdown regardless of qualified ID
      });
    };

    // Test with minsky-backend qualified ID
    await simulateHardcodedFallback("mt#123");
    
    // BUG: Even though "mt#123" suggests minsky backend, 
    // hardcoded fallback forces "markdown"
    expect(capturedBackend).toBe("markdown"); // This demonstrates the bug
    
    // After fix, this should be undefined to let the multi-backend service
    // route based on the "mt#" prefix
  });
});

/**
 * Test Documentation:
 * 
 * These tests demonstrate the exact problematic patterns:
 * 1. `backend: params.backend || "markdown"` in taskCommands.ts
 * 2. `backend: params.backend || "markdown"` in base-task-operation.ts
 * 
 * The issue is that when no backend is specified in params, the code
 * immediately falls back to "markdown" instead of:
 * - Using backend detection service
 * - Letting the multi-backend service determine routing
 * - Respecting configuration
 * 
 * Expected behavior after fix:
 * - Pass `backend: undefined` to let service determine backend
 * - Use backend detection service when appropriate
 * - Respect qualified ID routing from md#443
 */
