import { describe, it, expect, beforeEach, mock } from "bun:test";
import { approveSessionImpl } from "./session-approve-operations";
import type { SessionProviderInterface } from "./session-db-adapter";
import type { GitServiceInterface } from "../git";
import type { SessionRecord } from "./types";
import type { RepositoryBackend, MergeInfo } from "../repository/index";

describe("Session Approval Repository Backend Bug", () => {
  let mockSessionDB: SessionProviderInterface;
  let mockGitService: GitServiceInterface;
  let mockRepositoryBackend: RepositoryBackend;
  let mockCreateRepositoryBackend: any;
  let mockTaskService: any;

  beforeEach(() => {
    mockSessionDB = {
      getSession: mock(() => Promise.resolve(null)),
      getSessionByTaskId: mock(() => Promise.resolve(null)),
    } as any;

    mockGitService = {
      execInRepository: mock(() => Promise.resolve("")),
    } as any;

    mockRepositoryBackend = {
      getType: mock(() => "local"),
      mergePullRequest: mock(() =>
        Promise.resolve({
          commitHash: "abc123",
          mergeDate: "2025-07-30T23:14:24.213Z",
          mergedBy: "Test User",
        })
      ),
    } as any;

    mockTaskService = {
      getTask: mock(() => Promise.resolve({ id: "test", title: "Test Task" })),
      setTaskStatus: mock(() => Promise.resolve()),
      getTaskStatus: mock(() => Promise.resolve("TODO")),
    };

    // Mock createRepositoryBackend to return our mock backend
    mockCreateRepositoryBackend = mock(() => Promise.resolve(mockRepositoryBackend));
  });

  /**
   * BUG: Session approval incorrectly re-detects repository backend type
   * instead of using the session's stored repository configuration.
   *
   * Steps to reproduce:
   * 1. Session is created with LOCAL repository configuration
   * 2. Session approval is called for that session
   * 3. Instead of using session's LOCAL config, it re-detects backend from git remote
   * 4. This causes wrong backend type to be used (GitHub instead of LOCAL)
   */
  it("should use session's stored repository configuration instead of re-detecting backend type", async () => {
    // Arrange: Session was created with LOCAL repository configuration
    const localSessionRecord: SessionRecord = {
      session: "task335",
      repoName: "local-minsky",
      repoUrl: "/Users/edobry/Projects/minsky", // LOCAL path, not GitHub URL
      createdAt: "2025-07-30T23:14:24.213Z",
      taskId: "335",
      branch: "task335",
      // Note: no backendType set, which should default to LOCAL based on repoUrl
    };

    // Configure mock session database
    mockSessionDB.getSessionByTaskId = mock(() => Promise.resolve(localSessionRecord));
    mockSessionDB.getSession = mock(() => Promise.resolve(localSessionRecord));

    // Configure mock repository backend for LOCAL type
    mockRepositoryBackend.getType = mock(() => "local");
    mockRepositoryBackend.mergePullRequest = mock(() =>
      Promise.resolve({
        commitHash: "abc123def456",
        mergeDate: "2025-07-30T23:14:24.213Z",
        mergedBy: "John Doe",
      })
    );

    // Track the arguments passed to repository backend creation
    let capturedSessionRecord: SessionRecord | undefined;
    const mockCreateRepositoryBackendFromSession = mock((sessionRecord: SessionRecord) => {
      capturedSessionRecord = sessionRecord;
      return Promise.resolve(mockRepositoryBackend);
    });

    // Act: Approve session for task 335
    const result = await approveSessionImpl(
      { task: "335" },
      {
        sessionDB: mockSessionDB,
        gitService: mockGitService,
        taskService: mockTaskService,
        createRepositoryBackend: mockCreateRepositoryBackendFromSession,
      }
    );

    // Assert: Should use session's LOCAL repository configuration
    expect(result.session).toBe("task335");
    expect(result.prBranch).toBe("pr/task335");

    // Verify repository backend was created with session's configuration
    expect(mockCreateRepositoryBackendFromSession).toHaveBeenCalledTimes(1);
    expect(capturedSessionRecord).toEqual(localSessionRecord);

    // Verify LOCAL backend's mergePullRequest was called
    expect(mockRepositoryBackend.mergePullRequest).toHaveBeenCalledWith(
      "pr/task335", // PR branch name for LOCAL backend
      "task335" // Session name
    );

    // Verify it used LOCAL backend (not GitHub)
    expect(mockRepositoryBackend.getType).toHaveBeenCalled();
  });

  it("should respect session's GitHub backend configuration when explicitly set", async () => {
    // Arrange: Session explicitly configured for GitHub backend
    const githubSessionRecord: SessionRecord = {
      session: "task336",
      repoName: "github-minsky",
      repoUrl: "https://github.com/edobry/minsky.git",
      createdAt: "2025-07-30T23:14:24.213Z",
      taskId: "336",
      branch: "task336",
      backendType: "github", // Explicitly set to GitHub
      github: {
        owner: "edobry",
        repo: "minsky",
      },
    };

    // Configure mock session database
    mockSessionDB.getSessionByTaskId = mock(() => Promise.resolve(githubSessionRecord));
    mockSessionDB.getSession = mock(() => Promise.resolve(githubSessionRecord));

    // Configure mock repository backend for GitHub type
    mockRepositoryBackend.getType = mock(() => "github");
    mockRepositoryBackend.mergePullRequest = mock(() =>
      Promise.resolve({
        commitHash: "abc123def456",
        mergeDate: "2025-07-30T23:14:24.213Z",
        mergedBy: "GitHub Merge",
      })
    );

    // Track the arguments passed to repository backend creation
    let capturedSessionRecord: SessionRecord | undefined;
    const mockCreateRepositoryBackendFromSession = mock((sessionRecord: SessionRecord) => {
      capturedSessionRecord = sessionRecord;
      return Promise.resolve(mockRepositoryBackend);
    });

    // Act: Approve session for task 336
    const result = await approveSessionImpl(
      { task: "336" },
      {
        sessionDB: mockSessionDB,
        gitService: mockGitService,
        taskService: mockTaskService,
        createRepositoryBackend: mockCreateRepositoryBackendFromSession,
      }
    );

    // Assert: Should use session's GitHub repository configuration
    expect(result.session).toBe("task336");

    // Verify repository backend was created with session's configuration
    expect(mockCreateRepositoryBackendFromSession).toHaveBeenCalledTimes(1);
    expect(capturedSessionRecord).toEqual(githubSessionRecord);

    // Verify GitHub backend's mergePullRequest was called
    expect(mockRepositoryBackend.mergePullRequest).toHaveBeenCalledWith(
      "pr/task336", // PR branch name (will need actual PR number in real implementation)
      "task336" // Session name
    );
  });
});
