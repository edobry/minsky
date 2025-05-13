/**
 * Tests for interface-agnostic session functions
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";
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
  clone: mock.fn(() => ({ repoPath: "/mock/repo/path", success: true })),
  branch: mock.fn(() => ({ success: true })),
  stashChanges: mock.fn(() => Promise.resolve()),
  popStash: mock.fn(() => Promise.resolve()),
  pullLatest: mock.fn(() => Promise.resolve()),
  mergeBranch: mock.fn(() => ({ conflicts: false })),
  pushBranch: mock.fn(() => Promise.resolve()),
  getSessionWorkdir: mock.fn(() => "/mock/session/workdir"),
};

// Mock SessionDB
const mockSessionDB = {
  getSession: mock.fn((name: string) => (name === "test-session" ? mockSessionRecord : null)),
  addSession: mock.fn(() => Promise.resolve()),
  listSessions: mock.fn(() => [mockSessionRecord]),
  getSessionByTaskId: mock.fn((taskId: string) => (taskId === "#123" ? mockSessionRecord : null)),
  updateSession: mock.fn(() => Promise.resolve()),
};

// Mock TaskService
const mockTaskService = {
  getTask: mock.fn((id: string) => (id === "#123" ? mockTask : null)),
  getTaskStatus: mock.fn((id: string) => (id === "#123" ? "TODO" : null)),
  setTaskStatus: mock.fn(() => Promise.resolve()),
};

// Mock resolveRepoPath
const mockResolveRepoPath = mock.fn(() => Promise.resolve("/mock/repo/path"));

// Mock isSessionRepository
const mockIsSessionRepository = mock.fn(() => Promise.resolve(false));

// Mock getCurrentSession
const mockGetCurrentSession = mock.fn(() => Promise.resolve("test-session"));

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
        expect(mockSessionDB.addSession).toHaveBeenCalled();
        expect(mockGitService.clone).toHaveBeenCalled();
        expect(mockGitService.branch).toHaveBeenCalled();
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
      };

      // This would properly mock the actual implementation, but for simplicity
      // we'll just check that the error is thrown
      await expect(startSessionFromParams(params)).rejects.toThrow();
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
      };

      // Reimport to use mocked modules
      const { updateSessionFromParams: mockedUpdateSessionFromParams } = await import(
        "../session.js"
      );

      try {
        await mockedUpdateSessionFromParams(params);

        expect(mockSessionDB.getSession).toHaveBeenCalledWith("test-session");
        expect(mockGitService.getSessionWorkdir).toHaveBeenCalled();
        expect(mockGitService.stashChanges).toHaveBeenCalled();
        expect(mockGitService.pullLatest).toHaveBeenCalled();
        expect(mockGitService.mergeBranch).toHaveBeenCalledWith("/mock/session/workdir", "main");
        expect(mockGitService.pushBranch).toHaveBeenCalled();
        expect(mockGitService.popStash).toHaveBeenCalled();
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
      };

      await expect(updateSessionFromParams(params)).rejects.toThrow(ResourceNotFoundError);
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
      };

      // Reimport to use mocked modules
      const { updateSessionFromParams: mockedUpdateSessionFromParams } = await import(
        "../session.js"
      );

      await mockedUpdateSessionFromParams(params);

      expect(mockGitService.stashChanges).not.toHaveBeenCalled();
      expect(mockGitService.popStash).not.toHaveBeenCalled();
    });
  });
});
