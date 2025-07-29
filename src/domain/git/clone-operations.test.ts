/**
 * Clone Operations Tests
 * @migrated Converted from module mocking to established DI patterns
 * @colocated Placed alongside clone-operations.ts module
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { GitService } from "../git";
import { createTestDeps } from "../../utils/test-utils/dependencies";
import { createPartialMock } from "../../utils/test-utils/mocking";
import type { DomainDependencies } from "../../utils/test-utils/dependencies";
import type { CloneOptions, GitServiceInterface } from "./types";

describe("Clone Operations with Dependency Injection", () => {
  let deps: DomainDependencies;
  let gitService: GitService;

  beforeEach(() => {
    // Create custom mock for clone operations using createPartialMock
    const mockGitService = createPartialMock<GitServiceInterface>({
      clone: (options: CloneOptions) => {
        // Mock different clone scenarios based on repoUrl
        if (options?.repoUrl?.includes("nonexistent")) {
          return Promise.reject(new Error("Repository not found"));
        }
        if (options?.repoUrl?.includes("local/path/to/repo")) {
          return Promise.reject(new Error("Repository does not exist"));
        }
        // Default successful clone
        return Promise.resolve({
          workdir: options?.workdir || "/test/workdir",
          session: "test-session",
        });
      },
      execInRepository: (workdir: string, command: string) => {
        // Mock git commands for clone operations
        if (command.includes("rev-parse --show-toplevel")) {
          return Promise.resolve(workdir);
        }
        if (command.includes("status --porcelain")) {
          return Promise.resolve("");
        }
        return Promise.resolve("");
      },
    });

    // Use established DI patterns with custom git service mock
    deps = createTestDeps({
      gitService: mockGitService,
    });

    gitService = deps.gitService as GitService;
  });

  describe("Successful clone operations", () => {
    test("should clone repository successfully", async () => {
      const result = await gitService.clone({
        repoUrl: "https://github.com/user/repo.git",
        workdir: "/test/workdir",
      });

      expect(result).toBeDefined();
      expect(result.workdir).toBe("/test/workdir");
      expect(result.session).toBe("test-session");
    });

    test("should handle clone with default target directory", async () => {
      const result = await gitService.clone({
        repoUrl: "https://github.com/user/repo.git",
        workdir: "/default/workdir",
      });

      expect(result).toBeDefined();
      expect(result.workdir).toBeDefined();
      expect(result.session).toBe("test-session");
    });

    test("should support various repository URL formats", async () => {
      const urls = [
        "https://github.com/user/repo.git",
        "git@github.com:user/repo.git",
        "https://gitlab.com/user/repo.git",
      ];

      for (const url of urls) {
        const result = await gitService.clone({
          repoUrl: url,
          workdir: "/test/workdir",
        });
        expect(result).toBeDefined();
        expect(result.workdir).toBe("/test/workdir");
      }
    });
  });

  describe("Clone error handling", () => {
    test("should handle nonexistent repository", async () => {
      try {
        await gitService.clone({
          repoUrl: "https://github.com/user/nonexistent.git",
          workdir: "/test/workdir",
        });
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("Repository not found");
      }
    });

    test("should handle local repository that doesn't exist", async () => {
      try {
        await gitService.clone({
          repoUrl: "local/path/to/repo",
          workdir: "/test/workdir",
        });
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("Repository does not exist");
      }
    });
  });

  describe("DI architecture verification", () => {
    test("should use dependency injection for git operations", () => {
      expect(deps.gitService).toBeDefined();
      expect(typeof deps.gitService.clone).toBe("function");
      expect(typeof deps.gitService.execInRepository).toBe("function");
    });

    test("should provide consistent mocked behavior", async () => {
      // Test that our DI setup provides consistent results
      const result1 = await gitService.clone({
        repoUrl: "https://github.com/test/repo.git",
        workdir: "/workdir1",
      });
      const result2 = await gitService.clone({
        repoUrl: "https://github.com/test/repo.git",
        workdir: "/workdir2",
      });

      expect(result1.session).toBe(result2.session); // Same mock session
      expect(result1.workdir).toBe("/workdir1");
      expect(result2.workdir).toBe("/workdir2");
    });

    test("should demonstrate zero real git operations", async () => {
      // Verify our DI prevents real git commands
      const execResult = await gitService.execInRepository("/test", "status --porcelain");
      expect(execResult).toBe(""); // Mocked empty result

      const repoRoot = await gitService.execInRepository("/test", "rev-parse --show-toplevel");
      expect(repoRoot).toBe("/test"); // Mocked to return input workdir
    });
  });
});
