/**
 * mt#3939 — the pre-PR push's bound and its failure message.
 *
 * `session_pr_create` runs two pushes: the pre-PR session update's push (STEP
 * 6) and the "ensure the branch is on the remote" push inside PR creation
 * (STEP 7). The second carried a hardcoded 60s bound that no caller could
 * reach, so an operator who passed `pushTimeoutMs: 180000` and read "timed out
 * after 60 seconds" had no way to tell the two numbers described different
 * pushes.
 *
 * The STEP 6 half of the distinction is pinned in
 * `session/session-update-push-confirmation.test.ts` ("a hanging push is
 * bounded…"), which asserts that path's message and that it is NOT the
 * timeout template asserted against here.
 */

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PR_CREATE_PUSH_TIMEOUT_MS,
  PR_CREATE_PUSH_STEP,
  ensureBranchPushedForPr,
  type EnsureBranchPushedDeps,
} from "./github-pr-operations";
import { GitOperationTimeoutError, MinskyError } from "../errors/index";
import { createGitTimeoutErrorMessage } from "../errors/enhanced-error-templates";
import type { GitExecOptions, GitExecResult } from "../utils/git-exec";

type RecordedCall = { operation: string; command: string; options: GitExecOptions };

/**
 * A stand-in for `execGitWithTimeout` that records what it was handed and
 * fails in the requested way. The timeout failure is built with the REAL
 * template, so the "no network remedies" assertions below are testing a
 * rewrite that actually happened rather than an input that never had them.
 */
function makeRecordingExec(behavior: "ok" | "timeout" | "reject"): {
  calls: RecordedCall[];
  execGit: EnsureBranchPushedDeps["execGit"];
} {
  const calls: RecordedCall[] = [];
  const execGit = async (
    operation: string,
    command: string,
    options: GitExecOptions = {}
  ): Promise<GitExecResult> => {
    calls.push({ operation, command, options });
    const fullCommand = options.workdir ? `git -C ${options.workdir} ${command}` : `git ${command}`;

    if (behavior === "timeout") {
      const timeout = options.timeout ?? 0;
      throw new GitOperationTimeoutError(
        createGitTimeoutErrorMessage(operation, timeout, options.workdir, options.context),
        operation,
        timeout,
        fullCommand,
        options.workdir,
        timeout + 5
      );
    }
    if (behavior === "reject") {
      throw new MinskyError(
        "Git push failed: ! [remote rejected] task/mt-3939 -> task/mt-3939 (refusing to allow a GitHub App to create or update workflow)"
      );
    }
    return {
      stdout: "Everything up-to-date",
      stderr: "",
      command: fullCommand,
      workdir: options.workdir,
      executionTimeMs: 12,
    };
  };
  return { calls, execGit };
}

/** Narrowing accessor — keeps the assertions free of non-null assertions. */
function onlyCall(calls: RecordedCall[]): RecordedCall {
  expect(calls).toHaveLength(1);
  const [call] = calls;
  if (!call) throw new Error("expected exactly one recorded git call");
  return call;
}

const WORKDIR = "/sessions/78962985";
const BRANCH = "task/mt-3939";

