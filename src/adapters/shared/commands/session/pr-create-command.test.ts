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

import { describe, it, expect, beforeEach, mock, test } from "bun:test";
import {
  checkIfPrCanBeRefreshed,
  executeSessionPrCreate,
  buildDebugDetail,
  handlePrError,
  type SessionPrCreateParams,
} from "./pr-create-command";
import { handleOctokitError } from "@minsky/domain/repository/github-error-handler";
import { GitHubApiError } from "@minsky/domain/repository/index";
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

  // ---------------------------------------------------------------------------
  // mt#3169 — `--debug` has to actually add detail.
  //
  // Originating incident (2026-07-24): session_pr_create failed seven times, its
  // error advised re-running with --debug, and doing so produced BYTE-IDENTICAL
  // output. `debug` was threaded into the domain call and read by nothing on this
  // path. Worse, the upstream payload was already destroyed by then, because
  // handleOctokitError threw a replacement without a `cause`.
  // ---------------------------------------------------------------------------

  describe("mt#3169 — the debug affordance surfaces the upstream payload", () => {
    /** The Octokit error shape GitHub actually produces for a failed create. */
    function octokitError(): Error {
      const err = new Error("Server Error") as Error & Record<string, unknown>;
      err.status = 500;
      err.response = {
        status: 500,
        data: {
          message: "Server Error",
          documentation_url: "https://docs.github.com/rest/pulls/pulls#create-a-pull-request",
          errors: [{ resource: "PullRequest", code: "custom", message: "boom" }],
        },
      };
      err.request = { method: "POST", url: "https://api.github.com/repos/o/r/pulls" };
      return err;
    }

    const CTX = { operation: "create pull request", owner: "o", repo: "r" };
    const BASE_PARAMS = { title: "t" } as unknown as SessionPrCreateParams;

    function thrownFromHandler(): unknown {
      try {
        handleOctokitError(octokitError(), CTX);
      } catch (err) {
        return err;
      }
      throw new Error("expected handleOctokitError to throw");
    }

    test("AT1: handleOctokitError preserves the original error as `cause`", () => {
      // The precondition for everything below: without this the payload is gone
      // before any caller could render it, which is why --debug had nothing.
      const thrown = thrownFromHandler();

      expect(thrown).toBeInstanceOf(GitHubApiError);
      const cause = (thrown as { cause?: unknown }).cause;
      expect(cause).toBeDefined();
      expect((cause as { status?: number }).status).toBe(500);
    });

    test("AT2: with debug set, the message carries documentation_url, errors[], status and request", () => {
      const err = handlePrError(thrownFromHandler(), { ...BASE_PARAMS, debug: true });

      expect(err.message).toContain("Debug detail");
      expect(err.message).toContain(
        "https://docs.github.com/rest/pulls/pulls#create-a-pull-request"
      );
      expect(err.message).toContain("PullRequest");
      expect(err.message).toContain("http status: 500");
      expect(err.message).toContain("POST https://api.github.com/repos/o/r/pulls");
      // mt#3249's classification rides along — it is the answer the domain
      // already computed, so a debug dump should not omit it.
      expect(err.message).toContain('"kind":"degraded"');
    });

    test("AT3: without debug, the message is unchanged — this is purely additive", () => {
      const withoutDebug = handlePrError(thrownFromHandler(), BASE_PARAMS);
      const withDebugFalse = handlePrError(thrownFromHandler(), {
        ...BASE_PARAMS,
        debug: false,
      });

      expect(withoutDebug.message).toBe(withDebugFalse.message);
      expect(withoutDebug.message).not.toContain("Debug detail");
      // The default message still carries GitHub's own text (mt#3171) — the
      // debug block adds to it rather than replacing what operators already get.
      expect(withoutDebug.message).toContain("Server Error");
    });

    test("the advertised affordance is no longer a no-op (the actual regression)", () => {
      // The precise defect: identical output with and without the flag.
      const plain = handlePrError(thrownFromHandler(), BASE_PARAMS).message;
      const debugged = handlePrError(thrownFromHandler(), { ...BASE_PARAMS, debug: true }).message;

      expect(debugged).not.toBe(plain);
      expect(debugged.length).toBeGreaterThan(plain.length);
    });

    test("buildDebugDetail returns null when there is nothing diagnostic to show", () => {
      // So the caller appends nothing rather than an empty header.
      expect(buildDebugDetail(new Error("plain failure"))).toBeNull();
      expect(buildDebugDetail("not even an error")).toBeNull();
      expect(buildDebugDetail(undefined)).toBeNull();
    });

    test("buildDebugDetail survives an unserializable payload", () => {
      const err = new Error("x") as Error & Record<string, unknown>;
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      err.status = 500;
      err.response = { status: 500, data: { errors: cyclic } };

      const detail = buildDebugDetail(err);
      expect(detail).toContain("http status: 500");
      expect(detail).toContain("<unserializable>");
    });
  });
});
