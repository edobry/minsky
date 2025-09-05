/**
 * DEBUG TEST: Trace the exact session lookup bug
 */
import { describe, test, expect } from "bun:test";

describe("Session Lookup Debugging", () => {
  test("Debug validateQualifiedTaskId with mt#510", async () => {
    const { validateQualifiedTaskId } = await import("./domain/tasks/task-id-utils");

    const taskId = "mt#510";
    const validated = validateQualifiedTaskId(taskId);

    console.log(`Input: "${taskId}"`);
    console.log(`validateQualifiedTaskId result: "${validated}"`);
    console.log(`Is null? ${validated === null}`);
    console.log(`Type: ${typeof validated}`);

    // This is the critical test - what does the validation return?
    expect(validated).not.toBeNull();
    expect(validated).toBe(taskId);
  });

  test("Debug session comparison logic", async () => {
    // Mock the exact data we see in the database
    const sessionFromDB = {
      session: "task-mt#510",
      taskId: "mt#510"
    };

    const searchTaskId = "mt#510";
    const { validateQualifiedTaskId } = await import("./domain/tasks/task-id-utils");
    const validatedTaskId = validateQualifiedTaskId(searchTaskId);

    console.log(`DB taskId: "${sessionFromDB.taskId}"`);
    console.log(`Validated search taskId: "${validatedTaskId}"`);
    console.log(`Comparison: "${sessionFromDB.taskId}" === "${validatedTaskId}" = ${sessionFromDB.taskId === validatedTaskId}`);

    expect(sessionFromDB.taskId === validatedTaskId).toBe(true);
  });
});
