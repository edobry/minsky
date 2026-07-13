/**
 * Tests for CommitOperation (mt#2635 PR #1811 R1).
 *
 * The reviewer's main finding on the initial PR: FakeGitService — and any
 * other alternative GitServiceInterface implementation — lacked the
 * `commit()` method that session_commit's unified noFiles/allow-empty path
 * now requires end-to-end (session-commands.ts -> commitChangesFromParams
 * -> ModularGitCommandsManager -> CommitOperation.execute ->
 * gitService.commit(message, repo, amend, allowEmpty)). This file proves
 * FakeGitService is now in parity: CommitOperation can run against it,
 * `allowEmpty` is threaded through correctly, and a scripted commit failure
 * propagates UNMODIFIED through CommitOperation/BaseGitOperation — the same
 * error-preservation guarantee the real GitService.commit -> commitImpl
 * path has (see git-core-operations.ts's commitImpl doc comment).
 */
import { describe, test, expect } from "bun:test";
import { createCommitOperation } from "./basic-operations";
import { FakeGitService } from "../fake-git-service";
import type { GitOperationDependencies } from "./base-git-operation";

// Shared test constant — reuse via this name so the magic-string linter is
// satisfied and a rename only has one place to change.
const WAKE_WEBHOOK_MESSAGE = "chore: wake webhook";

function makeDeps(fakeGitService: FakeGitService): GitOperationDependencies {
  return { createGitService: () => fakeGitService };
}

describe("CommitOperation against FakeGitService (parity)", () => {
  test("allowEmpty=true, noStage=true (the noFiles/allow-empty shape) reaches gitService.commit with allowEmpty", async () => {
    const fakeGitService = new FakeGitService();
    const commitOperation = createCommitOperation(makeDeps(fakeGitService));

    const result = await commitOperation.execute({
      message: WAKE_WEBHOOK_MESSAGE,
      repo: "/mock/workdir",
      noStage: true,
      allowEmpty: true,
    });

    expect(fakeGitService.commitCalls).toHaveLength(1);
    expect(fakeGitService.commitCalls[0]).toEqual({
      message: WAKE_WEBHOOK_MESSAGE,
      repoPath: "/mock/workdir",
      amend: undefined,
      allowEmpty: true,
    });
    expect(result.commitHash).toBe("fakecommit001");
    expect(result.message).toBe(WAKE_WEBHOOK_MESSAGE);
  });

  test("allowEmpty is false/undefined for an ordinary (non-allow-empty) commit", async () => {
    const fakeGitService = new FakeGitService();
    const commitOperation = createCommitOperation(makeDeps(fakeGitService));

    await commitOperation.execute({
      message: "fix(mt#1): a real change",
      repo: "/mock/workdir",
      noStage: true,
    });

    expect(fakeGitService.commitCalls[0]?.allowEmpty).toBeUndefined();
  });

  // Proves the error-preservation guarantee: a hook failure surfaced by
  // gitService.commit() propagates through CommitOperation/BaseGitOperation
  // UNMODIFIED (same object, same .stdout/.stderr if present) — mirroring
  // commitImpl's real-git-service behavior that classifyHookFailure
  // (workflow-commands.ts) depends on.
  test("a scripted commit() failure propagates unmodified through CommitOperation", async () => {
    const fakeGitService = new FakeGitService();
    const hookFailure = Object.assign(
      new Error("Command failed: git -C /mock/workdir commit --allow-empty -m 'x'"),
      {
        stderr: "",
        stdout: "⚠️ ⚠️ ⚠️ TOO MANY WARNINGS! COMMIT BLOCKED! ⚠️ ⚠️ ⚠️\nWarnings: 10 (threshold: 0)",
      }
    );
    fakeGitService.setCommitErrors([hookFailure]);
    const commitOperation = createCommitOperation(makeDeps(fakeGitService));

    let caught: unknown;
    try {
      await commitOperation.execute({
        message: WAKE_WEBHOOK_MESSAGE,
        repo: "/mock/workdir",
        noStage: true,
        allowEmpty: true,
      });
    } catch (err) {
      caught = err;
    }

    // Same object identity — BaseGitOperation.execute's catch block only
    // logs and re-throws (see base-git-operation.ts); it does not wrap.
    expect(caught).toBe(hookFailure);
    const e = caught as Record<string, unknown>;
    expect(e.stdout).toContain("TOO MANY WARNINGS");
  });
});
