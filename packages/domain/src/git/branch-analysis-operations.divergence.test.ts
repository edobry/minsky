/**
 * `analyzeBranchDivergence` must distinguish "could not measure" from
 * "measured zero divergence" (mt#3220).
 *
 * Before this, a failed or unparseable `git rev-list` returned
 * `aheadCommits: 0, behindCommits: 0, divergenceType: "none",
 * recommendedAction: "none"` — byte-identical to a genuinely converged pair.
 * That value is not merely displayed: `smartSessionUpdate` branches on it and
 * would return "No update needed - session is current or ahead", silently
 * skipping an update for a session that may well have been behind.
 *
 * Same family as mt#3164 (git_status defaulting ahead/behind to 0) and mt#3163
 * (an empty grep result reading as "no matches") — an inapplicable measurement
 * rendered as a confident answer.
 */
import { describe, test, expect } from "bun:test";
import {
  analyzeBranchDivergenceImpl,
  parseCount,
  unknownDivergence,
  type BranchAnalysisDeps,
} from "./branch-analysis-operations";

const REPO = "/tmp/repo";
const SESSION_BRANCH = "task/mt-3220";
const BASE_BRANCH = "main";

const silentLog: BranchAnalysisDeps["log"] = {
  debug: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * `execAsync` stub. `revList` is what the rev-list call returns (or throws);
 * everything else returns a plausible default so the function reaches the
 * branch under test.
 */
function makeDeps(revList: { stdout?: unknown } | Error): BranchAnalysisDeps {
  return {
    log: silentLog,
    async execAsync(command: string) {
      if (command.includes("rev-list")) {
        if (revList instanceof Error) throw revList;
        return { stdout: revList.stdout as string, stderr: "" };
      }
      if (command.includes("merge-base")) return { stdout: "abc123\n", stderr: "" };
      return { stdout: "", stderr: "" };
    },
  } as BranchAnalysisDeps;
}

describe("undeterminable divergence is distinguishable from convergence (mt#3220)", () => {
  test("empty rev-list output yields unknown, not none (AT1)", async () => {
    const result = await analyzeBranchDivergenceImpl(
      REPO,
      SESSION_BRANCH,
      BASE_BRANCH,
      makeDeps({ stdout: "" })
    );

    expect(result.divergenceType).toBe("unknown");
    // The assertion that actually matters: it must not read as "verified
    // nothing to do", which is what a caller acts on.
    expect(result.recommendedAction).not.toBe("none");
    expect(result.recommendedAction).toBe("manual_review");
    expect(result.aheadCommits).toBeNull();
    expect(result.behindCommits).toBeNull();
    expect(result.lastCommonCommit).toBeNull();
  });

  test("unparseable rev-list output yields unknown, and specifically not 0/0 (AT2)", async () => {
    const result = await analyzeBranchDivergenceImpl(
      REPO,
      SESSION_BRANCH,
      BASE_BRANCH,
      makeDeps({ stdout: "garbage\n" })
    );

    expect(result.divergenceType).toBe("unknown");
    // Pins the pre-fix values explicitly: `Number("garbage") || 0` produced
    // exactly this, and it is what made the failure invisible.
    expect(result.aheadCommits === 0 && result.behindCommits === 0).toBe(false);
    expect(result.recommendedAction).not.toBe("none");
  });

  test("a partial row (one field) is unknown rather than half-zero", async () => {
    const result = await analyzeBranchDivergenceImpl(
      REPO,
      SESSION_BRANCH,
      BASE_BRANCH,
      makeDeps({ stdout: "3\n" })
    );
    expect(result.divergenceType).toBe("unknown");
  });

  test("a thrown rev-list propagates rather than reporting convergence (AT3)", async () => {
    // Checked because the filing spec flagged this path as unread. It rethrows,
    // which is already correct — a caller sees a failure instead of a false
    // "nothing to do". Pinned so a future refactor cannot quietly convert it
    // into a swallowed zero.
    await expect(
      analyzeBranchDivergenceImpl(
        REPO,
        SESSION_BRANCH,
        BASE_BRANCH,
        makeDeps(new Error("fatal: bad revision"))
      )
    ).rejects.toThrow(/bad revision/);
  });

  test("a genuine 0/0 still reports converged — the honest zero stays reachable (AT4)", async () => {
    const result = await analyzeBranchDivergenceImpl(
      REPO,
      SESSION_BRANCH,
      BASE_BRANCH,
      makeDeps({ stdout: "0\t0\n" })
    );

    expect(result.divergenceType).toBe("none");
    expect(result.recommendedAction).toBe("none");
    expect(result.aheadCommits).toBe(0);
    expect(result.behindCommits).toBe(0);
  });

  test("real counts still parse correctly — regression guard (AT5)", async () => {
    // rev-list --left-right --count emits "<behind>\t<ahead>" for base...session.
    const result = await analyzeBranchDivergenceImpl(
      REPO,
      SESSION_BRANCH,
      BASE_BRANCH,
      makeDeps({ stdout: "3\t2\n" })
    );

    expect(result.behindCommits).toBe(3);
    expect(result.aheadCommits).toBe(2);
    expect(result.divergenceType).toBe("diverged");
  });
});

describe("parseCount", () => {
  test("parses a non-negative integer", () => {
    expect(parseCount("0")).toBe(0);
    expect(parseCount("42")).toBe(42);
    expect(parseCount(" 7 ")).toBe(7);
  });

  test("returns null for everything that is not one", () => {
    // Each of these became 0 under `Number(x) || 0`.
    expect(parseCount(undefined)).toBeNull();
    expect(parseCount("")).toBeNull();
    expect(parseCount("garbage")).toBeNull();
    expect(parseCount("-1")).toBeNull();
    expect(parseCount("1.5")).toBeNull();
    expect(parseCount("NaN")).toBeNull();
  });
});

describe("unknownDivergence", () => {
  test("never reports a recommendedAction that reads as verified-no-op", () => {
    const result = unknownDivergence(SESSION_BRANCH, BASE_BRANCH);
    expect(result.divergenceType).toBe("unknown");
    expect(result.recommendedAction).toBe("manual_review");
    expect(result.aheadCommits).toBeNull();
    expect(result.behindCommits).toBeNull();
    expect(result.lastCommonCommit).toBeNull();
    expect(result.sessionBranch).toBe(SESSION_BRANCH);
    expect(result.baseBranch).toBe(BASE_BRANCH);
  });
});
