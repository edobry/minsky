/**
 * Shared Octokit error-handling utilities for GitHub backend operations.
 *
 * Extracts the repeated pattern of classifying HTTP status codes and
 * Octokit response payloads into user-friendly MinskyError messages.
 */

import { MinskyError, getErrorMessage } from "../../errors/index";

// ── Structured error info extracted from an Octokit error ──────────────

export interface OctokitErrorInfo {
  /** HTTP status code, if present */
  status?: number;
  /** Top-level error message */
  message: string;
  /** Lowercased message for quick substring checks */
  messageLower: string;
  /** Array of structured GitHub error objects (from response.data.errors) */
  ghErrors: any[];
  /** Concatenated, lowercased text of ghMessage + ghErrors fields */
  ghErrorsText: string;
  /** GitHub response message (response.data.message) */
  ghMessage: string;
}

/**
 * Extract structured information from an Octokit / GitHub API error.
 *
 * Works whether the value is an Octokit RequestError, a plain Error,
 * or an unknown value.
 */
export function classifyOctokitError(error: unknown): OctokitErrorInfo {
  const anyErr: any = error as any;
  const message: string =
    error instanceof Error ? error.message : String(error);
  const status: number | undefined =
    (anyErr?.status ?? anyErr?.response?.status) as number | undefined;
  const ghData = anyErr?.response?.data;
  const ghMessage: string =
    typeof ghData?.message === "string" ? ghData.message : "";
  const ghErrors: any[] = Array.isArray(ghData?.errors) ? ghData.errors : [];
  const ghErrorsText: string = `${ghMessage || ""} ${ghErrors
    .map((e: any) =>
      [e?.message, e?.code, e?.field].filter(Boolean).join(" "),
    )
    .join(" ")}`.toLowerCase();

  return {
    status,
    message,
    messageLower: message.toLowerCase(),
    ghErrors,
    ghErrorsText,
    ghMessage,
  };
}

// ── Context passed to the error handler so messages are specific ────────

export interface ErrorContext {
  /** Human-readable operation name, e.g. "create pull request" */
  operation: string;
  /** Repository owner */
  owner: string;
  /** Repository name */
  repo: string;
  /** PR number when applicable */
  prNumber?: number;
  /** Source branch (for create PR) */
  sourceBranch?: string;
  /** Base branch (for create PR) */
  baseBranch?: string;
}

// ── The main dispatcher ─────────────────────────────────────────────────

/**
 * Throw a user-friendly MinskyError based on the classified Octokit error.
 *
 * Call this from a catch block *after* any operation-specific handling.
 * It covers the common HTTP-status patterns (401, 403, 404, 422, 429,
 * network errors) so each call-site doesn't have to duplicate them.
 *
 * Always throws — the return type `never` lets callers write:
 *   `throw handleOctokitError(error, ctx);`
 * even though the function itself throws, to satisfy control-flow analysis.
 */
export function handleOctokitError(error: unknown, ctx: ErrorContext): never {
  const info = classifyOctokitError(error);

  // ── Authentication (401 / bad credentials) ──────────────────────
  if (
    info.status === 401 ||
    info.messageLower.includes("401") ||
    info.messageLower.includes("bad credentials") ||
    info.messageLower.includes("unauthorized")
  ) {
    throw new MinskyError(
      `GitHub Authentication Failed\n\n` +
        `Your GitHub token is invalid or expired.\n\n` +
        `To fix this:\n` +
        `  1. Generate a new Personal Access Token at ` +
        `https://github.com/settings/tokens\n` +
        `  2. Set it as GITHUB_TOKEN or GH_TOKEN environment variable\n` +
        `  3. Ensure the token has 'repo' and 'pull_requests' permissions\n\n` +
        `Repository: ${ctx.owner}/${ctx.repo}`,
    );
  }

  // ── Permission denied (403 / forbidden) ─────────────────────────
  if (
    (info.status === 403 ||
      info.messageLower.includes("403") ||
      info.messageLower.includes("forbidden")) &&
    !info.messageLower.includes("422")
  ) {
    throw new MinskyError(
      `GitHub Permission Denied\n\n` +
        `You don't have permission to ${ctx.operation} in ` +
        `${ctx.owner}/${ctx.repo}.\n\n` +
        `To fix this:\n` +
        `  - Ensure you have write access to the repository\n` +
        `  - Verify your GitHub token has sufficient permissions\n\n` +
        `Repository: https://github.com/${ctx.owner}/${ctx.repo}`,
    );
  }

  // ── Not found (404) ─────────────────────────────────────────────
  if (
    info.status === 404 ||
    info.messageLower.includes("404") ||
    info.messageLower.includes("not found")
  ) {
    const subject = ctx.prNumber
      ? `Pull request #${ctx.prNumber} was not found in ${ctx.owner}/${ctx.repo}.`
      : `The repository ${ctx.owner}/${ctx.repo} was not found.`;
    throw new MinskyError(
      `GitHub Not Found\n\n${subject}\n\n` +
        `To fix this:\n` +
        `  - Verify the repository/PR exists and is accessible\n` +
        `  - Check if the repository is private and you have access\n\n` +
        `https://github.com/${ctx.owner}/${ctx.repo}` +
        (ctx.prNumber ? `/pull/${ctx.prNumber}` : ""),
    );
  }

  // ── Rate limiting (429) ─────────────────────────────────────────
  if (
    info.status === 429 ||
    info.messageLower.includes("429") ||
    info.messageLower.includes("rate limit")
  ) {
    throw new MinskyError(
      `GitHub Rate Limit Exceeded\n\n` +
        `You've hit GitHub's API rate limit.\n\n` +
        `To fix this:\n` +
        `  - Wait a few minutes before trying again\n` +
        `  - Use a GitHub token for higher rate limits`,
    );
  }

  // ── Network / connectivity ──────────────────────────────────────
  if (
    info.messageLower.includes("network") ||
    info.messageLower.includes("timeout") ||
    info.messageLower.includes("enotfound")
  ) {
    throw new MinskyError(
      `Network Connection Error\n\n` +
        `Unable to connect to GitHub API.\n\n` +
        `To fix this:\n` +
        `  - Check your internet connection\n` +
        `  - Verify GitHub is accessible (https://githubstatus.com)\n` +
        `  - Try again in a few moments\n\n` +
        `Error: ${info.message}`,
    );
  }

  // ── Self-approval ───────────────────────────────────────────────
  if (
    info.messageLower.includes("can not approve your own pull request") ||
    info.messageLower.includes("cannot approve your own pull request")
  ) {
    throw new MinskyError(
      `Cannot Approve Your Own Pull Request\n\n` +
        `GitHub prevents authors from approving their own PR.\n\n` +
        (ctx.prNumber
          ? `PR: https://github.com/${ctx.owner}/${ctx.repo}/pull/${ctx.prNumber}\n\n`
          : "") +
        `Next steps:\n` +
        `  - Request a review from a maintainer\n` +
        `  - Have another collaborator approve the PR`,
    );
  }

  // ── Fallback ────────────────────────────────────────────────────
  throw new MinskyError(
    `Failed to ${ctx.operation}: ${getErrorMessage(error)}`,
  );
}

