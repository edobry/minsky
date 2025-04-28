// bun:test does not support mocking dependencies like vitest.
// For full business logic testing, refactor startSession for dependency injection or use a compatible test runner.
import { describe, it, expect } from 'bun:test';
import { startSession } from './startSession';

describe('startSession', () => {
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
      addSession: mockAddSession
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
}); 
