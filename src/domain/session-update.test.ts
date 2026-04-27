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
import { updateSessionImpl } from "./session/session-update-operations";
import { ValidationError, ResourceNotFoundError } from "../errors/index";
import { setupTestMocks } from "../utils/test-utils/mocking";
import { FakeGitService } from "./git/fake-git-service";
import { FakeSessionProvider } from "./session/fake-session-provider";

// Set up automatic mock cleanup
setupTestMocks();

describe("updateSessionImpl - Basic Validation", () => {
  test("throws ValidationError when sessionId is not provided", async () => {
    const mockEmptySessionProvider = new FakeSessionProvider();

    const mockGitService = new FakeGitService();

    await expect(
      updateSessionImpl(
        {
          sessionId: undefined,
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
    const mockEmptySessionProvider = new FakeSessionProvider();

    const mockGitService = new FakeGitService();

    await expect(
      updateSessionImpl(
        {
          sessionId: "nonexistent-session",
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
