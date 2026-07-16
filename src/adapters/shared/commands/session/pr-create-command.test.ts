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
import {
  checkIfPrCanBeRefreshed,
  executeSessionPrCreate,
  type SessionPrCreateParams,
} from "./pr-create-command";
import type { CommandExecutionContext } from "../../command-registry";
import type { SessionProviderInterface } from "@minsky/domain/session/types";
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
      } as SessionPrCreateParams);

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
          } as SessionPrCreateParams,
          mockContext
        );
      }).toThrow(/PR description is required/);
    });
  });

  // mt#2821: PR-title create/edit validation parity. Before the fix,
  // session_pr_create performed NO length validation on the description-only
  // --title (composeConventionalTitle had no length check), so an
  // over-budget title was silently accepted at create time and only rejected
  // later by session_pr_edit's separate 80-char validator (conversation
  // bdf8f782: "too long (87 > 80)"). Both commands now route through the
  // same composeConventionalTitle validator, so create rejects up front.
  describe("description-length parity (mt#2821)", () => {
    it("rejects a description-only title over the 80-char budget with the same validator session_pr_edit uses", async () => {
      const taskId = "md#2821";

      const mockSessionProvider = {
        getSession: mock(async () => null),
        getSessionByTaskId: mock(async () => null),
        listSessions: mock(async () => []),
      };

      const deps = {
        sessionProvider: mockSessionProvider as unknown as SessionProviderInterface,
      } as unknown as SessionCommandDependencies;

      await expect(
        executeSessionPrCreate(
          deps,
          {
            task: taskId,
            type: "feat",
            title: "a".repeat(87),
            body: "test body",
          } as SessionPrCreateParams,
          mockContext
        )
      ).rejects.toThrow(/too long|87|80/i);
    });
  });

  describe("Current Implementation Analysis", () => {
    it("should show how checkIfPrCanBeRefreshed currently fails with task parameter", async () => {
      const params = {
        task: "md#368",
        title: "Test PR",
      } as SessionPrCreateParams;

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
