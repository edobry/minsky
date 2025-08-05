/**
 * Test for PR Detection Bug Fix
 * 
 * Bug: Session PR create command fails to detect existing PRs when invoked with --task parameter
 * 
 * Issue Description:
 * When running `minsky session pr create --task md#368`, the command fails with:
 * "PR description is required for new pull request creation"
 * 
 * Root Cause:
 * The checkIfPrCanBeRefreshed() method only checks for explicit session name or 
 * current working directory detection, but doesn't use the same session resolution
 * logic as the main command (resolveSessionContextWithFeedback).
 * 
 * Steps to Reproduce:
 * 1. Have an existing session with PR state for a task
 * 2. Run session pr create with --task parameter (not --name)
 * 3. Command should detect existing PR but fails
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { SessionPrCreateCommand } from "./pr-subcommand-commands";
import type { CommandExecutionContext } from "../../types";

describe("Session PR Create Command - Task Parameter Bug Fix", () => {
  let command: SessionPrCreateCommand;
  let mockContext: CommandExecutionContext;
  let originalCwd: string;

  beforeEach(() => {
    command = new SessionPrCreateCommand();
    mockContext = {
      interface: "cli",
      workingDirectory: "/Users/edobry/Projects/minsky", // Not in session workspace
    } as CommandExecutionContext;
    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  describe("🐛 Bug: PR Detection with Task Parameter", () => {
    it("should detect existing PR when using --task parameter instead of --name", async () => {
      // Bug reproduction scenario: task has existing session with PR state
      const taskId = "md#368";
      const sessionName = "test-session-fix-368";

      // Mock the session provider to return an existing session with PR state
      const mockSessionProvider = {
        getSession: mock(async (name: string) => {
          if (name === sessionName) {
            return {
              session: sessionName,
              taskId: taskId,
              prState: {
                commitHash: "abc123",
                branchName: `pr/${sessionName}`,
                exists: true,
                lastChecked: new Date().toISOString(),
              },
              prBranch: `pr/${sessionName}`,
              repoName: "local-minsky",
            };
          }
          return null;
        }),
      };

      // Mock the session resolution to map task to session (this works in real code)
      const mockSessionResolver = mock(async (options: any) => {
        if (options.task === taskId) {
          return {
            sessionName: sessionName,
            taskId: taskId,
            autoDetectionMessage: `Auto-detected session: ${sessionName}`,
          };
        }
        throw new Error("Session not found");
      });

      // Mock git service to confirm branch exists
      const mockGitService = {
        execInRepository: mock(async (dir: string, command: string) => {
          if (command.includes("show-ref")) {
            return ""; // Branch exists (empty output means success)
          }
          if (command.includes("ls-remote")) {
            return `abc123 refs/heads/pr/${sessionName}`; // Remote branch exists
          }
          return "";
        }),
      };

      // Spy on imports to inject mocks
      const sessionImportSpy = spyOn(
        await import("../../../../domain/session"),
        "createSessionProvider"
      ).mockReturnValue(mockSessionProvider as any);

      const gitImportSpy = spyOn(
        await import("../../../../domain/git"),
        "createGitService"
      ).mockReturnValue(mockGitService as any);

      const resolverImportSpy = spyOn(
        await import("../../../../domain/session/session-context-resolver"),
        "resolveSessionContextWithFeedback"
      ).mockImplementation(mockSessionResolver as any);

      try {
        // Test the specific method that was fixed
        const canRefresh = await (command as any).checkIfPrCanBeRefreshed({
          task: taskId,
          title: "fix: Test PR",
        });

        // This should now return true thanks to our fix
        expect(canRefresh).toBe(true);
      } finally {
        sessionImportSpy.mockRestore();
        gitImportSpy.mockRestore();
        resolverImportSpy.mockRestore();
      }
    });

    it("should still require body for truly new PRs (regression check)", async () => {
      // Ensure we don't break the legitimate case where body is required
      const taskId = "md#999";
      
      const mockSessionProvider = {
        getSession: mock(async () => null), // No existing session
      };

      const mockSessionResolver = mock(async () => {
        throw new Error("Session not found for task md#999");
      });

      const sessionImportSpy = spyOn(
        await import("../../../../domain/session"),
        "createSessionProvider"
      ).mockReturnValue(mockSessionProvider as any);

      const resolverImportSpy = spyOn(
        await import("../../../../domain/session/session-context-resolver"),
        "resolveSessionContextWithFeedback"
      ).mockImplementation(mockSessionResolver as any);

      try {
        await expect(async () => {
          await command.executeCommand(
            {
              task: taskId,
              title: "fix: New PR",
              // No body or bodyPath - should be required for new PR
            },
            mockContext
          );
        }).toThrow(/PR description is required/);
      } finally {
        sessionImportSpy.mockRestore();
        resolverImportSpy.mockRestore();
      }
    });
  });

  describe("🔍 Current Implementation Analysis", () => {
    it("should show how checkIfPrCanBeRefreshed currently fails with task parameter", async () => {
      // This test documents the current broken behavior
      const params = {
        task: "md#368",
        title: "Test PR",
        // No name parameter, not in session workspace
      };

      // Set working directory to main workspace (not session workspace)
      process.chdir("/Users/edobry/Projects/minsky");

      // Call the private method to test its current behavior
      const canRefresh = await (command as any).checkIfPrCanBeRefreshed(params);

      // Currently this returns false because:
      // 1. params.name is undefined
      // 2. current directory doesn't contain "/sessions/"
      // 3. Method doesn't try task-to-session resolution
      expect(canRefresh).toBe(false);
    });
  });
});