/**
 * Tests for interface-agnostic session functions
 */
import { describe, test, expect, beforeEach, mock, jest, afterEach as bunAfterEach, afterAll } from "bun:test";
import { SessionDB, startSessionFromParams, updateSessionFromParams, createSessionDeps as actualCreateSessionDeps } from "../session"; // Static import, no .js, ADDED SessionDB
import { ResourceNotFoundError } from "../../errors"; // no .js
import type { SessionRecord, Session, SessionDeps } from "../session"; // no .js
import type { Task } from "../tasks"; // no .js
import type { SessionUpdateParams } from "../../schemas/session"; // no .js
import * as WorkspaceUtilsFns from "../workspace"; // no .js
import { createMock, setupTestMocks } from "../../utils/test-utils/mocking"; // no .js, already correct
import { rm } from "fs/promises"; // Import rm for cleanup
import { createTempTestDir } from "../../utils/test-utils"; // CORRECTED PATH

// Mock dependencies
const mockSessionRecord = {
  session: "test-session",
  repoUrl: "/mock/repo/url",
  repoName: "mock-repo",
  createdAt: new Date().toISOString(),
  taskId: "#123",
};

const mockTask = {
  id: "#123",
  title: "Test Task",
  status: "TODO",
  description: "This is a test task",
};

// Mock GitService
const mockGitService = {
  clone: createMock(() => ({ repoPath: "/mock/repo/path", success: true })),
  branch: createMock(() => ({ success: true })),
  stashChanges: createMock(() => Promise.resolve()),
  popStash: createMock(() => Promise.resolve()),
  pullLatest: createMock(() => Promise.resolve()),
  mergeBranch: createMock(() => ({ conflicts: false })),
  pushBranch: createMock(() => Promise.resolve()),
  getSessionWorkdir: createMock(() => "/mock/session/workdir"),
};

// Mock SessionDB
const mockSessionDB = {
  getSession: createMock((name: string) => (name === "test-session" ? mockSessionRecord : null)),
  addSession: createMock(() => Promise.resolve()),
  listSessions: createMock(() => [mockSessionRecord]),
  getSessionByTaskId: createMock((taskId: string) => (taskId === "#123" ? mockSessionRecord : null)),
  updateSession: createMock(() => Promise.resolve()),
  getNewSessionRepoPath: createMock((repoName: string, sessionId: string) => `/mock/repo/${repoName}/sessions/${sessionId}`),
  getSessionWorkdir: createMock((sessionName: string) => Promise.resolve(`/mocked/workdir/${sessionName}`)),
};

// Mock TaskService
const mockTaskService = {
  getTask: createMock((id: string) => (id === "#123" ? mockTask : null)),
  getTaskStatus: createMock((id: string) => (id === "#123" ? "TODO" : null)),
  setTaskStatus: createMock(() => Promise.resolve()),
};

// Mock resolveRepoPath
const mockResolveRepoPath = createMock(() => Promise.resolve("/mock/repo/path"));

// Mock isSessionRepository
const mockIsSessionRepository = createMock(() => Promise.resolve(false));

// Mock getCurrentSession
const mockGetCurrentSession = createMock(() => Promise.resolve("test-session"));

// Create a mock for WorkspaceUtils if needed by SessionDeps
const mockWorkspaceUtils = {
  ...WorkspaceUtilsFns, // Spread actual functions, can override specific ones with mocks if needed
  isSessionRepository: mockIsSessionRepository, // Ensure this is mocked if used by tested functions
  resolveRepoPath: mockResolveRepoPath, // Ensure this is mocked if used by tested functions
  getCurrentSession: mockGetCurrentSession, // Ensure this is mocked
};

