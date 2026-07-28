/**
 * Tests for `classifyMergeError` -- the session.pr.merge failure classifier
 * (mt#2890).
 *
 * Root cause: `session_pr_merge` mislabeled a GitHub API degradation (rate
 * limit / 5xx, surfaced as `mergeable: null` during PR #1988's merge) as
 * "Merge conflict prevented PR from merging". The prior classifier
 * (`isMergeConflictError`) matched on bare "conflict" / "mergeable"
 * substrings, so ANY message mentioning mergeability -- including a
 * legitimate "mergeability is still unknown, retry shortly" message --
 * collapsed onto the conflict path, sending operators down the wrong
 * remediation (rebase) during a rate-limited window.
 *
 * `classifyMergeError` replaces it with a narrower conflict-phrase match
 * plus explicit rate-limit and 5xx/degraded classes. These tests pin the
 * mt#2890 acceptance criteria:
 *   - mocked rate-limit error on merge -> classified as rate-limit, not conflict
 *   - mocked 405 merge-conflict response -> classified as conflict
 *   - mergeable:null poll-exhausted unknown-state message -> NOT a conflict
 *   - 5xx -> classified as degraded, with the HTTP status extracted
 *   - regression: a definite mergeable===false message is still a conflict
 */

import { describe, test, expect } from "bun:test";
import {
  classifyMergeError,
  withOriginalMessage,
  MERGE_ERROR_SUMMARY_EXCERPT_LIMIT,
} from "./workflow-commands";
import { SessionConflictError } from "@minsky/domain/errors/index";
import { handleOctokitError } from "@minsky/domain/repository/github-error-handler";
import { GitHubApiError } from "@minsky/domain/repository/github-error-handler";
import { classifyOctokitOriginReadError } from "./merge-error-classification";

describe("classifyMergeError", () => {
  test("SessionConflictError instance classifies as conflict", () => {
    const err = new SessionConflictError("session branch has merge conflicts", "task/mt-1", "main");
    expect(classifyMergeError(err)).toEqual({ kind: "conflict" });
  });

  test("mergePullRequest's definitive mergeable===false message classifies as conflict", () => {
    // Exact text thrown by mergePullRequest (github-pr-operations.ts) when
    // GitHub reports mergeable: false.
    const err = new Error(`Pull request #1988 has merge conflicts that must be resolved first`);
    expect(classifyMergeError(err)).toEqual({ kind: "conflict" });
  });

  test("405/422 'cannot be merged automatically' diagnosis classifies as conflict", () => {
    const err = new Error(
      `Pull Request Cannot Be Merged\n\n` +
        `Pull request #1988 cannot be merged automatically.\n\n` +
        `Common causes:\n  - Merge conflicts that need to be resolved\n\n` +
        `Visit the PR to resolve: https://github.com/owner/repo/pull/1988`
    );
    expect(classifyMergeError(err)).toEqual({ kind: "conflict" });
  });

  test("mocked rate-limit error on merge classifies as rate-limit, NOT conflict", () => {
    // Exact text thrown by handleOctokitError's rate-limit branch (github-error-handler.ts).
    const err = new Error(
      `GitHub Rate Limit Exceeded\n\n` +
        `You've hit GitHub's API rate limit.\n\n` +
        `To fix this:\n` +
        `  - Wait a few minutes before trying again\n` +
        `  - Use a GitHub token for higher rate limits`
    );
    const result = classifyMergeError(err);
    expect(result.kind).toBe("rate-limit");
    expect(result.kind).not.toBe("conflict");
  });

  test("5xx degradation classifies as degraded, with status extracted", () => {
    // Exact text thrown by handleOctokitError's new 5xx branch (mt#2890).
    const err = new Error(
      `GitHub API degraded/unavailable (HTTP 503)\n\n` +
        `GitHub's API returned a server error for this request. This is not a problem with ` +
        `your PR or credentials -- GitHub's service is temporarily degraded.\n\n` +
        `Error: Service Unavailable`
    );
    expect(classifyMergeError(err)).toEqual({ kind: "degraded", status: "503" });
  });

  test("mt#2890 unknown-mergeability (poll-exhausted) message is NOT a conflict", () => {
    // Exact text thrown by mergePullRequest when the poll budget is exhausted
    // and mergeable is still null (github-pr-operations.ts).
    const err = new Error(
      `Pull request #1988 merge readiness could not be determined after polling ` +
        `GitHub. GitHub may still be computing it, or the API may be degraded. This is not ` +
        `a problem with the PR itself — retry the merge shortly.`
    );
    const result = classifyMergeError(err);
    expect(result.kind).not.toBe("conflict");
    expect(result.kind).toBe("other");
  });

  test("a bare 'mergeable' substring alone (no conflict phrase) is NOT classified as conflict", () => {
    // Regression guard for the mt#2890 root cause: the pre-fix classifier
    // matched ANY message containing "mergeable", which is exactly what
    // mislabeled the unknown-mergeability case above.
    const err = new Error("Could not determine the mergeable status for this PR.");
    expect(classifyMergeError(err).kind).not.toBe("conflict");
  });

  test("an unrelated error (e.g. 404 not found) classifies as other", () => {
    const err = new Error("GitHub Not Found\n\nPull request #1988 was not found.");
    expect(classifyMergeError(err)).toEqual({ kind: "other" });
  });

  test("classification is case-insensitive for phrase matching", () => {
    expect(classifyMergeError(new Error("RATE LIMIT hit")).kind).toBe("rate-limit");
    expect(classifyMergeError(new Error("MERGE CONFLICT detected")).kind).toBe("conflict");
  });

  test("string errors (non-Error) are handled", () => {
    expect(classifyMergeError("has merge conflicts").kind).toBe("conflict");
    expect(classifyMergeError("rate limit exceeded").kind).toBe("rate-limit");
  });
});

