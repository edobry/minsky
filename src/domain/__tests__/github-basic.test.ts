/**
 * NOTE: These tests are temporarily disabled due to issues with mocking in Bun environment.
 * 
 * The GitHub backend basic tests require proper mocking which is not working correctly.
 * 
 * This test suite will be reimplemented after improving the test utilities.
 */
import { describe, test, expect, mock } from "bun:test";
import { GitHubBackend } from "../repository/github.js";

describe("GitHub Basic Functionality", () => {
  test("initializes with correct repository URL", () => {
    const repoUrl = "https://github.com/username/repo.git";
    const backend = new GitHubBackend({
      type: "github",
      repoUrl,
      github: {
        owner: "username",
        repo: "repo"
      }
    });
    
    const config = backend.getConfig();
    expect(config.repoUrl).toBe(repoUrl);
  });
  
  test("properly uses provided owner and repo values", () => {
    const repoUrl = "https://github.com/username/repo.git";
    const owner = "username";
    const repo = "repo";
    
    const backend = new GitHubBackend({
      type: "github",
      repoUrl,
      github: {
        owner,
        repo
      }
    });
    
    const config = backend.getConfig();
    expect(config.github?.owner).toBe(owner);
    expect(config.github?.repo).toBe(repo);
  });
  
  test("correctly identifies backend type", () => {
    const backend = new GitHubBackend({
      type: "github",
      repoUrl: "https://github.com/username/repo.git"
    });
    
    expect(backend.getType()).toBe("github");
  });
}); 
