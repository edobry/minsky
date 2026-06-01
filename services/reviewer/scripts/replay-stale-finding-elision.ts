#!/usr/bin/env bun
/**
 * Replay verification for mt#2211 — stale-finding self-anchoring elision.
 *
 * Reconstructs the prior-review summary that the reviewer would assemble for
 * PR #1447 (the originating incident) at its final HEAD, and asserts that the
 * stale R1 escaped-quote code example is NOT carried into the assembled
 * prompt, while the structured `file:line` location IS preserved.
 *
 * This is the structural-change verification artifact for the Option B fix in
 * `prior-review-summary.ts` (stale iterations render `severity · file:line`
 * from parsed fields instead of the verbatim body). The pure-function unit
 * tests in `prior-review-summary.test.ts` cover synthetic cases; this script
 * runs the same path against the REAL incident reviews fetched live from
 * GitHub, so the regression is verified end-to-end against production data.
 *
 * Env gating:
 *   - GITHUB_TOKEN required. Absent → SKIP (exit 0) with a clear message.
 *
 * Exit codes: 0 = pass (or skipped), 1 = fail.
 *
 * Usage:
 *   GITHUB_TOKEN=ghp_xxx bun services/reviewer/scripts/replay-stale-finding-elision.ts
 */

import { Octokit } from "@octokit/rest";
import {
  isBotReviewerEntry,
  summarizePriorReviews,
  type PriorReview,
} from "../src/prior-review-summary";

const OWNER = "edobry";
const REPO = "minsky";
const PR_NUMBER = 1447;

// The literal carry-forward hazard from the incident: R1's escaped-quote code
// example. The bug was the model re-quoting this across R2/R3 against a clean
// diff. After the fix it must NOT appear in the assembled stale-iteration render.
const CARRY_FORWARD_NEEDLE = '\\"what could we do';
// The structured signal that MUST survive so convergence still works.
const EXPECTED_LOCATION = ".claude/skills/marketing-site-design/SKILL.md";

function skip(message: string): never {
  console.log(JSON.stringify({ result: "SKIP", message }, null, 2));
  process.exit(0);
}

async function main(): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    skip(
      "GITHUB_TOKEN not set — skipping live replay (unit tests cover the logic deterministically)."
    );
  }

  const octokit = new Octokit({ auth: token });

  const pr = await octokit.pulls.get({ owner: OWNER, repo: REPO, pull_number: PR_NUMBER });
  const headSha = pr.data.head.sha;

  const reviewsResp = await octokit.pulls.listReviews({
    owner: OWNER,
    repo: REPO,
    pull_number: PR_NUMBER,
    per_page: 100,
  });

  const priorReviews: PriorReview[] = reviewsResp.data
    .filter((r) =>
      isBotReviewerEntry({
        state: r.state ?? "",
        userLogin: r.user?.login ?? "",
        body: r.body ?? "",
      })
    )
    .map((r) => ({
      id: r.id,
      state: (r.state ?? "COMMENTED") as PriorReview["state"],
      submittedAt: r.submitted_at ?? "",
      commitId: r.commit_id ?? "",
      userLogin: r.user?.login ?? "",
      body: r.body ?? "",
    }))
    .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));

  const summary = summarizePriorReviews(priorReviews, headSha);
  const md = summary.markdown;

  const staleCount = summary.reviews.filter((r) => r.isStale).length;
  const carriedForward = md.includes(CARRY_FORWARD_NEEDLE);
  const locationPreserved = md.includes(EXPECTED_LOCATION);

  // The fix is only meaningfully exercised when there is at least one stale
  // bot review carrying the original escaped-quote example.
  const exercised = staleCount > 0;

  const pass = !carriedForward && (locationPreserved || !exercised);

  console.log(
    JSON.stringify(
      {
        result: pass ? "PASS" : "FAIL",
        prNumber: PR_NUMBER,
        headSha,
        botReviewsFound: priorReviews.length,
        staleIterations: staleCount,
        carriedForwardExample: carriedForward,
        locationPreserved,
        exercised,
        note: exercised
          ? "Stale iterations present; verbatim escaped-quote example must be absent and file:line present."
          : "No stale bot reviews available to exercise the elision (reviews may have been dismissed/pruned).",
      },
      null,
      2
    )
  );

  process.exit(pass ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ result: "ERROR", error: String(err) }, null, 2));
  process.exit(1);
});