/**
 * Tests for `withOriginalMessage` -- the helper that folds the true failure
 * text into a structured error's `summary` (mt#2890).
 *
 * `buildWireMessage` (mcp-structured-errors.ts) only reads `details.tail` /
 * `subprocessOutput` when composing the message that actually reaches the
 * MCP wire -- an arbitrary `details.originalMessage` field, which the PR
 * #1988 incident's error payload set, is silently dropped. This is why the
 * excerpt must be folded into `summary` itself rather than left in
 * `details` alone.
 */
describe("withOriginalMessage", () => {
  test("appends a flattened, truncated excerpt of the original message", () => {
    const result = withOriginalMessage(
      "Merge conflict prevented PR from merging",
      "Pull request #1988 has merge conflicts that must be resolved first"
    );
    expect(result).toBe(
      "Merge conflict prevented PR from merging: Pull request #1988 has merge conflicts that must be resolved first"
    );
  });

  test("flattens embedded newlines/whitespace into single spaces", () => {
    const result = withOriginalMessage(
      "GitHub API degraded/unavailable (HTTP 503)",
      "GitHub API degraded/unavailable (HTTP 503)\n\nGitHub's API returned a server error.\n\nError: Service Unavailable"
    );
    expect(result).not.toContain("\n");
    expect(result).toContain("GitHub's API returned a server error.");
  });

  test("caps the appended excerpt at MERGE_ERROR_SUMMARY_EXCERPT_LIMIT chars", () => {
    const huge = "x".repeat(1000);
    const result = withOriginalMessage("headline", huge);
    // "headline: " prefix + excerpt, excerpt itself capped at the limit.
    const excerpt = result.slice("headline: ".length);
    expect(excerpt.length).toBeLessThanOrEqual(MERGE_ERROR_SUMMARY_EXCERPT_LIMIT);
  });

  test("returns the bare headline when the original message is empty", () => {
    expect(withOriginalMessage("headline", "")).toBe("headline");
    expect(withOriginalMessage("headline", "   ")).toBe("headline");
  });

  test("does not duplicate when the headline already contains the (short) original message", () => {
    expect(withOriginalMessage("Merge conflict: oops", "oops")).toBe("Merge conflict: oops");
  });
});

/**
 * End-to-end check that the summary text an operator actually sees (per
 * `classifyMergeError` + `withOriginalMessage` composition) satisfies the
 * mt#2890 acceptance criteria: rate-limit and 5xx failures are never
 * described as conflicts, and the true failure text is always visible.
 */
