/**
 * Basic tests for GitHub Repository Backend
 * 
 * This is a simplified test file that tests only key aspects of the GitHub backend
 * to avoid dependency issues with winston and other modules.
 */
import { describe, test, expect, mock } from "bun:test";
import { GitHubBackend } from "../repository/github.js";
import type { RepositoryBackendConfig } from "../repository/index.js";

// Mock out all the core dependencies
mock.module("../session.js", () => ({
  SessionDB: mock.fn(() => ({
    listSessions: mock.fn(),
    getSession: mock.fn()
  }))
}));

mock.module("../git.js", () => ({
  GitService: mock.fn(() => ({
    clone: mock.fn(),
    push: mock.fn(),
    pullLatest: mock.fn(),
    getStatus: mock.fn()
  }))
}));

mock.module("child_process", () => ({
  exec: mock.fn()
}));

mock.module("fs/promises", () => ({
  mkdir: mock.fn()
}));

// Mock logger
mock.module("../../utils/logger.js", () => ({
  log: {
    debug: mock.fn(),
    error: mock.fn(),
    warn: mock.fn(),
    agent: mock.fn(),
    cli: mock.fn(),
    cliWarn: mock.fn(),
    cliError: mock.fn(),
    setLevel: mock.fn(),
    cliDebug: mock.fn()
  }
}));

// Just test basic functionality
describe("GitHub Repository Backend - Basic Tests", () => {
  describe("constructor", () => {
    test("should initialize with repository URL", () => {
      // Arrange & Act
      const backend = new GitHubBackend({
        type: "github",
        repoUrl: "https://github.com/user/repo.git"
      });

      // Assert
      expect(backend.getType()).toBe("github");
    });

    test("should initialize with owner and repo details", () => {
      // Arrange & Act
      const backend = new GitHubBackend({
        type: "github",
        repoUrl: "https://github.com/user/repo.git",
        github: {
          owner: "user",
          repo: "repo"
        }
      });

      // Assert
      expect(backend.getType()).toBe("github");
    });

    test("should throw error when repository URL is missing", () => {
      // Arrange & Act
      let error: Error | undefined;
      
      try {
        new GitHubBackend({
          type: "github",
          repoUrl: "" // Empty URL
        });
      } catch (e) {
        error = e as Error;
      }
      
      // Assert
      expect(error).toBeDefined();
      expect(error?.message).toContain("Repository URL is required");
    });
  });

  describe("getConfig", () => {
    test("should return the repository configuration", () => {
      // Arrange
      const config: RepositoryBackendConfig = {
        type: "github",
        repoUrl: "https://github.com/user/repo.git",
        github: {
          owner: "user",
          repo: "repo"
        }
      };
      
      const backend = new GitHubBackend(config);

      // Act
      const result = backend.getConfig();

      // Assert
      expect(result.type).toBe("github");
      expect(result.repoUrl).toBe("https://github.com/user/repo.git");
      expect(result.github?.owner).toBe("user");
      expect(result.github?.repo).toBe("repo");
    });
  });
}); 
