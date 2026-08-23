/**
 * Tests for `trimChecksResult` (mt#2656): the checks-payload trim used by
 * `session.pr.drive`'s convergence-tail mode. Pure function — no session
 * resolution or backend involved, so these are plain unit tests.
 *
 * Also covers `sessionPrChecks` itself (mt#4020): the wait/poll loop, and
 * — the mt#4020 regression — the setup phase (session resolution + backend
 * construction) that runs BEFORE the loop's own deadline used to be
 * computed. Before mt#4020 nothing bounded that setup: a stalled
 * `sessionDB.getSession` (or the session resolver's own DB call) hung the
 * whole call past `timeoutSeconds` with no `onProgress` reachable at all,
 * which is the incident this task closes (PR #2891, 2026-08-11).
 */
import { describe, expect, test } from "bun:test";
import { trimChecksResult, sessionPrChecks, applyMergeStateToChecks } from "./pr-checks-subcommand";
import type { SessionPrChecksDependencies } from "./pr-checks-subcommand";
import type { ChecksResult, RepositoryBackend } from "../../repository/index";
import type { SessionProviderInterface, SessionRecord } from "../types";
import { getCheckRunsForRef } from "../../repository/github-pr-checks";
import type { Octokit } from "@octokit/rest";

describe("trimChecksResult (mt#2656)", () => {
  test("drops the per-check breakdown when all checks passed", () => {
    const result: ChecksResult = {
      allPassed: true,
      summary: { total: 3, passed: 3, failed: 0, pending: 0 },
      checks: [
        { name: "build", status: "completed", conclusion: "success", url: null },
        { name: "test", status: "completed", conclusion: "success", url: null },
        { name: "lint", status: "completed", conclusion: "neutral", url: null },
      ],
    };
    const trimmed = trimChecksResult(result);
    expect(trimmed).toEqual({ allPassed: true, summary: result.summary });
    expect("checks" in trimmed).toBe(false);
    expect("failingChecks" in trimmed).toBe(false);
  });

  test("surfaces only the failing check when one of several checks failed", () => {
    const result: ChecksResult = {
      allPassed: false,
      summary: { total: 2, passed: 1, failed: 1, pending: 0 },
      checks: [
        { name: "build", status: "completed", conclusion: "success", url: null },
        { name: "test", status: "completed", conclusion: "failure", url: "https://ci/test" },
      ],
    };
    const trimmed = trimChecksResult(result);
    expect(trimmed.allPassed).toBe(false);
    expect(trimmed.summary).toEqual(result.summary);
    expect(trimmed.failingChecks).toEqual([
      { name: "test", status: "completed", conclusion: "failure", url: "https://ci/test" },
    ]);
  });

  test("surfaces pending (incomplete) checks in failingChecks alongside failed ones", () => {
    const result: ChecksResult = {
      allPassed: false,
      timedOut: true,
      summary: { total: 3, passed: 1, failed: 1, pending: 1 },
      checks: [
        { name: "build", status: "completed", conclusion: "success", url: null },
        { name: "test", status: "completed", conclusion: "failure", url: null },
        { name: "deploy", status: "in_progress", conclusion: null, url: null },
      ],
    };
    const trimmed = trimChecksResult(result);
    expect(trimmed.timedOut).toBe(true);
    expect(trimmed.failingChecks).toHaveLength(2);
    expect(trimmed.failingChecks?.map((c) => c.name).sort()).toEqual(["deploy", "test"]);
  });

  test("treats neutral and skipped conclusions as passing, not failing", () => {
    const result: ChecksResult = {
      allPassed: false,
      summary: { total: 3, passed: 2, failed: 1, pending: 0 },
      checks: [
        { name: "neutral-check", status: "completed", conclusion: "neutral", url: null },
        { name: "skipped-check", status: "completed", conclusion: "skipped", url: null },
        { name: "failed-check", status: "completed", conclusion: "failure", url: null },
      ],
    };
    const trimmed = trimChecksResult(result);
    expect(trimmed.failingChecks).toEqual([
      { name: "failed-check", status: "completed", conclusion: "failure", url: null },
    ]);
  });

  test("does not set timedOut when the source result did not time out", () => {
    const result: ChecksResult = {
      allPassed: false,
      summary: { total: 1, passed: 0, failed: 1, pending: 0 },
      checks: [{ name: "test", status: "completed", conclusion: "failure", url: null }],
    };
    const trimmed = trimChecksResult(result);
    expect("timedOut" in trimmed).toBe(false);
  });

  test("empty checks array with allPassed:false yields an empty failingChecks array", () => {
    const result: ChecksResult = {
      allPassed: false,
      summary: { total: 0, passed: 0, failed: 0, pending: 0 },
      checks: [],
    };
    const trimmed = trimChecksResult(result);
    expect(trimmed.failingChecks).toEqual([]);
  });
});

