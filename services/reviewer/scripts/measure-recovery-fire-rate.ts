#!/usr/bin/env bun
/**
 * Baseline measurement script for mt#2828.
 *
 * Measures the mt#2685 empty-findings coherence recovery pass's fire rate
 * over a recent window, using the reviewer bot's OWN posted review bodies as
 * the durable record: `applyEmptyFindingsRecovery` (empty-findings-recovery.ts)
 * synthesizes a finding whose `details` field embeds the literal marker string
 * "Synthesized by the empty-findings coherence recovery pass (mt#2685)", and
 * `composeReviewBody` renders that `details` text verbatim into the "##
 * Findings" section of the posted GitHub review — so the recovery pass's
 * fire/no-fire outcome for every review round is durably observable via the
 * public GitHub API, with no Railway/Postgres production credentials needed.
 *
 * Denominator: every review posted by an allowed reviewer-bot login
 * (ALLOWED_REVIEWER_BOT_LOGINS) carrying the Chinese-wall marker within the
 * window — i.e. every genuine review round, matching the spec's "denominator:
 * review rounds". Also reports the REQUEST_CHANGES-only rate as a secondary,
 * more targeted metric (the recovery pass can only ever fire on a
 * REQUEST_CHANGES conclusion).
 *
 * Window: defaults to the shorter of `--days` (default 21, i.e. ~3 weeks —
 * the spec's "last 2-3 weeks") and the recovery pass's actual production
 * lifetime (mt#2685 shipped 2026-07-08 per its own module doc) — measuring
 * further back than the mechanism existed would understate the rate with a
 * zero-fire denominator inflation. Override the lifetime floor with
 * --since=<ISO date> if needed.
 *
 * Usage:
 *   bun services/reviewer/scripts/measure-recovery-fire-rate.ts [--days=21] [--since=2026-07-08]
 *
 * Requires: GITHUB_TOKEN or OCTOKIT_AUTH (via harness-auth.ts), or falls back
 * to `gh auth token` when neither is set.
 * Outputs: services/reviewer/scripts/measure-recovery-fire-rate-results.json
 */

import { Octokit } from "@octokit/rest";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveGitHubToken, getAuthSource } from "./harness-auth";
import { ALLOWED_REVIEWER_BOT_LOGINS, CHINESE_WALL_MARKER } from "../src/prior-review-summary";

const OWNER = "edobry";
const REPO = "minsky";

/** The mt#2685 recovery pass's ship date — the floor for the measurement window. */
const RECOVERY_PASS_SHIP_DATE = "2026-07-08";

/** Literal marker embedded in a synthesized finding's `details` field (empty-findings-recovery.ts). */
const RECOVERY_FIRE_MARKER = "Synthesized by the empty-findings coherence recovery pass (mt#2685)";

function resolveToken(): string {
  const fromEnv = resolveGitHubToken();
  if (fromEnv) return fromEnv;
  try {
    // bun_over_node.mdc: use Bun.spawnSync instead of node:child_process.execSync.
    const result = Bun.spawnSync(["gh", "auth", "token"]);
    const fromGh = result.stdout.toString("utf-8").trim();
    if (result.success && fromGh) return fromGh;
  } catch {
    // fall through to the error below
  }
  console.error(
    "ERROR: no GitHub token available (OCTOKIT_AUTH, GITHUB_TOKEN, and `gh auth token` all failed)."
  );
  process.exit(1);
}

interface ParsedArgs {
  days: number;
  since?: string;
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  let days = 21;
  let since: string | undefined;
  for (const arg of args) {
    if (arg.startsWith("--days=")) {
      const parsed = parseInt(arg.slice("--days=".length), 10);
      if (!isNaN(parsed) && parsed > 0) days = parsed;
    } else if (arg.startsWith("--since=")) {
      since = arg.slice("--since=".length).trim();
    }
  }
  return { days, since };
}

interface ReviewRoundRecord {
  prNumber: number;
  reviewId: number;
  submittedAt: string;
  state: string;
  fired: boolean;
  /** Best-effort verdict classification from the review state, for the REQUEST_CHANGES-only rate. */
  isRequestChanges: boolean;
}

