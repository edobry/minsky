import { describe, test, expect, beforeEach, mock } from "bun:test";
import { updateSessionFromParams } from "../session.js";
import { MinskyError, ValidationError, ResourceNotFoundError } from "../../errors/index.js";

// Mock dependencies
const mockGitService = {
  getSessionWorkdir: mock(() => "/mock/session/workdir"),
  execInRepository: mock(() => ""),
  stashChanges: mock(() => Promise.resolve()),
  pullLatest: mock(() => Promise.resolve()),
  mergeBranch: mock(() => Promise.resolve({ conflicts: false })),
  push: mock(() => Promise.resolve()),
  popStash: mock(() => Promise.resolve()),
};

const mockSessionProvider = {
  getSession: mock(() => Promise.resolve({
    session: "test-session",
    repoName: "test-repo",
    repoUrl: "https://example.com/test-repo",
    branch: "test-branch",
    createdAt: "2023-01-01",
    taskId: "123"
  })),
};

const mockGetCurrentSession = mock(() => Promise.resolve("test-session"));

describe("updateSessionFromParams", () => {
  beforeEach(() => {
    // Reset all mocks
    mockGitService.getSessionWorkdir.mockClear();
    mockGitService.execInRepository.mockClear();
    mockGitService.stashChanges.mockClear();
    mockGitService.pullLatest.mockClear();
    mockGitService.mergeBranch.mockClear();
    mockGitService.push.mockClear();
    mockGitService.popStash.mockClear();
    mockSessionProvider.getSession.mockClear();
    mockGetCurrentSession.mockClear();
  });

  test("throws ValidationError when name is not provided", async () => {
    await expect(updateSessionFromParams({} as any)).rejects.toBeInstanceOf(ValidationError);
  });

  test("throws ResourceNotFoundError when session does not exist", async () => {
    mockSessionProvider.getSession.mockImplementationOnce(() => Promise.resolve(null));

    await expect(
      updateSessionFromParams(
        { name: "nonexistent-session" },
        {
          sessionDB: mockSessionProvider,
          gitService: mockGitService,
          getCurrentSession: mockGetCurrentSession,
        }
      )
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  test("returns session information when update is successful", async () => {
    const result = await updateSessionFromParams(
      { name: "test-session" },
      {
        sessionDB: mockSessionProvider,
        gitService: mockGitService,
        getCurrentSession: mockGetCurrentSession,
      }
    );

    expect(result).toEqual({
      session: "test-session",
      repoName: "test-repo",
      repoUrl: "https://example.com/test-repo",
      branch: "test-branch",
      createdAt: "2023-01-01",
      taskId: "123",
      repoPath: "/mock/session/workdir",
    });

    expect(mockGitService.stashChanges).toHaveBeenCalledTimes(1);
    expect(mockGitService.pullLatest).toHaveBeenCalledTimes(1);
    expect(mockGitService.mergeBranch).toHaveBeenCalledTimes(1);
    expect(mockGitService.push).toHaveBeenCalledTimes(1);
    expect(mockGitService.popStash).toHaveBeenCalledTimes(1);
  });

  test("throws error when workspace is dirty and force is not set", async () => {
    // Mock dirty workspace
    mockGitService.execInRepository.mockImplementationOnce(() => Promise.resolve("M file.txt"));

    await expect(
      updateSessionFromParams(
        { name: "test-session", force: false },
        {
          sessionDB: mockSessionProvider,
          gitService: mockGitService,
          getCurrentSession: mockGetCurrentSession,
        }
      )
    ).rejects.toBeInstanceOf(MinskyError);
  });

  test("updates session when workspace is dirty and force is set", async () => {
    // Mock dirty workspace
    mockGitService.execInRepository.mockImplementationOnce(() => Promise.resolve("M file.txt"));

    const result = await updateSessionFromParams(
      { name: "test-session", force: true },
      {
        sessionDB: mockSessionProvider,
        gitService: mockGitService,
        getCurrentSession: mockGetCurrentSession,
      }
    );

    expect(result).toEqual({
      session: "test-session",
      repoName: "test-repo",
      repoUrl: "https://example.com/test-repo",
      branch: "test-branch",
      createdAt: "2023-01-01",
      taskId: "123",
      repoPath: "/mock/session/workdir",
    });

    // Verify that the update proceeded despite dirty workspace
    expect(mockGitService.stashChanges).toHaveBeenCalledTimes(1);
    expect(mockGitService.pullLatest).toHaveBeenCalledTimes(1);
    expect(mockGitService.mergeBranch).toHaveBeenCalledTimes(1);
    expect(mockGitService.push).toHaveBeenCalledTimes(1);
  });

  test("skips stashing when noStash is true", async () => {
    await updateSessionFromParams(
      { name: "test-session", noStash: true },
      {
        sessionDB: mockSessionProvider,
        gitService: mockGitService,
        getCurrentSession: mockGetCurrentSession,
      }
    );

    expect(mockGitService.stashChanges).toHaveBeenCalledTimes(0);
    expect(mockGitService.popStash).toHaveBeenCalledTimes(0);
    expect(mockGitService.pullLatest).toHaveBeenCalledTimes(1);
    expect(mockGitService.mergeBranch).toHaveBeenCalledTimes(1);
    expect(mockGitService.push).toHaveBeenCalledTimes(1);
  });

  test("skips pushing when noPush is true", async () => {
    await updateSessionFromParams(
      { name: "test-session", noPush: true },
      {
        sessionDB: mockSessionProvider,
        gitService: mockGitService,
        getCurrentSession: mockGetCurrentSession,
      }
    );

    expect(mockGitService.stashChanges).toHaveBeenCalledTimes(1);
    expect(mockGitService.pullLatest).toHaveBeenCalledTimes(1);
    expect(mockGitService.mergeBranch).toHaveBeenCalledTimes(1);
    expect(mockGitService.push).toHaveBeenCalledTimes(0);
    expect(mockGitService.popStash).toHaveBeenCalledTimes(1);
  });

  test("throws error when merge conflicts are detected", async () => {
    mockGitService.mergeBranch.mockImplementationOnce(() => Promise.resolve({ conflicts: true }));

    await expect(
      updateSessionFromParams(
        { name: "test-session" },
        {
          sessionDB: mockSessionProvider,
          gitService: mockGitService,
          getCurrentSession: mockGetCurrentSession,
        }
      )
    ).rejects.toBeInstanceOf(MinskyError);
  });
}); 