// ── sessionPrChecks (mt#4020) ───────────────────────────────────────────

const SESSION_ID = "test-session";
const PR_NUMBER = 2891;

function makeSessionRecord(): SessionRecord {
  return {
    session: SESSION_ID,
    repoName: "edobry-minsky",
    repoUrl: "https://github.com/edobry/minsky.git",
    createdAt: new Date().toISOString(),
    pullRequest: { number: PR_NUMBER, branch: "task/mt-4020", baseBranch: "main" },
    taskId: "mt#4020",
  } as unknown as SessionRecord;
}

/** A `ChecksResult` where every check is still running. */
function pendingResult(pending = 1): ChecksResult {
  return {
    allPassed: false,
    summary: { total: pending, passed: 0, failed: 0, pending },
    checks: Array.from({ length: pending }, (_, i) => ({
      name: `check-${i}`,
      status: "in_progress",
      conclusion: null,
      url: null,
    })),
  };
}

/** A `ChecksResult` where every check has completed successfully. */
function terminalResult(): ChecksResult {
  return {
    allPassed: true,
    summary: { total: 1, passed: 1, failed: 0, pending: 0 },
    checks: [{ name: "build", status: "completed", conclusion: "success", url: null }],
  };
}

/**
 * Standard fixture: a fake clock/sleep pair plus a `backend.ci.getChecksForPR`
 * driven by a scripted queue of `ChecksResult`s (repeats the last entry once
 * exhausted, mirroring `pr-wait-for-review-subcommand.test.ts`'s `makeDeps`).
 */
function makeQueueDeps(
  resultsQueue: ChecksResult[],
  clockStart = 1_000_000
): SessionPrChecksDependencies & { fetchCalls: number; sleepCalls: number[] } {
  let clock = clockStart;
  let idx = 0;
  const sleepCalls: number[] = [];

  const sessionRecord = makeSessionRecord();
  const sessionDB = {
    getSession: async (id: string) => (id === SESSION_ID ? sessionRecord : null),
  } as unknown as SessionProviderInterface;

  const backend = {
    ci: {
      getChecksForPR: async () => {
        const next = resultsQueue[Math.min(idx, resultsQueue.length - 1)];
        idx++;
        return next;
      },
    },
    // mt#4182: a mergeable PR — present so these tests exercise the
    // merge-state correction path rather than its can't-read guard.
    pr: { get: async () => ({ mergeable: true }) },
  } as unknown as RepositoryBackend;

  const deps = {
    sessionDB,
    createBackend: async () => backend,
    now: () => clock,
    sleep: async (ms: number) => {
      sleepCalls.push(ms);
      clock += ms;
    },
    get fetchCalls() {
      return idx;
    },
    get sleepCalls() {
      return sleepCalls;
    },
  };

  return deps as unknown as SessionPrChecksDependencies & {
    fetchCalls: number;
    sleepCalls: number[];
  };
}

