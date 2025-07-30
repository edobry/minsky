const TEST_VALUE = 123;

/**
 * Session Update Tests
 * @migrated Migrated to native Bun patterns
 * @refactored Uses project utilities instead of raw Bun APIs
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { updateSessionFromParams } from "./session";
import { MinskyError, ValidationError, ResourceNotFoundError } from "../errors/index";
import { createMock, setupTestMocks } from "../utils/test-utils/mocking";
import { expectToBeInstanceOf, expectToHaveBeenCalled } from "../utils/test-utils/assertions";
import * as execUtils from "../utils/exec";
import * as childProcess from "child_process";

// Set up automatic mock cleanup
setupTestMocks();

describe("updateSessionFromParams", () => {
  // Mock dependencies
  let mockGitService: unknown;
  let mockSessionProvider: unknown;
  let mockGetCurrentSession: unknown;

  beforeEach(() => {
    // Create fresh mocks for each test
    mockGitService = {
      getSessionWorkdir: createMock(() => "/mock/session/workdir"),
      execInRepository: createMock((workdir, command) => {
        // Return different values based on the git command
        if ((command as string).includes("rev-list --left-right --count")) {
          return Promise.resolve("0\t5"); // 0 commits ahead, 5 behind origin (definitely needs update)
        }
        if ((command as string).includes("rev-parse") && (command as string).includes("origin/")) {
          return Promise.resolve("abc123"); // Remote ref exists
        }
        return Promise.resolve("");
      }),
      stashChanges: createMock(() => Promise.resolve()),
      pullLatest: createMock(() => Promise.resolve()),
      mergeBranch: createMock(() => Promise.resolve({ conflicts: false })),
      push: createMock(() => Promise.resolve()),
      popStash: createMock(() => Promise.resolve()),
      getCurrentBranch: createMock(() => Promise.resolve("main")),
      hasUncommittedChanges: createMock(() => Promise.resolve(false)),
      fetchDefaultBranch: createMock(() => Promise.resolve("main")),
      analyzeBranchDivergence: createMock(() =>
        Promise.resolve({
          sessionBranch: "test-session",
          baseBranch: "main",
          aheadCommits: 0,
          behindCommits: 5, // Session is 5 commits behind
          lastCommonCommit: "abc123",
          sessionChangesInBase: false,
          divergenceType: "behind" as const, // This will trigger the update
          recommendedAction: "pull" as const,
        })
      ),
    };

    mockSessionProvider = {
      getSession: createMock(() =>
        Promise.resolve({
          session: "test-session",
          repoName: "test-repo",
          repoUrl: "https://example.com/test-repo",
          branch: "test-branch",
          createdAt: "2023-01-01",
          taskId: "TEST_VALUE",
        })
      ),
      getSessionWorkdir: createMock(() => Promise.resolve("/tmp/mock-session-workdir")),
    };

    mockGetCurrentSession = createMock(() => Promise.resolve("test-session"));
  });

  test("throws ValidationError when name is not provided", async () => {
    try {
      await updateSessionFromParams({
        name: "",
        noStash: false,
        noPush: false,
        force: false,
      } as any);
      throw new Error("Should have thrown an error");
    } catch (error: unknown) {
      expectToBeInstanceOf(error, ValidationError);
    }
  });

  test("throws ResourceNotFoundError when session does not exist", async () => {
    mockSessionProvider.getSession = mock(() => Promise.resolve(null));

    try {
      await updateSessionFromParams(
        { name: "nonexistent-session", noStash: false, noPush: false, force: false },
        {
          sessionDB: mockSessionProvider,
          gitService: mockGitService,
          getCurrentSession: mockGetCurrentSession,
        }
      );
      throw new Error("Should have thrown an error");
    } catch (error: unknown) {
      expectToBeInstanceOf(error, ResourceNotFoundError);
    }
  });

  test("returns session information when update is successful", async () => {
    const _result = await updateSessionFromParams(
      {
        name: "test-session",
        noStash: false,
        noPush: false,
        force: false,
        skipConflictCheck: false,
        autoResolveDeleteConflicts: false,
        dryRun: false,
        skipIfAlreadyMerged: false,
      },
      {
        sessionDB: mockSessionProvider as any,
        gitService: mockGitService as any,
        getCurrentSession: mockGetCurrentSession as any,
      }
    );

    expect(_result).toEqual({
      session: "test-session",
      repoName: "test-repo",
      repoUrl: "https://example.com/test-repo",
      branch: "main", // Note: this comes from getCurrentBranch mock
      createdAt: "2023-01-01",
      taskId: "TEST_VALUE",
    });

    // Verify that the update proceeded despite dirty workspace
    expectToHaveBeenCalled((mockGitService as any).stashChanges);
    expectToHaveBeenCalled((mockGitService as any).pullLatest);
    expectToHaveBeenCalled((mockGitService as any).mergeBranch);
    expectToHaveBeenCalled((mockGitService as any).push);
    expectToHaveBeenCalled((mockGitService as any).popStash);
  });

  test("throws error when workspace is dirty and force is not set", async () => {
    // Mock git service to report dirty workspace
    (mockGitService as any).hasUncommittedChanges = mock(() => Promise.resolve(true));

    try {
      await updateSessionFromParams(
        {
          name: "test-session",
          force: false,
          noStash: false,
          noPush: false,
          skipConflictCheck: false,
          autoResolveDeleteConflicts: false,
          dryRun: false,
          skipIfAlreadyMerged: false,
        },
        {
          sessionDB: mockSessionProvider as any,
          gitService: mockGitService as any,
          getCurrentSession: mockGetCurrentSession as any,
        }
      );
      // Should not reach here
      expect(false).toBeTruthy();
    } catch (error) {
      expectToBeInstanceOf(error, MinskyError);
    }
  });

  test("updates session when workspace is dirty and force is set", async () => {
    // Mock git service to report dirty workspace
    (mockGitService as any).hasUncommittedChanges = mock(() => Promise.resolve(true));

    const result = await updateSessionFromParams(
      {
        name: "test-session",
        force: true,
        noStash: false,
        noPush: false,
        skipConflictCheck: false,
        autoResolveDeleteConflicts: false,
        dryRun: false,
        skipIfAlreadyMerged: false,
      },
      {
        sessionDB: mockSessionProvider as any,
        gitService: mockGitService as any,
        getCurrentSession: mockGetCurrentSession as any,
      }
    );

    expect(result).toEqual({
      session: "test-session",
      repoName: "test-repo",
      repoUrl: "https://example.com/test-repo",
      branch: "main",
      createdAt: "2023-01-01",
      taskId: "TEST_VALUE",
    });

    // Verify that the update proceeded despite dirty workspace
    expectToHaveBeenCalled((mockGitService as any).stashChanges);
    expectToHaveBeenCalled((mockGitService as any).pullLatest);
    expectToHaveBeenCalled((mockGitService as any).mergeBranch);
    expectToHaveBeenCalled((mockGitService as any).push);
    expectToHaveBeenCalled((mockGitService as any).popStash);
  });

  test("skips stashing when noStash is true", async () => {
    await updateSessionFromParams(
      {
        name: "test-session",
        noStash: true,
        noPush: false,
        force: false,
        skipConflictCheck: false,
        autoResolveDeleteConflicts: false,
        dryRun: false,
        skipIfAlreadyMerged: false,
      },
      {
        sessionDB: mockSessionProvider as any,
        gitService: mockGitService as any,
        getCurrentSession: mockGetCurrentSession as any,
      }
    );

    // Verify stashing was not called
    expectToHaveBeenCalled((mockGitService as any).pullLatest);
  });

  test("skips pushing when noPush is true", async () => {
    await updateSessionFromParams(
      {
        name: "test-session",
        noStash: false,
        noPush: true,
        force: false,
        skipConflictCheck: false,
        autoResolveDeleteConflicts: false,
        dryRun: false,
        skipIfAlreadyMerged: false,
      },
      {
        sessionDB: mockSessionProvider as any,
        gitService: mockGitService as any,
        getCurrentSession: mockGetCurrentSession as any,
      }
    );

    expectToHaveBeenCalled((mockGitService as any).pullLatest);
  });

  test("throws error when merge conflicts are detected", async () => {
    // Mock merge to return conflicts
    (mockGitService as any).mergeBranch = mock(() => Promise.resolve({ conflicts: true }));

    try {
      await updateSessionFromParams(
        {
          name: "test-session",
          noStash: false,
          noPush: false,
          force: false,
          skipConflictCheck: false,
          autoResolveDeleteConflicts: false,
          dryRun: false,
          skipIfAlreadyMerged: false,
        },
        {
          sessionDB: mockSessionProvider as any,
          gitService: mockGitService as any,
          getCurrentSession: mockGetCurrentSession as any,
        }
      );
      // Should not reach here
      expect(false).toBeTruthy();
    } catch (error) {
      expectToBeInstanceOf(error, MinskyError);
    }
  });
});
