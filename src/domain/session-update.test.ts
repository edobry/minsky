const TEST_VALUE = 123;

/**
 * Session Update Tests
 * @migrated Migrated to native Bun patterns
 * @refactored Uses project utilities instead of raw Bun APIs
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { updateSessionFromParams } from "../session.ts";
import { MinskyError, ValidationError, ResourceNotFoundError } from "../../errors/index.ts";
import { createMock, setupTestMocks } from "../../utils/test-utils/mocking.ts";
import { expectToBeInstanceOf, expectToHaveBeenCalled } from "../../utils/test-utils/assertions.ts";

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
      execInRepository: createMock(() => ""),
      stashChanges: createMock(() => Promise.resolve()),
      pullLatest: createMock(() => Promise.resolve()),
      mergeBranch: createMock(() => Promise.resolve({ conflicts: false })),
      push: createMock(() => Promise.resolve()),
      popStash: createMock(() => Promise.resolve()),
    };

    mockSessionProvider = {
      getSession: createMock(() =>
        Promise.resolve({
          _session: "test-session",
          repoName: "test-repo",
          repoUrl: "https://example.com/test-repo",
          _branch: "test-branch",
          createdAt: "2023-01-01",
          taskId: "TEST_VALUE",
        })
      ),
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
    mockSessionProvider.getSession.mockImplementation(() => Promise.resolve(null));

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
      { name: "test-session", noStash: false, noPush: false, force: false },
      {
        sessionDB: mockSessionProvider,
        gitService: mockGitService,
        getCurrentSession: mockGetCurrentSession,
      }
    );

    expect(_result).toEqual({
      _session: "test-session",
      repoName: "test-repo",
      repoUrl: "https://example.com/test-repo",
      _branch: "test-branch",
      createdAt: "2023-01-01",
      taskId: "TEST_VALUE",
      repoPath: "/mock/session/workdir",
    });

    expectToHaveBeenCalled(mockGitService.stashChanges);
    expectToHaveBeenCalled(mockGitService.pullLatest);
    expectToHaveBeenCalled(mockGitService.mergeBranch);
    expectToHaveBeenCalled(mockGitService.push);
    expectToHaveBeenCalled(mockGitService.popStash);
  });

  test("throws error when workspace is dirty and force is not set", async () => {
    // Mock dirty workspace
    mockGitService.execInRepository.mockImplementation(() => Promise.resolve("M file.txt"));

    try {
      await updateSessionFromParams(
        { name: "test-session", force: false, noStash: false, noPush: false },
        {
          sessionDB: mockSessionProvider,
          gitService: mockGitService,
          getCurrentSession: mockGetCurrentSession,
        }
      );
      throw new Error("Should have thrown an error");
    } catch (error: unknown) {
      expectToBeInstanceOf(error, MinskyError);
    }
  });

  test("updates session when workspace is dirty and force is set", async () => {
    // Mock dirty workspace
    mockGitService.execInRepository.mockImplementation(() => Promise.resolve("M file.txt"));

    const _result = await updateSessionFromParams(
      { name: "test-session", force: true, noStash: false, noPush: false },
      {
        sessionDB: mockSessionProvider,
        gitService: mockGitService,
        getCurrentSession: mockGetCurrentSession,
      }
    );

    expect(_result).toEqual({
      _session: "test-session",
      repoName: "test-repo",
      repoUrl: "https://example.com/test-repo",
      _branch: "test-branch",
      createdAt: "2023-01-01",
      taskId: "TEST_VALUE",
      repoPath: "/mock/session/workdir",
    });

    // Verify that the update proceeded despite dirty workspace
    expectToHaveBeenCalled(mockGitService.stashChanges);
    expectToHaveBeenCalled(mockGitService.pullLatest);
    expectToHaveBeenCalled(mockGitService.mergeBranch);
    expectToHaveBeenCalled(mockGitService.push);
  });

  test("skips stashing when noStash is true", async () => {
    await updateSessionFromParams(
      { name: "test-session", noStash: true, noPush: false, force: false },
      {
        sessionDB: mockSessionProvider,
        gitService: mockGitService,
        getCurrentSession: mockGetCurrentSession,
      }
    );

    expect(mockGitService.stashChanges.mock.calls.length).toBe(0);
    expect(mockGitService.popStash.mock.calls.length).toBe(0);
    expectToHaveBeenCalled(mockGitService.pullLatest);
    expectToHaveBeenCalled(mockGitService.mergeBranch);
    expectToHaveBeenCalled(mockGitService.push);
  });

  test("skips pushing when noPush is true", async () => {
    await updateSessionFromParams(
      { name: "test-session", noPush: true, noStash: false, force: false },
      {
        sessionDB: mockSessionProvider,
        gitService: mockGitService,
        getCurrentSession: mockGetCurrentSession,
      }
    );

    expectToHaveBeenCalled(mockGitService.stashChanges);
    expectToHaveBeenCalled(mockGitService.pullLatest);
    expectToHaveBeenCalled(mockGitService.mergeBranch);
    expect(mockGitService.push.mock.calls.length).toBe(0);
    expectToHaveBeenCalled(mockGitService.popStash);
  });

  test("throws error when merge conflicts are detected", async () => {
    mockGitService.mergeBranch.mockImplementation(() => Promise.resolve({ conflicts: true }));

    try {
      await updateSessionFromParams(
        { name: "test-session", noStash: false, noPush: false, force: false },
        {
          sessionDB: mockSessionProvider,
          gitService: mockGitService,
          getCurrentSession: mockGetCurrentSession,
        }
      );
      throw new Error("Should have thrown an error");
    } catch (error: unknown) {
      expectToBeInstanceOf(error, MinskyError);
    }
  });
});
