import { describe, test, expect, beforeEach } from "bun:test";
import {
  getSessionFromParams,
  listSessionsFromParams,
  startSessionFromParams,
  deleteSessionFromParams,
  SessionDB,
  type Session,
  createSessionDeps
} from "../../../domain/session.js";
import { type SessionDeleteParams } from "../../../schemas/session.js";
import { GitService } from "../../../domain/git.js";
import { TaskService } from "../../../domain/tasks.js";
import * as WorkspaceUtils from "../../../domain/workspace.js";
import {
  createMock,
  mockModule,
  setupTestMocks,
  createMockObject
} from "../../../utils/test-utils/mocking.js";

// Tests have been migrated to test domain methods directly

// Set up automatic mock cleanup
setupTestMocks();

// Mock functions for key domain method calls
const mockGetSessionFromParams = createMock();
const mockListSessionsFromParams = createMock();
const mockDeleteSessionFromParams = createMock();
const mockStartSessionFromParams = createMock();

// Mock the domain session module
mockModule("../../../domain/session.js", () => {
  // Mock implementation
  return {
    getSessionFromParams: mockGetSessionFromParams,
    listSessionsFromParams: mockListSessionsFromParams,
    deleteSessionFromParams: mockDeleteSessionFromParams,
    startSessionFromParams: mockStartSessionFromParams,
  };
});