describe("classifyMergeError + withOriginalMessage composition (mt#2890 acceptance)", () => {
  function buildSummary(headline: string, err: unknown): string {
    const original = err instanceof Error ? err.message : String(err);
    return withOriginalMessage(headline, original);
  }

  test("rate-limit error produces a rate-limit summary, not a conflict summary", () => {
    const err = new Error(
      `GitHub Rate Limit Exceeded\n\nYou've hit GitHub's API rate limit.\n\nTo fix this:\n  - Wait a few minutes before trying again`
    );
    const errorClass = classifyMergeError(err);
    expect(errorClass.kind).toBe("rate-limit");

    const summary = buildSummary(
      "GitHub API rate limit exceeded — wait a few minutes before retrying the merge",
      err
    );
    expect(summary).not.toContain("Merge conflict");
    expect(summary).toContain("rate limit");
  });

  test("405 conflict error preserves a conflict summary with the original text visible", () => {
    const err = new Error(`Pull request #1988 has merge conflicts that must be resolved first`);
    const errorClass = classifyMergeError(err);
    expect(errorClass.kind).toBe("conflict");

    const conflictHeadline = "Merge conflict prevented PR from merging";
    const summary = buildSummary(conflictHeadline, err);
    expect(summary).toContain(conflictHeadline);
    expect(summary).toContain("has merge conflicts that must be resolved first");
  });

  test("5xx error produces a degraded summary carrying the HTTP status, not a conflict summary", () => {
    const err = new Error(
      `GitHub API degraded/unavailable (HTTP 500)\n\nGitHub's API returned a server error.`
    );
    const errorClass = classifyMergeError(err);
    expect(errorClass).toEqual({ kind: "degraded", status: "500" });

    const statusSuffix =
      errorClass.kind === "degraded" && errorClass.status ? ` (HTTP ${errorClass.status})` : "";
    const summary = buildSummary(`GitHub API degraded/unavailable${statusSuffix}`, err);
    expect(summary).toContain("HTTP 500");
    expect(summary).not.toContain("Merge conflict");
  });
});

// ---------------------------------------------------------------------------
// mt#3221 — end-to-end through the REAL producer.
//
// The tests above construct the degraded message by hand. These run the actual
// `handleOctokitError` output through `classifyMergeError`, so the producer and
// the parser are pinned together: Octokit synthesizes `status: 500` for every
// transport-level failure, and before mt#3221 that made the operator's own
// connectivity failure classify as a GitHub outage here.
// ---------------------------------------------------------------------------

describe("mt#3221 — transport failure vs GitHub-responded 5xx, end to end", () => {
  const CTX = {
    operation: "merge pull request",
    owner: "owner",
    repo: "repo",
    prNumber: 1988,
  };

  function thrownMessage(error: unknown): string {
    try {
      handleOctokitError(error, CTX);
    } catch (err) {
      return (err as Error).message;
    }
    throw new Error("expected handleOctokitError to throw");
  }

  test("a synthesized transport 5xx (status, no response) does NOT classify as degraded", () => {
    // The exact shape Octokit's fetch wrapper throws for a DNS/connection failure.
    const transport = new Error(
      "Unable to connect. Is the computer able to access the url?"
    ) as Error & { status: number };
    transport.status = 500;

    expect(classifyMergeError(new Error(thrownMessage(transport))).kind).toBe("other");
  });

  test("a GitHub-responded 5xx still classifies as degraded with its status", () => {
    const responded = new Error("boom") as Error & {
      status: number;
      response: { status: number };
    };
    responded.status = 503;
    responded.response = { status: 503 };

    expect(classifyMergeError(new Error(thrownMessage(responded)))).toEqual({
      kind: "degraded",
      status: "503",
    });
  });
});

// ---------------------------------------------------------------------------
// mt#3249 — the classification travels as DATA, so wording is no longer an API.
//
// Previously the domain layer computed what a failure was, discarded it into
// prose, and these classifiers reconstructed it by matching that prose. The
// round-trip is why mt#2890 had to push the status into the message purely so
// it could be read back, and why mt#3171/mt#3221 each had to prove they had
// not disturbed the headline. `GitHubApiError` carries the answer directly.
// ---------------------------------------------------------------------------