async function main() {
  const { days, since: sinceOverride } = parseArgs();
  const token = resolveToken();
  const octokit = new Octokit({ auth: token });

  const daysFloor = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const lifetimeFloor = new Date(sinceOverride ?? RECOVERY_PASS_SHIP_DATE);
  // Window start = the LATER (more recent) of the two floors — measuring
  // before the mechanism existed would only dilute the rate with
  // structural zero-fire rounds.
  const windowStart = daysFloor > lifetimeFloor ? daysFloor : lifetimeFloor;
  const windowStartIso = windowStart.toISOString();
  const now = new Date();

  console.log(`=== mt#2828 recovery-pass fire-rate baseline measurement ===`);
  console.log(`Repo: ${OWNER}/${REPO}`);
  console.log(`Auth source: ${getAuthSource() !== "none" ? getAuthSource() : "gh auth token"}`);
  console.log(`Window: ${windowStartIso} .. ${now.toISOString()}`);
  console.log(
    `  (requested --days=${days} floor: ${daysFloor.toISOString().slice(0, 10)}; ` +
      `recovery-pass lifetime floor: ${lifetimeFloor.toISOString().slice(0, 10)})`
  );
  console.log("");

  // Enumerate PRs touched within the window. Sort by updated desc; stop once
  // we've seen a full page entirely before windowStart (buffer: 1 extra page
  // past the boundary to tolerate out-of-order updates).
  const candidatePrNumbers: number[] = [];
  let page = 1;
  let sawPastBoundary = false;
  const maxPages = 20; // hard cap: 2000 PRs, generous for a 3-week window
  while (page <= maxPages) {
    const { data: prs } = await octokit.rest.pulls.list({
      owner: OWNER,
      repo: REPO,
      state: "all",
      sort: "updated",
      direction: "desc",
      per_page: 100,
      page,
    });
    if (prs.length === 0) break;

    let anyInWindow = false;
    for (const pr of prs) {
      const updatedAt = new Date(pr.updated_at);
      if (updatedAt >= windowStart) {
        candidatePrNumbers.push(pr.number);
        anyInWindow = true;
      }
    }

    if (!anyInWindow) {
      if (sawPastBoundary) break;
      sawPastBoundary = true;
    }
    page++;
  }

  console.log(`Candidate PRs touched in window: ${candidatePrNumbers.length}`);
  console.log("Fetching reviews per PR (this may take a while for a large candidate set)...\n");

  const records: ReviewRoundRecord[] = [];
  let prsProcessed = 0;
  let prsErrored = 0;

  for (const prNumber of candidatePrNumbers) {
    try {
      const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
        owner: OWNER,
        repo: REPO,
        pull_number: prNumber,
        per_page: 100,
      });

      for (const review of reviews) {
        if (review.state === "PENDING") continue;
        const login = review.user?.login ?? "";
        if (!ALLOWED_REVIEWER_BOT_LOGINS.has(login)) continue;
        const body = review.body ?? "";
        if (!body.includes(CHINESE_WALL_MARKER)) continue;
        const submittedAt = review.submitted_at ?? "";
        if (!submittedAt) continue;
        const submittedDate = new Date(submittedAt);
        if (submittedDate < windowStart || submittedDate > now) continue;

        records.push({
          prNumber,
          reviewId: review.id,
          submittedAt,
          state: review.state,
          fired: body.includes(RECOVERY_FIRE_MARKER),
          isRequestChanges: review.state === "CHANGES_REQUESTED",
        });
      }
      prsProcessed++;
    } catch (err: unknown) {
      prsErrored++;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  WARN: failed to fetch reviews for PR #${prNumber}: ${message}`);
    }
  }

  const totalRounds = records.length;
  const firedRounds = records.filter((r) => r.fired).length;
  const requestChangesRounds = records.filter((r) => r.isRequestChanges);
  const firedRequestChangesRounds = requestChangesRounds.filter((r) => r.fired).length;

  const overallRate = totalRounds === 0 ? 0 : firedRounds / totalRounds;
  const requestChangesRate =
    requestChangesRounds.length === 0 ? 0 : firedRequestChangesRounds / requestChangesRounds.length;

  const result = {
    measuredAt: now.toISOString(),
    windowStart: windowStartIso,
    windowEnd: now.toISOString(),
    repo: `${OWNER}/${REPO}`,
    prsCandidates: candidatePrNumbers.length,
    prsProcessed,
    prsErrored,
    totalReviewRounds: totalRounds,
    firedRounds,
    overallFireRate: overallRate,
    requestChangesRounds: requestChangesRounds.length,
    firedRequestChangesRounds,
    requestChangesFireRate: requestChangesRate,
    firedReviews: records
      .filter((r) => r.fired)
      .map((r) => ({ prNumber: r.prNumber, reviewId: r.reviewId, submittedAt: r.submittedAt })),
  };

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const outputPath = join(scriptDir, "measure-recovery-fire-rate-results.json");
  writeFileSync(outputPath, JSON.stringify(result, null, 2), "utf-8");

  console.log("\n=== Results ===");
  console.log(
    `PRs candidates: ${candidatePrNumbers.length} (processed: ${prsProcessed}, errored: ${prsErrored})`
  );
  console.log(`Total review rounds in window: ${totalRounds}`);
  console.log(`Recovery-pass fires: ${firedRounds}`);
  console.log(
    `Overall fire rate (denominator: all review rounds): ${(overallRate * 100).toFixed(1)}%`
  );
  console.log(
    `REQUEST_CHANGES-only fire rate (denominator: REQUEST_CHANGES rounds, n=${requestChangesRounds.length}): ${(
      requestChangesRate * 100
    ).toFixed(1)}%`
  );
  console.log(`\nResults written to: ${outputPath}`);

  process.exit(0);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error("Measurement script error:", message);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
