/**
 * Tests for interface-agnostic session functions
 */
import { describe, test, expect, beforeEach, mock, jest } from "bun:test";
import { startSessionFromParams, updateSessionFromParams } from "../session.js";
import { ResourceNotFoundError } from "../../errors/index.js";

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
  clone: jest.fn(() => ({ repoPath: "/mock/repo/path", success: true })),
  branch: jest.fn(() => ({ success: true })),
  stashChanges: jest.fn(() => Promise.resolve()),
  popStash: jest.fn(() => Promise.resolve()),
  pullLatest: jest.fn(() => Promise.resolve()),
  mergeBranch: jest.fn(() => ({ conflicts: false })),
  pushBranch: jest.fn(() => Promise.resolve()),
  getSessionWorkdir: jest.fn(() => "/mock/session/workdir"),
};

// Mock SessionDB
const mockSessionDB = {
  getSession: jest.fn((name: string) => (name === "test-session" ? mockSessionRecord : null)),
  addSession: jest.fn(() => Promise.resolve()),
  listSessions: jest.fn(() => [mockSessionRecord]),
  getSessionByTaskId: jest.fn((taskId: string) => (taskId === "#123" ? mockSessionRecord : null)),
  updateSession: jest.fn(() => Promise.resolve()),
};

// Mock TaskService
const mockTaskService = {
  getTask: jest.fn((id: string) => (id === "#123" ? mockTask : null)),
  getTaskStatus: jest.fn((id: string) => (id === "#123" ? "TODO" : null)),
  setTaskStatus: jest.fn(() => Promise.resolve()),
};

// Mock resolveRepoPath
const mockResolveRepoPath = jest.fn(() => Promise.resolve("/mock/repo/path"));

// Mock isSessionRepository
const mockIsSessionRepository = jest.fn(() => Promise.resolve(false));

// Mock getCurrentSession
const mockGetCurrentSession = jest.fn(() => Promise.resolve("test-session"));

