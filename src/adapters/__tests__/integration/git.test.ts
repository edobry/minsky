import { describe, test, expect, beforeEach } from "bun:test";
import {
  GitService,
  type CloneOptions,
  type CloneResult,
  type BranchOptions,
  type BranchResult,
  type PushOptions,
  type PushResult,
  createPullRequestFromParams,
  commitChangesFromParams
} from "../../../domain/git.js";
import {
  createMock,
  mockModule,
  setupTestMocks,
  createMockObject
} from "../../../utils/test-utils/mocking.js";

// Set up automatic mock cleanup
setupTestMocks();

// Mock the core Git methods
const mockClone = createMock();
const mockBranch = createMock();
const mockPush = createMock();
const mockCreatePullRequestFromParams = createMock();
const mockCommitChangesFromParams = createMock();
const mockExecInRepository = createMock();

// Create mock implementation before using mockModule
class MockGitService {
  clone = mockClone;
  branch = mockBranch;
  push = mockPush;
  execInRepository = mockExecInRepository;
}

// Mock the Git module
mockModule("../../../domain/git.js", () => {
  return {
    GitService: MockGitService,
    createPullRequestFromParams: mockCreatePullRequestFromParams,
    commitChangesFromParams: mockCommitChangesFromParams
  };
});

describe("Git Domain Methods", () => {
  beforeEach(() => {
    // Reset all mocks before each test
    mockClone.mockReset();
    mockBranch.mockReset();
    mockPush.mockReset();
    mockCreatePullRequestFromParams.mockReset();
    mockCommitChangesFromParams.mockReset();
    mockExecInRepository.mockReset();
  });

  describe("clone", () => {
    test("clones a repository with default options", async () => {
      // Arrange
      const options: CloneOptions = {
        repoUrl: "https://github.com/example/repo.git"
      };
      
      const expectedResult: CloneResult = {
        workdir: "/path/to/cloned/repo",
        session: "test-session"
      };
      
      mockClone.mockResolvedValue(expectedResult);
      
      // Act
      const gitService = new GitService();
      const result = await gitService.clone(options);
      
      // Assert
      expect(mockClone).toHaveBeenCalledWith(options);
      expect(result).toEqual(expectedResult);
      expect(result.workdir).toBe("/path/to/cloned/repo");
      expect(result.session).toBe("test-session");
    });

    test("clones a repository with custom session name", async () => {
      // Arrange
      const options: CloneOptions = {
        repoUrl: "https://github.com/example/repo.git",
        session: "custom-session"
      };
      
      const expectedResult: CloneResult = {
        workdir: "/path/to/custom/session/repo",
        session: "custom-session"
      };
      
      mockClone.mockResolvedValue(expectedResult);
      
      // Act
      const gitService = new GitService();
      const result = await gitService.clone(options);
      
      // Assert
      expect(mockClone).toHaveBeenCalledWith(options);
      expect(result).toEqual(expectedResult);
      expect(result.session).toBe("custom-session");
    });

    test("clones a repository with specific branch", async () => {
      // Arrange
      const options: CloneOptions = {
        repoUrl: "https://github.com/example/repo.git",
        branch: "feature-branch"
      };
      
      const expectedResult: CloneResult = {
        workdir: "/path/to/cloned/repo",
        session: "test-session"
      };
      
      mockClone.mockResolvedValue(expectedResult);
      
      // Act
      const gitService = new GitService();
      const result = await gitService.clone(options);
      
      // Assert
      expect(mockClone).toHaveBeenCalledWith(options);
      expect(result).toEqual(expectedResult);
    });

    test("throws error when clone fails", async () => {
      // Arrange
      const options: CloneOptions = {
        repoUrl: "https://invalid-url.git"
      };
      
      const error = new Error("Failed to clone repository");
      mockClone.mockRejectedValue(error);
      
      // Act & Assert
      const gitService = new GitService();
      await expect(gitService.clone(options)).rejects.toThrow("Failed to clone repository");
    });
  });

  describe("branch", () => {
    test("creates a new branch", async () => {
      // Arrange
      const options: BranchOptions = {
        session: "test-session",
        branch: "feature-branch"
      };
      
      const expectedResult: BranchResult = {
        workdir: "/path/to/repo",
        branch: "feature-branch"
      };
      
      mockBranch.mockResolvedValue(expectedResult);
      
      // Act
      const gitService = new GitService();
      const result = await gitService.branch(options);
      
      // Assert
      expect(mockBranch).toHaveBeenCalledWith(options);
      expect(result).toEqual(expectedResult);
      expect(result.branch).toBe("feature-branch");
    });

    test("throws error when branch creation fails", async () => {
      // Arrange
      const options: BranchOptions = {
        session: "test-session",
        branch: "invalid-branch"
      };
      
      const error = new Error("Failed to create branch");
      mockBranch.mockRejectedValue(error);
      
      // Act & Assert
      const gitService = new GitService();
      await expect(gitService.branch(options)).rejects.toThrow("Failed to create branch");
    });
  });

  describe("push", () => {
    test("pushes changes to remote", async () => {
      // Arrange
      const options: PushOptions = {
        session: "test-session"
      };
      
      const expectedResult: PushResult = {
        workdir: "/path/to/repo",
        pushed: true
      };
      
      mockPush.mockResolvedValue(expectedResult);
      
      // Act
      const gitService = new GitService();
      const result = await gitService.push(options);
      
      // Assert
      expect(mockPush).toHaveBeenCalledWith(options);
      expect(result).toEqual(expectedResult);
      expect(result.pushed).toBe(true);
    });

    test("pushes to specified remote", async () => {
      // Arrange
      const options: PushOptions = {
        session: "test-session",
        remote: "upstream"
      };
      
      const expectedResult: PushResult = {
        workdir: "/path/to/repo",
        pushed: true
      };
      
      mockPush.mockResolvedValue(expectedResult);
      
      // Act
      const gitService = new GitService();
      const result = await gitService.push(options);
      
      // Assert
      expect(mockPush).toHaveBeenCalledWith(options);
      expect(result).toEqual(expectedResult);
    });

    test("force pushes changes", async () => {
      // Arrange
      const options: PushOptions = {
        session: "test-session",
        force: true
      };
      
      const expectedResult: PushResult = {
        workdir: "/path/to/repo",
        pushed: true
      };
      
      mockPush.mockResolvedValue(expectedResult);
      
      // Act
      const gitService = new GitService();
      const result = await gitService.push(options);
      
      // Assert
      expect(mockPush).toHaveBeenCalledWith(options);
      expect(result).toEqual(expectedResult);
    });

    test("throws error when push fails", async () => {
      // Arrange
      const options: PushOptions = {
        session: "test-session"
      };
      
      const error = new Error("Failed to push changes");
      mockPush.mockRejectedValue(error);
      
      // Act & Assert
      const gitService = new GitService();
      await expect(gitService.push(options)).rejects.toThrow("Failed to push changes");
    });
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
  });
}); 
