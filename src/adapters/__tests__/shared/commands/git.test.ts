/**
 * Shared Git Commands Tests
 * @migrated Migrated to native Bun patterns
 * @refactored Uses project utilities instead of raw Bun APIs
 */
import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { registerGitCommands } from "../../../../adapters/shared/commands/git.js";
import {
  sharedCommandRegistry,
  CommandCategory,
} from "../../../../adapters/shared/command-registry.js";
import * as gitDomain from "../../../../domain/git.js";
import {
  expectToHaveBeenCalled,
  getMockCallArg,
  expectToHaveLength,
} from "../../../../utils/test-utils/assertions.js";
import { setupTestMocks } from "../../../../utils/test-utils/mocking.js";

const EXPECTED_GIT_COMMANDS_COUNT = 5;

// Set up automatic mock cleanup
setupTestMocks();

describe("Shared Git Commands", () => {
  // Set up spies for domain functions
  let commitSpy: ReturnType<typeof spyOn>;
  let pushSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // Set up spies
    commitSpy = spyOn(gitDomain, "commitChangesFromParams").mockImplementation(() =>
      Promise.resolve({
        commitHash: "mocked-commit-hash",
        message: "mocked-commit-message",
      })
    );

    pushSpy = spyOn(gitDomain, "pushFromParams").mockImplementation(() =>
      Promise.resolve({
        pushed: true,
        _workdir: "/mocked/workdir",
      })
    );

    // Clear the registry (this is a hacky way to do it since there's no clear method,
    // but it works for testing)
    (sharedCommandRegistry as any).commands = new Map();
  });

  afterEach(() => {
    // Restore all mocks for clean tests
    mock.restore();
  });

  test("registerGitCommands should register git commands in registry", () => {
    // Register commands
    registerGitCommands();

    // Verify commands were registered
    const gitCommands = sharedCommandRegistry.getCommandsByCategory(CommandCategory.GIT);
    expectToHaveLength(gitCommands, EXPECTED_GIT_COMMANDS_COUNT);

    // Verify commit command
    const commitCommand = sharedCommandRegistry.getCommand("git.commit");
    expect(commitCommand).toBeDefined();
    expect(commitCommand?.name).toBe("commit");
    expect(commitCommand?.category).toBe(CommandCategory.GIT);

    // Verify push command
    const pushCommand = sharedCommandRegistry.getCommand("git.push");
    expect(pushCommand).toBeDefined();
    expect(pushCommand?.name).toBe("push");
    expect(pushCommand?.category).toBe(CommandCategory.GIT);
  });

  test("git.commit command should call domain function with correct params", async () => {
    // Register commands
    registerGitCommands();

    // Get command
    const commitCommand = sharedCommandRegistry.getCommand("git.commit");
    expect(commitCommand).toBeDefined();

    // Execute command
    const params = {
      message: "test commit message",
      all: true,
      repo: "/test/repo",
    };
    const _context = { interface: "test" };
    const _result = await commitCommand!.execute(params, _context);

    // Verify domain function was called with correct params
    expectToHaveBeenCalled(commitSpy);
    expect(getMockCallArg(commitSpy, 0, 0)).toEqual({
      message: "test commit message",
      all: true,
      repo: "/test/repo",
      amend: undefined,
      noStage: undefined,
      _session: undefined,
    });

    // Verify result
    expect(_result).toEqual({
      success: true,
      commitHash: "mocked-commit-hash",
      message: "mocked-commit-message",
    });
  });

  test("git.push command should call domain function with correct params", async () => {
    // Register commands
    registerGitCommands();

    // Get command
    const pushCommand = sharedCommandRegistry.getCommand("git.push");
    expect(pushCommand).toBeDefined();

    // Execute command
    const params = {
      repo: "/test/repo",
      force: true,
    };
    const _context = { interface: "test" };
    const _result = await pushCommand!.execute(params, _context);

    // Verify domain function was called with correct params
    expectToHaveBeenCalled(pushSpy);
    expect(getMockCallArg(pushSpy, 0, 0)).toEqual({
      repo: "/test/repo",
      force: true,
      remote: undefined,
      _session: undefined,
      debug: undefined,
    });

    // Verify result
    expect(_result).toEqual({
      success: true,
      _workdir: "/mocked/workdir",
    });
  });
});
