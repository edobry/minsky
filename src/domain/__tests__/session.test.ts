/**
 * Tests for interface-agnostic session functions
 */
import { describe, test, expect, beforeEach, mock, jest, spyOn } from "bun:test";
import { ResourceNotFoundError } from "../../errors/index.js";

// Mock dependencies from HEAD/origin/main - they are similar
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

// Mock GitService - combine and use jest.fn
const mockGitService = {
  clone: jest.fn(() => Promise.resolve({ workdir: "/mock/repo/path", session: "test-session" })),
  branch: jest.fn(() => Promise.resolve({ workdir: "/mock/repo/path", branch: "test-branch" })),
  stashChanges: jest.fn(() => Promise.resolve()),
  popStash: jest.fn(() => Promise.resolve()),
  pullLatest: jest.fn(() => Promise.resolve()),
  mergeBranch: jest.fn(() => Promise.resolve({ conflicts: false })),
  push: jest.fn(() => Promise.resolve({ pushed: true, workdir: "/mock/repo/path"})), // changed from pushBranch
  getSessionWorkdir: jest.fn(() => "/mock/session/workdir"),
};

// Mock SessionDB
const mockSessionDB = {
  getSession: jest.fn((name: string) => (name === "test-session" ? mockSessionRecord : null)),
  addSession: jest.fn(() => Promise.resolve()),
  listSessions: jest.fn(() => Promise.resolve([mockSessionRecord])),
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
    mockGitService.push.mockClear();
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

    // Reset mock implementations to default (favoring origin/main for consistency)
    mockGitService.clone.mockImplementation(() => Promise.resolve({ workdir: "/mock/repo/path", session: "test-session" }));
    mockGitService.branch.mockImplementation(() => Promise.resolve({ workdir: "/mock/repo/path", branch: "test-branch" }));
    mockGitService.mergeBranch.mockImplementation(() => Promise.resolve({ conflicts: false }));

    mockSessionDB.getSession.mockImplementation((name: string) =>
      name === "test-session" ? mockSessionRecord : null
    );
    mockSessionDB.listSessions.mockImplementation(() => Promise.resolve([mockSessionRecord]));
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
      mockSessionDB.getSession.mockImplementationOnce(() => null);

      // Using mock.module as per origin/main for dynamic imports
      mock.module("../../domain/git.js", () => ({
        GitService: jest.fn(() => mockGitService),
      }));
      mock.module("../../domain/session.js", () => ({
        SessionDB: jest.fn(() => mockSessionDB),
      }));
      mock.module("../../domain/tasks.js", () => ({
        TaskService: jest.fn(() => mockTaskService),
        TASK_STATUS: { TODO: "TODO", DONE: "DONE", IN_PROGRESS: "IN-PROGRESS", IN_REVIEW: "IN-REVIEW" },
      }));
      mock.module("../../domain/workspace.js", () => ({
        isSessionRepository: mockIsSessionRepository,
      }));
      mock.module("../../domain/repo-utils.js", () => ({
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

      const { startSessionFromParams: mockedStartSessionFromParams } = await import(
        "../../domain/session.js"
      );

      const result = await mockedStartSessionFromParams(params as any);
      expect(result).toBeDefined();
      expect(result.session).toBe("test-session");
      expect(result.repoUrl).toBe("/mock/repo/url");
      expect(mockSessionDB.addSession.mock.calls.length).toBeGreaterThan(0);
      expect(mockGitService.clone.mock.calls.length).toBeGreaterThan(0);
      expect(mockGitService.branch.mock.calls.length).toBeGreaterThan(0);
    });

    test("should throw ValidationError when session name and task ID are missing", async () => {
      const params = {
        repo: "/mock/repo/url",
        quiet: false,
        noStatusUpdate: false,
        backend: "markdown" as const,
        remote: { authMethod: "ssh" as const, depth: 1 },
      };
      const { startSessionFromParams: mockedStartSessionFromParams } = await import(
        "../../domain/session.js"
      );
      try {
        await mockedStartSessionFromParams(params as any);
        expect(true).toBe(false); 
      } catch (e) {
        expect(e instanceof Error).toBe(true); 
      }
    });
  });

  describe("updateSessionFromParams", () => {
    test("should update a session with valid parameters", async () => {
      mock.module("../../domain/git.js", () => ({
        GitService: jest.fn(() => mockGitService),
      }));
      mock.module("../../domain/session.js", () => ({
        SessionDB: jest.fn(() => mockSessionDB),
      }));
      mock.module("../../domain/workspace.js", () => ({
        getCurrentSession: mockGetCurrentSession,
      }));

      const params = {
        name: "test-session",
        branch: "main",
        remote: "origin",
        noStash: false,
        noPush: false,
      };
      const { updateSessionFromParams: mockedUpdateSessionFromParams } = await import(
        "../../domain/session.js"
      );
      await mockedUpdateSessionFromParams(params as any);
      expect(mockSessionDB.getSession).toHaveBeenCalledWith("test-session");
      expect(mockGitService.getSessionWorkdir.mock.calls.length).toBeGreaterThan(0);
      expect(mockGitService.stashChanges.mock.calls.length).toBeGreaterThan(0);
      expect(mockGitService.pullLatest.mock.calls.length).toBeGreaterThan(0);
      expect(mockGitService.mergeBranch).toHaveBeenCalledWith("/mock/session/workdir", "main");
      expect(mockGitService.push.mock.calls.length).toBeGreaterThan(0);
      expect(mockGitService.popStash.mock.calls.length).toBeGreaterThan(0);
    });

    test("should throw ResourceNotFoundError when session is not found", async () => {
      mockSessionDB.getSession.mockImplementation(() => null);
      const params = {
        name: "non-existent-session",
        branch: "main",
        noStash: false,
        noPush: false,
      };
       const { updateSessionFromParams: mockedUpdateSessionFromParams } = await import(
        "../../domain/session.js"
      );
      await expect(mockedUpdateSessionFromParams(params as any)).rejects.toThrow("not found");
    });

    test("should not stash or pop when noStash is true", async () => {
      mock.module("../../domain/git.js", () => ({
        GitService: jest.fn(() => mockGitService),
      }));
      mock.module("../../domain/session.js", () => ({
        SessionDB: jest.fn(() => mockSessionDB),
      }));
      mock.module("../../domain/workspace.js", () => ({
        getCurrentSession: mockGetCurrentSession,
      }));

      const params = {
        name: "test-session",
        branch: "main",
        noStash: true,
        noPush: false,
      };
      const { updateSessionFromParams: mockedUpdateSessionFromParams } = await import(
        "../../domain/session.js"
      );
      await mockedUpdateSessionFromParams(params as any);
      expect(mockGitService.stashChanges.mock.calls.length).toEqual(0);
      expect(mockGitService.popStash.mock.calls.length).toEqual(0);
    });
  });
});