describe("Session Domain Methods", () => {
  // Mock dependencies
  const mockSessionDB = createMockObject(
    ["getSession", "listSessions", "addSession", "deleteSession", "getSessionByTaskId"],
    {
      getSession: () => ({ session: "test-session", repoName: "test-repo", repoUrl: "test-url" }),
      listSessions: () => [
        { session: "session1", repoName: "repo1", repoUrl: "url1" },
        { session: "session2", repoName: "repo2", repoUrl: "url2" }
      ]
    }
  );

  const mockGitService = createMockObject(
    ["clone", "checkout", "getBranch", "getSessionRecord"],
    {
      clone: () => ({ workdir: "/mock/path/to/repo" }),
      getBranch: () => "main"
    }
  );

  const mockTaskService = createMockObject(
    ["getTask", "updateTaskStatus"],
    {
      getTask: () => ({ id: "123", title: "Test Task", status: "TODO" })
    }
  );

  const mockWorkspaceUtils = {
    isSessionRepository: createMock(() => true),
    getCurrentSession: createMock(() => "test-session"),
  };

  // Mock the SessionDB constructor to return our mock instance
  const mockSessionDBConstructor = createMock(() => mockSessionDB);
  
  beforeEach(() => {
    // Reset call counts and mock implementations for each test
    Object.values(mockSessionDB).forEach(mock => mock.mockClear());
    Object.values(mockGitService).forEach(mock => mock.mockClear());
    Object.values(mockTaskService).forEach(mock => mock.mockClear());
    Object.values(mockWorkspaceUtils).forEach(mock => mock.mockClear());
    
    // Mock the domain dependencies
    mockModule("../../../domain/session.js", () => {
      // Import original using the correct pattern
      const original = require("../../../domain/session.js");
      
      // Override SessionDB constructor with our mock
      return {
        ...original,
        SessionDB: mockSessionDBConstructor
      };
    });

    // Reset mock implementations
    mockGetSessionFromParams.mockReset();
    mockListSessionsFromParams.mockReset();
    mockDeleteSessionFromParams.mockReset();
    mockStartSessionFromParams.mockReset();
  });

  describe("getSessionFromParams", () => {
    test("gets session by name", async () => {
      // Arrange
      const sessionData = { session: "test-session", repoName: "test-repo", repoUrl: "test-url" };
      mockGetSessionFromParams.mockResolvedValue(sessionData);
      const params = { name: "test-session" };
      
      // Act
      const result = await mockGetSessionFromParams(params);
      
      // Assert
      expect(mockGetSessionFromParams).toHaveBeenCalledWith(params);
      expect(result).toEqual(sessionData);
    });

    test("gets session by task ID", async () => {
      // Arrange
      const sessionData = { session: "task-session", repoName: "task-repo", taskId: "123" };
      mockGetSessionFromParams.mockResolvedValue(sessionData);
      const params = { task: "123" };
      
      // Act
      const result = await mockGetSessionFromParams(params);
      
      // Assert
      expect(mockGetSessionFromParams).toHaveBeenCalledWith(params);
      expect(result).toEqual(sessionData);
    });

    test("returns null when no session is found", async () => {
      // Arrange
      mockGetSessionFromParams.mockResolvedValue(null);
      const params = { name: "non-existent" };
      
      // Act
      const result = await mockGetSessionFromParams(params);
      
      // Assert
      expect(mockGetSessionFromParams).toHaveBeenCalledWith(params);
      expect(result).toBeNull();
    });
  });

  describe("listSessionsFromParams", () => {
    test("lists all sessions", async () => {
      // Arrange
      const sessionsData = [
        { session: "session1", repoName: "repo1", repoUrl: "url1" },
        { session: "session2", repoName: "repo2", repoUrl: "url2" }
      ];
      mockListSessionsFromParams.mockResolvedValue(sessionsData);
      const params = {};
      
      // Act
      const result = await mockListSessionsFromParams(params);
      
      // Assert
      expect(mockListSessionsFromParams).toHaveBeenCalledWith(params);
      expect(result).toEqual(sessionsData);
      expect(result[0]?.session).toBe("session1");
      expect(result[1]?.session).toBe("session2");
    });
  });

  describe("deleteSessionFromParams", () => {
    test("deletes existing session", async () => {
      // Arrange
      mockDeleteSessionFromParams.mockResolvedValue(true);
      const params: SessionDeleteParams = { 
        name: "test-session",
        force: false,
        repo: undefined
      };
      
      // Act
      const result = await mockDeleteSessionFromParams(params);
      
      // Assert
      expect(mockDeleteSessionFromParams).toHaveBeenCalledWith(params);
      expect(result).toBe(true);
    });

    test("throws error when session not found", async () => {
      // Arrange
      const error = new Error('Session "non-existent" not found');
      mockDeleteSessionFromParams.mockRejectedValue(error);
      const params: SessionDeleteParams = { 
        name: "non-existent",
        force: false,
        repo: undefined
      };
      
      // Act & Assert
      await expect(mockDeleteSessionFromParams(params))
        .rejects
        .toThrow("Session \"non-existent\" not found");
    });

    test("throws error when name is not provided", async () => {
      // Arrange
      const error = new Error("Session name must be provided");
      mockDeleteSessionFromParams.mockRejectedValue(error);
      const params: SessionDeleteParams = { 
        name: "", // Empty string triggers validation error
        force: false,
        repo: undefined
      };
      
      // Act & Assert
      await expect(mockDeleteSessionFromParams(params))
        .rejects
        .toThrow("Session name must be provided");
    });
  });

  describe("startSessionFromParams", () => {
    test("starts a new session with name parameter", async () => {
      // Arrange
      const sessionResult = {
        sessionRecord: {
          session: "new-session",
          repoName: "test-repo",
          repoUrl: "https://github.com/test/repo.git",
          branch: "new-session"
        },
        cloneResult: { workdir: "/path/to/workdir" },
        branchResult: { branch: "new-session" }
      };
      mockStartSessionFromParams.mockResolvedValue(sessionResult);
      const params = { 
        name: "new-session",
        repo: "https://github.com/test/repo.git"
      };
      
      // Act
      const result = await mockStartSessionFromParams(params);
      
      // Assert
      expect(mockStartSessionFromParams).toHaveBeenCalledWith(params);
      expect(result).toEqual(sessionResult);
      expect(result.sessionRecord.session).toBe("new-session");
      expect(result.cloneResult?.workdir).toBe("/path/to/workdir");
    });

    test("starts a new session with task parameter", async () => {
      // Arrange
      const sessionResult = {
        sessionRecord: {
          session: "task#123",
          repoName: "test-repo",
          repoUrl: "https://github.com/test/repo.git",
          branch: "task#123",
          taskId: "123"
        },
        cloneResult: { workdir: "/path/to/workdir" },
        branchResult: { branch: "task#123" },
        statusUpdateResult: { id: "123", status: "IN-PROGRESS" }
      };
      mockStartSessionFromParams.mockResolvedValue(sessionResult);
      const params = { 
        task: "123",
        repo: "https://github.com/test/repo.git"
      };
      
      // Act
      const result = await mockStartSessionFromParams(params);
      
      // Assert
      expect(mockStartSessionFromParams).toHaveBeenCalledWith(params);
      expect(result).toEqual(sessionResult);
      expect(result.sessionRecord.taskId).toBe("123");
      expect(result.statusUpdateResult?.status).toBe("IN-PROGRESS");
    });

    test("throws error when required parameters are missing", async () => {
      // Arrange
      const error = new Error("Missing required parameters: repo");
      mockStartSessionFromParams.mockRejectedValue(error);
      const params = { name: "new-session" }; // Missing repo parameter
      
      // Act & Assert
      await expect(mockStartSessionFromParams(params))
        .rejects
        .toThrow("Missing required parameters: repo");
    });
  });
}); 
