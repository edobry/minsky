/**
 * Regression test for task status "status is not defined" bug
 * This test ensures that the variable naming fix in taskConstants.ts
 * prevents the "status is not defined" error from recurring.
 */

import { TASK_PARSING_UTILS } from "./tasks/taskConstants";

describe("Task Status Bug Regression Tests", () => {
  describe("TASK_PARSING_UTILS.getCheckboxFromStatus", () => {
    test("should return correct checkbox for TODO status", () => {
      const result = TASK_PARSING_UTILS.getCheckboxFromStatus("TODO");
      expect(result)!.toBe(" ");
    });

    test("should return correct checkbox for IN-PROGRESS status", () => {
      const result = TASK_PARSING_UTILS.getCheckboxFromStatus("IN-PROGRESS");
      expect(result)!.toBe("+");
    });

    test("should return correct checkbox for IN-REVIEW status", () => {
      const result = TASK_PARSING_UTILS.getCheckboxFromStatus("IN-REVIEW");
      expect(result)!.toBe("-");
    });

    test("should return correct checkbox for DONE status", () => {
      const result = TASK_PARSING_UTILS.getCheckboxFromStatus("DONE");
      expect(result)!.toBe("x");
    });

    test("should return correct checkbox for BLOCKED status", () => {
      const result = TASK_PARSING_UTILS.getCheckboxFromStatus("BLOCKED");
      expect(result)!.toBe("~");
    });

    test("should not throw 'status is not defined' error", () => {
      // This test ensures the parameter naming issue is fixed
      expect(() => {
        TASK_PARSING_UTILS.getCheckboxFromStatus("TODO");
      }).not.toThrow("status is not defined");
    });
  });

  describe("Integration test with task status functionality", () => {
    test("should handle all status transitions without variable naming errors", () => {
      const statuses = ["TODO", "IN-PROGRESS", "IN-REVIEW", "DONE", "BLOCKED"] as const;

      // This should not throw any "status is not defined" errors
      expect(() => {
        for (const status of statuses) {
          const checkbox = TASK_PARSING_UTILS.getCheckboxFromStatus(status);
          expect(typeof checkbox).toBe("string");
          expect(checkbox.length).toBe(1);
        }
      }).not.toThrow();
    });
  });
});
