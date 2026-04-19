/**
 * GitHub PR check run queries.
 *
 * Reusable logic for fetching and categorising CI check results for a given
 * commit SHA via the GitHub Checks API and the legacy combined-status API.
 */

import { Octokit } from "@octokit/rest";
import { log } from "../../utils/logger";
import type { GitHubContext } from "./github-pr-operations";

// ── Public interfaces ────────────────────────────────────────────────────

export interface CheckRunResult {
  /** Check name as reported by GitHub. */
  name: string;
  /** Run lifecycle state: "completed" | "queued" | "in_progress" */
  status: string;
  /**
   * Terminal outcome when status === "completed".
   * One of: "success" | "failure" | "neutral" | "cancelled" | "skipped" |
   *         "timed_out" | "action_required" | null
   */
  conclusion: string | null;
  /** Link to the detailed check-run page on GitHub (or null). */
  url: string | null;
}

export interface ChecksResult {
  /** True when every check has passed (or been skipped/neutralised). */
  allPassed: boolean;
  /** Set to true only when returned from a wait-loop that exceeded its deadline. */
  timedOut?: boolean;
  summary: {
    total: number;
    passed: number;
    failed: number;
    pending: number;
  };
  checks: CheckRunResult[];
}

// ── Internal GitHub API shapes ───────────────────────────────────────────

interface RawCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string | null;
  details_url?: string | null;
}

interface RawCommitStatus {
  state: string;
  context?: string;
  description?: string;
  target_url?: string | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Conclusions that are considered a non-blocking pass. */
const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

function classifyCheckRun(run: RawCheckRun): "passed" | "failed" | "pending" {
  if (run.status !== "completed") return "pending";
  if (run.conclusion === null) return "pending";
  if (PASSING_CONCLUSIONS.has(run.conclusion)) return "passed";
  return "failed";
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Fetch all check runs (and legacy commit statuses) for the given commit SHA,
 * classify them, and return a structured summary.
 *
 * Legacy commit statuses (submitted via the Statuses API rather than the
 * Checks API) are included so that older CI integrations are not missed.
 */
export async function getCheckRunsForRef(
  gh: GitHubContext,
  headSha: string,
  octokit: Octokit
): Promise<ChecksResult> {
  const { owner, repo } = gh;

  // Fetch check-runs and combined status in parallel.
  const [checkRunsResp, combinedStatusResp] = await Promise.allSettled([
    octokit.rest.checks.listForRef({ owner, repo, ref: headSha, per_page: 100 }),
    octokit.rest.repos.getCombinedStatusForRef({ owner, repo, ref: headSha }),
  ]);

  const allChecks: CheckRunResult[] = [];

  // --- Checks API results ---
  if (checkRunsResp.status === "fulfilled") {
    const rawRuns = checkRunsResp.value.data.check_runs as RawCheckRun[];
    for (const run of rawRuns) {
      allChecks.push({
        name: run.name,
        status: run.status,
        conclusion: run.conclusion,
        url: run.html_url || run.details_url || null,
      });
    }
  } else {
    log.debug("Failed to fetch check runs", { error: checkRunsResp.reason });
  }

  // --- Legacy statuses (only add if not already covered by check runs) ---
  const checkNames = new Set(allChecks.map((c) => c.name));
  if (combinedStatusResp.status === "fulfilled") {
    const statuses = combinedStatusResp.value.data.statuses as RawCommitStatus[];
    for (const s of statuses) {
      const name = s.context || s.description || "status";
      if (checkNames.has(name)) continue; // already present via Checks API
      const status = s.state === "pending" ? "in_progress" : "completed";
      const conclusion =
        s.state === "success" ? "success" : s.state === "pending" ? null : "failure";
      allChecks.push({
        name,
        status,
        conclusion,
        url: s.target_url || null,
      });
    }
  } else {
    log.debug("Failed to fetch combined status", { error: combinedStatusResp.reason });
  }

  // --- Summarise ---
  let passed = 0;
  let failed = 0;
  let pending = 0;

  for (const check of allChecks) {
    const category = classifyCheckRun({
      name: check.name,
      status: check.status,
      conclusion: check.conclusion,
      html_url: check.url,
    });
    if (category === "passed") passed++;
    else if (category === "failed") failed++;
    else pending++;
  }

  const allPassed = allChecks.length > 0 && failed === 0 && pending === 0;

  return {
    allPassed,
    summary: { total: allChecks.length, passed, failed, pending },
    checks: allChecks,
  };
}
