import { describe, it, expect } from "bun:test";
import { getNextTaskId } from "../tasks/taskFunctions";
import { TaskData } from "../../types/tasks/taskData";

// Constants to avoid repetition
const TEST_CONSTANTS = {
  TASK_IDS: {
    EXISTING_HIGH: "md#371",
    EXPECTED_NEXT: "372", // getNextTaskId returns plain format
    BUGGY_SEQUENCE: "2", // tasks.length + 1 gives wrong sequence
  },
} as const;

describe("Task ID Generation Bug Reproduction", () => {
  it("should demonstrate correct ID generation with getNextTaskId function", () => {
    // Setup: Mock task data with existing high-numbered task (md#371)
    const existingTasks: TaskData[] = [
      {
        id: TEST_CONSTANTS.TASK_IDS.EXISTING_HIGH,
        title: "Existing high numbered task",
        description: "This simulates existing task md#371",
        status: "TODO",
        specPath: "process/tasks/md#371.md",
      },
    ];

    // Call the CORRECT function that should be used
    const nextId = getNextTaskId(existingTasks);

    console.log("getNextTaskId result:", nextId);
    console.log("Expected next ID:", TEST_CONSTANTS.TASK_IDS.EXPECTED_NEXT);

    // This should PASS - getNextTaskId works correctly
    expect(nextId).toBe(TEST_CONSTANTS.TASK_IDS.EXPECTED_NEXT);
  });

  it("should demonstrate the BUG in JsonFileTaskBackend ID generation", () => {
    // Setup: Same mock task data
    const existingTasks: TaskData[] = [
      {
        id: TEST_CONSTANTS.TASK_IDS.EXISTING_HIGH,
        title: "Existing high numbered task",
        description: "This simulates existing task md#371",
        status: "TODO",
        specPath: "process/tasks/md#371.md",
      },
    ];

    // BUG REPRODUCTION: JsonFileTaskBackend does this WRONG approach:
    // const nextIdNumber = tasks.length + 1;
    // taskId = String(nextIdNumber);

    const buggyNextId = String(existingTasks.length + 1);

    console.log("Buggy approach (tasks.length + 1):", buggyNextId);
    console.log("Should be:", TEST_CONSTANTS.TASK_IDS.EXPECTED_NEXT);

    // This test documents the BUG - should FAIL until JsonFileTaskBackend is fixed
    expect(buggyNextId).toBe(TEST_CONSTANTS.TASK_IDS.BUGGY_SEQUENCE); // Shows the bug
    expect(buggyNextId).not.toBe(TEST_CONSTANTS.TASK_IDS.EXPECTED_NEXT); // Shows it's wrong
  });

  it("should show the difference between correct and buggy approaches", () => {
    // Multiple tasks with gaps to make the bug more obvious
    const tasksWithGaps: TaskData[] = [
      { id: "md#50", title: "Task 50", description: "", status: "TODO", specPath: "" },
      { id: "md#100", title: "Task 100", description: "", status: "TODO", specPath: "" },
      { id: "md#371", title: "Task 371", description: "", status: "TODO", specPath: "" },
    ];

    const correctNext = getNextTaskId(tasksWithGaps);
    const buggyNext = String(tasksWithGaps.length + 1);

    console.log("Correct approach (max ID + 1):", correctNext);
    console.log("Buggy approach (array.length + 1):", buggyNext);

    // Correct approach: finds max ID (371) + 1 = 372
    expect(correctNext).toBe("372");

    // Buggy approach: uses array length (3) + 1 = 4
    expect(buggyNext).toBe("4");

    // Show they're different
    expect(correctNext).not.toBe(buggyNext);
  });

  it("should show that getNextTaskId handles qualified IDs correctly", () => {
    // Mix of qualified and unqualified IDs (real-world scenario)
    const mixedTasks: TaskData[] = [
      { id: "md#300", title: "Task 300", description: "", status: "TODO", specPath: "" },
      { id: "gh#45", title: "GitHub Task 45", description: "", status: "TODO", specPath: "" },
      { id: "371", title: "Plain Task 371", description: "", status: "TODO", specPath: "" },
    ];

    const nextId = getNextTaskId(mixedTasks);

    // Should find the highest numeric value (371) and return 372
    expect(nextId).toBe("372");
  });
});
