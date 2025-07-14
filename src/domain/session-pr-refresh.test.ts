import { describe, it, expect, beforeEach, jest } from "bun:test";
import { sessionPrFromParams } from "./session";
import { MinskyError, ValidationError } from "../errors/index";

// Mock dependencies
const mockGitService = {
  getCurrentBranch: jest.fn(),
  hasUncommittedChanges: jest.fn(),
  getStatus: jest.fn(),
  execInRepository: jest.fn(),
};

const mockSessionProvider = {
  getSession: jest.fn(),
  getSessionByTaskId: jest.fn(),
};

const mockPreparePrFromParams = jest.fn();

// Mock the preparePrFromParams function
jest.mock("../git.js", () => ({
  preparePrFromParams: mockPreparePrFromParams,
}));

jest.mock("../session.js", () => ({
  ...jest.requireActual("../session.js"),
  createGitService: () => mockGitService,
  createSessionProvider: () => mockSessionProvider,
}));

describe("Session PR Refresh Functionality", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Setup default mocks
    mockGitService.getCurrentBranch.mockResolvedValue("task#231");
    mockGitService.hasUncommittedChanges.mockResolvedValue(false);
    mockSessionProvider.getSession.mockResolvedValue({
      session: "task#231",
      taskId: "231",
      repoUrl: "/test/repo",
    });
    
    // Mock process.cwd to return a session workspace path
    const originalCwd = process.cwd;
    process.cwd = jest.fn().mockReturnValue("/Users/test/.local/state/minsky/sessions/task#231");
    
    // Restore after tests
    afterEach(() => {
      process.cwd = originalCwd;
    });
  });

  describe("PR Branch Detection Logic", () => {
    it("should refresh existing PR when no title provided", async () => {
      // Mock PR branch exists
      mockGitService.execInRepository
        .mockResolvedValueOnce("not-exists") // local branch check
        .mockResolvedValueOnce("refs/heads/pr/task#231\torigin/pr/task#231") // remote branch check
        .mockResolvedValueOnce("") // fetch command
        .mockResolvedValueOnce("feat(#231): Initial implementation\n\nThis is the PR body"); // get commit message

      mockPreparePrFromParams.mockResolvedValue({
        prBranch: "pr/task#231",
        baseBranch: "main",
        title: "feat(#231): Initial implementation",
        body: "This is the PR body",
      });

      const result = await sessionPrFromParams({
        session: "task#231",
        // No title provided - should reuse existing
      });

      expect(mockPreparePrFromParams).toHaveBeenCalledWith({
        session: "task#231",
        title: "feat(#231): Initial implementation",
        body: "This is the PR body",
        baseBranch: undefined,
        debug: undefined,
      });

      expect(result.title).toBe("feat(#231): Initial implementation");
      expect(result.body).toBe("This is the PR body");
    });

    it("should update existing PR when new title provided", async () => {
      // Mock PR branch exists
      mockGitService.execInRepository
        .mockResolvedValueOnce("not-exists") // local branch check
        .mockResolvedValueOnce("refs/heads/pr/task#231\torigin/pr/task#231"); // remote branch check

      mockPreparePrFromParams.mockResolvedValue({
        prBranch: "pr/task#231",
        baseBranch: "main",
        title: "feat(#231): Updated implementation",
        body: "Updated body",
      });

      const result = await sessionPrFromParams({
        session: "task#231",
        title: "feat(#231): Updated implementation",
        body: "Updated body",
      });

      expect(mockPreparePrFromParams).toHaveBeenCalledWith({
        session: "task#231",
        title: "feat(#231): Updated implementation",
        body: "Updated body",
        baseBranch: undefined,
        debug: undefined,
      });

      expect(result.title).toBe("feat(#231): Updated implementation");
    });

    it("should create new PR when no existing PR and title provided", async () => {
      // Mock PR branch doesn't exist
      mockGitService.execInRepository
        .mockResolvedValueOnce("not-exists") // local branch check
        .mockResolvedValueOnce(""); // remote branch check (empty = doesn't exist)

      mockPreparePrFromParams.mockResolvedValue({
        prBranch: "pr/task#231",
        baseBranch: "main",
        title: "feat(#231): New implementation",
        body: "New body",
      });

      const result = await sessionPrFromParams({
        session: "task#231",
        title: "feat(#231): New implementation",
        body: "New body",
      });

      expect(mockPreparePrFromParams).toHaveBeenCalledWith({
        session: "task#231",
        title: "feat(#231): New implementation",
        body: "New body",
        baseBranch: undefined,
        debug: undefined,
      });
    });

    it("should error when no existing PR and no title provided", async () => {
      // Mock PR branch doesn't exist
      mockGitService.execInRepository
        .mockResolvedValueOnce("not-exists") // local branch check
        .mockResolvedValueOnce(""); // remote branch check (empty = doesn't exist)

      await expect(sessionPrFromParams({
        session: "task#231",
        // No title provided and no existing PR
      })).rejects.toThrow(MinskyError);

      await expect(sessionPrFromParams({
        session: "task#231",
      })).rejects.toThrow("PR branch pr/task#231 doesn't exist. Please provide --title for initial PR creation.");
    });

    it("should error when PR exists but cannot extract description", async () => {
      // Mock PR branch exists but description extraction fails
      mockGitService.execInRepository
        .mockResolvedValueOnce("not-exists") // local branch check
        .mockResolvedValueOnce("refs/heads/pr/task#231\torigin/pr/task#231") // remote branch check
        .mockResolvedValueOnce("") // fetch command
        .mockRejectedValueOnce(new Error("Git command failed")); // get commit message fails

      await expect(sessionPrFromParams({
        session: "task#231",
        // No title provided
      })).rejects.toThrow("PR branch pr/task#231 exists but could not extract existing title/body. Please provide --title explicitly.");
    });
  });

  describe("Title/Body Extraction", () => {
    it("should correctly parse commit message with title and body", async () => {
      // Mock PR branch exists with multi-line commit message
      mockGitService.execInRepository
        .mockResolvedValueOnce("not-exists") // local branch check
        .mockResolvedValueOnce("refs/heads/pr/task#231\torigin/pr/task#231") // remote branch check
        .mockResolvedValueOnce("") // fetch command
        .mockResolvedValueOnce("feat(#231): Add new feature\n\nThis is the detailed description\nwith multiple lines"); // get commit message

      mockPreparePrFromParams.mockResolvedValue({
        prBranch: "pr/task#231",
        baseBranch: "main",
        title: "feat(#231): Add new feature",
        body: "This is the detailed description\nwith multiple lines",
      });

      const result = await sessionPrFromParams({
        session: "task#231",
      });

      expect(result.title).toBe("feat(#231): Add new feature");
      expect(result.body).toBe("This is the detailed description\nwith multiple lines");
    });

    it("should handle commit message with title only", async () => {
      // Mock PR branch exists with single-line commit message
      mockGitService.execInRepository
        .mockResolvedValueOnce("not-exists") // local branch check
        .mockResolvedValueOnce("refs/heads/pr/task#231\torigin/pr/task#231") // remote branch check
        .mockResolvedValueOnce("") // fetch command
        .mockResolvedValueOnce("feat(#231): Simple title only"); // get commit message

      mockPreparePrFromParams.mockResolvedValue({
        prBranch: "pr/task#231",
        baseBranch: "main",
        title: "feat(#231): Simple title only",
        body: "",
      });

      const result = await sessionPrFromParams({
        session: "task#231",
      });

      expect(result.title).toBe("feat(#231): Simple title only");
      expect(result.body).toBe("");
    });
  });

  describe("Schema Validation", () => {
    it("should accept optional title parameter", async () => {
      // Mock PR branch exists
      mockGitService.execInRepository
        .mockResolvedValueOnce("not-exists") // local branch check
        .mockResolvedValueOnce("refs/heads/pr/task#231\torigin/pr/task#231") // remote branch check
        .mockResolvedValueOnce("") // fetch command
        .mockResolvedValueOnce("feat(#231): Existing title\n\nExisting body"); // get commit message

      mockPreparePrFromParams.mockResolvedValue({
        prBranch: "pr/task#231",
        baseBranch: "main",
        title: "feat(#231): Existing title",
        body: "Existing body",
      });

      // Should not throw validation error for missing title
      await expect(sessionPrFromParams({
        session: "task#231",
      })).resolves.toBeDefined();
    });

    it("should still validate required parameters", async () => {
      // Should throw validation error for completely empty params
      await expect(sessionPrFromParams({
        // No session, no task, no title
      })).rejects.toThrow();
    });
  });
}); 
