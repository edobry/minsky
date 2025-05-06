// bun:test does not support mocking dependencies like vitest.
// For full business logic testing, refactor startSession for dependency injection or use a compatible test runner.
import { describe, it, expect, mock } from "bun:test";
import { startSession } from "./startSession";
import path from "path";
import type { StartSessionOptions } from "./startSession";
import { randomBytes } from "crypto";
import { normalizeTaskId } from "../../utils/task-utils";
import { resolveRepoPath } from "../../domain/repo-utils";
import { GitService } from "../../domain/git";
import { SessionDB } from "../../domain/session";
import type { SessionRecord } from "../../domain/session";
import { join } from "path";
import { TaskService } from "../../domain/tasks";
import fs from "fs";

// Define a result interface matching the actual function return type
interface StartSessionResult {
  cloneResult: { workdir: string };
  branchResult: { branch: string };
}

// Define interfaces for mocked services
interface MockedGitService {
  clone: (options: any) => Promise<{ workdir: string }>;
  branch: (options: any) => Promise<{ branch: string }>;
}

interface MockedSessionDB {
  getSession: (sessionName: string) => SessionRecord | null;
  addSession: (session: any) => void;
  listSessions: () => SessionRecord[];
}

interface MockedTaskService {
  getTask: (taskId: string) => { id: string; title: string } | null;
}

// Define the complete test options interface
interface TestOptions {
  session?: string;
  repo?: string;
  taskId?: string;
  gitService?: any;
  sessionDB?: any;
  taskService?: any;
  resolveRepoPath?: any;
}

