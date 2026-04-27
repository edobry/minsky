import { describe, it, expect, beforeEach, mock } from "bun:test";
import { approveSessionImpl } from "./session-approve-operations";
import type { SessionRecord } from "./types";
import type { RepositoryBackend } from "../repository/index";
import { FakeSessionProvider } from "./fake-session-provider";
import { FakeGitService } from "../git/fake-git-service";
import { FakeTaskService } from "../tasks/fake-task-service";

describe("Session Approval Repository Backend Bug", () => {
  let mockSessionDB: FakeSessionProvider;
  let mockGitService: FakeGitService;
  let mockRepositoryBackend: RepositoryBackend;
  let _mockCreateRepositoryBackend: ReturnType<typeof mock>;
  let mockTaskService: FakeTaskService;

  beforeEach(() => {
    mockSessionDB = new FakeSessionProvider();
    mockGitService = new FakeGitService();

    mockRepositoryBackend = {
      getType: mock(() => "local"),
      pr: {
        merge: mock(() =>
          Promise.resolve({
            commitHash: "abc123",
            mergeDate: "2025-07-30T23:14:24.213Z",
            mergedBy: "Test User",
          })
        ),
      },
    } as unknown as RepositoryBackend;

    mockTaskService = new FakeTaskService();
    mockTaskService.getTask = mock(() =>
      Promise.resolve({ id: "test", title: "Test Task", status: "TODO" })
    ) as any;
    mockTaskService.setTaskStatus = mock(() => Promise.resolve()) as any;
    mockTaskService.getTaskStatus = mock(() => Promise.resolve("TODO")) as any;

    // Mock createRepositoryBackend to return our mock backend
    _mockCreateRepositoryBackend = mock(() => Promise.resolve(mockRepositoryBackend));
  });

  it("should use session's stored repository configuration for GitHub backend", async () => {
    // Arrange: Session created with GitHub repository configuration
    const githubSessionRecord: SessionRecord = {
      sessionId: "task335",
      repoName: "github-minsky",
      repoUrl: "https://github.com/edobry/minsky.git",
      createdAt: "2025-07-30T23:14:24.213Z",
      taskId: "md#335",
      backendType: "github",
    };

    // Configure fake session database
    mockSessionDB = new FakeSessionProvider({ initialSessions: [githubSessionRecord] });

    // Configure mock repository backend for GitHub type
    mockRepositoryBackend.getType = mock(() => "github");
    (mockRepositoryBackend.pr as any).merge = mock(() =>
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
      { task: "md#335" },
      {
        sessionDB: mockSessionDB,
        gitService: mockGitService,
        taskService: mockTaskService,
        createRepositoryBackend: mockCreateRepositoryBackendFromSession,
      }
    );

    // Assert: Should use session's GitHub repository configuration
    expect(result.session).toBe("task335");

    // Verify repository backend was created with session's configuration
    expect(mockCreateRepositoryBackendFromSession).toHaveBeenCalledTimes(1);
    expect(capturedSessionRecord).toEqual(githubSessionRecord);

    // Verify GitHub backend's mergePullRequest was called
    expect(mockRepositoryBackend.pr.merge).toHaveBeenCalledWith(
      "task335", // For GitHub backend, session ID is used as PR identifier
      "task335" // Session ID
    );
  });

  it("should respect session's GitHub backend configuration when explicitly set", async () => {
    // Arrange: Session explicitly configured for GitHub backend
    const githubSessionRecord: SessionRecord = {
      sessionId: "task336",
      repoName: "github-minsky",
      repoUrl: "https://github.com/edobry/minsky.git",
      createdAt: "2025-07-30T23:14:24.213Z",
      taskId: "md#336",
      // branch removed from persistent schema; tests should not rely on it
      backendType: "github", // Explicitly set to GitHub
      github: {
        owner: "edobry",
        repo: "minsky",
      },
    };

    // Configure fake session database
    mockSessionDB = new FakeSessionProvider({ initialSessions: [githubSessionRecord] });

    // Configure mock repository backend for GitHub type
    mockRepositoryBackend.getType = mock(() => "github");
    (mockRepositoryBackend.pr as any).merge = mock(() =>
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
      { task: "md#336" },
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
    expect(mockRepositoryBackend.pr.merge).toHaveBeenCalledWith(
      "task336", // For GitHub backend, session ID is used as PR identifier
      "task336" // Session ID
    );
  });
});
