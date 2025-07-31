/**
 * Test-Driven Bug Fix: session PR --body-path parameter completely ignored
 *
 * Bug Description: The sessionPr function receives bodyPath parameter but never
 * reads the file content. It only passes the body parameter to preparePrFromParams,
 * completely ignoring bodyPath. This causes --body-path CLI parameter to have no effect.
 *
 * Expected Behavior: When bodyPath is provided, the function should read the file
 * content and use it as the body content for the prepared commit.
 *
 * This test reproduces the bug and will FAIL until the implementation is fixed.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { writeFile, mkdir, rm } from "fs/promises";
import { join } from "path";
import { sessionPr } from "../../../src/domain/session/commands/pr-command";

describe("Session PR bodyPath Parameter Bug", () => {
  const testDir = "/tmp/minsky-session-pr-bodypath-bug-test";
  const testBodyPath = join(testDir, "pr-description.md");
  const expectedBodyContent = `# feat(#360): Implement session outdated detection and display system

## Summary

This PR implements a comprehensive session outdated detection and display system for Minsky CLI.

## Changes

### Added
- New sync status tracking functionality
- CLI commands for outdated session detection
- Visual indicators for session status

### Testing
- All new functionality includes comprehensive error handling
- Git operations gracefully handle missing repositories`;

  beforeEach(async () => {
    // Create test directory and write body content to file
    await mkdir(testDir, { recursive: true });
    await writeFile(testBodyPath, expectedBodyContent);
  });

  afterEach(async () => {
    // Clean up test directory and restore mocks
    await rm(testDir, { recursive: true, force: true });
    mock.restore();
  });

  test("BUG REPRODUCTION: bodyPath parameter is completely ignored", async () => {
    // This test should FAIL before the fix and PASS after the fix
    
    // Arrange: Mock the dependencies to capture what actually gets passed to preparePrFromParams
    let capturedBodyContent: string | undefined;
    
    // Mock preparePrFromParams to capture what body content is actually passed
    const mockPreparePrFromParams = mock(async (params: any) => {
      capturedBodyContent = params.body;
      return {
        prBranch: "pr/test-session",
        baseBranch: "main", 
        title: params.title,
        body: params.body,
      };
    });

    // Mock the preparePrFromParams import
    mock.module("../../git", () => ({
      preparePrFromParams: mockPreparePrFromParams,
    }));

    // Mock session context resolver
    const mockResolveSessionContext = mock(async () => ({
      sessionName: "test-session",
    }));

    mock.module("../session-context-resolver", () => ({
      resolveSessionContextWithFeedback: mockResolveSessionContext,
    }));

    // Mock session provider
    const mockSessionRecord = {
      session: "test-session",
      taskId: "360",
      repoName: "minsky",
      branch: "task360",
    };

    const mockSessionProvider = {
      getSession: mock(() => Promise.resolve(mockSessionRecord)),
      getSessionWorkdir: mock(() => Promise.resolve("/tmp/test-workdir")),
    };

    mock.module("../../session", () => ({
      createSessionProvider: () => mockSessionProvider,
    }));

    // Mock git service
    const mockGitService = {
      execInRepository: mock(() => Promise.resolve("")),
    };

    mock.module("../../git", () => ({
      createGitService: () => mockGitService,
      preparePrFromParams: mockPreparePrFromParams,
    }));

    // Mock extractPrDescription to return null (no existing PR)
    mock.module("../session-update-operations", () => ({
      extractPrDescription: mock(() => Promise.resolve(null)),
    }));

    // Act: Call sessionPr with bodyPath parameter  
    const result = await sessionPr({
      session: "test-session",
      title: "feat(#360): Implement session outdated detection and display system",
      body: undefined,           // No direct body content
      bodyPath: testBodyPath,    // This should be read and used
      debug: false,
    });

    // Assert: This should FAIL before the fix
    // The bug is that bodyPath content is never read, so capturedBodyContent will be undefined
    expect(capturedBodyContent).toBeDefined();
    expect(capturedBodyContent).toBe(expectedBodyContent);
    
    // Additional assertions to verify the fix
    expect(result.body).toBe(expectedBodyContent);
    expect(mockPreparePrFromParams).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expectedBodyContent,
      })
    );
  });

  test("CONTROL TEST: body parameter works correctly (not affected by bug)", async () => {
    // This control test verifies that direct body parameter still works
    // This should PASS both before and after the fix
    
    const directBodyContent = "Direct body content provided via --body parameter";
    let capturedBodyContent: string | undefined;
    
    // Mock preparePrFromParams
    const mockPreparePrFromParams = mock(async (params: any) => {
      capturedBodyContent = params.body;
      return {
        prBranch: "pr/test-session",
        baseBranch: "main",
        title: params.title,
        body: params.body,
      };
    });

    // Set up the same mocks as above
    mock.module("../../git", () => ({
      preparePrFromParams: mockPreparePrFromParams,
    }));

    const mockResolveSessionContext = mock(async () => ({
      sessionName: "test-session",
    }));

    mock.module("../session-context-resolver", () => ({
      resolveSessionContextWithFeedback: mockResolveSessionContext,
    }));

    const mockSessionRecord = {
      session: "test-session",
      taskId: "360", 
      repoName: "minsky",
      branch: "task360",
    };

    const mockSessionProvider = {
      getSession: mock(() => Promise.resolve(mockSessionRecord)),
      getSessionWorkdir: mock(() => Promise.resolve("/tmp/test-workdir")),
    };

    mock.module("../../session", () => ({
      createSessionProvider: () => mockSessionProvider,
    }));

    const mockGitService = {
      execInRepository: mock(() => Promise.resolve("")),
    };

    mock.module("../../git", () => ({
      createGitService: () => mockGitService,
      preparePrFromParams: mockPreparePrFromParams,
    }));

    mock.module("../session-update-operations", () => ({
      extractPrDescription: mock(() => Promise.resolve(null)),
    }));

    // Act: Call sessionPr with direct body parameter
    const result = await sessionPr({
      session: "test-session",
      title: "feat(#360): Test direct body",
      body: directBodyContent,   // Direct body content
      bodyPath: undefined,       // No body path
      debug: false,
    });

    // Assert: This should work correctly (control test)
    expect(capturedBodyContent).toBe(directBodyContent);
    expect(result.body).toBe(directBodyContent);
  });

  test("EDGE CASE: bodyPath file does not exist", async () => {
    // Test error handling when bodyPath points to non-existent file
    const nonExistentPath = join(testDir, "missing-file.md");
    
    // Mock dependencies (minimal setup for error case)
    mock.module("../session-context-resolver", () => ({
      resolveSessionContextWithFeedback: mock(async () => ({
        sessionName: "test-session",
      })),
    }));

    mock.module("../../session", () => ({
      createSessionProvider: () => ({
        getSession: mock(() => Promise.resolve({
          session: "test-session",
          taskId: "360",
        })),
        getSessionWorkdir: mock(() => Promise.resolve("/tmp/test-workdir")),
      }),
    }));

    mock.module("../../git", () => ({
      createGitService: () => ({}),
      preparePrFromParams: mock(() => Promise.resolve({})),
    }));

    mock.module("../session-update-operations", () => ({
      extractPrDescription: mock(() => Promise.resolve(null)),
    }));

    // Act & Assert: Should handle file read error gracefully
    await expect(sessionPr({
      session: "test-session", 
      title: "Test missing file",
      body: undefined,
      bodyPath: nonExistentPath,
      debug: false,
    })).rejects.toThrow();
  });
});