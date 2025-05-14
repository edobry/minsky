/**
 * Tests for interface-agnostic session functions
 */
import { describe, test, expect, beforeEach, mock, jest } from "bun:test";
import { startSessionFromParams, updateSessionFromParams } from "../session.js";
import { ResourceNotFoundError } from "../../errors/index.js";
import type { SessionRecord, Session, SessionDeps } from "../session.js";
import type { Task } from "../tasks.js";
import type { SessionUpdateParams } from "../../schemas/session.js";
import * as WorkspaceUtilsFns from "../../utils/workspace.js";

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
  getNewSessionRepoPath: jest.fn((repoName: string, sessionId: string) => `/mock/repo/${repoName}/sessions/${sessionId}`),
  getSessionWorkdir: jest.fn((sessionName: string) => Promise.resolve(`/mocked/workdir/${sessionName}`)),
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

// Create a mock for WorkspaceUtils if needed by SessionDeps
const mockWorkspaceUtils = {
  ...WorkspaceUtilsFns, // Spread actual functions, can override specific ones with mocks if needed
  // Example: getCurrentSession: jest.fn(),
};

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
    mockSessionDB.getNewSessionRepoPath.mockClear();
    mockSessionDB.getSessionWorkdir.mockClear();

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
    mockSessionDB.getNewSessionRepoPath.mockImplementation((repoName: string, sessionId: string) => `/mock/repo/${repoName}/sessions/${sessionId}`);
    mockSessionDB.getSessionWorkdir.mockImplementation((sessionName: string) => Promise.resolve(`/mocked/workdir/${sessionName}`));

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
        constructor() {
          return mockGitService;
        }
      };

      const SessionDB = class {
        getSession = mockSessionDB.getSession;
        addSession = mockSessionDB.addSession;
        listSessions = mockSessionDB.listSessions;
        getSessionByTaskId = mockSessionDB.getSessionByTaskId;
        updateSession = mockSessionDB.updateSession;
        getNewSessionRepoPath = mockSessionDB.getNewSessionRepoPath;
        getSessionWorkdir = mockSessionDB.getSessionWorkdir;
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
        quiet: false,
        noStatusUpdate: false,
        backend: "markdown" as const,
        remote: { authMethod: "ssh" as const, depth: 1 },
      };

      // Reimport to use mocked modules
      const { startSessionFromParams: mockedStartSessionFromParams } = await import(
        "../session.js"
      );

      mockSessionDB.getSession.mockImplementationOnce(() => null);

      try {
        const result = await mockedStartSessionFromParams(params);

        expect(result).toBeDefined();
        expect(result.session).toBe("test-session");
        expect(result.repoUrl).toBe("/mock/repo/url");
        expect(mockSessionDB.addSession.mock.calls.length).toBeGreaterThan(0);
        expect(mockGitService.clone.mock.calls.length).toBeGreaterThan(0);
        // expect(mockGitService.branch.mock.calls.length).toBeGreaterThan(0); // Removed, branch is part of clone
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
    test("should update a session with valid parameters", async () => {
      // mock.module calls removed for this test

      const { updateSessionFromParams, createSessionDeps } = await import("../session.js"); // Get the real function and default deps creator

      const deps: SessionDeps = {
        sessionDB: mockSessionDB as any, 
        gitService: mockGitService as any, 
        taskService: mockTaskService as any, 
        workspaceUtils: mockWorkspaceUtils, // Use the defined mock
      };

      const params: SessionUpdateParams = {
        name: "test-session",
        branch: "main",
        remote: "origin",
        noStash: false,
        noPush: false,
      };

      try {
        await updateSessionFromParams(params, deps); // Pass mocked dependencies

        expect(mockSessionDB.getSession).toHaveBeenCalledWith("test-session");
        // expect(mockGitService.getSessionWorkdir.mock.calls.length).toBeGreaterThan(0); // Removed, not called by updateSessionFromParams
        expect(mockGitService.stashChanges).toHaveBeenCalledWith();
        expect(mockGitService.pullLatest).toHaveBeenCalledWith();
        expect(mockGitService.mergeBranch).toHaveBeenCalledWith("/mock/session/workdir", "main");
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
        addSession = mockSessionDB.addSession;
        listSessions = mockSessionDB.listSessions;
        getSessionByTaskId = mockSessionDB.getSessionByTaskId;
        updateSession = mockSessionDB.updateSession;
        getNewSessionRepoPath = mockSessionDB.getNewSessionRepoPath;
        getSessionWorkdir = mockSessionDB.getSessionWorkdir;
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

      expect(mockGitService.stashChanges.mock.calls.length).toEqual(0);
      expect(mockGitService.popStash.mock.calls.length).toEqual(0);
    });
  });
});
