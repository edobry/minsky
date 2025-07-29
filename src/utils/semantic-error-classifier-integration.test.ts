/**
 * Integration tests for SemanticErrorClassifier with real filesystem scenarios
 * Addresses senior engineer concern about heuristic brittleness
 */

import { mkdtemp, rmdir, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { SemanticErrorClassifier, ErrorContext } from "./semantic-error-classifier";
import { SemanticErrorCode } from "../types/semantic-errors";

describe("SemanticErrorClassifier Integration Tests", () => {
  let testDir: string;

  beforeEach(async () => {
    // Create a temporary directory for each test
    testDir = await mkdtemp(join(tmpdir(), "semantic-error-test-"));
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await rmdir(testDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("Real filesystem scenarios", () => {
    it("should correctly classify file not found vs directory not found", async () => {
      // Test 1: File not found in existing directory
      await mkdir(join(testDir, "existing-dir"));

      const fileError = new Error(
        `ENOENT: no such file or directory, open '${join(testDir, "existing-dir", "missing-file.txt")}'`
      );
      (fileError as any).code = "ENOENT";

      const fileContext: ErrorContext = {
        operation: "read_file",
        path: join(testDir, "existing-dir", "missing-file.txt"),
      };

      const fileResult = await SemanticErrorClassifier.classifyError(fileError, fileContext);
      expect(fileResult.errorCode).toBe(SemanticErrorCode.FILE_NOT_FOUND);

      // Test 2: Directory not found for write operation
      const dirError = new Error(
        `ENOENT: no such file or directory, open '${join(testDir, "missing-dir", "file.txt")}'`
      );
      (dirError as any).code = "ENOENT";

      const dirContext: ErrorContext = {
        operation: "write_file",
        path: join(testDir, "missing-dir", "file.txt"),
        createDirs: false,
      };

      const dirResult = await SemanticErrorClassifier.classifyError(dirError, dirContext);
      expect(dirResult.errorCode).toBe(SemanticErrorCode.DIRECTORY_NOT_FOUND);
    });

    it("should handle various real filesystem error formats", async () => {
      // Test different error message formats that occur in practice
      const errorFormats = [
        `ENOENT: no such file or directory, open '${join(testDir, "test.txt")}'`,
        `ENOENT: no such file or directory, scandir '${join(testDir, "missing")}'`,
        `ENOENT: no such file or directory, mkdir '${join(testDir, "deep", "path", "file.txt")}'`,
      ];

      for (const errorMsg of errorFormats) {
        const error = new Error(errorMsg);
        (error as any).code = "ENOENT";

        const context: ErrorContext = {
          operation: errorMsg.includes("mkdir") ? "write_file" : "read_file",
          createDirs: false,
        };

        const result = await SemanticErrorClassifier.classifyError(error, context);
        expect(result.success).toBe(false);
        expect(result.errorCode).toMatch(/FILE_NOT_FOUND|DIRECTORY_NOT_FOUND/);
        expect(result.solutions.length).toBeGreaterThan(0);
      }
    });

    it("should provide context-aware solutions for real scenarios", async () => {
      const error = new Error(
        `ENOENT: no such file or directory, open '${join(testDir, "deep", "nested", "file.txt")}'`
      );
      (error as any).code = "ENOENT";

      const context: ErrorContext = {
        operation: "write_file",
        path: join(testDir, "deep", "nested", "file.txt"),
        createDirs: false,
      };

      const result = await SemanticErrorClassifier.classifyError(error, context);

      // Should suggest createDirs: true for this scenario
      expect(result.solutions[0]).toContain("createDirs: true");
      expect(result.relatedTools).toContain("session_create_directory");
      expect(result.retryable).toBe(true);
    });
  });
});