describe("ensureBranchPushedForPr — bound (mt#3939)", () => {
  test("AT1: the caller's pushTimeoutMs governs the push and the bound it reports", async () => {
    const { calls, execGit } = makeRecordingExec("timeout");

    let caught: unknown;
    try {
      await ensureBranchPushedForPr(
        { workdir: WORKDIR, sourceBranch: BRANCH, pushTimeoutMs: 180_000 },
        { execGit }
      );
    } catch (error) {
      caught = error;
    }

    // The bound reached the subprocess...
    expect(onlyCall(calls).options.timeout).toBe(180_000);

    // ...and the bound the failure REPORTS is the same number. This pair is
    // the whole defect: before mt#3939 the call site's 60s was reported here
    // no matter what the caller passed.
    expect(caught).toBeInstanceOf(MinskyError);
    const message = (caught as MinskyError).message;
    expect(message).toContain("180 seconds");
    expect(message).not.toContain("60 seconds");
    expect(message).toContain("caller-supplied pushTimeoutMs");
  });

  test("with no caller bound, the documented default applies and is named as the source", async () => {
    const { calls, execGit } = makeRecordingExec("timeout");

    let caught: unknown;
    try {
      await ensureBranchPushedForPr({ workdir: WORKDIR, sourceBranch: BRANCH }, { execGit });
    } catch (error) {
      caught = error;
    }

    expect(onlyCall(calls).options.timeout).toBe(DEFAULT_PR_CREATE_PUSH_TIMEOUT_MS);
    const message = (caught as MinskyError).message;
    expect(message).toContain("60 seconds");
    expect(message).toContain("DEFAULT_PR_CREATE_PUSH_TIMEOUT_MS");
  });

  test("AT3: the failure names which of the two pushes failed", async () => {
    const { execGit } = makeRecordingExec("timeout");

    let caught: unknown;
    try {
      await ensureBranchPushedForPr(
        { workdir: WORKDIR, sourceBranch: BRANCH, pushTimeoutMs: 90_000 },
        { execGit }
      );
    } catch (error) {
      caught = error;
    }

    const message = (caught as MinskyError).message;
    expect(message).toContain(PR_CREATE_PUSH_STEP);
    // It says, in so many words, that it is not the other one.
    expect(message).toContain("Failed to push changes to remote during session update");
    expect(message).toContain(BRANCH);
    // The underlying error is retained for anyone who wants the raw detail.
    expect((caught as MinskyError).cause).toBeInstanceOf(GitOperationTimeoutError);
  });

  test("AT4: the network-oriented remedies are not printed for this step", async () => {
    const { execGit } = makeRecordingExec("timeout");

    let caught: unknown;
    try {
      await ensureBranchPushedForPr({ workdir: WORKDIR, sourceBranch: BRANCH }, { execGit });
    } catch (error) {
      caught = error;
    }

    // Not a vacuous assertion: the message this one REPLACED carries all three.
    const generic = createGitTimeoutErrorMessage("push", 60_000, WORKDIR);
    expect(generic).toContain("ping");
    expect(generic).toContain("count-objects");
    expect(generic).toContain("shallow clone");

    const message = (caught as MinskyError).message;
    expect(message).not.toContain("ping");
    expect(message).not.toContain("count-objects");
    expect(message).not.toContain("shallow clone");
    expect(message).not.toContain("Git Operation Timeout");

    // What it prints instead points at the two things that actually explain a
    // push with nothing to send.
    expect(message).toContain("ls-remote");
    expect(message).toContain("mt#3881");
  });

  test("a non-timeout push failure keeps its own detail and gains the step label", async () => {
    const { execGit } = makeRecordingExec("reject");

    let caught: unknown;
    try {
      await ensureBranchPushedForPr({ workdir: WORKDIR, sourceBranch: BRANCH }, { execGit });
    } catch (error) {
      caught = error;
    }

    const message = (caught as MinskyError).message;
    expect(message).toContain(PR_CREATE_PUSH_STEP);
    expect(message).toContain("remote rejected");
    // A rejection is not a timeout — it must not acquire timeout prose.
    expect(message).not.toContain("Timeout:");
  });

  test("the step and bound source travel with the subprocess as context", async () => {
    const { calls, execGit } = makeRecordingExec("ok");

    await ensureBranchPushedForPr(
      { workdir: WORKDIR, sourceBranch: BRANCH, pushTimeoutMs: 45_000 },
      { execGit }
    );

    const call = onlyCall(calls);
    expect(call.operation).toBe("push");
    expect(call.command).toBe(`push origin ${BRANCH}`);
    expect(call.options.workdir).toBe(WORKDIR);

    const labels = (call.options.context ?? []).map((entry) => entry.label);
    expect(labels).toContain("Step");
    expect(labels).toContain("Timeout source");
  });

  test("a successful push throws nothing", async () => {
    const { execGit } = makeRecordingExec("ok");
    await ensureBranchPushedForPr({ workdir: WORKDIR, sourceBranch: BRANCH }, { execGit });
  });
});
