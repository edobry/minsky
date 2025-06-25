/**
 * Regression test for task status "status is not defined" bug
 * This test ensures that the variable naming fix in taskConstants.ts
 * prevents the "status is not defined" error from recurring.
 */

import { TASK_PARSING_UTILS } from "../tasks/taskConstants";

describe("Task Status Variables Regression Tests", () => {
  describe("TASK_PARSING_UTILS.getCheckboxFromStatus", () => {
    test("should return correct checkbox for TODO status", () => {
      const result = TASK_PARSING_UTILS.getCheckboxFromStatus("TODO");
      expect(result).toBe(" ");
    });

    test("should return correct checkbox for IN-PROGRESS status", () => {
      const result = TASK_PARSING_UTILS.getCheckboxFromStatus("IN-PROGRESS");
      expect(result).toBe("+");
    });

    test("should return correct checkbox for DONE status", () => {
      const result = TASK_PARSING_UTILS.getCheckboxFromStatus("DONE");
      expect(result).toBe("x");
    });

    test("should not throw 'status is not defined' error", () => {
      // This test ensures the parameter naming issue is fixed
      expect(() => {
        TASK_PARSING_UTILS.getCheckboxFromStatus("TODO");
      }).not.toThrow("status is not defined");
    });
  });
});
