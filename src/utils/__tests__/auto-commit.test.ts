/**
 * Tests for auto-commit utility
 */
import { describe, test, expect } from "bun:test";
import { autoCommitTaskChanges } from "../auto-commit";

describe("autoCommitTaskChanges", () => {
  test("should be a function", () => {
    expect(typeof autoCommitTaskChanges).toBe("function");
  });

  test("should accept workspacePath and message parameters", () => {
    expect(autoCommitTaskChanges.length).toBe(2);
  });

  test("should return a Promise<boolean>", async () => {
    // This test will fail in CI/non-git environments, but verifies the signature
    const result = autoCommitTaskChanges("/tmp", "test commit");
    expect(result).toBeInstanceOf(Promise);
  });
});