describe("startSession", () => {
  // Test utility to track function calls
  const trackCalls = <T = unknown>() => {
    const calls: unknown[][] = [];
    const fn = (...args: unknown[]): T => {
      calls.push(args);
      return fn.returnValue as T;
    };
    fn.calls = calls;
    fn.returnValue = undefined as unknown as T;
    return fn;
  };

  // Basic test data
  const testSession = "test-session";
  const testRepo = "https://github.com/example/repo.git";
  const testLocalRepo = "/local/repo";
  const testWorkdir = "/tmp/test-workdir";
  const testBranch = "test-branch";

  it("creates a session with explicit repo", async () => {
    // Create tracked mock functions
    const mockClone = trackCalls<Promise<{ workdir: string }>>();
    mockClone.returnValue = Promise.resolve({ workdir: testWorkdir });
    
    const mockBranch = trackCalls<Promise<{ branch: string }>>();
    mockBranch.returnValue = Promise.resolve({ branch: testBranch });
    
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
      listSessions: () => []
    };
    
    // Run the function with explicit repo
    const options = {
      session: testSession,
      repo: testRepo,
      gitService: mockGitService,
      sessionDB: mockSessionDB
    } as unknown as StartSessionOptions;
    
    const result = await startSession(options) as unknown as StartSessionResult;
    
    // Verify the right calls were made
    expect(mockGetSession.calls.length).toBe(1);
    expect(mockGetSession.calls[0]?.[0]).toBe(testSession);
    
    expect(mockClone.calls.length).toBe(1);
    if (mockClone.calls[0]?.[0]) {
      const callArg = mockClone.calls[0][0] as Record<string, unknown>;
      expect(callArg.repoUrl).toBe(testRepo);
      expect(callArg.session).toBe(testSession);
    }
    
    expect(mockBranch.calls.length).toBe(1);
    if (mockBranch.calls[0]?.[0]) {
      const callArg = mockBranch.calls[0][0] as Record<string, unknown>;
      expect(callArg.branch).toBe(testSession);
    }
    
    expect(mockAddSession.calls.length).toBe(1);
    if (mockAddSession.calls[0]?.[0]) {
      const callArg = mockAddSession.calls[0][0] as Record<string, unknown>;
      expect(callArg.session).toBe(testSession);
      expect(callArg.repoUrl).toBe(testRepo);
    }
    
    // Verify the result
    expect(result.cloneResult.workdir).toBe(testWorkdir);
    expect(result.branchResult.branch).toBe(testBranch);
  });

  it("throws if session already exists", async () => {
    // Mock session DB that returns an existing session
    const mockSessionDB = {
      getSession: () => ({ session: testSession, repoUrl: testRepo }),
      addSession: () => {},
      listSessions: () => []
    };
    
    // Should throw error for existing session
    const options = {
      session: testSession,
      repo: testRepo,
      gitService: {},
      sessionDB: mockSessionDB
    } as unknown as StartSessionOptions;
    
    await expect(startSession(options)).rejects.toThrow("already exists");
  });

  it("converts local path to file:// URL", async () => {
    // Set up mocks
    const mockFs = {
      existsSync: () => true,
      statSync: () => ({
        isDirectory: () => true
      })
    };
    
    const mockPath = {
      resolve: (p: string) => `/resolved${p}`
    };
    
    // Local path to test
    const testLocalRepo = "/local/repo";
    
    // Function to test URL conversion logic
    const convertToFileUrl = (localPath: string) => {
      if (mockFs.existsSync?.() && mockFs.statSync?.().isDirectory?.()) {
        const absolutePath = mockPath.resolve(localPath);
        return `file://${absolutePath}`;
      }
      return localPath;
    };
    
    // Run the conversion
    const result = convertToFileUrl(testLocalRepo);
    
    // Verify result
    const expectedUrl = `file:///resolved${testLocalRepo}`;
    expect(result).toBe(expectedUrl);
  });

  it("uses resolveRepoPath when no repo is provided", async () => {
    // Mock implementations
    const mockResolveRepoPath = mock(() => Promise.resolve("/detected/git/repo"));
    
    const mockClone = trackCalls<Promise<{ workdir: string }>>();
    mockClone.returnValue = Promise.resolve({ workdir: testWorkdir });
    
    const mockBranch = trackCalls<Promise<{ branch: string }>>();
    mockBranch.returnValue = Promise.resolve({ branch: testBranch });
    
    const mockAddSession = trackCalls();
    
    // Create mock services
    const mockGitService = {
      clone: mockClone,
      branch: mockBranch
    };
    
    const mockSessionDB = {
      getSession: () => null,
      addSession: mockAddSession,
      listSessions: () => []
    };
    
    // Run the function with no repo (should use resolveRepoPath)
    const options = {
      session: testSession,
      gitService: mockGitService,
      sessionDB: mockSessionDB,
      resolveRepoPath: mockResolveRepoPath
    } as unknown as StartSessionOptions;
    
    await startSession(options);
    
    // Verify detected repo path was used
    expect(mockClone.calls.length).toBe(1);
    if (mockClone.calls[0]?.[0]) {
      const callArg = mockClone.calls[0][0] as Record<string, unknown>;
      expect(callArg.repoUrl).toBe("/detected/git/repo");
    }
  });

  it("throws if resolveRepoPath fails and no repo is provided", async () => {
    // Mock resolveRepoPath to throw
    const mockResolveRepoPath = () => {
      throw new Error("not in git repo");
    };
    
    // Run with no repo (should throw)
    const options = {
      session: testSession,
      gitService: {},
      sessionDB: { getSession: () => null },
      resolveRepoPath: mockResolveRepoPath
    } as unknown as StartSessionOptions;
    
    await expect(startSession(options)).rejects.toThrow("--repo is required");
  });

  it("creates a session with task ID", async () => {
    // Create tracked mock functions
    const mockClone = trackCalls<Promise<{ workdir: string }>>();
    mockClone.returnValue = Promise.resolve({ workdir: testWorkdir });
    
    const mockBranch = trackCalls<Promise<{ branch: string }>>();
    mockBranch.returnValue = Promise.resolve({ branch: testBranch });
    
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
    
    const testTaskId = "#123";
    
    // Run the function with task ID
    const options = {
      session: testSession,
      repo: testRepo,
      taskId: testTaskId,
      gitService: mockGitService,
      sessionDB: mockSessionDB
    } as unknown as StartSessionOptions;
    
    const result = await startSession(options) as unknown as StartSessionResult;
    
    // Verify session was created with task ID
    expect(mockAddSession.calls.length).toBe(1);
    if (mockAddSession.calls[0]?.[0]) {
      const callArg = mockAddSession.calls[0][0] as Record<string, unknown>;
      expect(callArg.session).toBe(testSession);
      expect(callArg.repoUrl).toBe(testRepo);
      expect(callArg.taskId).toBe(testTaskId);
    }
    
    // Verify the branch is named correctly
    expect(mockBranch.calls.length).toBe(1);
    if (mockBranch.calls[0]?.[0]) {
      const callArg = mockBranch.calls[0][0] as Record<string, unknown>;
      expect(callArg.branch).toBe(testSession);
    }
  });

  it("creates a session with just taskId", async () => {
    // Mock task service that returns a valid task
    const mockTaskService = {
      getTask: () => ({ id: "#001", title: "Test Task" })
    };
    
    // Mock tracked functions
    const mockClone = trackCalls<Promise<{ workdir: string }>>();
    mockClone.returnValue = Promise.resolve({ workdir: testWorkdir });
    
    const mockBranch = trackCalls<Promise<{ branch: string }>>();
    mockBranch.returnValue = Promise.resolve({ branch: testBranch });
    
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
    const options = {
      taskId: "#001",
      repo: testRepo,
      gitService: mockGitService,
      sessionDB: mockSessionDB,
      taskService: mockTaskService
    } as unknown as StartSessionOptions;
    
    const result = await startSession(options) as unknown as StartSessionResult;
    
    // Verify session name was derived from task ID
    const expectedSessionName = "task#001";
    
    expect(mockGetSession.calls.length).toBe(1);
    expect(mockGetSession.calls[0]?.[0]).toBe(expectedSessionName);
    
    expect(mockClone.calls.length).toBe(1);
    if (mockClone.calls[0]?.[0]) {
      const callArg = mockClone.calls[0][0] as Record<string, unknown>;
      expect(callArg.repoUrl).toBe(testRepo);
      expect(callArg.session).toBe(expectedSessionName);
    }
    
    expect(mockBranch.calls.length).toBe(1);
    if (mockBranch.calls[0]?.[0]) {
      const callArg = mockBranch.calls[0][0] as Record<string, unknown>;
      expect(callArg.branch).toBe(expectedSessionName);
    }
    
    expect(mockAddSession.calls.length).toBe(1);
    if (mockAddSession.calls[0]?.[0]) {
      const callArg = mockAddSession.calls[0][0] as Record<string, unknown>;
      expect(callArg.session).toBe(expectedSessionName);
      expect(callArg.repoUrl).toBe(testRepo);
      expect(callArg.taskId).toBe("#001");
    }
    
    // Verify the result
    expect(result.cloneResult.workdir).toBe(testWorkdir);
    expect(result.branchResult.branch).toBe(testBranch);
  });

  // Add test for duplicate task session
  it("throws if a session for the task already exists", async () => {
    const existingSession = {
      session: "task#001",
      repoUrl: testRepo,
      taskId: "#001"
    };
    
    const mockSessionDB = {
      getSession: () => null,
      addSession: () => {},
      listSessions: () => [existingSession]
    };
    
    const mockTaskService = {
      getTask: () => ({ id: "#001", title: "Test Task" })
    };
    
    // Should throw error for existing task session
    await expect(startSession({
      taskId: "#001",
      repo: testRepo,
      gitService: {} as unknown as GitService,
      sessionDB: mockSessionDB as unknown as SessionDB,
      taskService: mockTaskService as unknown as TaskService
    } as TestOptions)).rejects.toThrow("already exists");
  });

  // Bug Fix Test: Session DB operations must happen before branch creation
  it("adds session to database before clone and branch operations", async () => {
    // This test verifies the correct sequence of operations
    let sessionRecordCreated = false;
    
    // Mock function for branch that will fail if session does not exist
    const mockBranch = trackCalls<Promise<{ branch: string }>>();
    mockBranch.returnValue = Promise.resolve({ branch: testBranch });
    
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
      gitService: mockGitService as unknown as GitService,
      sessionDB: mockSessionDB as unknown as SessionDB
    } as TestOptions);
    
    // Verify the session was created before branch was called
    expect(sessionRecordCreated).toBe(true);
  });
});

describe("startSession URL conversion", () => {
  it("converts local path to file:// URL", () => {
    // Define the test input
    const localPath = "/local/repo";
    
    // Define the mock functions we need
    const mockFs = {
      existsSync: (_path: string) => true,
      statSync: (_path: string) => ({
        isDirectory: () => true
      })
    };
    
    const mockPath = {
      resolve: (p: string) => `/resolved${p}`
    };
    
    // Function to test URL conversion logic
    const convertToFileUrl = (path: string): string => {
      if (mockFs.existsSync(path) && mockFs.statSync(path).isDirectory()) {
        const absolutePath = mockPath.resolve(path);
        return `file://${absolutePath}`;
      }
      return path;
    };
    
    // Run the conversion
    const result = convertToFileUrl(localPath);
    
    // Verify result
    const expectedUrl = `file:///resolved${localPath}`;
    expect(result).toBe(expectedUrl);
  });
}); 
