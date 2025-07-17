/**
 * GitService PR Workflow Tests
 * @migrated Extracted from git.test.ts as part of modularization
 * @enhanced Enhanced with comprehensive PR workflow coverage and DI patterns
 */
import { describe, test, expect } from "bun:test";
import { GitService } from "../git";
import {
  createMock,
  setupTestMocks,
  mockModule,
} from "../../utils/test-utils/mocking";
import {
  createMockSessionProvider,
  createMockGitService,
} from "../../utils/test-utils/dependencies";
import {
  expectToHaveBeenCalled,
  expectToHaveBeenCalledWith,
} from "../../utils/test-utils/assertions";

// Set up automatic mock cleanup
setupTestMocks();

// Mock the logger module to avoid winston dependency issues
mockModule("../../utils/logger", () => ({
  log: {
    agent: createMock(),
    debug: createMock(),
    warn: createMock(),
    error: createMock(),
    cli: createMock(),
    cliWarn: createMock(),
    cliError: createMock(),
    setLevel: createMock(),
    cliDebug: createMock(),
  },
}));

// Mock the centralized execAsync module at the top level for proper module interception
const mockExecAsync = createMock();
mockModule("../../utils/exec", () => ({
  execAsync: mockExecAsync,
}));

// Mock the git-exec-enhanced module to prevent real git execution
mockModule("../../utils/git-exec-enhanced", () => ({
  execGitWithTimeout: createMock(async () => ({ stdout: "", stderr: "" })),
  gitFetchWithTimeout: createMock(async () => ({ stdout: "", stderr: "" })),
  gitMergeWithTimeout: createMock(async () => ({ stdout: "", stderr: "" })),
  gitPushWithTimeout: createMock(async () => ({ stdout: "", stderr: "" })),
}));

