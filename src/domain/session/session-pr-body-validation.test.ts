/**
 * SESSION PR BODY VALIDATION TESTS
 *
 * What this file tests:
 * - Session PR body validation requirements
 * - Validation errors for missing PR descriptions
 * - Business rule enforcement for PR creation
 * - Session PR parameter validation edge cases
 *
 * Key functionality tested:
 * - Required body/bodyPath validation for new PRs
 * - ValidationError throwing for missing PR descriptions
 * - Session PR business rule enforcement
 * - Bug fix verification for PR validation logic
 *
 * NOTE: This tests PR validation, not PR creation workflow (see other session tests)
 */

import { describe, test, expect } from "bun:test";
import { sessionPrImpl } from "./session-pr-operations";
import { ValidationError } from "../errors";
import {
  createMockGitService,
  createMockSessionProvider,
  createMockTaskService,
} from "../../utils/test-utils/dependencies";
import { MinskyError } from "../../errors";

/**
 * Session PR Body Validation Bug Fix Tests
 *
 * These tests verify that PR validation properly checks for required body content.
 * Previously, the session PR command would proceed without validating that
 * a PR description was provided, leading to PRs being created without proper descriptions.
 *
 * This test ensures that ValidationError is thrown when:
 * - Creating a new PR without --body or --body-path
 * - The validation happens BEFORE any git operations
 */

describe("Session PR Body Validation Bug Fix", () => {
  test("should throw ValidationError for new PR without body", async () => {
    // Arrange: Set up minimal mocks for dependencies
    const mockGitService = createMockGitService({
      getCurrentBranch: () => Promise.resolve("main"),
    });

    const mockSessionProvider = createMockSessionProvider({
      getSession: () =>
        Promise.resolve({
          session: "test-session",
          repoName: "test-repo",
          repoUrl: "/test/repo",
          taskId: "123",
          createdAt: new Date().toISOString(),
        }),
      // Also provide getSessionByTaskId and listSessions for comprehensive coverage
      getSessionByTaskId: () =>
        Promise.resolve({
          session: "test-session",
          repoName: "test-repo",
          repoUrl: "/test/repo",
          taskId: "123",
          createdAt: new Date().toISOString(),
        }),
      listSessions: () =>
        Promise.resolve([
          {
            session: "test-session",
            repoName: "test-repo",
            repoUrl: "/test/repo",
            taskId: "123",
            createdAt: new Date().toISOString(),
          },
        ]),
    });

    const mockTaskService = createMockTaskService({
      getTask: () =>
        Promise.resolve({
          id: "#123",
          title: "Test Task",
          status: "TODO",
        }),
    });

    try {
      // Act: Try to create PR without body (should fail validation)
      await sessionPrImpl(
        {
          session: "test-session",
          title: "Test PR",
          // No body or bodyPath provided - this should trigger ValidationError
          debug: false,
          noStatusUpdate: false,
          skipUpdate: true,
          autoResolveDeleteConflicts: false,
          skipConflictCheck: false,
        },
        {
          gitService: mockGitService,
          sessionDB: mockSessionProvider,
        }
      );

      // If we get here, the bug still exists (no error thrown)
      throw new Error("Expected ValidationError for new PR without body, but none was thrown");
    } catch (error) {
      // After our fix, this should be a ValidationError about missing body
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).message).toContain("PR description is required");
    }
  });
});
