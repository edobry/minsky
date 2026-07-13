#!/usr/bin/env bun
/**
 * Seeded-bug fidelity harness for mt#1515.
 *
 * Creates a real PR containing a deliberate, known-location bug, then asserts
 * that minsky-reviewer[bot] catches it with a CHANGES_REQUESTED review citing
 * the correct file and line range.
 *
 * What it does:
 *   1. Reads GITHUB_TOKEN (required), OWNER/REPO/BASE_BRANCH (optional).
 *   2. Picks a bug pattern from a fixed catalog (off-by-one, null-deref, or
 *      unhandled-promise). All three patterns are deterministic; the catalog is
 *      small by design so each run exercises a known code path.
 *   3. Creates a unique branch `mt-1515-seeded-bug-<utc-iso8601>`.
 *   4. Pushes a single commit adding a file under
 *      services/reviewer/scripts/__seeded_bug_targets__/<name>.ts.
 *   5. Opens a PR with body `<!-- minsky:tier=3 -->` so the reviewer routes it.
 *   6. Polls for a review by minsky-reviewer[bot] every 15s up to 5 min.
 *   7. Asserts: (a) at least one review exists, (b) state is CHANGES_REQUESTED,
 *      (c) the review body cites the injected filename + a line number ±5 of
 *      the injection point.
 *   8. Writes structured JSON to seeded-bug-results.json.
 *   9. Cleanup (finally): closes the PR, deletes the remote branch.
 *
 * Usage:
 *   bun services/reviewer/scripts/seeded-bug-harness.ts
 *   (with env) GITHUB_TOKEN set to your token, OWNER=edobry, REPO=minsky
 *
 * Skips gracefully when GITHUB_TOKEN is absent.
 *
 * mt#1515 context: this harness codifies the "seeded-bug fidelity" acceptance
 * criterion — differentiating "reviewer is reviewing" from "reviewer catches
 * real bugs at known locations."
 */

