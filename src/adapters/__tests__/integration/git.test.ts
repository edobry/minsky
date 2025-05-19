import { describe, test, expect, beforeEach } from "bun:test";
import {
  createPullRequestFromParams,
  commitChangesFromParams
} from "../../../domain/git.js";
import {
  createMock,
  mockModule,
  setupTestMocks
} from "../../../utils/test-utils/mocking.js";

// Set up automatic mock cleanup
setupTestMocks();

// Mock the core Git functions
const mockCreatePullRequestFromParams = createMock();
const mockCommitChangesFromParams = createMock();

// Mock the Git module
mockModule("../../../domain/git.js", () => {
  return {
    createPullRequestFromParams: mockCreatePullRequestFromParams,
    commitChangesFromParams: mockCommitChangesFromParams
  };
});

describe("Git Domain Methods", () => {
  beforeEach(() => {
    // Reset all mocks before each test
    mockCreatePullRequestFromParams.mockReset();
    mockCommitChangesFromParams.mockReset();
  });

  describe("createPullRequestFromParams", () => {
    test("creates pull request markdown", async () => {
      // Arrange
      const params = {
        session: "test-session",
        repo: "/path/to/repo"
      };
      
      const expectedResult = {
        markdown: "# Pull Request\n\nThis is a PR description"
      };
      
      mockCreatePullRequestFromParams.mockResolvedValue(expectedResult);
      
      // Act
      const result = await createPullRequestFromParams(params);
      
      // Assert
      expect(mockCreatePullRequestFromParams).toHaveBeenCalledWith(params);
      expect(result).toEqual(expectedResult);
      expect(result.markdown).toContain("Pull Request");
    });

    test("updates task status when creating pull request", async () => {
      // Arrange
      const params = {
        session: "test-session",
        taskId: "123"
      };
      
      const expectedResult = {
        markdown: "# Pull Request\n\nThis is a PR description",
        statusUpdateResult: {
          taskId: "123",
          previousStatus: "IN-PROGRESS",
          newStatus: "IN-REVIEW"
        }
      };
      
      mockCreatePullRequestFromParams.mockResolvedValue(expectedResult);
      
      // Act
      const result = await createPullRequestFromParams(params);
      
      // Assert
      expect(mockCreatePullRequestFromParams).toHaveBeenCalledWith(params);
      expect(result.statusUpdateResult?.taskId).toBe("123");
      expect(result.statusUpdateResult?.newStatus).toBe("IN-REVIEW");
    });
  });

  describe("commitChangesFromParams", () => {
    test("commits staged changes", async () => {
      // Arrange
      const params = {
        message: "feat: add new feature",
        session: "test-session"
      };
      
      const expectedResult = {
        commitHash: "abc123",
        message: "feat: add new feature"
      };
      
      mockCommitChangesFromParams.mockResolvedValue(expectedResult);
      
      // Act
      const result = await commitChangesFromParams(params);
      
      // Assert
      expect(mockCommitChangesFromParams).toHaveBeenCalledWith(params);
      expect(result).toEqual(expectedResult);
      expect(result.commitHash).toBe("abc123");
    });

    test("stages and commits all changes", async () => {
      // Arrange
      const params = {
        message: "fix: bug fixes",
        session: "test-session",
        all: true
      };
      
      const expectedResult = {
        commitHash: "def456",
        message: "fix: bug fixes"
      };
      
      mockCommitChangesFromParams.mockResolvedValue(expectedResult);
      
      // Act
      const result = await commitChangesFromParams(params);
      
      // Assert
      expect(mockCommitChangesFromParams).toHaveBeenCalledWith(params);
      expect(result).toEqual(expectedResult);
    });

    test("handles custom repo path", async () => {
      // Arrange
      const params = {
        message: "chore: update config",
        repo: "/custom/repo/path"
      };
      
      const expectedResult = {
        commitHash: "789abc",
        message: "chore: update config"
      };
      
      mockCommitChangesFromParams.mockResolvedValue(expectedResult);
      
      // Act
      const result = await commitChangesFromParams(params);
      
      // Assert
      expect(mockCommitChangesFromParams).toHaveBeenCalledWith(params);
      expect(result).toEqual(expectedResult);
    });

    test("throws error when commit fails", async () => {
      // Arrange
      const params = {
        message: "invalid commit",
        session: "invalid-session"
      };
      
      const error = new Error("Failed to commit changes");
      mockCommitChangesFromParams.mockRejectedValue(error);
      
      // Act & Assert
      await expect(commitChangesFromParams(params)).rejects.toThrow("Failed to commit changes");
    });
  });
}); 