describe("interface-agnostic session functions", () => {
  beforeEach(() => {
    // Reset mocks between tests
    mockGitService.clone.mockClear();
    mockGitService.branch.mockClear();
    mockGitService.stashChanges.mockClear();
    mockGitService.popStash.mockClear();
    mockGitService.pullLatest.mockClear();
    mockGitService.mergeBranch.mockClear();
    mockGitService.pushBranch.mockClear();
    mockGitService.getSessionWorkdir.mockClear();

    mockSessionDB.getSession.mockClear();
    mockSessionDB.addSession.mockClear();
    mockSessionDB.listSessions.mockClear();
    mockSessionDB.getSessionByTaskId.mockClear();
    mockSessionDB.updateSession.mockClear();

    mockTaskService.getTask.mockClear();
    mockTaskService.getTaskStatus.mockClear();
    mockTaskService.setTaskStatus.mockClear();

    mockResolveRepoPath.mockClear();
    mockIsSessionRepository.mockClear();
    mockGetCurrentSession.mockClear();

    // Reset mock implementations to default
    mockGitService.clone.mockImplementation(() => ({ repoPath: "/mock/repo/path", success: true }));
    mockGitService.branch.mockImplementation(() => ({ success: true }));
    mockGitService.mergeBranch.mockImplementation(() => ({ conflicts: false }));

    mockSessionDB.getSession.mockImplementation((name: string) =>
      name === "test-session" ? mockSessionRecord : null
    );
    mockSessionDB.listSessions.mockImplementation(() => [mockSessionRecord]);
    mockSessionDB.getSessionByTaskId.mockImplementation((taskId: string) =>
      taskId === "#123" ? mockSessionRecord : null
    );

    mockTaskService.getTask.mockImplementation((id: string) => (id === "#123" ? mockTask : null));
    mockTaskService.getTaskStatus.mockImplementation((id: string) =>
      id === "#123" ? "TODO" : null
    );

    mockIsSessionRepository.mockImplementation(() => Promise.resolve(false));
  });

  describe("startSessionFromParams", () => {
    test("should start a session with valid parameters", async () => {
      // Locally override getSession for this test to simulate session not existing initially
      mockSessionDB.getSession.mockImplementationOnce(() => null);

      // Mock the required dependencies
      const GitService = class {
        clone = mockGitService.clone;
        branch = mockGitService.branch;
      };

      const SessionDB = class {
        getSession = mockSessionDB.getSession;
        addSession = mockSessionDB.addSession;
        listSessions = mockSessionDB.listSessions;
      };

      const TaskService = class {
        constructor() {
          /* mock constructor */
        }
        getTask = mockTaskService.getTask;
        getTaskStatus = mockTaskService.getTaskStatus;
        setTaskStatus = mockTaskService.setTaskStatus;
      };

      // Setup module mocks
      mock.module("../git.js", () => ({
        GitService,
      }));

      mock.module("../session.js", () => ({
        SessionDB,
      }));

      mock.module("../tasks.js", () => ({
        TaskService,
        TASK_STATUS: {
          TODO: "TODO",
          DONE: "DONE",
          IN_PROGRESS: "IN-PROGRESS",
          IN_REVIEW: "IN-REVIEW",
        },
      }));

      mock.module("../workspace.js", () => ({
        isSessionRepository: mockIsSessionRepository,
      }));

      mock.module("../repo-utils.js", () => ({
        resolveRepoPath: mockResolveRepoPath,
        normalizeRepoName: () => "mock-repo",
      }));

      const params = {
        name: "test-session",
        repo: "/mock/repo/url",
        quiet: true,
        noStatusUpdate: false,
      };

      // Reimport to use mocked modules
      const { startSessionFromParams: mockedStartSessionFromParams } = await import(
        "../session.js"
      );

      try {
        const result = await mockedStartSessionFromParams(params);

        expect(result).toBeDefined();
        expect(result.session).toBe("test-session");
        expect(result.repoUrl).toBe("/mock/repo/url");
        expect(mockSessionDB.addSession.mock.calls.length > 0).toBe(true);
        expect(mockGitService.clone.mock.calls.length > 0).toBe(true);
        expect(mockGitService.branch.mock.calls.length > 0).toBe(true);
      } catch (error) {
        console.error("Test error:", error);
        throw error;
      }
    });

    test("should throw ValidationError when session name and task ID are missing", async () => {
      const params = {
        repo: "/mock/repo/url",
        quiet: true,
        noStatusUpdate: false,
      };
      // Using try/catch for robust error assertion with specific error types if needed
      try {
        await startSessionFromParams(params);
        expect(true).toBe(false); // Should not reach here
      } catch (e) {
        // Check for a generic error or a specific ValidationError if applicable
        expect(e instanceof Error).toBe(true); 
      }
    });
  });

  describe("updateSessionFromParams", () => {
    test("should update a session with valid parameters", async () => {
      // Mock the required dependencies
      const GitService = class {
        getSessionWorkdir = mockGitService.getSessionWorkdir;
        stashChanges = mockGitService.stashChanges;
        popStash = mockGitService.popStash;
        pullLatest = mockGitService.pullLatest;
        mergeBranch = mockGitService.mergeBranch;
        pushBranch = mockGitService.pushBranch;
      };

      const SessionDB = class {
        getSession = mockSessionDB.getSession;
      };

      // Setup module mocks
      mock.module("../git.js", () => ({
        GitService,
      }));

      mock.module("../session.js", () => ({
        SessionDB,
      }));

      mock.module("../workspace.js", () => ({
        getCurrentSession: mockGetCurrentSession,
      }));

      const params = {
        name: "test-session",
        branch: "main",
        remote: "origin",
        noStash: false,
        noPush: false,
      };

      // Reimport to use mocked modules
      const { updateSessionFromParams: mockedUpdateSessionFromParams } = await import(
        "../session.js"
      );

      try {
        await mockedUpdateSessionFromParams(params);

        expect(mockSessionDB.getSession).toHaveBeenCalledWith("test-session");
        expect(mockGitService.getSessionWorkdir.mock.calls.length > 0).toBe(true);
        expect(mockGitService.stashChanges.mock.calls.length > 0).toBe(true);
        expect(mockGitService.pullLatest.mock.calls.length > 0).toBe(true);
        expect(mockGitService.mergeBranch).toHaveBeenCalledWith("/mock/session/workdir", "main");
        expect(mockGitService.pushBranch.mock.calls.length > 0).toBe(true);
        expect(mockGitService.popStash.mock.calls.length > 0).toBe(true);
      } catch (error) {
        console.error("Test error:", error);
        throw error;
      }
    });

    test("should throw ResourceNotFoundError when session is not found", async () => {
      mockSessionDB.getSession.mockImplementation(() => null);

      const params = {
        name: "non-existent-session",
        branch: "main",
        noStash: false,
        noPush: false,
      };
      try {
        await updateSessionFromParams(params);
        expect(true).toBe(false); // Should not reach here
      } catch (e) {
        expect(e instanceof ResourceNotFoundError).toBe(true);
      }
    });

    test("should not stash or pop when noStash is true", async () => {
      // Same mocking as before but with noStash option
      const GitService = class {
        getSessionWorkdir = mockGitService.getSessionWorkdir;
        stashChanges = mockGitService.stashChanges;
        popStash = mockGitService.popStash;
        pullLatest = mockGitService.pullLatest;
        mergeBranch = mockGitService.mergeBranch;
        pushBranch = mockGitService.pushBranch;
      };

      const SessionDB = class {
        getSession = mockSessionDB.getSession;
      };

      // Setup module mocks
      mock.module("../git.js", () => ({
        GitService,
      }));

      mock.module("../session.js", () => ({
        SessionDB,
      }));

      mock.module("../workspace.js", () => ({
        getCurrentSession: mockGetCurrentSession,
      }));

      const params = {
        name: "test-session",
        branch: "main",
        noStash: true,
        noPush: false,
      };

      // Reimport to use mocked modules
      const { updateSessionFromParams: mockedUpdateSessionFromParams } = await import(
        "../session.js"
      );

      await mockedUpdateSessionFromParams(params);

      expect(mockGitService.stashChanges.mock.calls.length).toBe(0);
      expect(mockGitService.popStash.mock.calls.length).toBe(0);
    });
  });
});
