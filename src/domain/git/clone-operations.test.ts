/**
 * Clone Operations Tests
 * @migrated Extracted from git.test.ts as part of modularization
 * @colocated Placed alongside clone-operations.ts module
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { GitService } from "../git";
import {
  createMock,
  setupTestMocks,
  mockModule,
} from "../../utils/test-utils/mocking";
import {
  expectToHaveBeenCalled,
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
  },
}));

describe("Clone Operations", () => {
  let gitService: GitService;

  beforeEach(() => {
    gitService = new GitService("/test/base/dir");
  });

  test("should handle clone operations with filesystem validation", async () => {
    const mockDeps = {
      execAsync: createMock(async (command: string) => {
        if (command.includes("git clone")) {
          return { stdout: "Cloning into '/test/workdir'...\nDone.", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      }),
      mkdir: createMock(async () => {}),
      readdir: createMock(async () => {
        throw new Error("ENOENT: no such file or directory"); // Directory doesn't exist
      }),
      access: createMock(async () => {}), // .git directory exists
    };

    const result = await gitService.cloneWithDependencies(
      {
        repoUrl: "https://github.com/user/repo.git",
        session: "test-session",
        workdir: "/test/workdir",
      },
      mockDeps
    );

    expect(result.session).toBe("test-session");
    expect(result.workdir).toContain("test-session");
    expectToHaveBeenCalled(mockDeps.execAsync);
    expectToHaveBeenCalled(mockDeps.mkdir);
  });

  test("should handle clone with empty repository URL validation", async () => {
    const mockDeps = {
      execAsync: createMock(),
      mkdir: createMock(),
      readdir: createMock(),
      access: createMock(),
    };

    await expect(
      gitService.cloneWithDependencies(
        {
          repoUrl: "",
          session: "test-session",
          workdir: "/test/workdir",
        },
        mockDeps
      )
    ).rejects.toThrow("Repository URL is required for cloning");
  });

  test("should handle clone with existing non-empty directory", async () => {
    const mockDeps = {
      execAsync: createMock(async (command: string) => {
        if (command.includes("git clone")) {
          return { stdout: "Cloning...", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      }),
      mkdir: createMock(),
      readdir: createMock(async () => ["existing-file.txt"]), // Directory exists and not empty
      access: createMock(),
    };

    // Should still proceed with clone despite warning about non-empty directory
    const result = await gitService.cloneWithDependencies(
      {
        repoUrl: "https://github.com/user/repo.git",
        session: "test-session",
        workdir: "/test/workdir",
      },
      mockDeps
    );

    expect(result.session).toBe("test-session");
    expectToHaveBeenCalled(mockDeps.readdir);
  });

  test("should handle clone failure during git command execution", async () => {
    const mockDeps = {
      execAsync: createMock(async (command: string) => {
        if (command.includes("git clone")) {
          throw new Error(
            "fatal: repository 'https://github.com/user/nonexistent.git' not found"
          );
        }
        return { stdout: "", stderr: "" };
      }),
      mkdir: createMock(),
      readdir: createMock(async () => {
        throw new Error("ENOENT");
      }),
      access: createMock(),
    };

    await expect(
      gitService.cloneWithDependencies(
        {
          repoUrl: "https://github.com/user/nonexistent.git",
          session: "test-session",
          workdir: "/test/workdir",
        },
        mockDeps
      )
    ).rejects.toThrow("Failed to clone git repository");
  });

  test("should handle clone success verification failure", async () => {
    const mockDeps = {
      execAsync: createMock(async (command: string) => {
        if (command.includes("git clone")) {
          return { stdout: "Cloning...", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      }),
      mkdir: createMock(),
      readdir: createMock(async () => {
        throw new Error("ENOENT");
      }),
      access: createMock(async () => {
        throw new Error("ENOENT: .git directory not found"); // Clone verification fails
      }),
    };

    await expect(
      gitService.cloneWithDependencies(
        {
          repoUrl: "https://github.com/user/repo.git",
          session: "test-session",
          workdir: "/test/workdir",
        },
        mockDeps
      )
    ).rejects.toThrow("Git repository was not properly cloned: .git directory not found");
  });

  test("should handle clone with local repository normalization", async () => {
    const mockDeps = {
      execAsync: createMock(async () => ({ stdout: "Cloning...", stderr: "" })),
      mkdir: createMock(),
      readdir: createMock(async () => {
        throw new Error("ENOENT");
      }),
      access: createMock(),
    };

    const result = await gitService.cloneWithDependencies(
      {
        repoUrl: "local/path/to/repo",
        session: "test-session",
        workdir: "/test/workdir",
      },
      mockDeps
    );

    // NEW: Session-ID-based storage - repository name no longer in filesystem path
    // Path contains session ID but NOT repository name (this is the architectural change)
    expect(result.workdir).toContain("test-session");
    expect(result.session).toBe("test-session");
  });

  test("should handle clone error scenarios with proper error propagation", async () => {
    const mockDeps = {
      execAsync: createMock(async () => {
        throw new Error("fatal: not a git repository");
      }),
      mkdir: createMock(),
      readdir: createMock(),
      access: createMock(),
    };

    await expect(
      gitService.cloneWithDependencies(
        {
          repoUrl: "https://github.com/user/repo.git",
          session: "test-session",
          workdir: "/test/workdir",
        },
        mockDeps
      )
    ).rejects.toThrow("Failed to clone git repository");
  });
}); 