describe("mt#3249 — structured classification is preferred over message text", () => {
  test("a reworded message does not change the classification (the whole point)", () => {
    // Deliberately destroys BOTH prose signals the old path relied on: no
    // "GitHub API degraded/unavailable" headline and no "(HTTP 5xx)" token.
    const err = new GitHubApiError("something entirely different, no headline, no status token", {
      kind: "degraded",
      status: 503,
      respondedByServer: true,
    });

    expect(classifyMergeError(err)).toEqual({ kind: "degraded", status: "503" });
    expect(classifyOctokitOriginReadError(err)).toEqual({ kind: "degraded", status: "503" });
  });

  test("a reworded rate-limit message still classifies as rate-limit", () => {
    const err = new GitHubApiError("totally different wording", {
      kind: "rate-limit",
      respondedByServer: true,
    });

    expect(classifyMergeError(err)).toEqual({ kind: "rate-limit" });
    expect(classifyOctokitOriginReadError(err)).toEqual({ kind: "rate-limit" });
  });

  test("merge-blocked maps to conflict on the merge path, and to other on the read path", () => {
    // The read path has no "conflict" kind — these sites never produce
    // merge-conflict diagnoses (see the module doc), so it must not invent one.
    const err = new GitHubApiError("reworded, no conflict phrase present", {
      kind: "merge-blocked",
      status: 405,
      respondedByServer: true,
    });

    expect(classifyMergeError(err)).toEqual({ kind: "conflict" });
    expect(classifyOctokitOriginReadError(err)).toEqual({ kind: "other" });
  });

  test("kinds with no downstream meaning fall to 'other', not to a wrong class", () => {
    for (const kind of ["auth", "permission", "not-found", "network", "unclassified"] as const) {
      const err = new GitHubApiError("irrelevant text", { kind, respondedByServer: true });
      expect(classifyMergeError(err)).toEqual({ kind: "other" });
      expect(classifyOctokitOriginReadError(err)).toEqual({ kind: "other" });
    }
  });

  test("a degraded classification with no status omits it rather than emitting undefined", () => {
    const err = new GitHubApiError("x", { kind: "degraded", respondedByServer: true });
    expect(classifyMergeError(err)).toEqual({ kind: "degraded" });
  });

  test("back-compat: an error carrying NO classification still uses the string path", () => {
    // Non-Octokit origins and any unmigrated path must keep working.
    expect(
      classifyMergeError(new Error("GitHub API degraded/unavailable (HTTP 502)\n\nblah"))
    ).toEqual({ kind: "degraded", status: "502" });
    expect(classifyMergeError(new Error("hit the rate limit"))).toEqual({ kind: "rate-limit" });
    expect(classifyMergeError(new Error("merge conflict in foo.ts"))).toEqual({ kind: "conflict" });
  });

  test("PR #2018 R1 regression stays fixed on the read path", () => {
    // A domain-typed error whose message merely CONTAINS "rate limit" carries
    // no classification, so it takes the narrow headline path and is left
    // alone — not silently reclassified into a transport shape.
    expect(classifyOctokitOriginReadError(new Error("task 'rate limit' not found"))).toEqual({
      kind: "other",
    });
  });

  test("the real producer emits a structured error end to end", () => {
    // Not a hand-built fixture: this is what handleOctokitError actually throws.
    const responded = new Error("boom") as Error & {
      status: number;
      response: { status: number };
    };
    responded.status = 503;
    responded.response = { status: 503 };

    let thrown: unknown;
    try {
      handleOctokitError(responded, CTX_FOR_STRUCTURED);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(GitHubApiError);
    expect((thrown as GitHubApiError).classification).toEqual({
      kind: "degraded",
      status: 503,
      respondedByServer: true,
    });
    // And the consumer reads it without touching the message.
    expect(classifyMergeError(thrown)).toEqual({ kind: "degraded", status: "503" });
  });
});

const CTX_FOR_STRUCTURED = {
  operation: "merge pull request",
  owner: "owner",
  repo: "repo",
  prNumber: 1988,
};
