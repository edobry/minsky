/**
 * Tests for network error handling
 */
import { describe, expect, test } from "bun:test";
import {
  NetworkError,
  PortInUseError,
  NetworkPermissionError,
  isNetworkError,
  createNetworkError,
  formatNetworkErrorMessage,
} from "../network-errors.js";

// Test constants
const TEST_PORT = 8080;
const PRIVILEGED_PORT = 80;

describe("Network Error handling", () => {
  describe("NetworkError class", () => {
    test("should create a NetworkError with the correct properties", () => {
      const error = new NetworkError("Network test error", "TEST_CODE", TEST_PORT, "localhost");

      expect(error.message).toBe("Network test error");
      expect(error.code).toBe("TEST_CODE");
      expect(error.port).toBe(8080);
      expect(error.host).toBe("localhost");
      expect(error instanceof Error).toBe(true);
      expect(error.name).toBe("NetworkError");
    });
  });

  describe("PortInUseError class", () => {
    test("should create a PortInUseError with the correct message", () => {
      const error = new PortInUseError(TEST_PORT);

      expect(error.message).toBe(`Port ${TEST_PORT} is already in use.`);
      expect(error.code).toBe("EADDRINUSE");
      expect(error.port).toBe(TEST_PORT);
      expect(error.host).toBe("localhost");
    });

    test("should provide helpful suggestions", () => {
      const error = new PortInUseError(TEST_PORT);
      const suggestions = error.getSuggestions();

      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions[0]).toContain("Use a different port");
      expect(suggestions[1]).toContain(`Check what process is using port ${TEST_PORT}`);
    });
  });

  describe("NetworkPermissionError class", () => {
    test("should create a NetworkPermissionError with the correct message", () => {
      const error = new NetworkPermissionError(PRIVILEGED_PORT);

      expect(error.message).toContain("Permission denied");
      expect(error.code).toBe("EACCES");
      expect(error.port).toBe(PRIVILEGED_PORT);
    });

    test("should provide helpful suggestions", () => {
      const error = new NetworkPermissionError(PRIVILEGED_PORT);
      const suggestions = error.getSuggestions();

      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions[0]).toContain("Use a port number above 1024");
    });
  });

  describe("isNetworkError function", () => {
    test("should identify common network errors", () => {
      const eaddrinuseError = new Error("Address in use");
      (eaddrinuseError as any).code = "EADDRINUSE";

      const eaccessError = new Error("Permission denied");
      (eaccessError as any).code = "EACCES";

      const regularError = new Error("Regular error");

      expect(isNetworkError(eaddrinuseError)).toBe(true);
      expect(isNetworkError(eaccessError)).toBe(true);
      expect(isNetworkError(regularError)).toBe(false);
      expect(isNetworkError("not an error")).toBe(false);
    });
  });

  describe("createNetworkError function", () => {
    test("should create a PortInUseError for EADDRINUSE errors", () => {
      const originalError = new Error("Address in use");
      (originalError as any).code = "EADDRINUSE";

      const networkError = createNetworkError(originalError, TEST_PORT);

      expect(networkError instanceof PortInUseError).toBe(true);
      expect(networkError.message).toBe(`Port ${TEST_PORT} is already in use.`);
    });

    test("should create a NetworkPermissionError for EACCES errors", () => {
      const originalError = new Error("Permission denied");
      (originalError as any).code = "EACCES";

      const networkError = createNetworkError(originalError, PRIVILEGED_PORT);

      expect(networkError instanceof NetworkPermissionError).toBe(true);
      expect(networkError.message).toContain("Permission denied");
    });

    test("should create a generic NetworkError for other errors", () => {
      const originalError = new Error("Some other error");
      (originalError as any).code = "SOMETHING_ELSE";

      const networkError = createNetworkError(originalError, TEST_PORT);

      expect(networkError instanceof NetworkError).toBe(true);
      expect(networkError.message).toContain("Network error");
    });
  });

  describe("formatNetworkErrorMessage function", () => {
    test("should format a PortInUseError with suggestions", () => {
      const error = new PortInUseError(TEST_PORT);
      const message = formatNetworkErrorMessage(error);

      expect(message).toContain(`Port ${TEST_PORT} is already in use`);
      expect(message).toContain("Suggestions:");
      expect(message).toContain("Use a different port");
      expect(message).toContain("For detailed error information");
    });

    test("should not include the debug hint when debug is true", () => {
      const error = new PortInUseError(TEST_PORT);
      const message = formatNetworkErrorMessage(error, true);

      // Check that it doesn't contain the debug hint
      const hasDebugHint = message.includes("For detailed error information");
      expect(hasDebugHint).toBe(false);
    });
  });
});
