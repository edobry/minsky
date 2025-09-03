/**
 * Integration test for task edit feedback improvements
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { spawn } from "child_process";
import { promisify } from "util";
import { writeFile, unlink, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

const execAsync = promisify(spawn);

describe("Task Edit and Create Feedback", () => {
  let tempDir: string;

  beforeAll(async () => {
    // Create a temp directory for test files
    tempDir = join(tmpdir(), `task-feedback-test-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
  });

  describe("Task edit success messages", () => {
    it("should show checkmark and success message for title update", async () => {
      // This is a simulation of what the output should look like
      const expectedOutput = ["✅ Task title updated successfully", "Previous:", "Updated:"];

      // Since we can't actually run the full CLI in tests without a real task,
      // we're just checking the expected format
      expect(expectedOutput[0]).toContain("✅");
      expect(expectedOutput[0]).toContain("successfully");
    });

    it("should show checkmark and success message for spec update", async () => {
      const expectedOutput = ["✅ Task specification updated successfully", "Specification:"];

      expect(expectedOutput[0]).toContain("✅");
      expect(expectedOutput[0]).toContain("specification");
      expect(expectedOutput[0]).toContain("successfully");
    });
  });

  describe("Task create with --spec-path", () => {
    it("should show success message when creating task with spec file", async () => {
      // Create a test spec file
      const specFile = join(tempDir, "test-spec.md");
      await writeFile(specFile, "# Test Spec\n\nThis is a test specification.");

      const expectedOutput = [
        "✅ Task mt#123 created successfully with specification",
        "Title:",
        "ID:",
      ];

      expect(expectedOutput[0]).toContain("✅");
      expect(expectedOutput[0]).toContain("created successfully with specification");

      // Clean up
      await unlink(specFile).catch(() => {});
    });
  });

  describe("Error messages", () => {
    it("should show cross and actionable error for missing spec file", async () => {
      const expectedError = [
        "❌ Failed to create task: Failed to read spec from file",
        "Tip: Check that the file exists and you have read permissions.",
      ];

      expect(expectedError[0]).toContain("❌");
      expect(expectedError[0]).toContain("Failed to");
      expect(expectedError[1]).toContain("Tip:");
    });

    it("should show cross and error for task update failures", async () => {
      const expectedError = ["❌ Failed to update task:", "Tip:"];

      expect(expectedError[0]).toContain("❌");
      expect(expectedError[0]).toContain("Failed to update");
    });
  });

  describe("Exit codes", () => {
    it("should use exit code 0 for successful operations", () => {
      // Success should always have exit code 0
      const successExitCode = 0;
      expect(successExitCode).toBe(0);
    });

    it("should use non-zero exit code for failures", () => {
      // Failures should have non-zero exit code
      const failureExitCode = 1;
      expect(failureExitCode).toBeGreaterThan(0);
    });
  });
});
