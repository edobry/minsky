/**
 * Tests for hardcoded markdown backend defaults bug
 * 
 * These tests demonstrate that the current code ignores injected configuration
 * and falls back to hardcoded "markdown" defaults instead of respecting
 * the configured backend preferences.
 * 
 * Bug: Task commands and operations use || "markdown" fallbacks that bypass
 * proper backend detection and configuration.
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";
import {
  getTaskFromParams,
  setTaskStatusFromParams,
} from "./taskCommands";
import { BaseTaskOperation } from "./operations/base-task-operation";
import type { TaskServiceInterface } from "./taskService";
import { TASK_STATUS } from "./taskConstants";

describe("Hardcoded Markdown Defaults Bug", () => {
  const testWorkspacePath = "/tmp/test-workspace";
  
  // Mock task service that tracks which backend was requested
  let capturedBackendRequests: string[] = [];
  let mockTaskService: TaskServiceInterface;

  beforeEach(() => {
    capturedBackendRequests = [];
    
    // Create mock TaskService that captures backend requests
    mockTaskService = {
      getTask: async (taskId: string) => ({ 
        id: taskId, 
        title: "Test Task", 
        status: TASK_STATUS.TODO,
        spec: "Test spec"
      }),
      listTasks: async () => [],
      setTaskStatus: async () => {},
      createTask: async () => ({ id: "test#124", title: "New Task", status: TASK_STATUS.TODO }),
      deleteTask: async () => true,
      createTaskFromTitleAndSpec: async () => ({ id: "test#125", title: "Created Task", status: TASK_STATUS.TODO }),
      getTaskStatus: async () => TASK_STATUS.TODO,
      getWorkspacePath: () => testWorkspacePath,
      backends: [],
      currentBackend: "captured",
      getTaskSpecContent: async () => ({ 
        task: { id: "test#123", title: "Test", status: TASK_STATUS.TODO },
        specPath: "/test/spec.md",
        content: "test spec"
      }),
    } as any;
  });

  // Mock factory that captures which backend was requested
  const createMockConfiguredTaskService = mock(async (options: { workspacePath: string; backend?: string }) => {
    capturedBackendRequests.push(options.backend || "undefined");
    return mockTaskService;
  });

  describe("taskCommands.ts - getTaskFromParams", () => {
    test("should respect injected configuration instead of hardcoded markdown fallback", async () => {
      // Bug reproduction: When no backend is specified in params, it should use
      // configuration or detection service, NOT hardcoded "markdown"
      
      const params = {
        taskId: "test#123",
        // No backend specified - should use configuration, not hardcoded fallback
      };

      const deps = {
        createConfiguredTaskService: createMockConfiguredTaskService,
      };

      await getTaskFromParams(params, testWorkspacePath, deps);

      // BUG: This test will FAIL because the current code uses:
      // backend: validParams.backend || "markdown"
      // Instead of respecting configuration or using backend detection
      expect(capturedBackendRequests[0]).not.toBe("markdown");
      expect(capturedBackendRequests[0]).toBe("undefined"); // Should let service determine backend
    });
  });

  describe("taskCommands.ts - setTaskStatusFromParams", () => {
    test("should use backend detection instead of hardcoded markdown fallback", async () => {
      const params = {
        taskId: "mt#456",
        status: TASK_STATUS.IN_PROGRESS,
        // No backend specified
      };

      const deps = {
        createConfiguredTaskService: createMockConfiguredTaskService,
      };

      await setTaskStatusFromParams(params, testWorkspacePath, deps);

      // BUG: Qualified ID "mt#456" suggests minsky backend, but hardcoded fallback
      // will force "markdown" when backend param is undefined
      expect(capturedBackendRequests[0]).not.toBe("markdown");
    });
  });

  describe("base-task-operation.ts", () => {
    test("should use proper backend resolution instead of hardcoded markdown", async () => {
      class TestOperation extends BaseTaskOperation<any, any> {
        protected validateParams(params: any) {
          return { taskId: "test#123" };
        }
        
        protected async executeImpl(params: any, taskService: TaskServiceInterface) {
          return { success: true };
        }
      }

      const mockDeps = {
        createConfiguredTaskService: createMockConfiguredTaskService,
      };

      const operation = new TestOperation(mockDeps);
      
      const params = {
        taskId: "gh#789",
        // No backend specified
      };

      await operation.execute(params, testWorkspacePath);

      // BUG: BaseTaskOperation uses hardcoded || "markdown" fallback
      // Comment in code says "Use markdown as default to avoid config lookup"
      // This bypasses proper backend detection and multi-backend routing
      expect(capturedBackendRequests[0]).not.toBe("markdown");
      expect(capturedBackendRequests[0]).toBe("undefined"); // Should let service determine
    });
  });
});

/**
 * Expected Test Results (Before Fix):
 * 
 * All tests in this file should FAIL initially, demonstrating the bug:
 * - Tests expect backend requests to not be "markdown" 
 * - Current code uses || "markdown" fallbacks
 * - Tests will fail with: expected "markdown" not to be "markdown"
 * 
 * After implementing the fix:
 * - Replace || "markdown" with proper backend detection
 * - Tests should pass as backend selection becomes dynamic
 */
