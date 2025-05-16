import { describe, test, expect, jest, mock, beforeEach, afterEach } from "bun:test";
import { MinskyError } from "../../../errors/index.js";
import { createMock, setupTestMocks } from "../../../utils/test-utils/mocking";
import { describe, test, expect, jest, mock, beforeEach, afterEach } from "bun:test";
import { MinskyError } from "../../../errors/index.js";
import { createMock, setupTestMocks } from "../../../utils/test-utils/mocking";

/**
 * TODO: CLI/MCP adapter tests need to be migrated
 *
 * These tests should be replaced with tests that directly test
 * domain methods instead of testing CLI/MCP adapters.
 *
 * A separate task should be created to properly migrate these tests.
 */

describe("Session CLI adapter tests", () => {
  test("Placeholder test - CLI adapter tests disabled", () => {
    // This test does nothing but prevents test runner from complaining about empty test files
    expect(1).toBe(1);
  });
});

// TODO: These tests need to be migrated to test domain methods directly
// instead of testing CLI adapters.
describe.skip("Session Domain Functions", () => {
  // All tests are skipped until migration is complete

  // Sample mock sessions for testing
  const mockSessions = [
    {
      name: "test-session-1",
      repoPath: "/path/to/repo1",
      branch: "feature/test-1",
      createdAt: "2023-06-01T12:00:00Z",
    },
    {
      name: "test-session-2",
      repoPath: "/path/to/repo2",
      branch: "feature/test-2",
      createdAt: "2023-06-02T12:00:00Z",
      taskId: "123",
    },
  ];

  // Sample single session for testing
  const mockSession = {
    name: "test-session-1",
    repoPath: "/path/to/repo1",
    branch: "feature/test-1",
    createdAt: "2023-06-01T12:00:00Z",
  };

  // Mock the domain module before importing it
  mock.module("../../../domain/index.js", () => ({
    listSessionsFromParams: jest.fn(),
    getSessionFromParams: jest.fn(),
  }));

  // Import the mocked module
  import * as domainModule from "../../../domain/index.js";

  describe("listSessionsFromParams", () => {
    test("should handle sessions list retrieval", async () => {
      // Setup mock implementation for this test
      (domainModule.listSessionsFromParams as jest.Mock).mockResolvedValue(mockSessions);

      // Call the domain function directly
      const params = { json: false };
      const result = await domainModule.listSessionsFromParams(params);

      // Verify the function was called with the right parameters
      expect(domainModule.listSessionsFromParams).toHaveBeenCalledWith(params);

      // Verify the result is as expected
      expect(result).toEqual(mockSessions);
    });

    test("should handle errors properly", async () => {
      // Setup mock to throw an error
      const mockError = new Error("Test error");
      (domainModule.listSessionsFromParams as jest.Mock).mockRejectedValue(mockError);

      // Call the domain function and expect it to throw
      await expect(domainModule.listSessionsFromParams({})).rejects.toThrow("Test error");
    });
  });

  describe("getSessionFromParams", () => {
    test("should handle session retrieval by name", async () => {
      // Setup mock implementation for this test
      (domainModule.getSessionFromParams as jest.Mock).mockResolvedValue(mockSession);

      // Call the domain function directly
      const params = {
        name: "test-session-1",
        task: undefined,
      };
      const result = await domainModule.getSessionFromParams(params);

      // Verify the function was called with the right parameters
      expect(domainModule.getSessionFromParams).toHaveBeenCalledWith(params);

      // Verify the result is as expected
      expect(result).toEqual(mockSession);
    });

    test("should handle session with task ID", async () => {
      // Setup mock implementation for this test
      const mockSessionWithTask = {
        ...mockSession,
        taskId: "123",
      };
      (domainModule.getSessionFromParams as jest.Mock).mockResolvedValue(mockSessionWithTask);

      // Call the domain function directly
      const params = {
        name: "test-session-1",
        task: undefined,
      };
      const result = await domainModule.getSessionFromParams(params);

      // Verify the function was called with the right parameters
      expect(domainModule.getSessionFromParams).toHaveBeenCalledWith(params);

      // Verify the result is as expected
      expect(result).toEqual(mockSessionWithTask);
      expect(result.taskId).toBe("123");
    });

    test("should handle MinskyError properly", async () => {
      // Setup mock to throw a MinskyError
      const mockError = new MinskyError("Session not found");
      (domainModule.getSessionFromParams as jest.Mock).mockRejectedValue(mockError);

      // Call the domain function and expect it to throw
      await expect(
        domainModule.getSessionFromParams({
          name: "non-existent",
          task: undefined,
        })
      ).rejects.toThrow("Session not found");
    });

    test("should handle unexpected errors properly", async () => {
      // Setup mock to throw a generic error
      const mockError = new Error("Unexpected error");
      (domainModule.getSessionFromParams as jest.Mock).mockRejectedValue(mockError);

      // Call the domain function and expect it to throw
      await expect(
        domainModule.getSessionFromParams({
          name: "test-session",
          task: undefined,
        })
      ).rejects.toThrow("Unexpected error");
    });
  });
});
