import { describe, test, expect } from "bun:test";
import {
  computeDispatchStaleness,
  classifyDispatchRecoveryState,
  buildDispatchRecoveryContinuationPrompt,
  DISPATCH_RECOVERY_STALE_MS,
  type DispatchRecoveryPromptInput,
  type DispatchRecoveryClassification,
} from "./dispatch-recovery-classifier";

// Shared classification literals (custom/no-magic-string-duplication) — reused across the
// classify + prompt describe blocks below rather than repeating the raw string.
const CRASHED_NO_OUTPUT: DispatchRecoveryClassification = "crashed-no-output";
const PARTIAL_UNCOMMITTED_NO_HANDOFF: DispatchRecoveryClassification =
  "partial-uncommitted-no-handoff";

describe("computeDispatchStaleness", () => {
  const START = Date.parse("2026-07-17T10:00:00Z");

  test("not stale when a recent commit is within the window", () => {
    const now = START + 10 * 60 * 1000; // 10 min later
    const lastCommit = START + 5 * 60 * 1000; // committed 5 min ago
    const result = computeDispatchStaleness(START, lastCommit, now);
    expect(result.stale).toBe(false);
    expect(result.lastActivityAtMs).toBe(lastCommit);
  });

  test("stale when no activity beyond dispatch start for >= the threshold", () => {
    const now = START + DISPATCH_RECOVERY_STALE_MS;
    const result = computeDispatchStaleness(START, null, now);
    expect(result.stale).toBe(true);
    expect(result.lastActivityAtMs).toBe(START);
    expect(result.staleForMs).toBe(DISPATCH_RECOVERY_STALE_MS);
  });

  test("healthy long-running dispatch with a commit just under the threshold is NOT stale (false-positive-kill guard)", () => {
    const lastCommit = START + 20 * 60 * 1000;
    const now = lastCommit + (DISPATCH_RECOVERY_STALE_MS - 1000);
    const result = computeDispatchStaleness(START, lastCommit, now);
    expect(result.stale).toBe(false);
  });

  test("uses the max of startedAt and lastCommitAtMs even if the commit predates dispatch start (clock skew guard)", () => {
    const lastCommit = START - 1000;
    const now = START + 1000;
    const result = computeDispatchStaleness(START, lastCommit, now);
    expect(result.lastActivityAtMs).toBe(START);
    expect(result.stale).toBe(false);
  });

  test("respects a custom staleMs threshold", () => {
    const now = START + 5000;
    const result = computeDispatchStaleness(START, null, now, 1000);
    expect(result.stale).toBe(true);
  });
});

describe("classifyDispatchRecoveryState", () => {
  test("dirty tree, no handoff -> partial-uncommitted-no-handoff", () => {
    expect(
      classifyDispatchRecoveryState({
        dirtyFileCount: 3,
        commitsAheadOfBase: 0,
        handoffExists: false,
      })
    ).toBe("partial-uncommitted-no-handoff");
  });

  test("dirty tree with handoff -> partial-committed-handoff-written", () => {
    expect(
      classifyDispatchRecoveryState({
        dirtyFileCount: 1,
        commitsAheadOfBase: 2,
        handoffExists: true,
      })
    ).toBe("partial-committed-handoff-written");
  });

  test("clean tree, commits ahead -> committed-no-pr", () => {
    expect(
      classifyDispatchRecoveryState({
        dirtyFileCount: 0,
        commitsAheadOfBase: 4,
        handoffExists: false,
      })
    ).toBe("committed-no-pr");
  });

  test("clean tree, no commits -> crashed-no-output", () => {
    expect(
      classifyDispatchRecoveryState({
        dirtyFileCount: 0,
        commitsAheadOfBase: 0,
        handoffExists: false,
      })
    ).toBe(CRASHED_NO_OUTPUT);
  });

  test("null commitsAheadOfBase (undeterminable) treated as zero commits", () => {
    expect(
      classifyDispatchRecoveryState({
        dirtyFileCount: 0,
        commitsAheadOfBase: null,
        handoffExists: false,
      })
    ).toBe(CRASHED_NO_OUTPUT);
  });

  test("dirty tree takes priority over commits-ahead when both are present", () => {
    expect(
      classifyDispatchRecoveryState({
        dirtyFileCount: 2,
        commitsAheadOfBase: 5,
        handoffExists: false,
      })
    ).toBe(PARTIAL_UNCOMMITTED_NO_HANDOFF);
  });
});

describe("buildDispatchRecoveryContinuationPrompt", () => {
  const base: DispatchRecoveryPromptInput = {
    taskId: "mt#9999",
    sessionId: "session-abc",
    sessionDir: "/sessions/session-abc",
    agentType: "implementer",
    classification: CRASHED_NO_OUTPUT,
    dirtyFileCount: 0,
    commitsAheadOfBase: 0,
    handoffExists: false,
    handoffFirstLines: [],
    prNumber: null,
    prUrl: null,
    latestReviewState: null,
    attemptNumber: 2,
    originalStartedAt: "2026-07-17T10:00:00Z",
  };

  test("is session-bound: names the session id and directory, and instructs NOT to start a new session", () => {
    const prompt = buildDispatchRecoveryContinuationPrompt(base);
    expect(prompt).toContain("session-abc");
    expect(prompt).toContain("/sessions/session-abc");
    expect(prompt).toContain("do NOT start a new session");
  });

  test("names the attempt number and the 2-attempt bound", () => {
    const prompt = buildDispatchRecoveryContinuationPrompt(base);
    expect(prompt).toContain("attempt 2 of 2");
    expect(prompt).toContain("no third auto-resume");
  });

  test("partial-uncommitted-no-handoff guidance mentions committing before continuing", () => {
    const prompt = buildDispatchRecoveryContinuationPrompt({
      ...base,
      classification: PARTIAL_UNCOMMITTED_NO_HANDOFF,
      dirtyFileCount: 3,
    });
    expect(prompt).toContain("do NOT discard them");
  });

  test("partial-committed-handoff-written guidance reproduces the handoff content and points to it", () => {
    const prompt = buildDispatchRecoveryContinuationPrompt({
      ...base,
      classification: "partial-committed-handoff-written",
      handoffExists: true,
      handoffFirstLines: ["Done: X", "Remaining: Y"],
    });
    expect(prompt).toContain("Done: X");
    expect(prompt).toContain("Remaining: Y");
    expect(prompt).toContain("handoff.md");
  });

  test("committed-no-pr with no PR yet instructs creating a PR, not re-implementing", () => {
    const prompt = buildDispatchRecoveryContinuationPrompt({
      ...base,
      classification: "committed-no-pr",
      commitsAheadOfBase: 5,
    });
    expect(prompt).toContain("create the PR");
    expect(prompt).toContain("Do not re-implement");
  });

  test("committed-no-pr with an existing PR instructs driving to convergence, not re-implementing", () => {
    const prompt = buildDispatchRecoveryContinuationPrompt({
      ...base,
      classification: "committed-no-pr",
      commitsAheadOfBase: 5,
      prNumber: 1234,
      prUrl: "https://github.com/edobry/minsky/pull/1234",
      latestReviewState: "CHANGES_REQUESTED",
    });
    expect(prompt).toContain("#1234");
    expect(prompt).toContain("drive it to convergence");
    expect(prompt).toContain("CHANGES_REQUESTED");
  });

  test("crashed-no-output guidance treats it as a fresh start", () => {
    const prompt = buildDispatchRecoveryContinuationPrompt(base);
    expect(prompt).toContain("fresh start");
    expect(prompt).toContain("nothing to recover from the workspace");
  });
});