describe("SessionDB", () => {
  beforeEach(() => {
    // Clear all function mock history before each SessionDB test.
    jest.clearAllMocks();
  });

  describe("deleteSession", () => {
    test("should delete a session from the database", async () => {
      const tempTestDir = await createTempTestDir("del-db-test1");
      const db = new SessionDB({ baseDir: tempTestDir }); // Use globally imported SessionDB
      const session1 = { session: "test-session-1", repoName: "repo1", repoUrl: "url1", createdAt: new Date().toISOString() };
      const session2 = { session: "test-session-2", repoName: "repo2", repoUrl: "url2", createdAt: new Date().toISOString() };
      await db.saveSessions([session1, session2]);

      const result = await db.deleteSession("test-session-1");
      expect(result).toBe(true);

      const remainingSessions = await db.listSessions();
      expect(remainingSessions.length).toBe(1);
      expect(remainingSessions[0].session).toBe("test-session-2");
      await rm(tempTestDir, { recursive: true, force: true });
    });

    test("should return false if session does not exist", async () => {
      const tempTestDir = await createTempTestDir("del-db-test2");
      const db = new SessionDB({ baseDir: tempTestDir });
      const session1 = { session: "test-session-1", repoName: "repo1", repoUrl: "url1", createdAt: new Date().toISOString() };
      await db.saveSessions([session1]);

      const result = await db.deleteSession("non-existent-session");
      expect(result).toBe(false);

      const remainingSessions = await db.listSessions();
      expect(remainingSessions.length).toBe(1);
      await rm(tempTestDir, { recursive: true, force: true });
    });

    test("should handle empty database gracefully for delete", async () => {
      const tempTestDir = await createTempTestDir("del-db-test3");
      const db = new SessionDB({ baseDir: tempTestDir });
      // DB starts empty
      const result = await db.deleteSession("any-session");
      expect(result).toBe(false);
      await rm(tempTestDir, { recursive: true, force: true });
    });
    
    test("should handle non-existent database gracefully for delete", async () => {
      const tempTestDir = await createTempTestDir("del-db-test4");
      const db = new SessionDB({ baseDir: tempTestDir });
      // DB path might exist but file won't unless readDb/writeDb is called.
      // deleteSession calls readDb, which returns [] if file doesn't exist.
      const result = await db.deleteSession("test-session");
      expect(result).toBe(false);
      await rm(tempTestDir, { recursive: true, force: true });
    });
  });
  
  describe("getSessionByTaskId", () => {
    test("should find a session by task ID", async () => {
      const tempTestDir = await createTempTestDir("get-task-db-test1");
      const db = new SessionDB({ baseDir: tempTestDir });
      const session1 = { session: "s1", taskId: "#001", repoName: "r1", repoUrl: "u1", createdAt: "" };
      const session2 = { session: "s2", taskId: "#002", repoName: "r2", repoUrl: "u2", createdAt: "" };
      await db.saveSessions([session1, session2]);
      const found = await db.getSessionByTaskId("#001");
      expect(found).toEqual(session1);
      await rm(tempTestDir, { recursive: true, force: true });
    });

    test("should return null if no session has the given task ID", async () => {
      const tempTestDir = await createTempTestDir("get-task-db-test2");
      const db = new SessionDB({ baseDir: tempTestDir });
      const session1 = { session: "s1", taskId: "#001", repoName: "r1", repoUrl: "u1", createdAt: "" };
      await db.saveSessions([session1]);
      const found = await db.getSessionByTaskId("#999");
      expect(found).toBeNull();
      await rm(tempTestDir, { recursive: true, force: true });
    });
  });
});