describe("PR Workflow with Dependencies", () => {
  test("should generate PR markdown with proper dependency injection", async () => {
    const mockDeps = {
      execAsync: createMock(async (command: unknown) => {
        const cmd = command as string;
        if (cmd.includes("log --oneline")) {
          return { stdout: "abc123 feat: add new feature\ndef456 fix: bug fix", stderr: "" };
        }
        if (cmd.includes("diff --name-only")) {
          return { stdout: "src/feature.ts\nREADME.md", stderr: "" };
        }
        if (cmd.includes("merge-base")) {
          return { stdout: "base123", stderr: "" };
        }
        if (cmd.includes("branch --show-current")) {
          return { stdout: "feature-branch", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      }) as any,
      getSession: createMock(() =>
        Promise.resolve({
          session: "test-session",
          repoName: "test-repo",
          repoUrl: "https://github.com/user/repo.git",
        })
      ) as any,
      getSessionWorkdir: createMock(() => "/test/repo/sessions/test-session") as any,
    };

    const gitService = new GitService();
    const result = await gitService.prWithDependencies({ session: "test-session" }, mockDeps);

    expect(result.markdown).toContain("feature-branch");
    expect(result.markdown).toContain("abc123 feat: add new feature");
    expect(result.markdown).toContain("src/feature.ts");
    expectToHaveBeenCalled(mockDeps.execAsync);
    expectToHaveBeenCalledWith(mockDeps.getSession, "test-session");
  });

  test("should handle missing session in PR workflow", async () => {
    const mockSessionProvider = createMockSessionProvider({
      getSession: () => Promise.resolve(null),
    });
    
    const mockDeps = {
      execAsync: async (command: string, options?: any) => ({ stdout: "", stderr: "" }),
      getSession: mockSessionProvider.getSession,
      getSessionWorkdir: (session: string) => `/mock/session/${session}`,
    };

    const gitService = new GitService();

    await expect(
      gitService.prWithDependencies({ session: "nonexistent" }, mockDeps)
    ).rejects.toThrow("Session \"nonexistent\" Not Found");
  });

  test("should resolve taskId to session in PR workflow", async () => {
    const mockDeps = {
      execAsync: createMock(async (command: unknown) => {
        const cmd = command as string;
        if (cmd.includes("log --oneline")) {
          return { stdout: "abc123 feat: add new feature", stderr: "" };
        }
        if (cmd.includes("diff --name-only")) {
          return { stdout: "src/feature.ts", stderr: "" };
        }
        if (cmd.includes("merge-base")) {
          return { stdout: "base123", stderr: "" };
        }
        if (cmd.includes("branch --show-current")) {
          return { stdout: "feature-branch", stderr: "" };
        }
        if (cmd.includes("symbolic-ref")) {
          return { stdout: "origin/main", stderr: "" };
        }
        if (cmd.includes("diff --name-status")) {
          return { stdout: "M\tsrc/feature.ts", stderr: "" };
        }
        if (cmd.includes("status --porcelain")) {
          return { stdout: "", stderr: "" };
        }
        if (cmd.includes("diff --stat")) {
          return { stdout: "1 file changed, 1 insertion(+)", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      }) as unknown,
      getSession: createMock(() =>
        Promise.resolve({
          session: "task-143-session",
          repoName: "test-repo",
          repoUrl: "https://github.com/user/repo.git",
        })
      ) as unknown,
      getSessionWorkdir: createMock(() => "/test/repo/sessions/task-143-session") as unknown,
      getSessionByTaskId: createMock(() =>
        Promise.resolve({
          session: "task-143-session",
          repoName: "test-repo",
          repoUrl: "https://github.com/user/repo.git",
          taskId: "143",
        })
      ) as unknown,
    };

    const gitService = new GitService();
    const result = await gitService.prWithDependencies({ taskId: "143" }, mockDeps);

    // Verify that taskId was resolved to session
    expectToHaveBeenCalledWith(mockDeps.getSessionByTaskId, "143");
    expectToHaveBeenCalledWith(mockDeps.getSession, "task-143-session");
    expectToHaveBeenCalledWith(mockDeps.getSessionWorkdir, "task-143-session");

    // Verify PR was generated successfully
    expect(result.markdown).toContain("feature-branch");
    expect(result.markdown).toContain("abc123 feat: add new feature");
  });

  test("should throw error when taskId has no associated session", async () => {
    const mockSessionProvider = createMockSessionProvider({
      getSessionByTaskId: () => Promise.resolve(null),
    });
    
    const mockDeps = {
      execAsync: async (command: string, options?: any) => ({ stdout: "", stderr: "" }),
      getSession: mockSessionProvider.getSession,
      getSessionWorkdir: (session: string) => `/mock/session/${session}`,
      getSessionByTaskId: mockSessionProvider.getSessionByTaskId,
    };

    const gitService = new GitService();

    await expect(gitService.prWithDependencies({ taskId: "999" }, mockDeps)).rejects.toThrow(
      "No session found for task ID \"999\""
    );

    expectToHaveBeenCalledWith(mockDeps.getSessionByTaskId, "999");
  });

  test("should throw error when getSessionByTaskId dependency is not available", async () => {
    const mockSessionProvider = createMockSessionProvider();
    
    const mockDeps = {
      execAsync: async (command: string, options?: any) => ({ stdout: "", stderr: "" }),
      getSession: mockSessionProvider.getSession,
      getSessionWorkdir: (session: string) => `/mock/session/${session}`,
      // getSessionByTaskId is intentionally omitted
    };

    const gitService = new GitService();

    await expect(gitService.prWithDependencies({ taskId: "143" }, mockDeps)).rejects.toThrow(
      "getSessionByTaskId dependency not available"
    );
  });

  test("should prioritize session over taskId when both are provided", async () => {
    const mockDeps = {
      execAsync: createMock(async (command: string, options?: any) => {
        const cmd = command;
        if (cmd.includes("log --oneline")) {
          return { stdout: "abc123 feat: add new feature", stderr: "" };
        }
        if (cmd.includes("diff --name-only")) {
          return { stdout: "src/feature.ts", stderr: "" };
        }
        if (cmd.includes("merge-base")) {
          return { stdout: "base123", stderr: "" };
        }
        if (cmd.includes("branch --show-current")) {
          return { stdout: "feature-branch", stderr: "" };
        }
        if (cmd.includes("symbolic-ref")) {
          return { stdout: "origin/main", stderr: "" };
        }
        if (cmd.includes("diff --name-status")) {
          return { stdout: "M\tsrc/feature.ts", stderr: "" };
        }
        if (cmd.includes("status --porcelain")) {
          return { stdout: "", stderr: "" };
        }
        if (cmd.includes("diff --stat")) {
          return { stdout: "1 file changed, 1 insertion(+)", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      }),
      getSession: async () =>
        Promise.resolve({
          session: "direct-session",
          repoName: "test-repo",
          repoUrl: "https://github.com/user/repo.git",
        }),
      getSessionWorkdir: (session: string) => `/test/repo/sessions/${session}`,
      getSessionByTaskId: async () => null,
    };

    const gitService = new GitService();
    const result = await gitService.prWithDependencies(
      { session: "direct-session", taskId: "143" },
      mockDeps
    );

    // Verify that session was used directly and taskId was ignored
    expectToHaveBeenCalledWith(mockDeps.getSession, "direct-session");
    expectToHaveBeenCalledWith(mockDeps.getSessionWorkdir, "direct-session");

    // Verify getSessionByTaskId was NOT called
    expect(mockDeps.getSessionByTaskId.mock?.calls?.length ?? 0).toBe(0);

    // Verify PR was generated successfully
    expect(result.markdown).toContain("feature-branch");
  });

  test("should handle git command failures gracefully in PR workflow", async () => {
    const mockDeps = {
      execAsync: createMock(async (command: unknown) => {
        const cmd = command as string;
        // Allow some commands to succeed for basic workflow
        if (cmd.includes("rev-parse --show-toplevel")) {
          return { stdout: "/test/repo", stderr: "" };
        }
        if (cmd.includes("branch --show-current")) {
          return { stdout: "test-branch", stderr: "" };
        }
        // Fail other git commands to test error handling
        throw new Error("git: command not found");
      }),
      getSession: async () =>
        Promise.resolve({
          session: "test-session",
          repoName: "test-repo",
        }),
      getSessionWorkdir: (session: string) => "/test/repo",
    };

    const gitService = new GitService();

    // The PR workflow should handle git errors gracefully and still produce markdown
    const result = await gitService.prWithDependencies({ session: "test-session" }, mockDeps);

    expect(result.markdown).toContain("Pull Request for branch");
  });
}); 
