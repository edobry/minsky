/**
 * DEBUG TEST: Test the exact regex pattern used in validateQualifiedTaskId
 */
import { describe, test, expect } from "bun:test";

describe("Regex Pattern Debug", () => {
  test("Test the qualified task ID regex pattern", async () => {
    const taskId = "mt#510";
    const pattern = /^[a-z-]+#.+$/;

    console.log(`Testing "${taskId}" against pattern: ${pattern}`);
    console.log(`Does it match? ${pattern.test(taskId)}`);

    // Test each part
    console.log(`"mt" matches [a-z-]+? ${"mt".match(/^[a-z-]+$/)} `);
    console.log(`"#" is present? ${taskId.includes("#")}`);
    console.log(`"510" matches .+? ${"510".match(/^.+$/)} `);

    expect(pattern.test(taskId)).toBe(true);
  });

  test("Test validateQualifiedTaskId step by step", async () => {
    const { validateQualifiedTaskId } = await import("./domain/tasks/task-id-utils");

    // Test the actual function logic step by step
    const taskId = "mt#510";
    const trimmed = taskId.trim();

    console.log(`Original: "${taskId}"`);
    console.log(`Trimmed: "${trimmed}"`);

    // Test the qualified format check (line 27-29)
    const qualifiedPattern = /^[a-z-]+#.+$/;
    const isQualified = qualifiedPattern.test(trimmed);
    console.log(`Matches qualified pattern? ${isQualified}`);

    if (isQualified) {
      console.log(`Should return: "${trimmed}"`);
    }

    const result = validateQualifiedTaskId(taskId);
    console.log(`Actual result: "${result}"`);

    expect(result).toBe(taskId);
  });
});
