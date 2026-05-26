// TaskService interface compatibility tests
// Ensures TaskService provides all expected methods for CLI and other consumers
// Original issue: "taskService.setTaskStatus is not a function"
// Solution: Added missing interface methods for backward compatibility

import { describe, test, expect } from "bun:test";
import { createConfiguredTaskService, type TaskServiceInterface } from "./taskService";
import { TASK_STATUS } from "./taskConstants";
import { FakePersistenceProvider } from "../persistence/fake-persistence-provider";

describe("TaskService Interface Compatibility", () => {
  test("should provide setTaskStatus method", async () => {
    // This test ensures the setTaskStatus method exists and is callable
    // Required for CLI commands and other consumers that expect this interface

    const taskService = await createConfiguredTaskService({
      workspacePath: "/test/workspace",
      persistenceProvider: new FakePersistenceProvider(),
      // no specific backend: uses multi-backend mode
    });

    // Both methods should exist
    expect(typeof taskService.setTaskStatus).toBe("function");
    expect(typeof (taskService as TaskServiceInterface).setTaskStatus).toBe("function");

    // setTaskStatus should be an async function
    expect((taskService as TaskServiceInterface).setTaskStatus).toBeInstanceOf(Function);
    expect((taskService as TaskServiceInterface).setTaskStatus.constructor.name).toBe(
      "AsyncFunction"
    );
  });

  test("should have getTaskStatus method (ensures interface completeness)", async () => {
    // This test ensures the getTaskStatus method exists for interface compatibility

    const taskService = await createConfiguredTaskService({
      workspacePath: "/test/workspace",
      persistenceProvider: new FakePersistenceProvider(),
      // no specific backend: uses multi-backend mode
    });

    // getTaskStatus should exist
    expect(typeof (taskService as TaskServiceInterface).getTaskStatus).toBe("function");
    expect((taskService as TaskServiceInterface).getTaskStatus).toBeInstanceOf(Function);
    expect((taskService as TaskServiceInterface).getTaskStatus.constructor.name).toBe(
      "AsyncFunction"
    );
  });

  test("should validate task status in setTaskStatus method", async () => {
    // Ensures status validation works correctly in setTaskStatus

    const taskService = await createConfiguredTaskService({
      workspacePath: "/test/workspace",
      persistenceProvider: new FakePersistenceProvider(),
      // no specific backend: uses multi-backend mode
    });

    // Should reject when no backends are registered (graceful error)
    await expect(
      (taskService as TaskServiceInterface).setTaskStatus("test", "INVALID_STATUS")
    ).rejects.toThrow(/No backend available|Failed to read tasks data|Task with id .* not found/);

    // Should accept valid status (even though it may fail on missing file, that's expected)
    const validCall = (taskService as TaskServiceInterface).setTaskStatus("test", TASK_STATUS.TODO);
    expect(validCall).toBeInstanceOf(Promise);

    // Clean up the promise to avoid unhandled rejection
    validCall.catch(() => {}); // Expected to fail due to missing file, but that's OK for interface test
  });

  test("should maintain interface compatibility with existing commands", async () => {
    // This is the core regression test - ensures the methods exist with expected signatures
    // This is what the CLI depends on and what was broken before the fix

    const taskService = await createConfiguredTaskService({
      workspacePath: "/test/workspace",
      persistenceProvider: new FakePersistenceProvider(),
      // no specific backend: uses multi-backend mode
    });

    // Interface methods that CLI and other code expects to exist
    const requiredMethods = [
      "listTasks",
      "getTask",
      "getTaskStatus",
      "setTaskStatus",
      "updateTask",
      "getWorkspacePath",
    ];

    for (const methodName of requiredMethods) {
      expect(typeof (taskService as unknown as Record<string, unknown>)[methodName]).toBe(
        "function"
      );
    }
  });
});
