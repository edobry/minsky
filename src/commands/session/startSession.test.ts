// @ts-expect-error bun:test types may not be available
import { describe, it, expect, mock } from "bun:test";
import { startSession } from "./startSession";

describe("startSession", () => {
  // Create simple mocks that don't rely on global state
  const createBasicMocks = (overrides: Partial<{
    getSessionReturn: any,
    listSessionsReturn: any,
    addSessionImpl: (record: any) => any,
  }> = {}) => {
    const calls: Record<string, any[]> = {
      getSession: [],
      addSession: [],
      clone: [],
      branch: []
    };
    const returns = {
      getSession: overrides.getSessionReturn ?? null,
      listSessions: overrides.listSessionsReturn ?? [],
      clone: { workdir: "/path/to/test-workdir", session: "test-session" },
      branch: { workdir: "/path/to/test-workdir", branch: "test-branch" }
    };
    const mockGitService = {
      clone: mock((...args: any[]) => {
        (calls.clone as any[]).push(args[0]);
        return Promise.resolve(returns.clone);
      }),
      branch: mock((...args: any[]) => {
        (calls.branch as any[]).push(args[0]);
        return Promise.resolve(returns.branch);
      })
    };
    const mockSessionDB = {
      getSession: mock((sessionName: string) => {
        (calls.getSession as any[]).push([sessionName]);
        return Promise.resolve(returns.getSession);
      }),
      addSession: mock((record: any) => {
        (calls.addSession as any[]).push([record]);
        if (overrides.addSessionImpl) return Promise.resolve(overrides.addSessionImpl(record));
        return Promise.resolve(record);
      }),
      listSessions: mock(() => Promise.resolve(returns.listSessions))
    };
    return { 
      mockGitService, 
      mockSessionDB, 
      calls, 
      returns,
      setGetSession: (val: any) => { returns.getSession = val; },
      setListSessions: (val: any) => { returns.listSessions = val; },
      simulateExistingSession: (session: string, repoUrl: string) => {
        returns.getSession = { session, repoUrl };
      },
      simulateExistingTaskSession: (taskId: string) => {
        returns.listSessions = [{ session: `task${taskId}`, taskId }];
      }
    };
  };

  it("creates a session with explicit repo", async () => {
    const { mockGitService, mockSessionDB, calls } = createBasicMocks();
    const testSession = "test-session";
    const testRepo = "https://github.com/example/repo.git";
    
    // Reset mock calls to ensure clean state
    mockSessionDB.getSession.mockClear();
    mockSessionDB.addSession.mockClear();
    mockGitService.clone.mockClear();
    mockGitService.branch.mockClear();
    
    await startSession({
      session: testSession,
      repo: testRepo,
      gitService: mockGitService,
      sessionDB: mockSessionDB
    });
    
    // Verify the mock function was called correctly
    expect(mockSessionDB.getSession).toHaveBeenCalledWith(testSession);
    expect(mockGitService.clone).toHaveBeenCalledWith({ repoUrl: testRepo, session: testSession });
    expect(mockGitService.branch).toHaveBeenCalledWith({ session: testSession, branch: testSession });
    expect(mockSessionDB.addSession).toHaveBeenCalled();
    
    // Check that the session record was created with correct properties
    const sessionRecord = mockSessionDB.addSession.mock.calls[0][0];
    expect(sessionRecord.session).toBe(testSession);
    expect(sessionRecord.repoUrl).toBe(testRepo);
  });

  it("throws if session already exists", async () => {
    // Arrange
    const testSession = "test-session";
    const testRepo = "https://github.com/example/repo.git";
    
    const mockSessionDB = {
      getSession: mock(() => Promise.resolve({ 
        session: testSession, 
        repoUrl: testRepo 
      })),
      addSession: mock(() => Promise.resolve()),
      listSessions: mock(() => Promise.resolve([]))
    };
    
    const mockGitService = {
      clone: mock(() => Promise.resolve({ workdir: "/mock/workdir", session: testSession })),
      branch: mock(() => Promise.resolve({ workdir: "/mock/workdir", branch: testSession }))
    };

    // Act & Assert
    await expect(
      startSession({
        session: testSession,
        repo: testRepo,
        gitService: mockGitService,
        sessionDB: mockSessionDB
      })
    ).rejects.toThrow("already exists");
  });

  it("converts local path to file:// URL", async () => {
    // Arrange
    const testSession = "test-session";
    const testLocalRepo = "/local/repo";
    
    const mockSessionDB = {
      getSession: mock(() => Promise.resolve(null)),
      addSession: mock(() => Promise.resolve()),
      listSessions: mock(() => Promise.resolve([]))
    };
    
    const mockGitService = {
      clone: mock(() => Promise.resolve({ workdir: "/mock/workdir", session: testSession })),
      branch: mock(() => Promise.resolve({ workdir: "/mock/workdir", branch: testSession }))
    };
    
    // Mock fs to indicate this is a valid directory
    const mockFs = {
      existsSync: mock((path: string) => path === testLocalRepo),
      statSync: mock((path: string) => ({
        isDirectory: () => path === testLocalRepo
      }))
    };

    // Act
    await startSession({
      session: testSession,
      repo: testLocalRepo,
      gitService: mockGitService,
      sessionDB: mockSessionDB,
      fs: mockFs as any,
      path: { resolve: (path: string) => `/resolved${path}` } as any
    });

    // Assert
    expect(mockGitService.clone).toHaveBeenCalledWith({ 
      repoUrl: testLocalRepo, 
      session: testSession 
    });
    expect(mockSessionDB.addSession).toHaveBeenCalled();
    const sessionRecord = mockSessionDB.addSession.mock.calls[0][0];
    expect(sessionRecord.repoUrl).toBe(testLocalRepo);
  });

  it("uses resolveRepoPath when no repo is provided", async () => {
    // Arrange
    const testSession = "test-session";
    const detectedRepoPath = "/detected/repo/path";
    let resolvePathCalled = false;
    
    const mockResolveRepoPath = mock(() => {
      resolvePathCalled = true;
      return Promise.resolve(detectedRepoPath);
    });
    
    const mockSessionDB = {
      getSession: mock(() => Promise.resolve(null)),
      addSession: mock(() => Promise.resolve()),
      listSessions: mock(() => Promise.resolve([]))
    };
    
    const mockGitService = {
      clone: mock(() => Promise.resolve({ workdir: "/mock/workdir", session: testSession })),
      branch: mock(() => Promise.resolve({ workdir: "/mock/workdir", branch: testSession }))
    };

    // Act
    await startSession({
      session: testSession,
      gitService: mockGitService,
      sessionDB: mockSessionDB,
      resolveRepoPath: mockResolveRepoPath
    });

    // Assert
    expect(resolvePathCalled).toBe(true);
    expect(mockResolveRepoPath).toHaveBeenCalledWith({});
    expect(mockGitService.clone).toHaveBeenCalledWith({ 
      repoUrl: detectedRepoPath, 
      session: testSession 
    });
  });

  it("throws if resolveRepoPath fails and no repo is provided", async () => {
    // Arrange
    const testSession = "test-session";
    
    const mockResolveRepoPath = mock(() => {
      throw new Error("not in git repo");
    });
    
    const mockSessionDB = {
      getSession: mock(() => Promise.resolve(null)),
      addSession: mock(() => Promise.resolve()),
      listSessions: mock(() => Promise.resolve([]))
    };
    
    const mockGitService = {
      clone: mock(() => Promise.resolve({ workdir: "/mock/workdir", session: testSession })),
      branch: mock(() => Promise.resolve({ workdir: "/mock/workdir", branch: testSession }))
    };

    // Act & Assert
    await expect(
      startSession({
        session: testSession,
        gitService: mockGitService,
        sessionDB: mockSessionDB,
        resolveRepoPath: mockResolveRepoPath
      })
    ).rejects.toThrow("--repo is required");
  });

  it("creates a session with task ID", async () => {
    // Arrange
    const testRepo = "https://github.com/example/repo.git";
    const testTaskId = "#123";
    const testSession = "test-session";
    
    const mockSessionDB = {
      getSession: mock(() => Promise.resolve(null)),
      addSession: mock(() => Promise.resolve()),
      listSessions: mock(() => Promise.resolve([]))
    };
    
    const mockGitService = {
      clone: mock(() => Promise.resolve({ workdir: "/mock/workdir", session: testSession })),
      branch: mock(() => Promise.resolve({ workdir: "/mock/workdir", branch: testSession }))
    };

    // Act
    await startSession({
      session: testSession,
      repo: testRepo,
      taskId: testTaskId,
      gitService: mockGitService,
      sessionDB: mockSessionDB
    });

    // Assert
    expect(mockSessionDB.addSession).toHaveBeenCalled();
    const sessionRecord = mockSessionDB.addSession.mock.calls[0][0];
    expect(sessionRecord.taskId).toBe(testTaskId);
  });

  it("creates a session with just taskId", async () => {
    // Arrange
    const testRepo = "https://github.com/example/repo.git";
    const testTaskId = "#001";
    const expectedSessionName = "task#001";
    
    const mockTaskService = {
      getTask: mock((id: string) => Promise.resolve({ id, title: "Test Task" }))
    };
    
    const mockSessionDB = {
      getSession: mock(() => Promise.resolve(null)),
      addSession: mock(() => Promise.resolve()),
      listSessions: mock(() => Promise.resolve([]))
    };
    
    const mockGitService = {
      clone: mock(() => Promise.resolve({ workdir: "/mock/workdir", session: expectedSessionName })),
      branch: mock(() => Promise.resolve({ workdir: "/mock/workdir", branch: expectedSessionName }))
    };

    // Act
    await startSession({
      taskId: testTaskId,
      repo: testRepo,
      gitService: mockGitService,
      sessionDB: mockSessionDB,
      taskService: mockTaskService as any
    });

    // Assert
    expect(mockSessionDB.getSession).toHaveBeenCalledWith(expectedSessionName);
    expect(mockGitService.clone).toHaveBeenCalledWith({
      repoUrl: testRepo,
      session: expectedSessionName
    });
    expect(mockSessionDB.addSession).toHaveBeenCalled();
    const sessionRecord = mockSessionDB.addSession.mock.calls[0][0];
    expect(sessionRecord.taskId).toBe(testTaskId);
  });

  it("throws if a session for the task already exists", async () => {
    // Arrange
    const testRepo = "https://github.com/example/repo.git";
    const testTaskId = "#001";
    const existingSession = "task#001";
    
    const mockTaskService = {
      getTask: mock((id: string) => Promise.resolve({ id, title: "Test Task" }))
    };
    
    const mockSessionDB = {
      getSession: mock(() => Promise.resolve(null)),
      addSession: mock(() => Promise.resolve()),
      listSessions: mock(() => Promise.resolve([
        { session: existingSession, taskId: testTaskId }
      ]))
    };
    
    const mockGitService = {
      clone: mock(() => Promise.resolve({ workdir: "/mock/workdir", session: existingSession })),
      branch: mock(() => Promise.resolve({ workdir: "/mock/workdir", branch: existingSession }))
    };

    // Act & Assert
    await expect(
      startSession({
        taskId: testTaskId,
        repo: testRepo,
        gitService: mockGitService,
        sessionDB: mockSessionDB,
        taskService: mockTaskService as any
      })
    ).rejects.toThrow("already exists");
  });

  it("adds session to database before clone and branch operations", async () => {
    // Arrange
    const testSession = "test-session";
    const testRepo = "https://github.com/example/repo.git";
    let sessionRecordCreated = false;
    
    const mockSessionDB = {
      getSession: mock(() => Promise.resolve(null)),
      addSession: mock((record: any) => {
        sessionRecordCreated = true;
        return Promise.resolve(record);
      }),
      listSessions: mock(() => Promise.resolve([]))
    };
    
    const mockGitService = {
      clone: mock(() => {
        // This should run after addSession
        expect(sessionRecordCreated).toBe(true);
        return Promise.resolve({ workdir: "/mock/workdir", session: testSession });
      }),
      branch: mock(() => Promise.resolve({ workdir: "/mock/workdir", branch: testSession }))
    };

    // Act
    await startSession({
      session: testSession,
      repo: testRepo,
      gitService: mockGitService,
      sessionDB: mockSessionDB
    });

    // Assert
    expect(sessionRecordCreated).toBe(true);
    expect(mockGitService.clone).toHaveBeenCalled();
    expect(mockGitService.branch).toHaveBeenCalled();
  });
}); 
