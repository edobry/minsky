/**
 * DEBUG TEST: Compare the two different validation functions
 */
import { describe, test, expect } from "bun:test";

describe("Validation Function Comparison", () => {
  test("Compare taskIdSchema.parse vs validateQualifiedTaskId", async () => {
    const taskId = "mt#510";

    // Test taskIdSchema (from session context resolver)
    const { taskIdSchema } = await import("./schemas/common");
    const schemaResult = taskIdSchema.parse(taskId);
    console.log(`taskIdSchema.parse("${taskId}") = "${schemaResult}"`);

    // Test validateQualifiedTaskId (from SessionDbAdapter)
    const { validateQualifiedTaskId } = await import("./domain/tasks/task-id-utils");
    const utilsResult = validateQualifiedTaskId(taskId);
    console.log(`validateQualifiedTaskId("${taskId}") = "${utilsResult}"`);

    // Are they the same?
    console.log(`Results are equal: ${schemaResult === utilsResult}`);
    console.log(`Schema type: ${typeof schemaResult}, Utils type: ${typeof utilsResult}`);

    expect(schemaResult).toBe(utilsResult);
  });
});
