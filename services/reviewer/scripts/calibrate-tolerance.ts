#!/usr/bin/env bun
/**
 * Calibration script for NARRATIVE_TOLERANCE_CHARS (mt#1264).
 *
 * Replays every minsky-reviewer[bot] PR review body from the edobry/minsky
 * repo through sanitizeReviewBody and buckets results by prefix length x
 * narrative-phrase-presence.
 *
 * Usage:
 *   GITHUB_TOKEN=<pat> bun run services/reviewer/scripts/calibrate-tolerance.ts
 *
 * Output: JSON to stdout. The "at-risk" zone (prefix >= 300 chars with
 * narrative phrase and action == passthrough | stripped-only-by-narrative)
 * is included with ALL samples, not just 3.
 */

import { Octokit } from "@octokit/rest";
import { sanitizeReviewBody } from "../src/sanitize.ts";

const OWNER = "edobry";
const REPO = "minsky";
const BOT_LOGIN = "minsky-reviewer[bot]";

const BUCKET_BOUNDARIES = [0, 100, 200, 300, 400, 500];

const NARRATIVE_SCRATCH_PATTERN = /\bI\s+will\b|\bI['’]ll\b|\bI\s+am\s+going\s+to\b/i;

const STRUCTURAL_HEADING_RE =
  /^[ \t]*(?:#{1,6}[ \t]+|\*\*)(findings|spec verification|summary|documentation impact)\b/im;

interface ReviewRecord {
  prNumber: number;
  reviewId: number;
  action: string;
  signals: string[];
  originalLength: number;
  prefixLength: number;
  narrativePresent: boolean;
  bucketKey: string;
  excerpt: string;
}

interface BucketKey {
  prefixRange: string;
  narrativePresent: boolean;
}

interface BucketData {
  count: number;
  excerpts: string[];
  samples: ReviewRecord[];
}

function getPrefixRange(prefixLen: number): string {
  for (let i = BUCKET_BOUNDARIES.length - 1; i >= 0; i--) {
    if (prefixLen >= BUCKET_BOUNDARIES[i]) {
      const lo = BUCKET_BOUNDARIES[i];
      const hi = i + 1 < BUCKET_BOUNDARIES.length ? BUCKET_BOUNDARIES[i + 1] : null;
      return hi !== null ? `${lo}-${hi}` : `${lo}+`;
    }
  }
  return "0-100";
}

function bucketKeyStr(bk: BucketKey): string {
  return `${bk.prefixRange}/${bk.narrativePresent ? "narrative-yes" : "narrative-no"}`;
}

function makeExcerpt(text: string, maxLen = 120): string {
  const oneLine = text.replace(/\r?\n/g, " ").trim();
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, maxLen)}...`;
}

async function fetchAllBotReviews(octokit: Octokit): Promise<ReviewRecord[]> {
  const records: ReviewRecord[] = [];
  let page = 1;
  const PER_PAGE = 30;

  while (true) {
    process.stderr.write(`Fetching PR list page ${page}...\n`);
    const prsResp = await octokit.rest.pulls.list({
      owner: OWNER,
      repo: REPO,
      state: "all",
      per_page: PER_PAGE,
      page,
    });
    const prs = prsResp.data;
    if (prs.length === 0) break;

    for (const pr of prs) {
      const prNumber = pr.number;
      let reviewPage = 1;
      while (true) {
        const reviewsResp = await octokit.rest.pulls.listReviews({
          owner: OWNER,
          repo: REPO,
          pull_number: prNumber,
          per_page: 100,
          page: reviewPage,
        });
        const reviews = reviewsResp.data;
        if (reviews.length === 0) break;

        for (const review of reviews) {
          if (review.user?.login !== BOT_LOGIN) continue;
          const body = review.body ?? "";
          if (body.trim().length === 0) continue;

          const result = sanitizeReviewBody(body);
          const signals = result.meta.reason
            ? result.meta.reason.replace(/^cot-leak:/, "").split(",")
            : [];

          const headingMatch = STRUCTURAL_HEADING_RE.exec(body);
          const prefix = headingMatch ? body.slice(0, headingMatch.index) : body;
          const prefixLength = prefix.length;
          const narrativePresent = NARRATIVE_SCRATCH_PATTERN.test(prefix);
          const prefixRange = getPrefixRange(prefixLength);
          const bk: BucketKey = { prefixRange, narrativePresent };

          records.push({
            prNumber,
            reviewId: review.id,
            action: result.action,
            signals,
            originalLength: result.meta.originalLength,
            prefixLength,
            narrativePresent,
            bucketKey: bucketKeyStr(bk),
            excerpt: makeExcerpt(body),
          });
        }

        if (reviews.length < 100) break;
        reviewPage++;
      }
    }

    if (prs.length < PER_PAGE) break;
    page++;
  }

  return records;
}

function buildBuckets(records: ReviewRecord[]): Record<string, BucketData> {
  const buckets: Record<string, BucketData> = {};

  for (const rec of records) {
    const key = rec.bucketKey;
    if (!buckets[key]) {
      buckets[key] = { count: 0, excerpts: [], samples: [] };
    }
    buckets[key].count++;
    buckets[key].samples.push(rec);
    if (buckets[key].excerpts.length < 3) {
      buckets[key].excerpts.push(rec.excerpt);
    }
  }

  return buckets;
}

function identifyAtRisk(records: ReviewRecord[]): ReviewRecord[] {
  return records.filter((rec) => {
    if (rec.prefixLength < 300) return false;
    if (!rec.narrativePresent) return false;
    if (rec.action === "passthrough") return true;
    if (
      rec.action === "stripped" &&
      rec.signals.length === 1 &&
      rec.signals[0] === "long-narrative-prefix"
    )
      return true;
    return false;
  });
}

async function main() {
  const token = process.env["GITHUB_TOKEN"];
  if (!token) {
    process.stderr.write(
      "Error: GITHUB_TOKEN environment variable is required.\n" +
        "Usage: GITHUB_TOKEN=<pat> bun run services/reviewer/scripts/calibrate-tolerance.ts\n"
    );
    process.exit(1);
  }

  const octokit = new Octokit({ auth: token });

  process.stderr.write(`Fetching all ${BOT_LOGIN} reviews from ${OWNER}/${REPO}...\n`);
  const records = await fetchAllBotReviews(octokit);
  process.stderr.write(`Total bot reviews found: ${records.length}\n`);

  const buckets = buildBuckets(records);
  const atRisk = identifyAtRisk(records);

  const bucketSummary: Record<string, { count: number; excerpts: string[] }> = {};
  for (const [key, data] of Object.entries(buckets)) {
    bucketSummary[key] = { count: data.count, excerpts: data.excerpts };
  }

  const output = {
    summary: {
      totalBotReviews: records.length,
      atRiskCount: atRisk.length,
      currentThreshold: 300,
      buckets: bucketSummary,
    },
    atRiskZone: {
      description:
        "Prefix >= 300 chars + narrative phrase + action=passthrough OR stripped-only-by-narrative-signal",
      count: atRisk.length,
      samples: atRisk.map((rec) => ({
        prNumber: rec.prNumber,
        reviewId: rec.reviewId,
        action: rec.action,
        signals: rec.signals,
        prefixLength: rec.prefixLength,
        originalLength: rec.originalLength,
        excerpt: rec.excerpt,
      })),
    },
  };

  process.stdout.write(JSON.stringify(output, null, 2));
  process.stdout.write("\n");
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
