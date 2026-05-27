import type { Octokit } from "@octokit/rest";
import { withTimeout } from "./with-timeout";
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
  const { data: comments } = await withTimeout("github.issues.listComments", timeoutMs, (signal) =>
    octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
      request: { signal },
    })
  );

  for (const c of comments) {
    if (c.user?.login === botLogin && c.body?.includes(STATUS_MARKER)) {
      return { commentId: c.id };
    }
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
    `Review failed — ${reason}`,
    "",
    "### Commands",
    "- `/review` — request a fresh review",
  ].join("\n");
}

export function buildSkippedBody(reason: string): string {
  return [STATUS_MARKER, "", "## Minsky Reviewer Status", "", `Review skipped — ${reason}`].join(
    "\n"
  );
}

function formatTokenCount(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}