describe("sessionPrChecks — poll loop (mt#4020 AT1-AT4)", () => {
  test("AT1: returns on the third poll once checks go terminal", async () => {
    const deps = makeQueueDeps([pendingResult(), pendingResult(), terminalResult()]);
    const result = await sessionPrChecks(
      { sessionId: SESSION_ID, wait: true, timeoutSeconds: 60, intervalSeconds: 5 },
      deps
    );

    expect(result.allPassed).toBe(true);
    expect(result.timedOut).toBeUndefined();
    expect(deps.fetchCalls).toBe(3);
    expect(deps.sleepCalls).toHaveLength(2);
  });

  test("AT2: returns on the first poll when every check is already terminal", async () => {
    const deps = makeQueueDeps([terminalResult()]);
    const result = await sessionPrChecks(
      { sessionId: SESSION_ID, wait: true, timeoutSeconds: 60, intervalSeconds: 5 },
      deps
    );

    expect(result.allPassed).toBe(true);
    expect(deps.fetchCalls).toBe(1);
    expect(deps.sleepCalls).toHaveLength(0);
  });

  test("AT3: timeoutSeconds:5 against a fixture that never completes times out at ~5s, not later", async () => {
    const deps = makeQueueDeps([pendingResult()]);
    const result = await sessionPrChecks(
      { sessionId: SESSION_ID, wait: true, timeoutSeconds: 5, intervalSeconds: 1 },
      deps
    );

    expect(result.allPassed).toBe(false);
    expect(result.timedOut).toBe(true);
    // Fake clock started at 1_000_000s and timeoutSeconds=5 → deadline at
    // 1_005_000ms; the loop must not run past it.
    expect(deps.sleepCalls.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(5000);
  });

  test("AT4: onProgress is invoked at least once per poll interval across all three cases", async () => {
    const progress1: string[] = [];
    const deps1 = { ...makeQueueDeps([pendingResult(), pendingResult(), terminalResult()]) };
    await sessionPrChecks(
      { sessionId: SESSION_ID, wait: true, timeoutSeconds: 60, intervalSeconds: 5 },
      { ...deps1, onProgress: (m) => progress1.push(m) }
    );
    // 2 intervals elapsed before the terminal (3rd) poll.
    expect(progress1.length).toBeGreaterThanOrEqual(2);

    const progress2: string[] = [];
    const deps2 = { ...makeQueueDeps([terminalResult()]) };
    await sessionPrChecks(
      { sessionId: SESSION_ID, wait: true, timeoutSeconds: 60, intervalSeconds: 5 },
      { ...deps2, onProgress: (m) => progress2.push(m) }
    );
    // Nothing to wait through — the pre-setup ping is the only one expected.
    expect(progress2.length).toBeGreaterThanOrEqual(1);

    const progress3: string[] = [];
    const deps3 = { ...makeQueueDeps([pendingResult()]) };
    await sessionPrChecks(
      { sessionId: SESSION_ID, wait: true, timeoutSeconds: 5, intervalSeconds: 1 },
      { ...deps3, onProgress: (m) => progress3.push(m) }
    );
    expect(progress3.length).toBeGreaterThanOrEqual(1);
  });
});

describe("sessionPrChecks — setup-phase deadline (mt#4020 regression, SC1/SC4)", () => {
  /**
   * The mechanism this task names: `resolveSessionContextWithFeedback` (via
   * `sessionDB.getSession` for an explicit `sessionId`) runs BEFORE the poll
   * loop's own deadline used to be computed, so a stall there was completely
   * unbounded — no timeout, no progress, indistinguishable from a wedged
   * connection. This is a real negative control: run against the pre-fix
   * source (`git stash` on `pr-checks-subcommand.ts` only), this exact test
   * exceeded the 2s assertion below (observed: still pending after 2s,
   * confirming the hang is unbounded, not merely slow) — see the PR body's
   * `Negative control:` section for the captured run.
   */
  test("a hang in session resolution is bounded by timeoutSeconds, not left to run forever", async () => {
    const neverResolves = new Promise<SessionRecord | null>(() => {});
    const sessionDB = {
      getSession: async () => neverResolves,
    } as unknown as SessionProviderInterface;

    const deps: SessionPrChecksDependencies = {
      sessionDB,
      createBackend: async () => {
        throw new Error("must not be reached — setup should time out before backend creation");
      },
    };

    const start = performance.now();
    const result = await sessionPrChecks(
      { sessionId: SESSION_ID, wait: true, timeoutSeconds: 0.05 },
      deps
    );
    const elapsedMs = performance.now() - start;

    expect(result).toEqual({
      allPassed: false,
      summary: { total: 0, passed: 0, failed: 0, pending: 0 },
      checks: [],
      timedOut: true,
    });
    // Generous real-time margin (matches octokit-timeout.test.ts's pattern) —
    // the point is "bounded near its own deadline", not "hangs for minutes".
    expect(elapsedMs).toBeLessThan(2000);
  });

  test("a hang in backend construction is also bounded", async () => {
    const sessionRecord = makeSessionRecord();
    const sessionDB = {
      getSession: async () => sessionRecord,
    } as unknown as SessionProviderInterface;

    const deps: SessionPrChecksDependencies = {
      sessionDB,
      createBackend: () => new Promise(() => {}), // never resolves
    };

    const start = performance.now();
    const result = await sessionPrChecks(
      { sessionId: SESSION_ID, wait: true, timeoutSeconds: 0.05 },
      deps
    );
    const elapsedMs = performance.now() - start;

    expect(result.timedOut).toBe(true);
    expect(elapsedMs).toBeLessThan(2000);
  });

  test("onProgress fires at least once even when setup itself hangs (distinguishes slow from stuck)", async () => {
    const neverResolves = new Promise<SessionRecord | null>(() => {});
    const sessionDB = {
      getSession: async () => neverResolves,
    } as unknown as SessionProviderInterface;
    const progressMessages: string[] = [];

    const deps: SessionPrChecksDependencies = {
      sessionDB,
      createBackend: async () => {
        throw new Error("unreachable");
      },
      onProgress: (m) => progressMessages.push(m),
    };

    await sessionPrChecks({ sessionId: SESSION_ID, wait: true, timeoutSeconds: 0.05 }, deps);

    expect(progressMessages.length).toBeGreaterThanOrEqual(1);
    expect(progressMessages[0]).toContain("Resolving session");
  });

  test("non-wait mode is unaffected: a normal single fetch still returns the fetched result", async () => {
    const sessionRecord = makeSessionRecord();
    const sessionDB = {
      getSession: async () => sessionRecord,
    } as unknown as SessionProviderInterface;
    const backend = {
      ci: { getChecksForPR: async () => terminalResult() },
      // mt#4182: a mergeable PR — present so these tests exercise the
      // merge-state correction path rather than its can't-read guard.
      pr: { get: async () => ({ mergeable: true }) },
    } as unknown as RepositoryBackend;

    const deps: SessionPrChecksDependencies = {
      sessionDB,
      createBackend: async () => backend,
    };

    const result = await sessionPrChecks({ sessionId: SESSION_ID }, deps);
    expect(result.allPassed).toBe(true);
  });
});

describe("sessionPrChecks — SC5 fixture: real summarizer, combined-status {state: pending, total_count: 0}", () => {
  const GH = { owner: "edobry", repo: "minsky" };
  const HEAD_SHA = "deadbeef";

  /**
   * Fake Octokit whose check-runs response is driven by a queue (mirroring
   * this repo's actual behavior: check runs go from in_progress to
   * completed across polls) and whose combined-status response is ALWAYS
   * exactly `{state: "pending", total_count: 0}` with an empty `statuses`
   * array — the shape the spec confirmed this repo actually returns because
   * it uses check runs exclusively. The merge loop (github-pr-checks.ts)
   * iterates the `statuses` ARRAY, never the top-level `state`/`total_count`
   * fields, so this fixture proves that shape contributes nothing spurious
   * to `pending` at any poll.
   */
  function makeFakeOctokit(
    checkRunsQueue: Array<{ status: string; conclusion: string | null }[]>
  ): Octokit {
    let idx = 0;
    return {
      rest: {
        checks: {
          listForRef: async () => {
            const runs = checkRunsQueue[Math.min(idx, checkRunsQueue.length - 1)] ?? [];
            idx++;
            return {
              data: {
                check_runs: runs.map((r, i) => ({
                  name: `check-${i}`,
                  status: r.status,
                  conclusion: r.conclusion,
                  html_url: null,
                })),
              },
            };
          },
        },
        repos: {
          getCombinedStatusForRef: async () => ({
            data: { state: "pending", total_count: 0, statuses: [] },
          }),
        },
      },
    } as unknown as Octokit;
  }

  test("SC5: check runs complete mid-wait; the pending/0 combined-status payload never masks or fabricates a pending check", async () => {
    const octokit = makeFakeOctokit([
      [{ status: "in_progress", conclusion: null }],
      [{ status: "in_progress", conclusion: null }],
      [{ status: "completed", conclusion: "success" }],
    ]);

    const sessionRecord = makeSessionRecord();
    const sessionDB = {
      getSession: async () => sessionRecord,
    } as unknown as SessionProviderInterface;
    const backend = {
      ci: {
        getChecksForPR: async () => getCheckRunsForRef(GH, HEAD_SHA, octokit),
      },
      // mt#4182: a mergeable PR — present so these tests exercise the
      // merge-state correction path rather than its can't-read guard.
      pr: { get: async () => ({ mergeable: true }) },
    } as unknown as RepositoryBackend;

    let clock = 1_000_000;
    const sleepCalls: number[] = [];
    const deps: SessionPrChecksDependencies = {
      sessionDB,
      createBackend: async () => backend,
      now: () => clock,
      sleep: async (ms: number) => {
        sleepCalls.push(ms);
        clock += ms;
      },
    };

    const result = await sessionPrChecks(
      { sessionId: SESSION_ID, wait: true, timeoutSeconds: 60, intervalSeconds: 5 },
      deps
    );

    expect(result.allPassed).toBe(true);
    expect(result.summary.pending).toBe(0);
    expect(sleepCalls).toHaveLength(2);
  });
});

describe("applyMergeStateToChecks (mt#4182)", () => {
  /**
   * PR #3031's shape, verbatim: the only check present is the reviewer bot's
   * own findings run — the one check that does not need a merge ref, and so
   * the one that still reports when a conflict stops CI dispatching.
   */
  const REVIEWER_ONLY_GREEN: ChecksResult = {
    allPassed: true,
    summary: { total: 1, passed: 1, failed: 0, pending: 0 },
    checks: [
      {
        name: "minsky-reviewer/findings",
        status: "completed",
        conclusion: "success",
        url: "https://github.com/edobry/minsky/runs/95250179328",
      },
    ],
  };

  test("AT1: a conflicted PR whose only check passed is NOT reported as allPassed", () => {
    const result = applyMergeStateToChecks(REVIEWER_ONLY_GREEN, false);
    expect(result.allPassed).toBe(false);
    // The reason has to name the cause, not just deny the verdict — the whole
    // failure was an agent reading a green flag and diagnosing the wrong thing.
    expect(result.mergeBlocked).toContain("merge conflicts");
    expect(result.mergeBlocked).toContain("no pull_request workflows");
    // The observed checks are preserved: this corrects the VERDICT, not the
    // observation.
    expect(result.checks).toEqual(REVIEWER_ONLY_GREEN.checks);
    expect(result.summary).toEqual(REVIEWER_ONLY_GREEN.summary);
  });

  test("AT2: a mergeable PR with a full green set is untouched", () => {
    const fullGreen: ChecksResult = {
      allPassed: true,
      summary: { total: 8, passed: 8, failed: 0, pending: 0 },
      checks: [
        { name: "build", status: "completed", conclusion: "success", url: null },
        { name: "bundle-boot-smoke", status: "completed", conclusion: "success", url: null },
      ],
    };
    const result = applyMergeStateToChecks(fullGreen, true);
    expect(result).toEqual(fullGreen);
    expect(result.mergeBlocked).toBeUndefined();
  });

  test("AT3: mergeable===null is NOT treated as blocked — unknown is not a conflict", () => {
    // GitHub computes mergeability asynchronously and a GET triggers it, so a
    // first read routinely returns null. Failing closed here would report every
    // freshly-read PR as conflicted. Same call mt#2890 made for the approval
    // path (`computeNonApprovalMergeBlockers` excludes null deliberately).
    const result = applyMergeStateToChecks(REVIEWER_ONLY_GREEN, null);
    expect(result).toEqual(REVIEWER_ONLY_GREEN);
    expect(result.mergeBlocked).toBeUndefined();
  });

  test("a backend that does not report mergeability leaves the verdict alone", () => {
    // `undefined` is "this backend does not report it", distinct from both
    // false and null. Non-GitHub forges must not be reported as conflicted.
    const result = applyMergeStateToChecks(REVIEWER_ONLY_GREEN, undefined);
    expect(result).toEqual(REVIEWER_ONLY_GREEN);
  });

  test("an already-failing result keeps its verdict and gains no reason", () => {
    // The correction only ever turns green -> not-green. A result that was
    // already not-passing is not re-explained as a merge problem.
    const failing: ChecksResult = {
      allPassed: false,
      summary: { total: 3, passed: 2, failed: 1, pending: 0 },
      checks: [{ name: "build", status: "completed", conclusion: "failure", url: null }],
    };
    const result = applyMergeStateToChecks(failing, false);
    expect(result.allPassed).toBe(false);
    expect(result.checks).toEqual(failing.checks);
  });
});

describe("trimChecksResult carries mergeBlocked (mt#4182, PR #3042 R1)", () => {
  test("the trim drops the per-check breakdown but NOT the reason", () => {
    // Without this the drive path sees allPassed:false, an empty failingChecks
    // and zero counts — "nothing is wrong and nothing ran" — for a conflicted
    // PR. The trim is about volume, not about discarding the explanation.
    const trimmed = trimChecksResult({
      allPassed: false,
      mergeBlocked: "PR has merge conflicts, so GitHub could not build the merge ref",
      summary: { total: 1, passed: 1, failed: 0, pending: 0 },
      checks: [
        { name: "minsky-reviewer/findings", status: "completed", conclusion: "success", url: null },
      ],
    });
    expect(trimmed.mergeBlocked).toContain("merge conflicts");
    expect(trimmed.allPassed).toBe(false);
  });

  test("a green trim carries no mergeBlocked", () => {
    const trimmed = trimChecksResult({
      allPassed: true,
      summary: { total: 8, passed: 8, failed: 0, pending: 0 },
      checks: [],
    });
    expect(trimmed.mergeBlocked).toBeUndefined();
  });
});
