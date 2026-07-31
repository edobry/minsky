/**
 * Tests for github-pr-checks.ts's `getCheckRunsForRef` (mt#2888).
 *
 * Covers the fail-closed fix: when BOTH the Checks API and the legacy
 * combined-status API fail (e.g. a GitHub-side 503 degradation window),
 * the function must THROW rather than silently return a
 * zero-checks/allPassed:false result — a "successful" empty result is
 * indistinguishable from "this commit legitimately has no CI configured"
 * (mt#1553 coordination: fail closed with distinct reasons on every fetch
 * site this task rewrites).
 */
import { describe, expect, test, mock } from "bun:test";
import { getCheckRunsForRef } from "./github-pr-checks";
import type { Octokit } from "@octokit/rest";

const GH = { owner: "edobry", repo: "minsky" };
const HEAD_SHA = "abc123def456";

function makeOctokit(opts: {
  checkRuns?: () => Promise<unknown>;
  combinedStatus?: () => Promise<unknown>;
}): Octokit {
  return {
    rest: {
      checks: {
        listForRef:
          opts.checkRuns ?? mock(async () => ({ data: { check_runs: [], total_count: 0 } })),
      },
      repos: {
        getCombinedStatusForRef:
          opts.combinedStatus ?? mock(async () => ({ data: { statuses: [] } })),
      },
    },
  } as unknown as Octokit;
}

describe("getCheckRunsForRef — fail-closed on total fetch failure (mt#2888 / mt#1553)", () => {
  test("both fetches failing throws the check-runs rejection, not a silent empty result", async () => {
    const checkRunsError = Object.assign(new Error("Service Unavailable"), { status: 503 });
    const octokit = makeOctokit({
      checkRuns: mock(async () => {
        throw checkRunsError;
      }),
      combinedStatus: mock(async () => {
        throw new Error("combined status also unavailable");
      }),
    });

    await expect(getCheckRunsForRef(GH, HEAD_SHA, octokit)).rejects.toBe(checkRunsError);
  });

  test("only check-runs failing, combined-status succeeding: tolerated, no throw", async () => {
    const octokit = makeOctokit({
      checkRuns: mock(async () => {
        throw new Error("checks API down");
      }),
      combinedStatus: mock(async () => ({
        data: { statuses: [{ state: "success", context: "legacy-ci" }] },
      })),
    });

    const result = await getCheckRunsForRef(GH, HEAD_SHA, octokit);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]?.name).toBe("legacy-ci");
  });

  test("only combined-status failing, check-runs succeeding: tolerated, no throw", async () => {
    const octokit = makeOctokit({
      checkRuns: mock(async () => ({
        data: {
          check_runs: [{ name: "build", status: "completed", conclusion: "success" }],
        },
      })),
      combinedStatus: mock(async () => {
        throw new Error("legacy statuses API down");
      }),
    });

    const result = await getCheckRunsForRef(GH, HEAD_SHA, octokit);
    expect(result.checks).toHaveLength(1);
    expect(result.allPassed).toBe(true);
  });

  test("both fetches succeeding with zero checks returns a genuine empty result (not a failure)", async () => {
    const octokit = makeOctokit({});
    const result = await getCheckRunsForRef(GH, HEAD_SHA, octokit);
    expect(result.checks).toHaveLength(0);
    expect(result.summary.total).toBe(0);
  });
});
