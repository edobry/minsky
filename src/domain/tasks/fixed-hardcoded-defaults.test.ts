/**
 * Tests to verify that hardcoded markdown defaults have been fixed
 * 
 * These tests verify that the fixes work correctly - the code should now
 * pass backend: undefined to let the service determine the appropriate backend
 * instead of forcing "markdown" as a hardcoded default.
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";
import {
  getTaskFromParams,
  setTaskStatusFromParams,
} from "./taskCommands";
import { BaseTaskOperation } from "./operations/base-task-operation";
import type { TaskServiceInterface } from "./taskService";
import { TASK_STATUS } from "./taskConstants";

describe("Fixed Hardcoded Markdown Defaults", () => {
  const testWorkspacePath = "/tmp/test-workspace";
  
  // Mock task service that tracks which backend was requested
  let capturedBackendRequests: (string | undefined)[] = [];
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
    capturedBackendRequests.push(options.backend);
    return mockTaskService;
  });

  describe("taskCommands.ts - Fixed Functions", () => {
    test("getTaskFromParams should pass undefined backend to let service determine", async () => {
      const params = {
        taskId: "test#123",
        // No backend specified - should pass undefined, not "markdown"
      };

      const deps = {
        createConfiguredTaskService: createMockConfiguredTaskService,
      };

      await getTaskFromParams(params, testWorkspacePath, deps);

      // FIXED: Should now pass undefined instead of "markdown"
      expect(capturedBackendRequests[0]).toBe(undefined);
      expect(capturedBackendRequests[0]).not.toBe("markdown");
    });

    test("setTaskStatusFromParams should pass undefined backend to let service determine", async () => {
      const params = {
        taskId: "mt#456",
        status: TASK_STATUS.IN_PROGRESS,
        // No backend specified - should pass undefined, not "markdown"
      };

      const deps = {
        createConfiguredTaskService: createMockConfiguredTaskService,
      };

      await setTaskStatusFromParams(params, testWorkspacePath, deps);

      // FIXED: Should now pass undefined instead of "markdown"
      expect(capturedBackendRequests[0]).toBe(undefined);
      expect(capturedBackendRequests[0]).not.toBe("markdown");
    });
  });

  describe("base-task-operation.ts - Fixed Functions", () => {
    test("BaseTaskOperation should pass undefined backend to let service determine", async () => {
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
        // No backend specified - should pass undefined, not "markdown"
      };

      await operation.execute(params, testWorkspacePath);

      // FIXED: Should now pass undefined instead of "markdown"
      expect(capturedBackendRequests[0]).toBe(undefined);
      expect(capturedBackendRequests[0]).not.toBe("markdown");
    });
  });

  describe("Multi-backend Integration", () => {
    test("should allow multi-backend service to handle routing for qualified IDs", async () => {
      const params = {
        taskId: "md#123", // Markdown task
        // No backend specified - multi-backend service should route based on prefix
      };

      const deps = {
        createConfiguredTaskService: createMockConfiguredTaskService,
      };

      await getTaskFromParams(params, testWorkspacePath, deps);

      // FIXED: Service creation gets undefined backend, allowing multi-backend routing
      expect(capturedBackendRequests[0]).toBe(undefined);
      
      // This means the multi-backend service can:
      // 1. Parse the "md#" prefix from the taskId
      // 2. Route to the appropriate markdown backend
      // 3. Handle multiple backends simultaneously
    });
  });
});

/**
 * Test Documentation:
 * 
 * These tests verify that the hardcoded markdown defaults have been successfully removed.
 * 
 * Before fix:
 * - backend: params.backend || "markdown" (forced markdown when undefined)
 * 
 * After fix:
 * - backend: params.backend (passes undefined, lets service determine)
 * 
 * Benefits of the fix:
 * 1. Multi-backend service can route based on qualified IDs
 * 2. Backend detection service can determine appropriate backend
 * 3. Configuration system can specify backend preferences
 * 4. No hardcoded assumptions about default backend
 */
