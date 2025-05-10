/**
 * Tests for interface-agnostic git functions
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { 
  createPullRequestFromParams,
  commitChangesFromParams 
} from "../git.js";
import { MinskyError } from "../../errors/index.js";

// Mock dependencies
const mockPrResult = {
  markdown: "# Test PR\n\nThis is a test PR",
  statusUpdateResult: {
    taskId: "#123",
    previousStatus: "TODO",
    newStatus: "IN-REVIEW"
  }
};

// Mock functions
const mockPrFn = mock(() => Promise.resolve(mockPrResult));
const mockCommitFn = mock(() => Promise.resolve("abc123"));
const mockStageAllFn = mock(() => Promise.resolve());
const mockStageModifiedFn = mock(() => Promise.resolve());
const mockGetSessionFn = mock(() => Promise.resolve({
  session: "test-session",
  repoName: "test-repo",
  repoUrl: "/mock/repo/url",
  createdAt: new Date().toISOString(),
  taskId: "#123"
}));
const mockResolveRepoPathFn = mock(() => Promise.resolve("/mock/repo/path"));

describe("interface-agnostic git functions", () => {
  beforeEach(() => {
    // Reset mocks
    mockPrFn.mockReset();
    mockCommitFn.mockReset();
    mockStageAllFn.mockReset();
    mockStageModifiedFn.mockReset();
    mockGetSessionFn.mockReset();
    mockResolveRepoPathFn.mockReset();
    
    // Reset mock implementations to defaults
    mockPrFn.mockImplementation(() => Promise.resolve(mockPrResult));
    mockCommitFn.mockImplementation(() => Promise.resolve("abc123"));
    mockStageAllFn.mockImplementation(() => Promise.resolve());
    mockStageModifiedFn.mockImplementation(() => Promise.resolve());
    mockGetSessionFn.mockImplementation(() => Promise.resolve({
      session: "test-session",
      repoName: "test-repo",
      repoUrl: "/mock/repo/url",
      createdAt: new Date().toISOString(),
      taskId: "#123"
    }));
    mockResolveRepoPathFn.mockImplementation(() => Promise.resolve("/mock/repo/path"));
  });

  describe("createPullRequestFromParams", () => {
    test("should generate a PR with valid parameters", async () => {
      // Mock the required dependencies
      const GitService = class {
        pr = mockPrFn;
      };
      
      // Setup module mocks
      mock.module("../git.js", () => ({
        GitService
      }));
      
      // Reimport to use mocked modules
      const { createPullRequestFromParams: mockedPrFunction } = await import("../git.js");
      
      const params = {
        session: "test-session",
        repo: "/mock/repo/url",
        branch: "feature-branch",
        debug: true,
        noStatusUpdate: false,
        taskId: "#123"
      };
      
      const result = await mockedPrFunction(params);
      
      expect(result).toBeDefined();
      expect(result.markdown).toBe(mockPrResult.markdown);
      expect(mockPrFn).toHaveBeenCalledWith({
        session: "test-session",
        repoPath: "/mock/repo/url",
        branch: "feature-branch",
        debug: true,
        noStatusUpdate: false,
        taskId: "#123"
      });
    });

    test("should handle errors properly", async () => {
      // Mock the GitService to throw an error
      const GitService = class {
        pr = mock(() => { throw new Error("Test error"); });
      };
      
      // Setup module mocks
      mock.module("../git.js", () => ({
        GitService
      }));
      
      // Reimport to use mocked modules
      const { createPullRequestFromParams: mockedPrFunction } = await import("../git.js");
      
      const params = {
        session: "test-session",
        repo: "/mock/repo/url"
      };
      
      try {
        await mockedPrFunction(params);
        expect("Should have thrown").toBe("But did not");
      } catch (error) {
        expect(error).toBeInstanceOf(MinskyError);
      }
    });
  });

  describe("commitChangesFromParams", () => {
    test("should commit changes with valid parameters", async () => {
      // Mock the required dependencies
      const GitService = class {
        stageAll = mockStageAllFn;
        stageModified = mockStageModifiedFn;
        commit = mockCommitFn;
      };
      
      const SessionDB = class {
        getSession = mockGetSessionFn;
      };
      
      // Setup module mocks
      mock.module("../git.js", () => ({
        GitService
      }));
      
      mock.module("../session.js", () => ({
        SessionDB
      }));
      
      mock.module("../repo-utils.js", () => ({
        resolveRepoPath: mockResolveRepoPathFn
      }));
      
      mock.module("../../utils/task-utils.js", () => ({
        normalizeTaskId: (id: string) => id
      }));
      
      // Reimport to use mocked modules
      const { commitChangesFromParams: mockedCommitFunction } = await import("../git.js");
      
      const params = {
        session: "test-session",
        message: "Test commit message",
        all: true,
        amend: false
      };
      
      const result = await mockedCommitFunction(params);
      
      expect(result).toBeDefined();
      expect(result.commitHash).toBe("abc123");
      expect(result.message).toBe("#123: Test commit message");
      expect(mockResolveRepoPathFn).toHaveBeenCalledWith({
        session: "test-session",
        repo: undefined
      });
      expect(mockStageAllFn).toHaveBeenCalledWith("/mock/repo/path");
      expect(mockCommitFn).toHaveBeenCalledWith("#123: Test commit message", "/mock/repo/path", false);
    });

    test("should use stageModified when all is not set", async () => {
      // Mock the required dependencies
      const GitService = class {
        stageAll = mockStageAllFn;
        stageModified = mockStageModifiedFn;
        commit = mockCommitFn;
      };
      
      const SessionDB = class {
        getSession = mockGetSessionFn;
      };
      
      // Setup module mocks
      mock.module("../git.js", () => ({
        GitService
      }));
      
      mock.module("../session.js", () => ({
        SessionDB
      }));
      
      mock.module("../repo-utils.js", () => ({
        resolveRepoPath: mockResolveRepoPathFn
      }));
      
      mock.module("../../utils/task-utils.js", () => ({
        normalizeTaskId: (id: string) => id
      }));
      
      // Reimport to use mocked modules
      const { commitChangesFromParams: mockedCommitFunction } = await import("../git.js");
      
      const params = {
        session: "test-session",
        message: "Test commit message",
        all: false,
        amend: false
      };
      
      await mockedCommitFunction(params);
      
      expect(mockStageModifiedFn).toHaveBeenCalledWith("/mock/repo/path");
      expect(mockStageAllFn).not.toHaveBeenCalled();
    });

    test("should not stage when noStage is set", async () => {
      // Mock the required dependencies
      const GitService = class {
        stageAll = mockStageAllFn;
        stageModified = mockStageModifiedFn;
        commit = mockCommitFn;
      };
      
      const SessionDB = class {
        getSession = mockGetSessionFn;
      };
      
      // Setup module mocks
      mock.module("../git.js", () => ({
        GitService
      }));
      
      mock.module("../session.js", () => ({
        SessionDB
      }));
      
      mock.module("../repo-utils.js", () => ({
        resolveRepoPath: mockResolveRepoPathFn
      }));
      
      mock.module("../../utils/task-utils.js", () => ({
        normalizeTaskId: (id: string) => id
      }));
      
      // Reimport to use mocked modules
      const { commitChangesFromParams: mockedCommitFunction } = await import("../git.js");
      
      const params = {
        session: "test-session",
        message: "Test commit message",
        noStage: true
      };
      
      await mockedCommitFunction(params);
      
      expect(mockStageModifiedFn).not.toHaveBeenCalled();
      expect(mockStageAllFn).not.toHaveBeenCalled();
    });

    test("should handle errors properly", async () => {
      // Setup module mocks with error
      mock.module("../repo-utils.js", () => ({
        resolveRepoPath: () => { throw new Error("Test error"); }
      }));
      
      // Reimport to use mocked modules
      const { commitChangesFromParams: mockedCommitFunction } = await import("../git.js");
      
      const params = {
        message: "Test commit message"
      };
      
      try {
        await mockedCommitFunction(params);
        expect("Should have thrown").toBe("But did not");
      } catch (error) {
        expect(error).toBeInstanceOf(MinskyError);
      }
    });
  });
}); 
