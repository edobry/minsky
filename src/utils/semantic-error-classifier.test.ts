/**
 * Tests for SemanticErrorClassifier
 * Verifies that filesystem errors are properly converted to semantic errors
 */

import { SemanticErrorClassifier, ErrorContext } from "./semantic-error-classifier";
import { SemanticErrorCode } from "../types/semantic-errors";

describe("SemanticErrorClassifier", () => {
  describe("classifyError", () => {
    it("should classify ENOENT file errors correctly", async () => {
      const error = {
        code: "ENOENT",
        message: "ENOENT: no such file or directory, open '/path/to/file.txt'",
      };

      const context: ErrorContext = {
        operation: "read_file",
        path: "/path/to/file.txt",
        session: "test-session",
      };

      const result = await SemanticErrorClassifier.classifyError(error, context);

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(SemanticErrorCode.FILE_NOT_FOUND);
      expect(result.error).toContain("File not found");
      expect(result.solutions).toContain("Check the file path for typos");
      expect(result.relatedTools).toContain("file_search");
      expect(result.path).toBe("/path/to/file.txt");
      expect(result.session).toBe("test-session");
    });

    it("should classify ENOENT directory errors correctly", async () => {
      const error = {
        code: "ENOENT",
        message: "ENOENT: no such file or directory, mkdir '/nonexistent/path/file.txt'",
      };

      const context: ErrorContext = {
        operation: "write_file",
        path: "/nonexistent/path/file.txt",
        session: "test-session",
        createDirs: false,
      };

      const result = await SemanticErrorClassifier.classifyError(error, context);

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(SemanticErrorCode.DIRECTORY_NOT_FOUND);
      expect(result.error).toContain("parent directory does not exist");
      expect(result.solutions).toContain(
        "Set createDirs: true to automatically create parent directories"
      );
      expect(result.relatedTools).toContain("session_create_directory");
      expect(result.retryable).toBe(true);
    });

    it("should classify permission errors correctly", async () => {
      const error = {
        code: "EACCES",
        message: "EACCES: permission denied, open '/etc/passwd'",
      };

      const context: ErrorContext = {
        operation: "read_file",
        path: "/etc/passwd",
        session: "test-session",
      };

      const result = await SemanticErrorClassifier.classifyError(error, context);

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(SemanticErrorCode.PERMISSION_DENIED);
      expect(result.error).toContain("Permission denied");
      expect(result.solutions).toContain("Check file permissions and ownership");
      expect(result.retryable).toBe(false);
    });

    it("should classify session errors correctly", async () => {
      const error = {
        message: "Session not found: invalid-session",
      };

      const context: ErrorContext = {
        operation: "read_file",
        path: "/some/file.txt",
        session: "invalid-session",
      };

      const result = await SemanticErrorClassifier.classifyError(error, context);

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(SemanticErrorCode.SESSION_NOT_FOUND);
      expect(result.error).toContain("Session not found");
      expect(result.solutions).toContain("Use session_list to see available sessions");
      expect(result.relatedTools).toContain("session_list");
    });

    it("should classify git errors correctly", async () => {
      const error = {
        message: "git: authentication failed for repository",
      };

      const context: ErrorContext = {
        operation: "git_push",
        session: "test-session",
      };

      const result = await SemanticErrorClassifier.classifyError(error, context);

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(SemanticErrorCode.GIT_AUTHENTICATION_FAILED);
      expect(result.error).toContain("Git authentication failed");
      expect(result.solutions).toContain("Check git credentials");
      expect(result.retryable).toBe(true);
    });

    it("should handle generic errors gracefully", async () => {
      const error = {
        message: "Some unexpected error occurred",
      };

      const context: ErrorContext = {
        operation: "unknown_operation",
        session: "test-session",
      };

      const result = await SemanticErrorClassifier.classifyError(error, context);

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(SemanticErrorCode.OPERATION_FAILED);
      expect(result.error).toContain("Operation failed");
      expect(result.solutions.length).toBeGreaterThan(0);
      expect(result.retryable).toBe(true);
    });

    it("should extract file paths from error messages", async () => {
      const error = {
        code: "ENOENT",
        message: "ENOENT: no such file or directory, open '/extracted/path/file.txt'",
      };

      const context: ErrorContext = {
        operation: "read_file",
        session: "test-session",
        // Note: no path provided in context
      };

      const result = await SemanticErrorClassifier.classifyError(error, context);

      expect(result.path).toBe("/extracted/path/file.txt");
    });

    it("should enhance solutions based on context", async () => {
      const error = {
        code: "ENOENT",
        message: "ENOENT: no such file or directory, mkdir '/path/to/file.txt'",
      };

      const context: ErrorContext = {
        operation: "write_file",
        path: "/path/to/file.txt",
        session: "test-session",
        createDirs: false, // This should add extra solution
      };

      const result = await SemanticErrorClassifier.classifyError(error, context);

      expect(result.solutions[0]).toBe(
        "Set createDirs: true to automatically create parent directories"
      );
    });
  });
});
