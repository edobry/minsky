/**
 * Test for PR Detection Bug Fix
 *
 * Bug: Session PR create command fails to detect existing PRs when invoked with --task parameter
 *
 * Root Cause:
 * checkIfPrCanBeRefreshed() only checked for explicit session ID or current
 * working directory detection, but didn't use the same session resolution
 * logic as the main command (resolveSessionContextWithFeedback).
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { checkIfPrCanBeRefreshed, executeSessionPrCreate } from "./pr-create-command";
import type { CommandExecutionContext } from "../../command-registry";
import type { SessionProviderInterface } from "../../../../domain/session/session-db-adapter";
import type { SessionCommandDependencies } from "./types";

const SESSION_CONTEXT_RESOLVER_PATH = "../../../../domain/session/session-context-resolver";
const RESOLVE_SESSION_CONTEXT_FN = "resolveSessionContextWithFeedback";

describe("Session PR Create Command - Task Parameter Bug Fix", () => {
  let mockContext: CommandExecutionContext;

  beforeEach(() => {
    mockContext = {
      interface: "cli",
      workingDirectory: "/Users/edobry/Projects/minsky",
    } as CommandExecutionContext;
  });

  afterEach(() => {
    // no-op
  });

  describe("Bug: PR Detection with Task Parameter", () => {
    it("should detect existing PR when using --task parameter instead of --name", async () => {
      const taskId = "md#368";
      const sessionId = "test-session-fix-368";

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

      const deps = {
        sessionProvider: mockSessionProvider as unknown as SessionProviderInterface,
      } as unknown as SessionCommandDependencies;

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
        const canRefresh = await checkIfPrCanBeRefreshed(deps, {
          task: taskId,
          title: "fix: Test PR",
        });

        expect(canRefresh).toBe(true);
      } finally {
        resolverImportSpy.mockRestore();
      }
    });

    it("should still require body for truly new PRs (regression check)", async () => {
      const taskId = "md#999";

      const mockSessionProvider = {
        getSession: mock(async () => null),
      };

      const deps = {
        sessionProvider: mockSessionProvider as unknown as SessionProviderInterface,
      } as unknown as SessionCommandDependencies;

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
          await executeSessionPrCreate(
            deps,
            {
              task: taskId,
              title: "fix: New PR",
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
      const params = {
        task: "md#368",
        title: "Test PR",
      };

      const deps = {
        sessionProvider: {
          getSession: async () => null,
        } as unknown as SessionProviderInterface,
      } as unknown as SessionCommandDependencies;

      // Returns false because session resolution fails (no mock for resolver)
      const canRefresh = await checkIfPrCanBeRefreshed(deps, params);

      expect(canRefresh).toBe(false);
    });
  });
});
