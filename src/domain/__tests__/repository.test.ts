/**
 * Tests for repository domain functionality
 */
import { describe, test, expect } from "bun:test";
import { normalizeRepoName } from "../repo-utils";

describe("Repository backends", () => {
  // Proper tests for repository backends will be added later
  // This describes tests for GitHub, GitLab, etc. integrations
});

describe("Repository", () => {
  describe("normalizeRepoName", () => {
    test("should handle GitHub URLs correctly", () => {
      const githubUrl = "https://github.com/user/repo.git";
      expect(normalizeRepoName(githubUrl)).toBe("user/repo");
    });
    
    test("should handle SSH URLs correctly", () => {
      const sshUrl = "git@github.com:user/repo.git";
      expect(normalizeRepoName(sshUrl)).toBe("user/repo");
    });
    
    test("should handle local paths correctly", () => {
      const localPath = "/path/to/repo";
      // Local paths are returned as local/<basename>
      expect(normalizeRepoName(localPath)).toBe("local/repo");
    });

    test("should handle file:// URLs correctly", () => {
      const fileUrl = "file:///path/to/project";
      expect(normalizeRepoName(fileUrl)).toBe("local/project");
    });
  });
});
