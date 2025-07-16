/**
 * Tests for Parameter-Based Git Functions
 * @migrated Extracted from git.test.ts for focused responsibility
 */
import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { GitService } from "../git";
import { commitChangesFromParams, pushFromParams } from "../git";
import {
  createMock,
  setupTestMocks,
  mockModule,
} from "../../utils/test-utils/mocking";

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
const mockExecAsync = createMock() as any;
mockModule("../../utils/exec", () => ({
  execAsync: mockExecAsync,
}));

describe("Parameter-Based Git Functions", () => {
  beforeEach(() => {
    // CRITICAL: Mock GitService methods to prevent real git commands
    // This fix prevents tests from executing real git commands that pollute the repository
    spyOn(GitService.prototype, "stageAll").mockImplementation(async (): Promise<void> => {});
    spyOn(GitService.prototype, "stageModified").mockImplementation(async (): Promise<void> => {});
    spyOn(GitService.prototype, "commit").mockImplementation(async (): Promise<string> => "mock-commit-hash");
    spyOn(GitService.prototype, "push").mockImplementation(async (): Promise<any> => ({ pushed: true, workdir: "/mock/workdir" }));
    spyOn(GitService.prototype, "execInRepository").mockImplementation(async (): Promise<string> => "");
  });

  afterEach(() => {
    // Restore all mocks
    mock.restore();
  });

  describe("commitChangesFromParams", () => {
    test("should commit changes with all parameters", async () => {
      const params = {
        message: "test commit message",
        all: true,
        repo: "/test/repo",
        amend: false,
        noStage: false,
        session: "test-session",
      };

      const result = await commitChangesFromParams(params);

      expect(result).toBeDefined();
      expect(result.message).toBe("test commit message");
      expect(result.commitHash).toBeDefined();
      expect(typeof result.commitHash).toBe("string");
    });

    test("should handle commit with minimal parameters", async () => {
      const params = {
        message: "minimal commit",
      };

      const result = await commitChangesFromParams(params);

      expect(result).toBeDefined();
      expect(result.message).toBe("minimal commit");
      expect(result.commitHash).toBeDefined();
    });

    test("should handle commit with amend option", async () => {
      const params = {
        message: "amended commit",
        amend: true,
      };

      const result = await commitChangesFromParams(params);

      expect(result).toBeDefined();
      expect(result.message).toBe("amended commit");
    });

    test("should handle commit with noStage option", async () => {
      const params = {
        message: "no stage commit",
        noStage: true,
      };

      const result = await commitChangesFromParams(params);

      expect(result).toBeDefined();
      expect(result.message).toBe("no stage commit");
    });
  });

  describe("pushFromParams", () => {
    test("should push changes with all parameters", async () => {
      const params = {
        session: "test-session",
        repo: "/test/repo",
        remote: "origin",
        force: true,
        debug: true,
      };

      const result = await pushFromParams(params);

      expect(result).toBeDefined();
      expect(result.workdir).toBeDefined();
      expect(typeof result.workdir).toBe("string");
    });

    test("should handle push with minimal parameters", async () => {
      const params = {};

      const result = await pushFromParams(params);

      expect(result).toBeDefined();
      expect(result.workdir).toBeDefined();
    });

    test("should handle push with force option", async () => {
      const params = {
        force: true,
      };

      const result = await pushFromParams(params);

      expect(result).toBeDefined();
      expect(result.workdir).toBeDefined();
    });

    test("should handle push with custom remote", async () => {
      const params = {
        remote: "upstream",
      };

      const result = await pushFromParams(params);

      expect(result).toBeDefined();
      expect(result.workdir).toBeDefined();
    });
  });
});

describe("commitChangesFromParams - Detailed Tests", () => {
  beforeEach(() => {
    // Reset mockExecAsync for each test
    mockExecAsync.mockReset();
  });

  test("should commit changes with message and all flag", async () => {
    // Mock git commit command response
    mockExecAsync.mockResolvedValueOnce({
      stdout: "[main abc123] test commit message",
      stderr: ""
    });

    const params = {
      message: "test commit message",
      all: true,
      repo: "/test/repo",
    };

    const result = await commitChangesFromParams(params);

    expect(result).toBeDefined();
    expect(result.commitHash).toBe("abc123");
    expect(result.message).toBe("test commit message");
  });

  test("should commit changes with just message", async () => {
    // Mock git commit command response
    mockExecAsync.mockResolvedValueOnce({
      stdout: "[main def456] simple commit",
      stderr: ""
    });

    const params = {
      message: "simple commit",
      repo: "/test/repo",
    };

    const result = await commitChangesFromParams(params);

    expect(result).toBeDefined();
    expect(result.commitHash).toBe("def456");
    expect(result.message).toBe("simple commit");
  });

  test("should handle commit with custom repo path", async () => {
    // Mock git commit command response
    mockExecAsync.mockResolvedValueOnce({
      stdout: "[main ghi789] commit with custom repo",
      stderr: ""
    });

    const params = {
      message: "commit with custom repo",
      repo: "/custom/repo/path",
    };

    const result = await commitChangesFromParams(params);

    expect(result).toBeDefined();
    expect(result.commitHash).toBe("ghi789");
  });

  test("should handle commit errors gracefully", async () => {
    // Mock git commit command failure
    mockExecAsync.mockRejectedValueOnce(new Error("Git command failed"));

    const params = {
      message: "failing commit",
      repo: "/nonexistent/repo",
    };

    // Should not throw, should handle error gracefully
    await expect(commitChangesFromParams(params)).rejects.toThrow("Git command failed");
  });
});

describe("pushFromParams - Detailed Tests", () => {
  beforeEach(() => {
    // Reset mockExecAsync for each test
    mockExecAsync.mockReset();
  });

  test("should push changes successfully", async () => {
    // Mock git push command response
    mockExecAsync
      .mockResolvedValueOnce({ stdout: "main", stderr: "" }) // git rev-parse --abbrev-ref HEAD
      .mockResolvedValueOnce({ stdout: "Everything up-to-date", stderr: "" }); // git push

    const params = {
      repo: "/test/repo",
    };

    const result = await pushFromParams(params);

    expect(result).toBeDefined();
    expect(result.pushed).toBe(true);
    expect(result.workdir).toBe("/test/repo");
  });

  test("should handle push with custom remote", async () => {
    // Mock git push command response
    mockExecAsync
      .mockResolvedValueOnce({ stdout: "main", stderr: "" }) // git rev-parse --abbrev-ref HEAD
      .mockResolvedValueOnce({ stdout: "Everything up-to-date", stderr: "" }); // git push

    const params = {
      repo: "/test/repo",
      remote: "custom-remote",
    };

    const result = await pushFromParams(params);

    expect(result).toBeDefined();
    expect(result.pushed).toBe(true);
  });

  test("should handle push with branch specification", async () => {
    // Mock git push command response
    mockExecAsync
      .mockResolvedValueOnce({ stdout: "Everything up-to-date", stderr: "" }); // git push

    const params = {
      repo: "/test/repo",
      branch: "feature-branch",
    };

    const result = await pushFromParams(params);

    expect(result).toBeDefined();
    expect(result.pushed).toBe(true);
  });

  test("should handle push errors gracefully", async () => {
    // Mock git push command failure
    mockExecAsync.mockRejectedValueOnce(new Error("Git push failed"));

    const params = {
      repo: "/nonexistent/repo",
    };

    // Should not throw, should handle error gracefully
    await expect(pushFromParams(params)).rejects.toThrow("Git push failed");
  });
});