/**
 * Handle 422 validation errors for PR creation specifically.
 *
 * Separated because only createPullRequest needs the fine-grained
 * "already exists" / "no commits between" sub-classification.
 */
export function handleCreatePR422(
  info: OctokitErrorInfo,
  ctx: ErrorContext,
): void {
  if (info.status !== 422 && !info.messageLower.includes("422")) {
    return; // not a 422
  }

  const text = info.ghErrorsText || info.messageLower;

  // No commits between base and head
  if (text.includes("no commits between") || text.includes("no changes")) {
    throw new MinskyError(
      `No Changes to Create PR\n\n` +
        `No differences found between ` +
        `${ctx.sourceBranch} and ${ctx.baseBranch}.\n\n` +
        `To fix this:\n` +
        `  - Make sure your changes are committed to ${ctx.sourceBranch}\n` +
        `  - Push your branch: git push origin ${ctx.sourceBranch}\n` +
        `  - Verify you're on the correct branch: git branch`,
    );
  }

  // PR already exists
  if (
    text.includes("already exists") ||
    info.ghErrors.some((e: any) =>
      String(e?.message || e?.code || "")
        .toLowerCase()
        .includes("already exists"),
    )
  ) {
    throw new MinskyError(
      `Pull Request Already Exists\n\n` +
        `A pull request from ${ctx.sourceBranch} to ` +
        `${ctx.baseBranch} already exists.\n\n` +
        `Options:\n` +
        `  - Update the existing PR instead of creating a new one\n` +
        `  - Use a different branch name\n` +
        `  - Close the existing PR if it's no longer needed\n\n` +
        `Check: https://github.com/${ctx.owner}/${ctx.repo}/pulls`,
    );
  }

  // Generic 422
  throw new MinskyError(
    `GitHub Validation Failed\n\n` +
      `${info.ghMessage || "Unprocessable Entity"}`,
  );
}

/**
 * Handle 405/422 merge-specific errors with optional diagnosis.
 *
 * Returns `true` if a MinskyError was thrown (it always throws when it
 * matches), `false` if the status didn't match.
 */
export function handleMerge405or422(
  info: OctokitErrorInfo,
  ctx: ErrorContext,
  diagnosis?: string,
): void {
  const isMergeBlock =
    info.status === 405 ||
    info.status === 422 ||
    info.messageLower.includes("405") ||
    info.messageLower.includes("422") ||
    info.messageLower.includes("merge conflicts");

  if (!isMergeBlock) {
    return;
  }

  const body = diagnosis
    ? diagnosis
    : `Common causes:\n` +
      `  - Merge conflicts that need to be resolved\n` +
      `  - Branch protection rules requiring reviews\n` +
      `  - Required status checks not passing\n` +
      `  - PR is not in an open state`;

  throw new MinskyError(
    `Pull Request Cannot Be Merged\n\n` +
      `Pull request #${ctx.prNumber} cannot be merged automatically.\n\n` +
      `${body}\n\n` +
      `Visit the PR to resolve: ` +
      `https://github.com/${ctx.owner}/${ctx.repo}/pull/${ctx.prNumber}`,
  );
}
