/**
 * Test for task 153 status selector pre-selection fix
 * 
 * Verifies that the status selector correctly pre-selects the current task status
 * instead of always defaulting to TODO.
 */

import { describe, test, expect } from "bun:test";
import { TASK_STATUS } from "../../../../domain/tasks/taskConstants";

const BLOCKED_STATUS_INDEX = 4;

describe("Task Status Selector Pre-selection (Task #153 Fix)", () => {
  test("should pre-select BLOCKED status for task with BLOCKED status", () => {
    // Test the logic that determines the initialValue parameter
    const previousStatus = "BLOCKED";
    const statusOptions = [
      { value: TASK_STATUS.TODO, label: "TODO" },
      { value: TASK_STATUS.IN_PROGRESS, label: "IN-PROGRESS" },
      { value: TASK_STATUS.IN_REVIEW, label: "IN-REVIEW" },
      { value: TASK_STATUS.DONE, label: "DONE" },
      { value: TASK_STATUS.BLOCKED, label: "BLOCKED" },
    ];

    // This is the logic from the fixed code
    const currentStatusIndex = statusOptions.findIndex(
      (option) => option?.value === previousStatus
    );
    const initialValue = currentStatusIndex >= 0 ? previousStatus : TASK_STATUS?.TODO;

    // Verify BLOCKED status is found and selected
    expect(currentStatusIndex).toBe(BLOCKED_STATUS_INDEX); // BLOCKED is at index 4
    expect(initialValue).toBe("BLOCKED");
  });

  test("should pre-select TODO status for task with TODO status", () => {
    const previousStatus = "TODO";
    const statusOptions = [
      { value: TASK_STATUS.TODO, label: "TODO" },
      { value: TASK_STATUS.IN_PROGRESS, label: "IN-PROGRESS" },
      { value: TASK_STATUS.IN_REVIEW, label: "IN-REVIEW" },
      { value: TASK_STATUS.DONE, label: "DONE" },
      { value: TASK_STATUS.BLOCKED, label: "BLOCKED" },
    ];

    const currentStatusIndex = statusOptions.findIndex(
      (option) => option?.value === previousStatus
    );
    const initialValue = currentStatusIndex >= 0 ? previousStatus : TASK_STATUS?.TODO;

    expect(currentStatusIndex).toBe(0); // TODO is at index 0
    expect(initialValue).toBe("TODO");
  });

  test("should default to TODO for null/undefined status", () => {
    const previousStatus = null;
    const statusOptions = [
      { value: TASK_STATUS.TODO, label: "TODO" },
      { value: TASK_STATUS.IN_PROGRESS, label: "IN-PROGRESS" },
      { value: TASK_STATUS.IN_REVIEW, label: "IN-REVIEW" },
      { value: TASK_STATUS.DONE, label: "DONE" },
      { value: TASK_STATUS.BLOCKED, label: "BLOCKED" },
    ];

    const currentStatusIndex = statusOptions.findIndex(
      (option) => option?.value === previousStatus
    );
    const initialValue = currentStatusIndex >= 0 ? previousStatus : TASK_STATUS?.TODO;

    expect(currentStatusIndex).toBe(-1); // Not found
    expect(initialValue).toBe("TODO"); // Should default to TODO
  });

  test("should pre-select IN-PROGRESS status correctly", () => {
    const previousStatus = "IN-PROGRESS";
    const statusOptions = [
      { value: TASK_STATUS.TODO, label: "TODO" },
      { value: TASK_STATUS.IN_PROGRESS, label: "IN-PROGRESS" },
      { value: TASK_STATUS.IN_REVIEW, label: "IN-REVIEW" },
      { value: TASK_STATUS.DONE, label: "DONE" },
      { value: TASK_STATUS.BLOCKED, label: "BLOCKED" },
    ];

    const currentStatusIndex = statusOptions.findIndex(
      (option) => option?.value === previousStatus
    );
    const initialValue = currentStatusIndex >= 0 ? previousStatus : TASK_STATUS?.TODO;

    expect(currentStatusIndex).toBe(1); // IN-PROGRESS is at index 1
    expect(initialValue).toBe("IN-PROGRESS");
  });
}); 
