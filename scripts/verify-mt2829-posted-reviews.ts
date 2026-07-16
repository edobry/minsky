#!/usr/bin/env bun
/**
 * Live verification for mt#2829 — in-band read of posted PR review prose.
 *
 * Exercises `fetchPostedReviews` (packages/domain/src/session/commands/pr-get-reviews.ts)
 * against a REAL, already-merged multi-round PR (default: edobry/minsky#1953,
 * which has 3 rounds — CHANGES_REQUESTED, CHANGES_REQUESTED, then APPROVED),
 * using the live GitHub REST API (`listReviews` + `listReviewComments` from
 * packages/domain/src/repository/github-pr-review.ts) — the same code path
 * `session_pr_get(reviews: true)` uses in production.
 *
 * This is a read-only, non-destructive check (no PR mutation). Never prints
 * the resolved token; only a trimmed structural summary of the fetched
 * reviews is printed (reviewer, state, submittedAt, body length + short
 * preview, comment count) — never the full raw review body.
 *
 * Env gating: resolves a GitHub token from Minsky config (github.token) or
 * GITHUB_TOKEN/GH_TOKEN. Absent → SKIP with exit 0 (the documented §7a
 * no-env path).
 *
 * Usage:
 *   bun scripts/verify-mt2829-posted-reviews.ts             # PR #1953
 *   bun scripts/verify-mt2829-posted-reviews.ts --pr 1962   # a different PR
 */

// tsyringe (transitively imported via getConfiguration) requires reflect-metadata.
import "reflect-metadata";
import {
  CustomConfigFactory,
  getConfiguration,
  initializeConfiguration,
} from "@minsky/domain/configuration";
import {
  listReviews,
  listReviewComments,
} from "../packages/domain/src/repository/github-pr-review";
import type { GitHubContext } from "../packages/domain/src/repository/github-pr-operations";
import type { RepositoryBackend } from "../packages/domain/src/repository/index";
import { fetchPostedReviews } from "../packages/domain/src/session/commands/pr-get-reviews";

// Reads Minsky configuration the same way production code does, so the
// script never needs a token passed on the command line (which would land
// verbatim in shell history / a persisted transcript).
await initializeConfiguration(new CustomConfigFactory(), {
  workingDirectory: process.cwd(),
});

const OWNER = "edobry";
const REPO = "minsky";
const DEFAULT_PR = 1953;

function resolvePrNumber(): number {
  const flagIdx = process.argv.indexOf("--pr");
  if (flagIdx !== -1 && process.argv[flagIdx + 1]) {
    const parsed = Number.parseInt(process.argv[flagIdx + 1] ?? "", 10);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return DEFAULT_PR;
}

function resolveToken(): string | undefined {
  try {
    const cfg = getConfiguration();
    const configured = cfg.github?.token;
    if (configured) return configured;
  } catch {
    // Config not initialized in this standalone script context — fall through to env vars.
  }
  return process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"];
}

async function main(): Promise<number> {
  const token = resolveToken();
  if (!token) {
    console.log(
      JSON.stringify({
        ok: true,
        skipped: true,
        reason: "No GitHub token available (config github.token / GITHUB_TOKEN / GH_TOKEN unset)",
      })
    );
    return 0;
  }

  const prNumber = resolvePrNumber();

  const gh: GitHubContext = {
    owner: OWNER,
    repo: REPO,
    getToken: async () => token,
  };

  // Compose the same way GitHubBackend.review wires it in production
  // (packages/domain/src/repository/github.ts) — a minimal fake backend whose
  // two methods delegate to the real REST calls. fetchPostedReviews only ever
  // reads backend.review.listReviews/listReviewComments, so this script
  // deliberately implements just those two rather than the full
  // RepositoryBackend surface.
  const fakeBackend: Pick<RepositoryBackend, "review"> = {
    review: {
      approve: async () => {
        throw new Error("not implemented in this read-only verification script");
      },
      getApprovalStatus: async () => {
        throw new Error("not implemented in this read-only verification script");
      },
      listReviews: (prIdentifier: string | number) => listReviews(gh, prIdentifier),
      listReviewComments: (prIdentifier: string | number) => listReviewComments(gh, prIdentifier),
    },
  };
  const backend = fakeBackend as RepositoryBackend;

  const start = performance.now();
  let reviews: Awaited<ReturnType<typeof fetchPostedReviews>>;
  try {
    reviews = await fetchPostedReviews(backend, prNumber);
  } catch (err) {
    const elapsedMs = Math.round(performance.now() - start);
    console.log(
      JSON.stringify({ ok: false, prNumber, elapsedMs, error: (err as Error).message }, null, 2)
    );
    return 1;
  }
  const elapsedMs = Math.round(performance.now() - start);

  // Trimmed structural summary only — never the raw full body.
  const summary = reviews.map((r) => ({
    reviewId: r.reviewId,
    reviewerLogin: r.reviewerLogin,
    state: r.state,
    submittedAt: r.submittedAt,
    bodyLength: r.body.length,
    bodyTruncated: r.bodyTruncated,
    bodyPreview: r.body.slice(0, 160).replace(/\n/g, " "),
    commentCount: r.comments.length,
    firstCommentPreview: r.comments[0]
      ? {
          path: r.comments[0].path,
          line: r.comments[0].line,
          bodyPreview: r.comments[0].body.slice(0, 120).replace(/\n/g, " "),
        }
      : null,
  }));

  const ok = reviews.length > 0;
  console.log(
    JSON.stringify(
      {
        ok,
        prNumber,
        elapsedMs,
        reviewCount: reviews.length,
        statesInOrder: reviews.map((r) => r.state),
        reviews: summary,
      },
      null,
      2
    )
  );

  if (!ok) {
    console.error(`FAIL: PR #${prNumber} returned 0 reviews — expected at least one round.`);
    return 1;
  }

  console.log(`PASS: fetched ${reviews.length} posted review(s) for PR #${prNumber} live.`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("FAIL: verify script threw unexpectedly:", err);
    process.exit(1);
  });
