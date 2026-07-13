#!/usr/bin/env bun
/**
 * mt#2678 verification script — live CI log decode against a real GitHub
 * Actions run.
 *
 * Verifies that `viewWorkflowRunLogs` (the function `forge.ci_run_view_log`
 * calls under `backend.workflowRuns.viewLogs`) actually decodes a REAL
 * GitHub Actions run-log ZIP archive, not just the synthetic/recorded
 * fixtures covered by the unit tests in `github-workflow-runs.test.ts`.
 *
 * Why a live script and not just unit tests: the root cause (GitHub writes
 * run-log ZIP entries in "streaming" mode — general-purpose bit 3 set, local
 * header sizes zeroed, real sizes only in the central directory) is a
 * property of GitHub's live archive format. A recorded fixture pins today's
 * observed shape; a live run against the CURRENT most-recent completed run
 * on main is the acceptance criterion's actual bar ("Live check:
 * forge_ci_run_view_log against the most recent completed CI run on main
 * returns non-empty readable step output").
 *
 * USAGE
 *   GITHUB_TOKEN=$(gh auth token) bun scripts/verify-forge-ci-log-decode.ts
 *   # or set OCTOKIT_AUTH for a dedicated App installation token
 *   # optionally pin a specific run: ... bun scripts/verify-forge-ci-log-decode.ts <runId>
 *
 * ENV
 *   OCTOKIT_AUTH   Preferred — dedicated token (rate-limit isolation).
 *   GITHUB_TOKEN   Fallback — user PAT (e.g. via `gh auth token`).
 *
 * EXIT CODES
 *   0  Log decoded to readable, non-empty text — no DEFLATE-failure or
 *      base64-fallback markers present.
 *   1  Decode failed (DEFLATE-failure marker present, or empty output) —
 *      the regression this task fixes.
 *   2  Skipped — no token available, or no completed run found on main.
 */

import { Octokit } from "@octokit/rest";
import {
  listWorkflowRuns,
  viewWorkflowRunLogs,
} from "@minsky/domain/repository/github-workflow-runs";

const OWNER = "edobry";
const REPO = "minsky";

function resolveGitHubToken(): string | undefined {
  return process.env.OCTOKIT_AUTH || process.env.GITHUB_TOKEN;
}

const token = resolveGitHubToken();
if (!token) {
  console.log(
    "SKIP: Neither OCTOKIT_AUTH nor GITHUB_TOKEN set.\n" +
      "HINT: GITHUB_TOKEN=$(gh auth token) bun scripts/verify-forge-ci-log-decode.ts"
  );
  process.exit(2);
}

const octokit = new Octokit({ auth: token });
const gh = {
  owner: OWNER,
  repo: REPO,
  getToken: async () => token,
};

const pinnedRunId = process.argv[2] ? Number(process.argv[2]) : undefined;

let runId: number;
if (pinnedRunId) {
  runId = pinnedRunId;
  console.log(`Using pinned run ID: ${runId}`);
} else {
  // Filter on the "success" conclusion, not just "completed" — a completed
  // run can be "skipped" (e.g. a path-filtered workflow with zero jobs),
  // whose log archive is a legitimately EMPTY ZIP (0 entries). That's not
  // the DEFLATE-decode regression this script probes for; picking a run
  // that actually ran jobs keeps the check meaningful.
  const runs = await listWorkflowRuns(
    gh,
    { branch: "main", status: "success", perPage: 5 },
    octokit
  );
  const mostRecent = runs[0];
  if (!mostRecent) {
    console.log("SKIP: no successful workflow runs found on main.");
    process.exit(2);
  }
  runId = mostRecent.id;
  console.log(
    `Most recent completed run on main: ${runId} (${mostRecent.name}, ${mostRecent.created_at})`
  );
}

const logs = await viewWorkflowRunLogs(gh, runId, octokit);

const DEFLATE_FALLBACK_MARKER = "DEFLATE entry could not be inflated";
const BASE64_FALLBACK_MARKER = "[base64-encoded ZIP";

const hasDeflateFailure = logs.includes(DEFLATE_FALLBACK_MARKER);
const hasBase64Fallback = logs.includes(BASE64_FALLBACK_MARKER);
const nonEmpty = logs.trim().length > 0;

console.log(`\nDecoded log length: ${logs.length} chars`);
console.log(`Contains "${DEFLATE_FALLBACK_MARKER}": ${hasDeflateFailure}`);
console.log(`Contains "${BASE64_FALLBACK_MARKER}": ${hasBase64Fallback}`);
console.log(`\n--- first 500 chars of decoded output ---\n${logs.slice(0, 500)}`);

if (nonEmpty && !hasDeflateFailure && !hasBase64Fallback) {
  console.log("\nPASS: run log decoded to readable text, no fallback markers.");
  process.exit(0);
} else {
  console.log("\nFAIL: log did not decode cleanly (regression reproduced).");
  process.exit(1);
}
