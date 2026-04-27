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

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { checkIfPrCanBeRefreshed, executeSessionPrCreate } from "./pr-create-command";
import type { CommandExecutionContext } from "../../command-registry";
import type { SessionProviderInterface } from "../../../../domain/session/session-db-adapter";
import type { SessionCommandDependencies } from "./types";

describe("Session PR Create Command - Task Parameter Bug Fix", () => {
  let mockContext: CommandExecutionContext;

  beforeEach(() => {
    mockContext = {
      interface: "cli",
      workingDirectory: "/Users/edobry/Projects/minsky",
    } as CommandExecutionContext;
  });

  describe("Bug: PR Detection with Task Parameter", () => {
    it("should detect existing PR when using --task parameter instead of --name", async () => {
      const taskId = "md#368";
      const sessionId = "test-session-fix-368";

      const sessionRecord = {
        sessionId: sessionId,
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

      const mockSessionProvider = {
        getSession: mock(async (name: string) => {
          return name === sessionId ? sessionRecord : null;
        }),
        getSessionByTaskId: mock(async (tId: string) => {
          return tId === taskId ? sessionRecord : null;
        }),
        listSessions: mock(async () => [sessionRecord]),
      };

      const deps = {
        sessionProvider: mockSessionProvider as unknown as SessionProviderInterface,
      } as unknown as SessionCommandDependencies;

      const canRefresh = await checkIfPrCanBeRefreshed(deps, {
        task: taskId,
        title: "fix: Test PR",
      });

      expect(canRefresh).toBe(true);
    });

    it("should still require body for truly new PRs (regression check)", async () => {
      const taskId = "md#999";

      const mockSessionProvider = {
        getSession: mock(async () => null),
        getSessionByTaskId: mock(async () => null),
        listSessions: mock(async () => []),
      };

      const deps = {
        sessionProvider: mockSessionProvider as unknown as SessionProviderInterface,
      } as unknown as SessionCommandDependencies;

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