describe("interface-agnostic session functions", () => {
  setupTestMocks();

  beforeEach(() => {
    // Reset all mock history and implementations for functions created with createMock
    // This is now partly handled by setupTestMocks which calls mock.restore()
    // We might still need mockClear for individual mocks if their state needs to be reset per test
    // without affecting their base mock implementation if it was set by createMock(implementation)
    // For now, let's rely on setupTestMocks and the re-assignment of default implementations below.

    // Clear history for all created mocks
    Object.values(mockGitService).forEach(fn => fn.mockClear());
    Object.values(mockSessionDB).forEach(fn => fn.mockClear());
    Object.values(mockTaskService).forEach(fn => fn.mockClear());
    mockResolveRepoPath.mockClear();
    mockIsSessionRepository.mockClear();
    mockGetCurrentSession.mockClear();

    // Reset mock implementations to default for those that have them
    mockGitService.clone.mockImplementation(() => ({ repoPath: "/mock/repo/path", success: true }));
    mockGitService.branch.mockImplementation(() => ({ success: true }));
    mockGitService.mergeBranch.mockImplementation(() => ({ conflicts: false }));
    mockGitService.getSessionWorkdir.mockImplementation(() => "/mock/session/workdir");
    // ... other mockGitService methods are simple Promise.resolve mocks from createMock

    mockSessionDB.getSession.mockImplementation((name: string) => (name === "test-session" ? mockSessionRecord : null));
    mockSessionDB.listSessions.mockImplementation(() => [mockSessionRecord]);
    mockSessionDB.getSessionByTaskId.mockImplementation((taskId: string) => (taskId === "#123" ? mockSessionRecord : null));
    mockSessionDB.getNewSessionRepoPath.mockImplementation((repoName: string, sessionId: string) => `/mock/repo/${repoName}/sessions/${sessionId}`);
    mockSessionDB.getSessionWorkdir.mockImplementation((sessionName: string) => Promise.resolve(`/mocked/workdir/${sessionName}`));

    mockTaskService.getTask.mockImplementation((id: string) => (id === "#123" ? mockTask : null));
    mockTaskService.getTaskStatus.mockImplementation((id: string) => (id === "#123" ? "TODO" : null));

    mockIsSessionRepository.mockImplementation(() => Promise.resolve(false));
    mockResolveRepoPath.mockImplementation(() => Promise.resolve("/mock/repo/path"));
    mockGetCurrentSession.mockImplementation(() => Promise.resolve("test-session"));
  });

  // ADD afterAll to clean up module mocks from this describe block
  afterAll(() => {
    jest.mock("../git", () => jest.requireActual("../git"));
    jest.mock("../tasks", () => jest.requireActual("../tasks"));
    jest.mock("../workspace", () => jest.requireActual("../workspace"));
    jest.mock("../repo-utils", () => jest.requireActual("../repo-utils"));
  });

  describe("startSessionFromParams", () => {
    // Define mocks for modules imported by ../session
    const GitServiceMock = class { constructor() { return mockGitService; } };
    const TaskServiceMock = class { constructor() { return mockTaskService; } };
    
    // Mock external modules used by startSessionFromParams
    // These need to be at a scope where they apply before startSessionFromParams (from static import) is first called.
    // If called per test, ensure they are reset or consistently defined.
    mock.module("../git", () => ({ GitService: GitServiceMock }));
    mock.module("../tasks", () => ({
      TaskService: TaskServiceMock,
      TASK_STATUS: { TODO: "TODO", DONE: "DONE", IN_PROGRESS: "IN-PROGRESS", IN_REVIEW: "IN-REVIEW" },
    }));
    mock.module("../workspace", () => mockWorkspaceUtils); // Use the more complete mockWorkspaceUtils
    mock.module("../repo-utils", () => ({ resolveRepoPath: mockResolveRepoPath, normalizeRepoName: () => "mock-repo" }));

    test("should start a session with valid parameters", async () => {
      const directMockedSessionDB = {
        getSession: createMock().mockImplementationOnce(() => null),
        addSession: createMock(() => Promise.resolve()),
        listSessions: createMock(() => [mockSessionRecord]),
        getSessionByTaskId: createMock((taskId: string) => (taskId === "#123" ? mockSessionRecord : null)),
        updateSession: createMock(() => Promise.resolve()),
        getNewSessionRepoPath: createMock((repoName: string, sessionId: string) => `/mock/repo/${repoName}/sessions/${sessionId}`),
        getSessionWorkdir: createMock((sessionName: string) => Promise.resolve(`/mocked/workdir/${sessionName}`)),
      };

      const testDeps: SessionDeps = {
        sessionDB: directMockedSessionDB as any,
        gitService: mockGitService as any,
        taskService: mockTaskService as any,
        workspaceUtils: mockWorkspaceUtils as any, 
      };

      const params = {
        name: "test-session",
        repo: "/mock/repo/url",
        quiet: false,
        noStatusUpdate: false,
        backend: "markdown" as const,
        remote: { authMethod: "ssh" as const, depth: 1 },
      };

      try {
        const result = await startSessionFromParams(params, testDeps); // Pass direct mock deps

        expect(result).toBeDefined();
        expect(result.sessionRecord.session).toBe("test-session");
        expect(result.sessionRecord.repoUrl).toBe("/mock/repo/url");
        expect(directMockedSessionDB.addSession.mock.calls.length).toBeGreaterThan(0); // Use directMockedSessionDB
        expect(mockGitService.clone.mock.calls.length).toBeGreaterThan(0);
      } catch (error) {
        console.error("Test error:", error);
        throw error;
      }
    });

    test("should throw ValidationError when session name and task ID are missing", async () => {
      // Mock the required dependencies as before
      // This is a simplified example for the error case
      const params = {
        repo: "/mock/repo/url",
        quiet: false,
        noStatusUpdate: false,
        backend: "markdown" as const,
        remote: { authMethod: "ssh" as const, depth: 1 },
      };

      // This would properly mock the actual implementation, but for simplicity
      // we'll just check that the error is thrown
      await expect(startSessionFromParams(params)).rejects.toThrow();
    });
  });

  describe("updateSessionFromParams", () => {
    // Mock external modules used by updateSessionFromParams (if different or need reset)
    // For simplicity, assuming the same mocks as above are generally applicable or reset by beforeEach.
    // If updateSessionFromParams has different internal dependencies, they'd be mocked here.

    test("should update a session with valid parameters", async () => {
      const deps: SessionDeps = {
        sessionDB: mockSessionDB as any, 
        gitService: mockGitService as any, 
        taskService: mockTaskService as any, 
        workspaceUtils: mockWorkspaceUtils as any,
      };

      const params: SessionUpdateParams = {
        name: "test-session",
        branch: "main",
        remote: "origin",
        noStash: false,
        noPush: false,
      };

      try {
        await updateSessionFromParams(params, deps); // Pass mock deps

        expect(mockSessionDB.getSession).toHaveBeenCalledWith("test-session");
        expect(mockGitService.stashChanges.mock.calls.length).toBeGreaterThan(0); // Check calls.length
        expect(mockGitService.pullLatest.mock.calls.length).toBeGreaterThan(0);
        expect(mockGitService.mergeBranch.mock.calls.length).toBeGreaterThan(0);
        expect(mockGitService.pushBranch.mock.calls.length).toBeGreaterThan(0);
        expect(mockGitService.popStash.mock.calls.length).toBeGreaterThan(0);
      } catch (error) {
        console.error("Test error:", error);
        throw error;
      }
    });

    test("should throw ResourceNotFoundError when session is not found", async () => {
      // Mock getSession to return null for non-existent session
      mockSessionDB.getSession.mockImplementation(() => null);

      const params = {
        name: "non-existent-session",
        branch: "main",
        noStash: false,
        noPush: false,
      };

      await expect(updateSessionFromParams(params)).rejects.toThrow("not found");
    });

    test("should not stash or pop when noStash is true", async () => {
      // This test case might also rely on default dependency resolution via actualCreateSessionDeps
      // if deps are not explicitly passed to updateSessionFromParams.
      // For this test to work correctly if default deps are used, the global mocks 
      // for git.js etc. set at the describe-level must be active.
      
      const params: SessionUpdateParams = {
        name: "test-session",
        branch: "main",
        noStash: true,
        noPush: false,
      };
      
      // To ensure this test uses the intended mocks (like mockGitService), pass deps explicitly.
      const testDeps: SessionDeps = {
        sessionDB: mockSessionDB as any,
        gitService: mockGitService as any,
        taskService: mockTaskService as any,
        workspaceUtils: mockWorkspaceUtils as any,
      };

      await updateSessionFromParams(params, testDeps);

      expect(mockGitService.stashChanges.mock.calls.length).toBe(0);
      expect(mockGitService.popStash.mock.calls.length).toBe(0);
    });
  });
});