import { Octokit } from "@octokit/rest";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Environment configuration (read at call time, not module load time, so
// importing this module for testing does not trigger process.exit).
// ---------------------------------------------------------------------------

function getEnv(): {
  GITHUB_TOKEN: string | undefined;
  OWNER: string;
  REPO: string;
  BASE_BRANCH: string;
} {
  return {
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    OWNER: process.env.OWNER ?? "edobry",
    REPO: process.env.REPO ?? "minsky",
    BASE_BRANCH: process.env.BASE_BRANCH ?? "main",
  };
}

// ---------------------------------------------------------------------------
// Bug catalog
// ---------------------------------------------------------------------------

/**
 * A bug pattern entry. The `code` field is the full TypeScript file content
 * with the known flaw. `injectedLine` is the 1-based line number of the
 * principal defect (the line the reviewer should cite ±5).
 */
interface BugPattern {
  readonly name: string;
  readonly description: string;
  readonly code: string;
  /** 1-based line number of the principal injected defect. */
  readonly injectedLine: number;
}

/**
 * Fixed catalog of bug patterns. Deterministic — pattern 0 is always
 * off-by-one, 1 is null-deref, 2 is unhandled-promise. The harness cycles
 * through them in order so successive runs exercise all three.
 */
const BUG_CATALOG: ReadonlyArray<BugPattern> = [
  {
    name: "off-by-one",
    description: "Off-by-one error in array bounds check",
    // Off-by-one bug: the loop uses `<= arr.length` instead of `< arr.length`,
    // which reads one past the end of the array and returns undefined.
    code: `/**
 * SEEDED BUG TARGET (mt#1515): off-by-one
 * DO NOT USE IN PRODUCTION.
 */

export function findFirstPositive(arr: number[]): number | undefined {
  // BUG: should be i < arr.length (strict less-than), not i <= arr.length.
  // The inclusive upper bound reads arr[arr.length] which is always undefined,
  // so the function may return undefined even when a positive element exists
  // at the last index.
  for (let i = 0; i <= arr.length; i++) {
    if (arr[i] > 0) return arr[i];
  }
  return undefined;
}

export function sumPositive(arr: number[]): number {
  let total = 0;
  // Same off-by-one: i <= arr.length causes arr[arr.length] (undefined) to
  // be coerced to NaN, which propagates through the addition.
  for (let i = 0; i <= arr.length; i++) {
    if (typeof arr[i] === "number" && arr[i] > 0) {
      total += arr[i];
    }
  }
  return total;
}
`,
    // The principal defect is the first <= on line 12 (1-based).
    injectedLine: 12,
  },
  {
    name: "null-deref",
    description: "Null dereference without guard",
    // Null-deref bug: accessing .name on a potentially-null user without
    // a null check causes a TypeError at runtime when user is null.
    code: `/**
 * SEEDED BUG TARGET (mt#1515): null-deref
 * DO NOT USE IN PRODUCTION.
 */

interface User {
  id: number;
  name: string;
  email: string | null;
}

export function formatGreeting(user: User | null): string {
  // BUG: accessing user.name without null check. When user is null this
  // throws "Cannot read properties of null (reading 'name')".
  return \`Hello, \${user.name}!\`;
}

export function getUserEmail(user: User | null): string {
  // Same bug: no null guard before accessing user.email.
  if (user.email !== null) {
    return user.email;
  }
  // BUG: user could be null here; accessing user.name throws.
  return user.name;
}
`,
    // The principal defect is the unguarded user.name access on line 15.
    injectedLine: 15,
  },
  {
    name: "unhandled-promise",
    description: "Unhandled promise rejection",
    // Unhandled-promise bug: calling an async function without await or .catch
    // in an event handler causes silent rejection that swallows errors.
    code: `/**
 * SEEDED BUG TARGET (mt#1515): unhandled-promise
 * DO NOT USE IN PRODUCTION.
 */

async function fetchUserData(userId: string): Promise<{ name: string }> {
  const response = await fetch(\`https://api.example.com/users/\${userId}\`);
  if (!response.ok) {
    throw new Error(\`HTTP \${response.status}: \${response.statusText}\`);
  }
  return response.json() as Promise<{ name: string }>;
}

export function registerClickHandler(button: HTMLButtonElement, userId: string): void {
  button.addEventListener("click", () => {
    // BUG: fetchUserData returns a Promise that is not awaited or caught.
    // If the fetch fails, the rejection is silently swallowed. The handler
    // should use .catch() or the callback should be async with await.
    fetchUserData(userId);
  });
}

export async function loadAndDisplay(userId: string): Promise<void> {
  // Same pattern: fire-and-forget without error handling.
  // BUG: if fetchUserData rejects, the error is unhandled.
  fetchUserData(userId);
  console.log("User data loading...");
}
`,
    // The principal defect is the unhandled fetchUserData call on line 18.
    injectedLine: 18,
  },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HarnessResult {
  ranAt: string;
  prNumber: number | null;
  branch: string;
  bugPattern: string;
  injectedFile: string;
  injectedLine: number;
  reviewerLogin: string | null;
  reviewState: string | null;
  citationFound: boolean;
  citationLineMatch: number | null;
  passed: boolean;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pick a bug pattern from the catalog. Uses the current UTC minute modulo
 * catalog length so successive runs within different minutes exercise different
 * patterns while staying deterministic within a single minute.
 */
function pickBugPattern(): BugPattern {
  const index = new Date().getUTCMinutes() % BUG_CATALOG.length;
  return BUG_CATALOG[index];
}

/**
 * Compute a branch name unique to this run using UTC ISO-8601.
 * Colons are replaced with hyphens for git-ref compatibility.
 */
function makeBranchName(): string {
  const ts = new Date().toISOString().replace(/:/g, "-").replace(/\./g, "-");
  return `mt-1515-seeded-bug-${ts}`;
}

/**
 * Check whether the review body cites the injected filename + a line number
 * within ±5 of the injected line.
 *
 * The regex looks for `<filename>:\d+` (e.g. `off-by-one.ts:12`) anywhere in
 * the review body. Line numbers within ±5 of the injected line count as a hit.
 *
 * Returns the matched line number if found, or null.
 *
 * TOCTOU note: this is a pure local computation on a string already fetched;
 * no race window exists here.
 *
 * Exported so tests exercise the real implementation rather than a parallel
 * reimplementation (mt#1515 R1 review feedback).
 */
export function checkCitation(
  reviewBody: string,
  injectedFilename: string,
  injectedLine: number
): number | null {
  // Escape the filename for use in regex (dots, underscores are safe but
  // explicit escaping makes intent clear).
  const escapedFilename = injectedFilename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const citationRe = new RegExp(`${escapedFilename}:(\\d+)`, "g");

  let match: RegExpExecArray | null;
  while ((match = citationRe.exec(reviewBody)) !== null) {
    const citedLine = parseInt(match[1], 10);
    if (!isNaN(citedLine) && Math.abs(citedLine - injectedLine) <= 5) {
      return citedLine;
    }
  }
  return null;
}

/**
 * Compute the median of an array of numbers. Returns 0 for empty arrays.
 * Exported for unit testing.
 */
export function computeMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  }
  return sorted[mid] ?? 0;
}

/** Write result JSON to the scripts directory. Wrapped in try/catch. */
function writeResult(result: HarnessResult, scriptDir: string): void {
  const outputPath = join(scriptDir, "seeded-bug-results.json");
  try {
    writeFileSync(outputPath, JSON.stringify(result, null, 2), "utf-8");
    console.log(`Results written to: ${outputPath}`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Warning: failed to write results JSON: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { GITHUB_TOKEN, OWNER, REPO, BASE_BRANCH } = getEnv();

  if (!GITHUB_TOKEN) {
    console.log("SKIP: GITHUB_TOKEN not set; skipping seeded-bug harness.");
    process.exit(0);
  }

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const bugPattern = pickBugPattern();
  const branch = makeBranchName();
  const targetDir = "services/reviewer/scripts/__seeded_bug_targets__";
  const targetFilename = `${bugPattern.name}.ts`;
  const targetPath = `${targetDir}/${targetFilename}`;

  console.log("=== Seeded-Bug Fidelity Harness (mt#1515) ===");
  console.log(`Bug pattern: ${bugPattern.name} — ${bugPattern.description}`);
  console.log(`Branch: ${branch}`);
  console.log(`Target file: ${targetPath}`);
  console.log(`Owner/Repo: ${OWNER}/${REPO}, base: ${BASE_BRANCH}`);
  console.log("");

  const octokit = new Octokit({ auth: GITHUB_TOKEN });

  // Partial result for writing on failure paths.
  let prNumber: number | null = null;
  let branchCreated = false;

  const result: HarnessResult = {
    ranAt: new Date().toISOString(),
    prNumber: null,
    branch,
    bugPattern: bugPattern.name,
    injectedFile: targetFilename,
    injectedLine: bugPattern.injectedLine,
    reviewerLogin: null,
    reviewState: null,
    citationFound: false,
    citationLineMatch: null,
    passed: false,
    error: null,
  };

  try {
    // -----------------------------------------------------------------------
    // Step 1: Get the base branch SHA to use as the parent commit.
    // -----------------------------------------------------------------------
    let baseSha: string;
    try {
      const refResponse = await octokit.rest.git.getRef({
        owner: OWNER,
        repo: REPO,
        ref: `heads/${BASE_BRANCH}`,
      });
      baseSha = refResponse.data.object.sha;
      console.log(`Base branch SHA: ${baseSha}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to get base branch ref (${BASE_BRANCH}): ${message}`, {
        cause: err,
      });
    }

    // -----------------------------------------------------------------------
    // Step 2: Create the target file blob.
    // -----------------------------------------------------------------------
    let blobSha: string;
    try {
      const blobResponse = await octokit.rest.git.createBlob({
        owner: OWNER,
        repo: REPO,
        content: bugPattern.code,
        encoding: "utf-8",
      });
      blobSha = blobResponse.data.sha;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to create blob for seeded bug file: ${message}`, { cause: err });
    }

    // -----------------------------------------------------------------------
    // Step 3: Get the base tree SHA so we can create a new tree on top of it.
    // -----------------------------------------------------------------------
    let baseTreeSha: string;
    try {
      const commitResponse = await octokit.rest.git.getCommit({
        owner: OWNER,
        repo: REPO,
        commit_sha: baseSha,
      });
      baseTreeSha = commitResponse.data.tree.sha;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to get base commit tree SHA: ${message}`, { cause: err });
    }

    // -----------------------------------------------------------------------
    // Step 4: Create a new tree with the seeded file.
    // -----------------------------------------------------------------------
    let newTreeSha: string;
    try {
      const treeResponse = await octokit.rest.git.createTree({
        owner: OWNER,
        repo: REPO,
        base_tree: baseTreeSha,
        tree: [
          {
            path: targetPath,
            mode: "100644",
            type: "blob",
            sha: blobSha,
          },
        ],
      });
      newTreeSha = treeResponse.data.sha;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to create new tree with seeded file: ${message}`, { cause: err });
    }

    // -----------------------------------------------------------------------
    // Step 5: Create the commit.
    // -----------------------------------------------------------------------
    let newCommitSha: string;
    try {
      const commitResponse = await octokit.rest.git.createCommit({
        owner: OWNER,
        repo: REPO,
        message: `test(mt#1515): inject seeded bug (${bugPattern.name}) for fidelity harness\n\nAdds a deliberately flawed TypeScript file for the seeded-bug fidelity\nharness. This commit is auto-created by the harness and will be cleaned\nup (PR closed, branch deleted) when the harness completes.`,
        tree: newTreeSha,
        parents: [baseSha],
      });
      newCommitSha = commitResponse.data.sha;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to create commit with seeded bug: ${message}`, { cause: err });
    }

    // -----------------------------------------------------------------------
    // Step 6: Create the branch pointing at the new commit.
    // -----------------------------------------------------------------------
    try {
      await octokit.rest.git.createRef({
        owner: OWNER,
        repo: REPO,
        ref: `refs/heads/${branch}`,
        sha: newCommitSha,
      });
      branchCreated = true;
      console.log(`Branch created: ${branch} @ ${newCommitSha}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to create branch ${branch}: ${message}`, { cause: err });
    }

    // -----------------------------------------------------------------------
    // Step 7: Open the PR with the tier=3 marker.
    // -----------------------------------------------------------------------
    const prBody = `<!-- minsky:tier=3 -->

## Seeded-Bug Fidelity Harness (mt#1515)

This PR was auto-created by \`seeded-bug-harness.ts\` to verify that
\`minsky-reviewer[bot]\` catches a deliberately injected bug.

**Bug pattern:** \`${bugPattern.name}\` — ${bugPattern.description}

**Injected file:** \`${targetPath}\`

**Injected line:** ${bugPattern.injectedLine}

The harness is polling for a review with \`CHANGES_REQUESTED\` state that
cites the injected file and line number (±5). Once the review is received
(or the 5-minute timeout expires), the PR will be auto-closed and the
branch will be deleted.

_Do not merge this PR — it will be automatically cleaned up._
`;

    let prData: { number: number; node_id: string };
    try {
      const prResponse = await octokit.rest.pulls.create({
        owner: OWNER,
        repo: REPO,
        title: `test(mt#1515): seeded-bug fidelity harness (${bugPattern.name})`,
        head: branch,
        base: BASE_BRANCH,
        body: prBody,
      });
      prData = { number: prResponse.data.number, node_id: prResponse.data.node_id };
      prNumber = prData.number;
      result.prNumber = prNumber;
      console.log(`PR opened: #${prNumber}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to open PR: ${message}`, { cause: err });
    }

    // -----------------------------------------------------------------------
    // Step 8: Poll for a review by minsky-reviewer[bot].
    //
    // TOCTOU note (decision-action gap): The reviewer-bot is webhook-driven.
    // Between PR creation (above) and the first poll (below) there is a window
    // where the webhook might fire and the review post before we start polling.
    // This is handled by: (a) the poll loop reads the FULL review list each
    // time, not just new reviews, so a pre-poll review is captured on the first
    // iteration; (b) if the webhook misses entirely, the loop times out cleanly
    // at 5 min and the harness exits non-zero — idempotent, safe to retry.
    //
    // Accept-rationale: Idempotent + automatic recovery. If the webhook fires
    // before we start polling, the first poll captures the review. If the
    // webhook is missed, the next harness run re-creates the branch+PR+review
    // cycle from scratch. No silent worse-state; no redo forced on the user.
    // -----------------------------------------------------------------------
    const POLL_INTERVAL_MS = 15_000;
    const MAX_POLL_DURATION_MS = 5 * 60_000; // 5 minutes
    const pollStart = Date.now();

    console.log(`Polling for review (up to ${MAX_POLL_DURATION_MS / 60_000} min)...`);

    let reviewerLogin: string | null = null;
    let reviewState: string | null = null;
    let reviewBody: string | null = null;
    let reviewFound = false;

    while (Date.now() - pollStart < MAX_POLL_DURATION_MS) {
      let reviews: Array<{
        user: { login: string } | null;
        state: string;
        body: string;
        submitted_at?: string | null;
      }>;

      try {
        const reviewsResponse = await octokit.rest.pulls.listReviews({
          owner: OWNER,
          repo: REPO,
          pull_number: prNumber,
          per_page: 50,
        });
        reviews = reviewsResponse.data;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`  Poll error (will retry): ${message}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        continue;
      }

      const botReview = reviews.find(
        (r) => r.user?.login === "minsky-reviewer[bot]" && r.state !== "PENDING"
      );

      if (botReview) {
        reviewerLogin = botReview.user?.login ?? null;
        reviewState = botReview.state;
        reviewBody = botReview.body;
        reviewFound = true;
        console.log(`  Review found: state=${reviewState}, reviewer=${reviewerLogin}`);
        break;
      }

      const elapsed = Math.round((Date.now() - pollStart) / 1000);
      console.log(`  No review yet (elapsed: ${elapsed}s); waiting ${POLL_INTERVAL_MS / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    // -----------------------------------------------------------------------
    // Step 9: Assert the three conditions.
    // -----------------------------------------------------------------------
    result.reviewerLogin = reviewerLogin;
    result.reviewState = reviewState;

    if (!reviewFound) {
      result.error = `Timeout: no review posted by minsky-reviewer[bot] within ${MAX_POLL_DURATION_MS / 60_000} min`;
      result.passed = false;
      console.error(result.error);
    } else {
      // Condition (a): at least one review exists — already verified by reviewFound.
      // Condition (b): state must be CHANGES_REQUESTED.
      const stateOk = reviewState === "CHANGES_REQUESTED";

      // Condition (c): review body cites the injected file + line ±5.
      let citationLineMatch: number | null = null;
      if (reviewBody !== null) {
        citationLineMatch = checkCitation(reviewBody, targetFilename, bugPattern.injectedLine);
      }
      const citationOk = citationLineMatch !== null;
      result.citationFound = citationOk;
      result.citationLineMatch = citationLineMatch;

      result.passed = stateOk && citationOk;

      if (!stateOk) {
        console.error(
          `FAIL: expected CHANGES_REQUESTED, got ${reviewState}. ` +
            "Reviewer may have APPROVED or only COMMENTED."
        );
      }
      if (!citationOk) {
        console.error(
          `FAIL: no citation of ${targetFilename} near line ${bugPattern.injectedLine} ` +
            "found in the review body."
        );
      }
      if (result.passed) {
        console.log(
          `PASS: reviewer caught the ${bugPattern.name} bug with CHANGES_REQUESTED ` +
            `and cited ${targetFilename}:${citationLineMatch} (injected: ${bugPattern.injectedLine}).`
        );
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    result.error = message;
    result.passed = false;
    console.error(`Harness error: ${message}`);
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
  } finally {
    // -----------------------------------------------------------------------
    // Step 10: Cleanup — close the PR and delete the remote branch.
    // -----------------------------------------------------------------------
    if (prNumber !== null) {
      try {
        await octokit.rest.issues.createComment({
          owner: OWNER,
          repo: REPO,
          issue_number: prNumber,
          body: "Auto-closed by seeded-bug-harness (mt#1515). This PR was a test artifact.",
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Warning: failed to post cleanup comment on PR #${prNumber}: ${message}`);
      }

      try {
        await octokit.rest.pulls.update({
          owner: OWNER,
          repo: REPO,
          pull_number: prNumber,
          state: "closed",
        });
        console.log(`PR #${prNumber} closed.`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Warning: failed to close PR #${prNumber}: ${message}`);
      }
    }

    if (branchCreated) {
      try {
        await octokit.rest.git.deleteRef({
          owner: OWNER,
          repo: REPO,
          ref: `heads/${branch}`,
        });
        console.log(`Branch ${branch} deleted.`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Warning: failed to delete branch ${branch}: ${message}`);
      }
    }

    // Write results regardless of success/failure.
    writeResult(result, scriptDir);
  }

  process.exit(result.passed ? 0 : 1);
}

// Only run main() when this file is executed directly (not imported as a module
// for testing). Bun sets import.meta.main to true when the file is the entry
// point. This prevents process.exit() from firing when test files import
// exported helpers from this module.
if (import.meta.main) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Fatal harness error:", message);
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    process.exit(1);
  });
}
