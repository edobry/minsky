/**
 * Tests for Enhanced Multi-Backend Error Handling
 */
import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import {
  MultiBackendError,
  BackendNotFoundError,
  TaskRoutingError,
  BackendOperationError,
  TaskMigrationError,
  ErrorContext,
  ConsoleMultiBackendLogger,
  ErrorRecovery,
  MultiBackendValidation,
} from "./multi-backend-errors";

describe("Multi-Backend Error Handling", () => {
  describe("Error Types", () => {
    test("MultiBackendError should contain all required information", () => {
      const error = new MultiBackendError(
        "Test error",
        "test_operation",
        "test_backend",
        "test_task_id",
        new Error("Cause error")
      );

      expect(error.name).toBe("MultiBackendError");
      expect(error.message).toBe("Test error");
      expect(error.operation).toBe("test_operation");
      expect(error.backend).toBe("test_backend");
      expect(error.taskId).toBe("test_task_id");
      expect(error.cause?.message).toBe("Cause error");
    });

    test("MultiBackendError should serialize to JSON correctly", () => {
      const error = new MultiBackendError(
        "Test error",
        "test_operation",
        "test_backend",
        "test_task_id"
      );

      const json = error.toJSON();
      expect(json.name).toBe("MultiBackendError");
      expect(json.message).toBe("Test error");
      expect(json.operation).toBe("test_operation");
      expect(json.backend).toBe("test_backend");
      expect(json.taskId).toBe("test_task_id");
    });

    test("BackendNotFoundError should include available backends", () => {
      const error = new BackendNotFoundError("invalid", ["md", "gh", "json"]);

      expect(error.name).toBe("BackendNotFoundError");
      expect(error.message).toContain("Backend 'invalid' not found");
      expect(error.message).toContain("md, gh, json");
      expect(error.backend).toBe("invalid");
      expect(error.operation).toBe("backend_lookup");
    });

    test("TaskRoutingError should include task ID and reason", () => {
      const error = new TaskRoutingError("invalid#123", "Malformed task ID");

      expect(error.name).toBe("TaskRoutingError");
      expect(error.message).toContain("Failed to route task 'invalid#123'");
      expect(error.message).toContain("Malformed task ID");
      expect(error.taskId).toBe("invalid#123");
      expect(error.operation).toBe("task_routing");
    });

    test("BackendOperationError should include all operation details", () => {
      const cause = new Error("Network timeout");
      const error = new BackendOperationError("getTask", "github", "gh#123", cause);

      expect(error.name).toBe("BackendOperationError");
      expect(error.message).toContain("Backend operation 'getTask' failed");
      expect(error.message).toContain("backend 'github'");
      expect(error.message).toContain("task 'gh#123'");
      expect(error.message).toContain("Network timeout");
      expect(error.operation).toBe("getTask");
      expect(error.backend).toBe("github");
      expect(error.taskId).toBe("gh#123");
      expect(error.cause).toBe(cause);
    });

    test("TaskMigrationError should include migration details", () => {
      const error = new TaskMigrationError(
        "md#123",
        "markdown",
        "github",
        "Target backend unavailable"
      );

      expect(error.name).toBe("TaskMigrationError");
      expect(error.message).toContain("Failed to migrate task 'md#123'");
      expect(error.message).toContain("from 'markdown' to 'github'");
      expect(error.message).toContain("Target backend unavailable");
      expect(error.operation).toBe("task_migration");
      expect(error.backend).toBe("markdown");
      expect(error.taskId).toBe("md#123");
    });
  });

  describe("ErrorContext", () => {
    test("should build context with all fields", () => {
      const context = ErrorContext.create()
        .withOperation("list_tasks")
        .withBackend("markdown")
        .withTaskId("md#123")
        .withFilters({ status: "TODO" })
        .withMetadata({ attempt: 2 })
        .build();

      expect(context).toEqual({
        operation: "list_tasks",
        backend: "markdown",
        taskId: "md#123",
        filters: { status: "TODO" },
        metadata: { attempt: 2 },
      });
    });

    test("should create empty context by default", () => {
      const context = ErrorContext.create().build();
      expect(context).toEqual({});
    });

    test("should support method chaining", () => {
      const builder = ErrorContext.create();
      const result = builder.withOperation("test").withBackend("test_backend");
      expect(result).toBe(builder); // Should return same instance for chaining
    });
  });

  describe("ConsoleMultiBackendLogger", () => {
    let logger: ConsoleMultiBackendLogger;
    let logSpy: ReturnType<typeof spyOn>;
    let warnSpy: ReturnType<typeof spyOn>;
    let errorSpy: ReturnType<typeof spyOn>;
    let debugSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      logger = new ConsoleMultiBackendLogger();
      logSpy = spyOn(console, "log").mockImplementation(() => {});
      warnSpy = spyOn(console, "warn").mockImplementation(() => {});
      errorSpy = spyOn(console, "error").mockImplementation(() => {});
      debugSpy = spyOn(console, "debug").mockImplementation(() => {});
    });

    afterEach(() => {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      debugSpy.mockRestore();
    });

    test("should log info messages with context", () => {
      logger.info("Test message", { key: "value" });
      expect(logSpy).toHaveBeenCalledWith("[INFO] Test message", '{\n  "key": "value"\n}');
    });

    test("should log info messages without context", () => {
      logger.info("Test message");
      expect(logSpy).toHaveBeenCalledWith("[INFO] Test message", "");
    });

    test("should log warn messages", () => {
      logger.warn("Warning message", { backend: "test" });
      expect(warnSpy).toHaveBeenCalledWith("[WARN] Warning message", '{\n  "backend": "test"\n}');
    });

    test("should log error messages", () => {
      logger.error("Error message", { error: "details" });
      expect(errorSpy).toHaveBeenCalledWith("[ERROR] Error message", '{\n  "error": "details"\n}');
    });

    test("should log debug messages", () => {
      logger.debug("Debug message", { debug: "info" });
      expect(debugSpy).toHaveBeenCalledWith("[DEBUG] Debug message", '{\n  "debug": "info"\n}');
    });
  });

  describe("ErrorRecovery", () => {
    describe("withRetry", () => {
      test("should succeed on first attempt", async () => {
        const operation = mock(() => Promise.resolve("success"));
        const result = await ErrorRecovery.withRetry(operation, 3);

        expect(result).toBe("success");
        expect(operation).toHaveBeenCalledTimes(1);
      });

      test("should retry on failure and eventually succeed", async () => {
        let attempts = 0;
        const operation = mock(() => {
          attempts++;
          if (attempts < 3) {
            return Promise.reject(new Error("Temporary failure"));
          }
          return Promise.resolve("success");
        });

        const result = await ErrorRecovery.withRetry(operation, 3, 10); // Short backoff for testing

        expect(result).toBe("success");
        expect(operation).toHaveBeenCalledTimes(3);
      });

      test("should throw MultiBackendError after max retries", async () => {
        const operation = mock(() => Promise.reject(new Error("Persistent failure")));

        await expect(ErrorRecovery.withRetry(operation, 2, 10)).rejects.toThrow(MultiBackendError);
        expect(operation).toHaveBeenCalledTimes(2);
      });

      test("should handle non-Error objects", async () => {
        // eslint-disable-next-line prefer-promise-reject-errors
        const operation = mock(() => Promise.reject("String error"));

        await expect(ErrorRecovery.withRetry(operation, 1, 10)).rejects.toThrow(MultiBackendError);
      });
    });

    describe("handlePartialFailure", () => {
      test("should return successful results and log failures", () => {
        const results = [
          { success: true, result: "task1", backend: "md" },
          { success: false, error: new Error("Failed"), backend: "gh" },
          { success: true, result: "task2", backend: "json" },
        ];

        const successes = ErrorRecovery.handlePartialFailure(results, "list_tasks");

        expect(successes).toEqual(["task1", "task2"]);
      });

      test("should handle all failures gracefully", () => {
        const results = [
          { success: false, error: new Error("Failed 1"), backend: "md" },
          { success: false, error: new Error("Failed 2"), backend: "gh" },
        ];

        const successes = ErrorRecovery.handlePartialFailure(results, "list_tasks");

        expect(successes).toEqual([]);
      });

      test("should handle all successes", () => {
        const results = [
          { success: true, result: "task1", backend: "md" },
          { success: true, result: "task2", backend: "gh" },
        ];

        const successes = ErrorRecovery.handlePartialFailure(results, "list_tasks");

        expect(successes).toEqual(["task1", "task2"]);
      });
    });
  });

  describe("MultiBackendValidation", () => {
    describe("validateTaskId", () => {
      test("should accept valid task IDs", () => {
        expect(() => MultiBackendValidation.validateTaskId("md#123", "test")).not.toThrow();
        expect(() => MultiBackendValidation.validateTaskId("123", "test")).not.toThrow();
        expect(() => MultiBackendValidation.validateTaskId("task-abc", "test")).not.toThrow();
      });

      test("should reject invalid task IDs", () => {
        expect(() => MultiBackendValidation.validateTaskId("", "test")).toThrow(MultiBackendError);
        expect(() => MultiBackendValidation.validateTaskId("   ", "test")).toThrow(
          MultiBackendError
        );
        expect(() => MultiBackendValidation.validateTaskId(null as any, "test")).toThrow(
          MultiBackendError
        );
        expect(() => MultiBackendValidation.validateTaskId(undefined as any, "test")).toThrow(
          MultiBackendError
        );
        expect(() => MultiBackendValidation.validateTaskId(123 as any, "test")).toThrow(
          MultiBackendError
        );
      });
    });

    describe("validateBackendName", () => {
      test("should accept valid backend names", () => {
        expect(() => MultiBackendValidation.validateBackendName("md", "test")).not.toThrow();
        expect(() => MultiBackendValidation.validateBackendName("github", "test")).not.toThrow();
      });

      test("should reject invalid backend names", () => {
        expect(() => MultiBackendValidation.validateBackendName("", "test")).toThrow(
          MultiBackendError
        );
        expect(() => MultiBackendValidation.validateBackendName("   ", "test")).toThrow(
          MultiBackendError
        );
        expect(() => MultiBackendValidation.validateBackendName(null as any, "test")).toThrow(
          MultiBackendError
        );
      });
    });

    describe("validateTaskSpec", () => {
      test("should accept valid task specs", () => {
        expect(() =>
          MultiBackendValidation.validateTaskSpec({ title: "Valid Task" }, "test")
        ).not.toThrow();
        expect(() =>
          MultiBackendValidation.validateTaskSpec({ title: "Task", description: "Desc" }, "test")
        ).not.toThrow();
      });

      test("should reject invalid task specs", () => {
        expect(() => MultiBackendValidation.validateTaskSpec(null as any, "test")).toThrow(
          MultiBackendError
        );
        expect(() => MultiBackendValidation.validateTaskSpec("string" as any, "test")).toThrow(
          MultiBackendError
        );
        expect(() => MultiBackendValidation.validateTaskSpec({}, "test")).toThrow(
          MultiBackendError
        );
        expect(() => MultiBackendValidation.validateTaskSpec({ title: "" }, "test")).toThrow(
          MultiBackendError
        );
        expect(() => MultiBackendValidation.validateTaskSpec({ title: "   " }, "test")).toThrow(
          MultiBackendError
        );
        expect(() => MultiBackendValidation.validateTaskSpec({ title: null }, "test")).toThrow(
          MultiBackendError
        );
      });
    });
  });
});
