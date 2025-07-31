/**
 * Test-Driven Bug Fix: session PR create missing session update step
 *
 * Bug Description: The sessionPr function creates PRs without first updating the session
 * branch with latest main changes. This results in PRs that are missing recent commits
 * from the main branch, creating stale/outdated PRs.
 *
 * Root Cause: preparePrImpl completely skips session update logic - it fetches latest
 * main but never merges it into the session branch before creating the PR branch.
 *
 * Expected Behavior: session pr create should first update the session branch with
 * latest main (unless --skip-update is specified), then create the PR from the
 * updated session branch.
 *
 * Evidence: Our task360 session is missing 25+ commits from origin/main, resulting
 * in a PR that doesn't include recent changes like rule updates and bug fixes.
 *
 * This test reproduces the bug and will FAIL until the implementation is fixed.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { writeFile, mkdir, rm } from "fs/promises";
import { join } from "path";

import { sessionPr } from "../../../src/domain/session/commands/pr-command";

describe("Session PR Missing Update Bug", () => {
  const testDir = "/tmp/minsky-session-pr-update-bug-test";

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    mock.restore();
  });

  test("should call session update before creating PR (unless skipUpdate=true)", async () => {
    // Arrange: Track which operations are called
    const operationsCalled: string[] = [];

    const mockSessionProvider = {
      getSession: mock(() =>
        Promise.resolve({
          session: "test-session",
          taskId: "360",
          repoName: "minsky",
          branch: "task360",
          repoUrl: "git@github.com:user/minsky.git",
        })
      ),
      getSessionWorkdir: mock(() => Promise.resolve(testDir)),
    };

    const mockGitService = {
      execInRepository: mock(() => Promise.resolve("")),
    };

    // Mock the session update function to track if it's called
    const mockUpdateSessionFromParams = mock((params: any) => {
      operationsCalled.push("updateSession");
      return Promise.resolve({
        session: "test-session",
        repoName: "minsky",
        branch: "task360",
      });
    });

    // Mock the preparePr function to track if it's called
    const mockPreparePrFromParams = mock((params: any) => {
      operationsCalled.push("preparePr");
      return Promise.resolve({
        prBranch: "pr/test-session",
        baseBranch: "main",
        title: params.title,
        body: params.body,
      });
    });

    // Mock all dependencies
    mock.module("../../../src/domain/session", () => ({
      createSessionProvider: () => mockSessionProvider,
      updateSessionFromParams: mockUpdateSessionFromParams,
    }));

    mock.module("../../../src/domain/git", () => ({
      createGitService: () => mockGitService,
      preparePrFromParams: mockPreparePrFromParams,
    }));

    mock.module("../../../src/domain/session/session-context-resolver", () => ({
      resolveSessionContextWithFeedback: mock(() =>
        Promise.resolve({ sessionName: "test-session" })
      ),
    }));

    mock.module("../../../src/domain/session/session-update-operations", () => ({
      extractPrDescription: mock(() => Promise.resolve(null)),
    }));

    // Act: Call sessionPr without skipUpdate flag (should update by default)
    await sessionPr({
      session: "test-session",
      title: "Test PR",
      body: "Test body",
      debug: false,
      // skipUpdate: false (default - should trigger session update)
    });

    // Assert: Session update should be called before PR preparation
    expect(operationsCalled).toContain("updateSession");
    expect(operationsCalled).toContain("preparePr");

    // Session update should be called BEFORE preparePr
    const updateIndex = operationsCalled.indexOf("updateSession");
    const prIndex = operationsCalled.indexOf("preparePr");
    expect(updateIndex).toBeLessThan(prIndex);
  });

  test("should skip session update when skipUpdate=true", async () => {
    // Arrange: Track operations
    const operationsCalled: string[] = [];

    const mockSessionProvider = {
      getSession: mock(() =>
        Promise.resolve({
          session: "test-session",
          taskId: "360",
          repoName: "minsky",
          branch: "task360",
        })
      ),
      getSessionWorkdir: mock(() => Promise.resolve(testDir)),
    };

    const mockUpdateSessionFromParams = mock(() => {
      operationsCalled.push("updateSession");
      return Promise.resolve({});
    });

    const mockPreparePrFromParams = mock(() => {
      operationsCalled.push("preparePr");
      return Promise.resolve({
        prBranch: "pr/test-session",
        baseBranch: "main",
      });
    });

    // Mock dependencies
    mock.module("../../../src/domain/session", () => ({
      createSessionProvider: () => mockSessionProvider,
      updateSessionFromParams: mockUpdateSessionFromParams,
    }));

    mock.module("../../../src/domain/git", () => ({
      createGitService: () => ({}),
      preparePrFromParams: mockPreparePrFromParams,
    }));

    mock.module("../../../src/domain/session/session-context-resolver", () => ({
      resolveSessionContextWithFeedback: mock(() =>
        Promise.resolve({ sessionName: "test-session" })
      ),
    }));

    mock.module("../../../src/domain/session/session-update-operations", () => ({
      extractPrDescription: mock(() => Promise.resolve(null)),
    }));

    // Act: Call sessionPr WITH skipUpdate=true
    await sessionPr({
      session: "test-session",
      title: "Test PR",
      body: "Test body",
      debug: false,
      skipUpdate: true, // Should skip session update
    });

    // Assert: Session update should NOT be called when skipUpdate=true
    expect(operationsCalled).not.toContain("updateSession");
    expect(operationsCalled).toContain("preparePr");
  });

  test("verifies the bug fix: session update is now called correctly", async () => {
    // This test verifies the bug has been fixed
    // Previously session update was never called, now it should be called by default

    const operationsCalled: string[] = [];

    // Mock minimal dependencies for current implementation
    mock.module("../../../src/domain/session", () => ({
      createSessionProvider: () => ({
        getSession: () =>
          Promise.resolve({
            session: "test-session",
            taskId: "360",
            repoName: "minsky",
            branch: "task360",
          }),
        getSessionWorkdir: () => Promise.resolve(testDir),
      }),
      updateSessionFromParams: mock(() => {
        operationsCalled.push("updateSession");
        return Promise.resolve({});
      }),
    }));

    mock.module("../../../src/domain/git", () => ({
      createGitService: () => ({}),
      preparePrFromParams: mock(() => {
        operationsCalled.push("preparePr");
        return Promise.resolve({
          prBranch: "pr/test-session",
          baseBranch: "main",
        });
      }),
    }));

    mock.module("../../../src/domain/session/session-context-resolver", () => ({
      resolveSessionContextWithFeedback: () => Promise.resolve({ sessionName: "test-session" }),
    }));

    mock.module("../../../src/domain/session/session-update-operations", () => ({
      extractPrDescription: () => Promise.resolve(null),
    }));

    // Act: Call fixed implementation
    await sessionPr({
      session: "test-session",
      title: "Test PR",
      body: "Test body",
      debug: false,
      // skipUpdate not specified - should default to false and trigger update
    });

    // Assert: Bug fixed - session update is now called when it should be
    expect(operationsCalled).toContain("updateSession"); // FIXED: Now correctly calls updateSession
    expect(operationsCalled).toContain("preparePr");

    // Verify order: updateSession should be called before preparePr
    const updateIndex = operationsCalled.indexOf("updateSession");
    const prIndex = operationsCalled.indexOf("preparePr");
    expect(updateIndex).toBeLessThan(prIndex);
  });
});
