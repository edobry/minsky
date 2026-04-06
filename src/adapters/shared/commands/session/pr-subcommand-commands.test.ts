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
 * The checkIfPrCanBeRefreshed() method only checks for explicit session ID or
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
import type { CommandExecutionContext } from "../../command-registry";
import type { SessionProviderInterface } from "../../../../domain/session/session-db-adapter";
import { createMock as createMockFunction } from "../../../../utils/test-utils/core/mock-functions";

const SESSION_CONTEXT_RESOLVER_PATH = "../../../../domain/session/session-context-resolver";
const RESOLVE_SESSION_CONTEXT_FN = "resolveSessionContextWithFeedback";

describe("Session PR Create Command - Task Parameter Bug Fix", () => {
  let command: SessionPrCreateCommand;
  let mockContext: CommandExecutionContext;
  // Static mock path to prevent environment dependencies
  const mockWorkingDirectory = "/mock/projects/minsky";

  beforeEach(() => {
    mockContext = {
      interface: "cli",
      workingDirectory: "/Users/edobry/Projects/minsky", // Not in session workspace
    } as CommandExecutionContext;
    // Mock cleanup - avoiding real filesystem operations
  });

  afterEach(() => {
    // Mock cleanup - avoiding real filesystem operations
  });

  describe("Bug: PR Detection with Task Parameter", () => {
    it("should detect existing PR when using --task parameter instead of --name", async () => {
      // Bug reproduction scenario: task has existing session with PR state
      const taskId = "md#368";
      const sessionId = "test-session-fix-368";

      // Mock the session provider to return an existing session with PR state
      const mockSessionProvider = {
        getSession: mock(async (name: string) => {
          if (name === sessionId) {
            return {
              session: sessionId,
              taskId: taskId,
              prState: {
                commitHash: "abc123",
                branchName: `pr/${sessionId}`,
                exists: true,
                lastChecked: new Date().toISOString(),
              },
              prBranch: `pr/${sessionId}`,
              repoName: "local-minsky",
            };
          }
          return null;
        }),
      };

      // Create command with injected sessionProvider
      command = new SessionPrCreateCommand({
        sessionProvider: mockSessionProvider as unknown as SessionProviderInterface,
      });

      // Mock the session resolution to map task to session (this works in real code)
      const mockSessionResolver = mock(async (options: Record<string, unknown>) => {
        if (options.task === taskId) {
          return {
            sessionId: sessionId,
            taskId: taskId,
            autoDetectionMessage: `Auto-detected session: ${sessionId}`,
          };
        }
        throw new Error("Session not found");
      });

      const resolverImportSpy = spyOn(
        await import(SESSION_CONTEXT_RESOLVER_PATH),
        RESOLVE_SESSION_CONTEXT_FN
      ).mockImplementation(
        // eslint-disable-next-line custom/no-magic-string-duplication
        mockSessionResolver as unknown as (typeof import("../../../../domain/session/session-context-resolver"))["resolveSessionContextWithFeedback"]
      );

      try {
        // Test the specific method that was fixed
        const canRefresh = await (
          command as unknown as { checkIfPrCanBeRefreshed: (params: unknown) => Promise<boolean> }
        ).checkIfPrCanBeRefreshed({
          task: taskId,
          title: "fix: Test PR",
        });

        // This should now return true thanks to our fix
        expect(canRefresh).toBe(true);
      } finally {
        resolverImportSpy.mockRestore();
      }
    });

    it("should still require body for truly new PRs (regression check)", async () => {
      // Ensure we don't break the legitimate case where body is required
      const taskId = "md#999";

      const mockSessionProvider = {
        getSession: mock(async () => null), // No existing session
      };

      // Create command with injected sessionProvider
      command = new SessionPrCreateCommand({
        sessionProvider: mockSessionProvider as unknown as SessionProviderInterface,
      });

      const mockSessionResolver = mock(async () => {
        throw new Error("Session not found for task md#999");
      });

      const resolverImportSpy = spyOn(
        await import(SESSION_CONTEXT_RESOLVER_PATH),
        RESOLVE_SESSION_CONTEXT_FN
      ).mockImplementation(
        // eslint-disable-next-line custom/no-magic-string-duplication
        mockSessionResolver as unknown as (typeof import("../../../../domain/session/session-context-resolver"))["resolveSessionContextWithFeedback"]
      );

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
        resolverImportSpy.mockRestore();
      }
    });
  });

  describe("Current Implementation Analysis", () => {
    it("should show how checkIfPrCanBeRefreshed currently fails with task parameter", async () => {
      // This test documents the current broken behavior when no provider is injected
      const params = {
        task: "md#368",
        title: "Test PR",
        // No name parameter, not in session workspace
      };

      // Create command with a mock provider that returns null for getSession
      command = new SessionPrCreateCommand({
        sessionProvider: {
          getSession: async () => null,
        } as unknown as SessionProviderInterface,
      });

      // Call the private method to test its current behavior
      const canRefresh = await (
        command as unknown as { checkIfPrCanBeRefreshed: (params: unknown) => Promise<boolean> }
      ).checkIfPrCanBeRefreshed(params);

      // Returns false because session resolution fails (no mock for resolver)
      expect(canRefresh).toBe(false);
    });
  });
});
