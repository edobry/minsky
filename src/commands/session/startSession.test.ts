// bun:test does not support mocking dependencies like vitest.
// For full business logic testing, refactor startSession for dependency injection or use a compatible test runner.
import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { startSession } from './startSession';
import { GitService } from '../../domain/git';
import { SessionDB } from '../../domain/session';
import { TaskService } from '../../domain/tasks';
import type { SessionRecord } from '../../domain/session';

// Mock dependencies
const mockGetTask = mock(() => Promise.resolve({ id: '#001', title: 'Test Task', status: 'TODO' }));
const mockAddSession = mock(() => Promise.resolve());
const mockListSessions = mock(() => Promise.resolve([]));
const mockGetSession = mock(() => Promise.resolve(null));
const mockClone = mock(() => Promise.resolve({ workdir: '/path/to/test-workdir', session: 'test-session' }));
const mockBranch = mock(() => Promise.resolve({ workdir: '/path/to/test-workdir', branch: 'test-branch' }));
const mockResolveRepoPath = mock(() => Promise.resolve('/path/to/repo'));

describe('startSession', () => {
  beforeEach(() => {
    // Reset mock counts between tests
    mockGetTask.mockClear();
    mockAddSession.mockClear();
    mockListSessions.mockClear();
    mockGetSession.mockClear();
    mockClone.mockClear();
    mockBranch.mockClear();
    mockResolveRepoPath.mockClear();
  });

  // Test utility to track function calls
  const trackCalls = <T = any>() => {
    const calls: any[] = [];
    const fn = (...args: any[]): T => {
      calls.push(args);
      return fn.returnValue as T;
    };
    fn.calls = calls;
    fn.returnValue = undefined as unknown as T;
    return fn;
  };

  // Basic test data
  const testSession = 'test-session';
  const testRepo = 'https://github.com/example/repo.git';
  const testLocalRepo = '/local/repo';
  const testWorkdir = '/tmp/test-workdir';
  const testBranch = 'test-branch';

  it('creates a session with explicit repo', async () => {
    // Create tracked mock functions
    const mockClone = trackCalls<{ workdir: string }>();
    mockClone.returnValue = { workdir: testWorkdir };
    
    const mockBranch = trackCalls<{ branch: string }>();
    mockBranch.returnValue = { branch: testBranch };
    
    const mockGetSession = trackCalls<null>();
    mockGetSession.returnValue = null;
    
    const mockAddSession = trackCalls();
    
    // Mock implementations
    const mockGitService = {
      clone: mockClone,
      branch: mockBranch
    };
    
    const mockSessionDB = {
      getSession: mockGetSession,
      addSession: mockAddSession
    };
    
    // Run the function with explicit repo
    const result = await startSession({
      session: testSession,
      repo: testRepo,
      gitService: mockGitService,
      sessionDB: mockSessionDB,
    });
    
    // Verify the right calls were made
    expect(mockGetSession.calls.length).toBe(1);
    expect(mockGetSession.calls[0][0]).toBe(testSession);
    
    expect(mockClone.calls.length).toBe(1);
    expect(mockClone.calls[0][0].repoUrl).toBe(testRepo);
    expect(mockClone.calls[0][0].session).toBe(testSession);
    
    expect(mockBranch.calls.length).toBe(1);
    expect(mockBranch.calls[0][0].session).toBe(testSession);
    expect(mockBranch.calls[0][0].branch).toBe(testSession);
    
    expect(mockAddSession.calls.length).toBe(1);
    expect(mockAddSession.calls[0][0].session).toBe(testSession);
    expect(mockAddSession.calls[0][0].repoUrl).toBe(testRepo);
    
    // Verify the result
    expect(result.cloneResult.workdir).toBe(testWorkdir);
    expect(result.branchResult.branch).toBe(testBranch);
  });

  it('throws if session already exists', async () => {
    // Mock session DB that returns an existing session
    const mockSessionDB = {
      getSession: () => ({ session: testSession, repoUrl: testRepo }),
      addSession: () => {}
    };
    
    // Should throw error for existing session
    await expect(startSession({
      session: testSession,
      repo: testRepo,
      gitService: {},
      sessionDB: mockSessionDB,
    })).rejects.toThrow('already exists');
  });

  it('converts local path to file:// URL', async () => {
    // Mock tracked functions
    const mockClone = trackCalls<{ workdir: string }>();
    mockClone.returnValue = { workdir: testWorkdir };
    
    const mockBranch = trackCalls<{ branch: string }>();
    mockBranch.returnValue = { branch: testBranch };
    
    const mockAddSession = trackCalls();
    
    // Mock implementations
    const mockGitService = {
      clone: mockClone,
      branch: mockBranch
    };
    
    const mockSessionDB = {
      getSession: () => null,
      addSession: mockAddSession
    };
    
    // Mock fs
    const mockFs = {
      existsSync: (path: string) => path === testLocalRepo,
      statSync: (path: string) => ({
        isDirectory: () => path === testLocalRepo
      })
    } as any;
    
    // Mock path
    const mockPath = {
      resolve: (path: string) => `/resolved${path}`
    } as any;
    
    // Run the function with local repo path
    await startSession({
      session: testSession,
      repo: testLocalRepo,
      gitService: mockGitService,
      sessionDB: mockSessionDB,
      fs: mockFs,
      path: mockPath
    });
    
    // Verify file:// URL conversion
    expect(mockClone.calls.length).toBe(1);
    expect(mockClone.calls[0][0].repoUrl).toBe(`file:///resolved${testLocalRepo}`);
    
    // Verify session record has the correct URL
    expect(mockAddSession.calls.length).toBe(1);
    expect(mockAddSession.calls[0][0].repoUrl).toBe(`file:///resolved${testLocalRepo}`);
  });

  it('uses resolveRepoPath when no repo is provided', async () => {
    // Mock implementations
    const mockResolveRepoPath = async () => '/detected/git/repo';
    
    const mockClone = trackCalls<{ workdir: string }>();
    mockClone.returnValue = { workdir: testWorkdir };
    
    const mockBranch = trackCalls<{ branch: string }>();
    mockBranch.returnValue = { branch: testBranch };
    
    const mockAddSession = trackCalls();
    
    // Create mock services
    const mockGitService = {
      clone: mockClone,
      branch: mockBranch
    };
    
    const mockSessionDB = {
      getSession: () => null,
      addSession: mockAddSession
    };
    
    // Mock fs
    const mockFs = {
      existsSync: () => false,
      statSync: () => ({ isDirectory: () => false })
    } as any;
    
    // Run the function with no repo (should use resolveRepoPath)
    await startSession({
      session: testSession,
      gitService: mockGitService,
      sessionDB: mockSessionDB,
      fs: mockFs,
      resolveRepoPath: mockResolveRepoPath
    });
    
    // Verify detected repo path was used
    expect(mockClone.calls.length).toBe(1);
    expect(mockClone.calls[0][0].repoUrl).toBe('/detected/git/repo');
  });

  it('throws if resolveRepoPath fails and no repo is provided', async () => {
    // Mock resolveRepoPath to throw
    const mockResolveRepoPath = async () => {
      throw new Error('not in git repo');
    };
    
    // Run with no repo (should throw)
    await expect(startSession({
      session: testSession,
      gitService: {},
      sessionDB: { getSession: () => null },
      resolveRepoPath: mockResolveRepoPath
    })).rejects.toThrow('--repo is required');
  });

  it('creates a session with task ID', async () => {
    // Create tracked mock functions
    const mockClone = trackCalls<{ workdir: string }>();
    mockClone.returnValue = { workdir: testWorkdir };
    
    const mockBranch = trackCalls<{ branch: string }>();
    mockBranch.returnValue = { branch: testBranch };
    
    const mockGetSession = trackCalls<null>();
    mockGetSession.returnValue = null;
    
    const mockAddSession = trackCalls();
    
    // Mock implementations
    const mockGitService = {
      clone: mockClone,
      branch: mockBranch
    };
    
    const mockSessionDB = {
      getSession: mockGetSession,
      addSession: mockAddSession,
      listSessions: () => [] // Add empty list for no existing sessions
    };
    
    const testTaskId = '#123';
    
    // Run the function with task ID
    const result = await startSession({
      session: testSession,
      repo: testRepo,
      taskId: testTaskId,
      gitService: mockGitService,
      sessionDB: mockSessionDB,
    });
    
    // Verify session was created with task ID
    expect(mockAddSession.calls.length).toBe(1);
    expect(mockAddSession.calls[0][0].session).toBe(testSession);
    expect(mockAddSession.calls[0][0].repoUrl).toBe(testRepo);
    expect(mockAddSession.calls[0][0].taskId).toBe(testTaskId);
    
    // Verify the branch is named correctly
    expect(mockBranch.calls.length).toBe(1);
    expect(mockBranch.calls[0][0].branch).toBe(testSession);
  });

  it('creates a session with just taskId', async () => {
    // Mock task service that returns a valid task
    const mockTaskService = {
      getTask: () => ({ id: '#001', title: 'Test Task' })
    };

    // Mock tracked functions
    const mockClone = trackCalls<{ workdir: string }>();
    mockClone.returnValue = { workdir: testWorkdir };
    
    const mockBranch = trackCalls<{ branch: string }>();
    mockBranch.returnValue = { branch: testBranch };
    
    const mockGetSession = trackCalls<null>();
    mockGetSession.returnValue = null;
    
    const mockAddSession = trackCalls();
    
    // Mock implementations
    const mockGitService = {
      clone: mockClone,
      branch: mockBranch
    };
    
    const mockSessionDB = {
      getSession: mockGetSession,
      addSession: mockAddSession,
      listSessions: () => [] // Add empty list for no existing sessions
    };
    
    // Run the function with just taskId
    const result = await startSession({
      taskId: '#001',
      repo: testRepo,
      gitService: mockGitService,
      sessionDB: mockSessionDB,
      taskService: mockTaskService
    });
    
    // Verify session name was derived from task ID
    const expectedSessionName = 'task#001';
    
    expect(mockGetSession.calls.length).toBe(1);
    expect(mockGetSession.calls[0][0]).toBe(expectedSessionName);
    
    expect(mockClone.calls.length).toBe(1);
    expect(mockClone.calls[0][0].repoUrl).toBe(testRepo);
    expect(mockClone.calls[0][0].session).toBe(expectedSessionName);
    
    expect(mockBranch.calls.length).toBe(1);
    expect(mockBranch.calls[0][0].session).toBe(expectedSessionName);
    expect(mockBranch.calls[0][0].branch).toBe(expectedSessionName);
    
    expect(mockAddSession.calls.length).toBe(1);
    expect(mockAddSession.calls[0][0].session).toBe(expectedSessionName);
    expect(mockAddSession.calls[0][0].repoUrl).toBe(testRepo);
    expect(mockAddSession.calls[0][0].taskId).toBe('#001');
    
    // Verify the result
    expect(result.cloneResult.workdir).toBe(testWorkdir);
    expect(result.branchResult.branch).toBe(testBranch);
  });

  // Add test for duplicate task session
  it('throws if a session for the task already exists', async () => {
    const existingSession = {
      session: 'task#001',
      repoUrl: testRepo,
      taskId: '#001'
    };

    const mockSessionDB = {
      getSession: () => null,
      addSession: () => {},
      listSessions: () => [existingSession]
    };

    const mockTaskService = {
      getTask: () => ({ id: '#001', title: 'Test Task' })
    };

    // Should throw error for existing task session
    await expect(startSession({
      taskId: '#001',
      repo: testRepo,
      gitService: {},
      sessionDB: mockSessionDB,
      taskService: mockTaskService
    })).rejects.toThrow('already exists');
  });

  // Bug Fix Test: Session DB operations must happen before branch creation
  // Bug #008: Branch creation failed with "Session not found" when session was added to DB after branch creation
  // The bug caused "Session not found" errors because GitService.branch() checks for session existence
  // before the session record was actually added to the database
  it('adds session to database before clone and branch operations', async () => {
    // This test verifies the correct sequence of operations
    let sessionRecordCreated = false;
    
    // Mock function for branch that will fail if session does not exist
    const mockBranch = trackCalls<{ branch: string }>();
    mockBranch.returnValue = { branch: testBranch };
    
    // Mock session DB with getSession that checks if record was created
    const mockSessionDB = {
      getSession: (sessionName: string) => {
        // This simulates GitService.branch checking for session existence
        // If sessionRecordCreated is false, this should simulate our bug
        if (!sessionRecordCreated) {
          return null; // Session does not exist yet
        }
        return { session: sessionName };
      },
      addSession: () => {
        // Mark the session as created when addSession is called
        sessionRecordCreated = true;
      },
      listSessions: () => []
    };
    
    // Create mock services with branch implementation that relies on session existence
    const mockGitService = {
      clone: () => ({ workdir: testWorkdir }),
      branch: (options: any) => {
        // This simulates the actual behavior in GitService.branch
        // It should throw if the session doesn't exist when called
        const record = mockSessionDB.getSession(options.session);
        if (!record) {
          throw new Error(`Session '${options.session}' not found.`);
        }
        return { branch: options.branch };
      }
    };
    
    // Execute the function - should not throw with correct operation order
    await startSession({
      session: testSession,
      repo: testRepo,
      gitService: mockGitService,
      sessionDB: mockSessionDB
    });
    
    // Verify the session was created before branch was called
    expect(sessionRecordCreated).toBe(true);
  });

  it('creates a session with default local backend when no backend is specified', async () => {
    // Arrange
    const mockGitService = {
      clone: mockClone,
      branch: mockBranch
    };
    
    const mockSessionDB = {
      addSession: mockAddSession,
      listSessions: mockListSessions,
      getSession: mockGetSession
    };
    
    // Act
    const result = await startSession({
      session: 'test-session',
      repo: '/path/to/repo',
      gitService: mockGitService as unknown as GitService,
      sessionDB: mockSessionDB as unknown as SessionDB,
      resolveRepoPath: mockResolveRepoPath
    });
    
    // Assert
    expect(mockAddSession).toHaveBeenCalledTimes(1);
    expect(mockAddSession.mock.calls[0][0]).toMatchObject({
      session: 'test-session',
      repoUrl: '/path/to/repo',
      backendType: 'local'
    });
    
    expect(mockClone).toHaveBeenCalledTimes(1);
    expect(mockClone.mock.calls[0][0]).toMatchObject({
      repoUrl: '/path/to/repo',
      session: 'test-session',
      backend: 'local'
    });
    
    expect(result.sessionRecord.backendType).toBe('local');
  });

  it('creates a session with github backend when specified', async () => {
    // Arrange
    const mockGitService = {
      clone: mockClone,
      branch: mockBranch
    };
    
    const mockSessionDB = {
      addSession: mockAddSession,
      listSessions: mockListSessions,
      getSession: mockGetSession
    };
    
    const githubOptions = {
      token: 'test-token',
      owner: 'test-owner',
      repo: 'test-repo'
    };
    
    // Act
    const result = await startSession({
      session: 'test-session',
      repo: 'https://github.com/test-owner/test-repo.git',
      backend: 'github',
      github: githubOptions,
      gitService: mockGitService as unknown as GitService,
      sessionDB: mockSessionDB as unknown as SessionDB,
      resolveRepoPath: mockResolveRepoPath
    });
    
    // Assert
    expect(mockAddSession).toHaveBeenCalledTimes(1);
    expect(mockAddSession.mock.calls[0][0]).toMatchObject({
      session: 'test-session',
      repoUrl: 'https://github.com/test-owner/test-repo.git',
      backendType: 'github',
      github: githubOptions
    });
    
    expect(mockClone).toHaveBeenCalledTimes(1);
    expect(mockClone.mock.calls[0][0]).toMatchObject({
      repoUrl: 'https://github.com/test-owner/test-repo.git',
      session: 'test-session',
      backend: 'github',
      github: githubOptions
    });
    
    expect(result.sessionRecord.backendType).toBe('github');
    expect(result.sessionRecord.github).toBe(githubOptions);
  });

  it('creates a session with task ID and local backend', async () => {
    // Arrange
    const mockTaskService = {
      getTask: mockGetTask
    };
    
    const mockGitService = {
      clone: mockClone,
      branch: mockBranch
    };
    
    const mockSessionDB = {
      addSession: mockAddSession,
      listSessions: mockListSessions,
      getSession: mockGetSession
    };
    
    // Act
    const result = await startSession({
      taskId: '001',
      repo: '/path/to/repo',
      backend: 'local',
      gitService: mockGitService as unknown as GitService,
      sessionDB: mockSessionDB as unknown as SessionDB,
      taskService: mockTaskService as unknown as TaskService,
      resolveRepoPath: mockResolveRepoPath
    });
    
    // Assert
    expect(mockGetTask).toHaveBeenCalledTimes(1);
    expect(mockGetTask.mock.calls[0][0]).toBe('#001');
    
    expect(mockAddSession).toHaveBeenCalledTimes(1);
    expect(mockAddSession.mock.calls[0][0]).toMatchObject({
      session: 'task#001',
      repoUrl: '/path/to/repo',
      taskId: '#001',
      backendType: 'local'
    });
    
    expect(mockClone).toHaveBeenCalledTimes(1);
    expect(mockClone.mock.calls[0][0]).toMatchObject({
      repoUrl: '/path/to/repo',
      session: 'task#001',
      backend: 'local'
    });
    
    expect(result.sessionRecord.session).toBe('task#001');
    expect(result.sessionRecord.taskId).toBe('#001');
    expect(result.sessionRecord.backendType).toBe('local');
  });
}); 
