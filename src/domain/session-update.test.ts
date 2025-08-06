/**
 * Session Update Integration Tests
 *
 * NOTE: For testing the conditional logic (noStash, noPush, force),
 * see session-update-logic.test.ts which tests the extracted pure functions.
 *
 * These tests focus on basic validation and error handling that can be
 * tested without complex git operations.
 */
import { describe, test, expect } from "bun:test";
import { updateSessionFromParams } from "./session";
import { ValidationError, ResourceNotFoundError } from "../errors/index";
import { setupTestMocks } from "../utils/test-utils/mocking";
import { createMockGitService, createMockSessionProvider } from "../utils/test-utils/dependencies";

// Set up automatic mock cleanup
setupTestMocks();

describe("updateSessionFromParams - Basic Validation", () => {
  test("throws ValidationError when name is not provided", async () => {
    const mockEmptySessionProvider = createMockSessionProvider({
      listSessions: () => Promise.resolve([]), // No sessions available for auto-detection
    });

    const mockGitService = createMockGitService();

    await expect(
      updateSessionFromParams(
        {
          name: undefined as any, // Invalid input
          task: undefined,
          repo: undefined,
          noStash: false,
          noPush: false,
          force: false,
          skipConflictCheck: false,
          autoResolveDeleteConflicts: false,
          dryRun: false,
          skipIfAlreadyMerged: false,
        },
        {
          sessionDB: mockEmptySessionProvider,
          gitService: mockGitService,
          getCurrentSession: () => Promise.resolve(undefined),
        }
      )
    ).rejects.toThrow(ValidationError);
  });

  test("throws ResourceNotFoundError when session does not exist", async () => {
    const mockEmptySessionProvider = createMockSessionProvider({
      getSession: () => Promise.resolve(null), // Session not found
      listSessions: () => Promise.resolve([]), // No sessions
    });

    const mockGitService = createMockGitService();

    await expect(
      updateSessionFromParams(
        {
          name: "nonexistent-session",
          noStash: false,
          noPush: false,
          force: false,
          skipConflictCheck: false,
          autoResolveDeleteConflicts: false,
          dryRun: false,
          skipIfAlreadyMerged: false,
        },
        {
          sessionDB: mockEmptySessionProvider,
          gitService: mockGitService,
          getCurrentSession: () => Promise.resolve(undefined),
        }
      )
    ).rejects.toThrow(ResourceNotFoundError);
  });
});

// NOTE: For comprehensive testing of noStash, noPush, and force logic,
// see the focused unit tests in session-update-logic.test.ts
//
// Those tests verify:
// - shouldStashChanges(options, state) - when stashing should occur
// - shouldPushChanges(options) - when pushing should occur
// - shouldRestoreStash(options) - when stash restoration should occur
// - determineGitOperations(options, state) - overall operation planning
//
// This separation allows testing the business logic without complex git mocking.
