import { describe, test, expect } from "bun:test";
import {
  buildDispatchRecoveryProbe,
  parseCommitsAheadOutput,
  DISPATCH_RECOVERY_PROBE_HANDOFF_MAX_LINES,
  type DispatchRecoveryProbePr,
} from "./dispatch-recovery-probe";

const emptyGitStatus = { staged: [], unstaged: [], untracked: [] };

const noPr: DispatchRecoveryProbePr = {
  number: null,
  url: null,
  state: null,
  latestReview: null,
  reviewFetchError: null,
};

describe("parseCommitsAheadOutput", () => {
  test("parses a numeric count", () => {
    expect(parseCommitsAheadOutput("3\n")).toBe(3);
    expect(parseCommitsAheadOutput("0")).toBe(0);
  });

  test("returns null for empty output", () => {
    expect(parseCommitsAheadOutput("")).toBeNull();
    expect(parseCommitsAheadOutput("   \n")).toBeNull();
  });

  test("returns null for unparseable output", () => {
    expect(parseCommitsAheadOutput("fatal: bad revision")).toBeNull();
  });
});

describe("buildDispatchRecoveryProbe", () => {
  test("computes dirtyFileCount as the sum of staged/unstaged/untracked", () => {
    const result = buildDispatchRecoveryProbe({
      session: "s1",
      gitStatus: { staged: ["a.ts"], unstaged: ["b.ts", "c.ts"], untracked: ["d.ts"] },
      commitsAheadOfBase: 2,
      baseBranch: "main",
      pr: noPr,
      handoffFileContent: null,
    });
    expect(result.dirtyFileCount).toBe(4);
  });

  test("handoff absent -> exists: false, empty firstLines", () => {
    const result = buildDispatchRecoveryProbe({
      session: "s1",
      gitStatus: emptyGitStatus,
      commitsAheadOfBase: 0,
      baseBranch: "main",
      pr: noPr,
      handoffFileContent: null,
    });
    expect(result.handoff).toEqual({ exists: false, firstLines: [] });
  });

  test("handoff present -> exists: true, split into lines", () => {
    const result = buildDispatchRecoveryProbe({
      session: "s1",
      gitStatus: emptyGitStatus,
      commitsAheadOfBase: 0,
      baseBranch: "main",
      pr: noPr,
      handoffFileContent: "Done: X\nIn progress: Y\nRemaining: Z",
    });
    expect(result.handoff.exists).toBe(true);
    expect(result.handoff.firstLines).toEqual(["Done: X", "In progress: Y", "Remaining: Z"]);
  });

  test("handoff content longer than the max is truncated", () => {
    const bigContent = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const result = buildDispatchRecoveryProbe({
      session: "s1",
      gitStatus: emptyGitStatus,
      commitsAheadOfBase: 0,
      baseBranch: "main",
      pr: noPr,
      handoffFileContent: bigContent,
    });
    expect(result.handoff.firstLines).toHaveLength(DISPATCH_RECOVERY_PROBE_HANDOFF_MAX_LINES);
    expect(result.handoff.firstLines[0]).toBe("line 0");
  });

  test("an empty-string handoff file (exists but empty) is distinguished from absent", () => {
    const result = buildDispatchRecoveryProbe({
      session: "s1",
      gitStatus: emptyGitStatus,
      commitsAheadOfBase: 0,
      baseBranch: "main",
      pr: noPr,
      handoffFileContent: "",
    });
    expect(result.handoff.exists).toBe(true);
    expect(result.handoff.firstLines).toEqual([""]);
  });

  test("propagates PR + latest review state unchanged", () => {
    const pr: DispatchRecoveryProbePr = {
      number: 1776,
      url: "https://github.com/edobry/minsky/pull/1776",
      state: "open",
      latestReview: {
        state: "CHANGES_REQUESTED",
        reviewerLogin: "minsky-reviewer[bot]",
        submittedAt: "2026-07-07T10:00:00.000Z",
      },
      reviewFetchError: null,
    };
    const result = buildDispatchRecoveryProbe({
      session: "s1",
      gitStatus: emptyGitStatus,
      commitsAheadOfBase: 5,
      baseBranch: "main",
      pr,
      handoffFileContent: null,
    });
    expect(result.pr).toEqual(pr);
    expect(result.commitsAheadOfBase).toBe(5);
    expect(result.baseBranch).toBe("main");
  });

  test("a review-fetch error is surfaced without dropping the rest of the pr slice", () => {
    const pr: DispatchRecoveryProbePr = {
      number: 42,
      url: "https://github.com/edobry/minsky/pull/42",
      state: "open",
      latestReview: null,
      reviewFetchError: "GitHub API rate limited",
    };
    const result = buildDispatchRecoveryProbe({
      session: "s1",
      gitStatus: emptyGitStatus,
      commitsAheadOfBase: null,
      baseBranch: null,
      pr,
      handoffFileContent: null,
    });
    expect(result.pr.reviewFetchError).toBe("GitHub API rate limited");
    expect(result.pr.number).toBe(42);
    expect(result.commitsAheadOfBase).toBeNull();
  });

  test("respects a custom handoffMaxLines", () => {
    const content = "l1\nl2\nl3\nl4";
    const result = buildDispatchRecoveryProbe({
      session: "s1",
      gitStatus: emptyGitStatus,
      commitsAheadOfBase: 0,
      baseBranch: "main",
      pr: noPr,
      handoffFileContent: content,
      handoffMaxLines: 2,
    });
    expect(result.handoff.firstLines).toEqual(["l1", "l2"]);
  });
});
