import type { Octokit } from "@octokit/rest";
import { withTimeout } from "./with-timeout";
import { safeTruncate } from "@minsky/shared/safe-truncate";
import type { ReviewResult } from "./review-worker";

const STATUS_MARKER = "<!-- minsky-reviewer-status -->";

const DEFAULT_TIMEOUT_MS = 15_000;

export interface StatusCommentRef {
  commentId: number;
}

export async function findBotStatusComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  botLogin: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<StatusCommentRef | null> {
  const PER_PAGE = 100;
  const MAX_PAGES = 10;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data: comments } = await withTimeout(
      "github.issues.listComments",
      timeoutMs,
      (signal) =>
        octokit.rest.issues.listComments({
          owner,
          repo,
          issue_number: prNumber,
          per_page: PER_PAGE,
          page,
          request: { signal },
        })
    );

    for (const c of comments) {
      if (c.user?.login === botLogin && c.body?.includes(STATUS_MARKER)) {
        return { commentId: c.id };
      }
    }

    if (comments.length < PER_PAGE) break;
  }

  return null;
}

export async function upsertStatusComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
  botLogin: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<StatusCommentRef> {
  const existing = await findBotStatusComment(octokit, owner, repo, prNumber, botLogin, timeoutMs);

  if (existing) {
    await withTimeout("github.issues.updateComment", timeoutMs, (signal) =>
      octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: existing.commentId,
        body,
        request: { signal },
      })
    );
    return existing;
  }

  const { data } = await withTimeout("github.issues.createComment", timeoutMs, (signal) =>
    octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body,
      request: { signal },
    })
  );

  return { commentId: data.id };
}

// ---------------------------------------------------------------------------
// Body builders
// ---------------------------------------------------------------------------

export function buildPendingBody(): string {
  return [
    STATUS_MARKER,
    "",
    "## Minsky Reviewer Status",
    "",
    "Review requested — awaiting processing",
  ].join("\n");
}

export function buildInProgressBody(chunkInfo?: { current: number; total: number }): string {
  const progress = chunkInfo
    ? `Reviewing chunk ${chunkInfo.current}/${chunkInfo.total}...`
    : "Review in progress...";

  return [STATUS_MARKER, "", "## Minsky Reviewer Status", "", progress].join("\n");
}

export function buildCompletedBody(result: ReviewResult, durationMs?: number): string {
  const lines = [STATUS_MARKER, "", "## Minsky Reviewer Status", ""];

  const isApproved = result.blockingCount == null || result.blockingCount === 0;
  if (isApproved) {
    lines.push("**Verdict:** APPROVED — no blocking findings");
  } else {
    lines.push(`**Verdict:** CHANGES_REQUESTED — ${result.blockingCount} blocking finding(s)`);
  }

  if (result.review?.htmlUrl) {
    lines.push(`**Review:** [View review](${result.review.htmlUrl})`);
  }

  const metaParts: string[] = [];
  if (result.providerUsed && result.providerModel) {
    metaParts.push(`**Model:** ${result.providerUsed}/${result.providerModel}`);
  }
  if (result.usage) {
    const { promptTokens, completionTokens } = result.usage;
    if (promptTokens != null && completionTokens != null) {
      metaParts.push(
        `**Tokens:** ${formatTokenCount(promptTokens)} prompt, ${formatTokenCount(completionTokens)} completion`
      );
    }
  }
  if (durationMs != null) {
    metaParts.push(`**Duration:** ${Math.round(durationMs / 1000)}s`);
  }
  if (metaParts.length > 0) {
    lines.push(metaParts.join(" | "));
  }

  if (result.scope) {
    lines.push(`**Mode:** ${result.scope}`);
  }

  lines.push("", "### Commands", "- `/review` — request a fresh review");

  return lines.join("\n");
}

export function buildErrorBody(reason: string): string {
  return [
    STATUS_MARKER,
    "",
    "## Minsky Reviewer Status",
    "",
    `Review failed — ${sanitizeReason(reason)}`,
    "",
    "### Commands",
    "- `/review` — request a fresh review",
  ].join("\n");
}

export function buildSkippedBody(reason: string): string {
  return [
    STATUS_MARKER,
    "",
    "## Minsky Reviewer Status",
    "",
    `Review skipped — ${sanitizeReason(reason)}`,
  ].join("\n");
}

export function buildResolvedBody(stats: {
  threadsResolved: number;
  reviewsDismissed: number;
}): string {
  return [
    STATUS_MARKER,
    "",
    "## Minsky Reviewer Status",
    "",
    `Findings resolved — ${stats.threadsResolved} thread(s) resolved, ${stats.reviewsDismissed} stale review(s) dismissed.`,
    "",
    "### Commands",
    "- `/review` — request a fresh review",
  ].join("\n");
}

const SAFE_REASON_PATTERNS = [
  /^tier \d/i,
  /^draft/i,
  /^timeout/i,
  /^routing/i,
  /^Posted/,
  /^skipped/i,
  /^concurrent/i,
];

function sanitizeReason(reason: string): string {
  const short = safeTruncate(reason, 200, "head");
  if (SAFE_REASON_PATTERNS.some((p) => p.test(short))) return short;
  return "an internal error occurred. Use `/review` to retry.";
}

function formatTokenCount(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}
