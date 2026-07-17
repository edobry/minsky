/**
 * Shared Octokit error-handling utilities for GitHub backend operations.
 *
 * Extracts the repeated pattern of classifying HTTP status codes and
 * Octokit response payloads into user-friendly MinskyError messages.
 */

import { MinskyError, getErrorMessage } from "../errors/index";
import { getLastGithubRateLimitSnapshot } from "./github-rate-limit-state";
import { safeTruncate } from "@minsky/shared/safe-truncate";

// ── HTML-body sanitization (mt#2888) ─────────────────────────────────────
//
// GitHub occasionally serves a 5xx (or other) response as an HTML error
// page (the "Unicorn" page — ~5KB of markup with base64-inlined images)
// instead of JSON. `@octokit/request`'s fetch wrapper folds a non-JSON
// string response body DIRECTLY into the thrown `RequestError`'s `.message`
// (see `toErrorMessage`/`getResponseData` in
// `@octokit/request/dist-src/fetch-wrapper.js`: `if (typeof data ===
// "string") return data;`) — so without this guard, the raw markup flows
// straight through `classifyOctokitError` into every `handleOctokitError`
// branch that echoes `info.message` (the 5xx branch's `Error:
// ${info.message}` line in particular), burning agent context and burying
// the actual signal. Originating incident: mt#2888, 2026-07-16 — `gh api`'s
// own JSON-decode failure surfaced this class independently (`invalid
// character '<' looking for beginning of value`); the Octokit path exhibits
// the SAME underlying GitHub behavior, but Octokit's fetch layer swallows
// the parse failure and keeps the raw body as the message instead of
// erroring, so it needs this dedicated sanitization pass.
const HTML_BODY_PATTERN = /<(!doctype\s+html|html[\s>]|head[\s>]|body[\s>])/i;

/**
 * True when `text` looks like an HTML document body rather than a GitHub
 * API JSON/plain-text error message. Only inspects a bounded prefix — an
 * HTML document's doctype/opening tags always appear at the very start.
 */
export function looksLikeHtmlBody(text: string): boolean {
  if (!text) return false;
  return HTML_BODY_PATTERN.test(safeTruncate(text, 500, "head"));
}

/**
 * Replace an HTML-body message with a short, safe placeholder naming the
 * byte length — never echoes the markup itself. Callers that need the HTTP
 * status for classification already have it via `OctokitErrorInfo.status`,
 * independent of this sanitization (status is extracted separately from
 * `error.status` / `error.response.status`, not parsed out of the message).
 */
export function sanitizeOctokitMessage(message: string): string {
  if (!looksLikeHtmlBody(message)) return message;
  return `<non-JSON HTML error page from GitHub, ${message.length} chars — see HTTP status for classification>`;
}

// ── Structured error info extracted from an Octokit error ──────────────

export interface OctokitErrorInfo {
  /** HTTP status code, if present */
  status?: number;
  /** Top-level error message */
  message: string;
  /** Lowercased message for quick substring checks */
  messageLower: string;
  /** Array of structured GitHub error objects (from response.data.errors) */
  ghErrors: Record<string, unknown>[];
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
interface OctokitErrorShape {
  status?: number;
  response?: {
    status?: number;
    data?: {
      message?: unknown;
      errors?: Record<string, unknown>[];
    };
  };
}

export function classifyOctokitError(error: unknown): OctokitErrorInfo {
  const anyErr = error as OctokitErrorShape; // Octokit errors have dynamic shape not covered by standard types
  const rawMessage: string = error instanceof Error ? error.message : String(error);
  const message: string = sanitizeOctokitMessage(rawMessage);
  const status: number | undefined = anyErr?.status ?? anyErr?.response?.status;
  const ghData = anyErr?.response?.data;
  const rawGhMessage: string = typeof ghData?.message === "string" ? ghData.message : "";
  const ghMessage: string = sanitizeOctokitMessage(rawGhMessage);
  const ghErrors: Record<string, unknown>[] = Array.isArray(ghData?.errors) ? ghData.errors : [];
  const ghErrorsText: string = `${ghMessage || ""} ${ghErrors
    .map((e) => [e?.["message"], e?.["code"], e?.["field"]].filter(Boolean).join(" "))
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
        `Repository: ${ctx.owner}/${ctx.repo}`
    );
  }

  // ── Rate limiting (checked BEFORE 403: GitHub's primary rate limits are
  // HTTP 403 with a "rate limit" message, and the 403 branch below matches
  // any 403 — ordering is load-bearing; PR #2005 R-final finding, mt#2890) ──
  if (
    info.status === 429 ||
    info.messageLower.includes("429") ||
    info.messageLower.includes("rate limit")
  ) {
    // mt#2888: fold the last-observed `x-ratelimit-reset` into the message
    // when available, so the reset time survives into
    // `withOriginalMessage`'s one-line excerpt at the adapter layer instead
    // of a bare "wait a few minutes" with no concrete time.
    const snapshot = getLastGithubRateLimitSnapshot();
    const resetSuffix = snapshot ? ` (resets ${snapshot.reset})` : "";
    throw new MinskyError(
      `GitHub Rate Limit Exceeded${resetSuffix}\n\n` +
        `You've hit GitHub's API rate limit.\n\n` +
        `To fix this:\n` +
        `  - Wait a few minutes before trying again\n` +
        `  - Use a GitHub token for higher rate limits`
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
        `Repository: https://github.com/${ctx.owner}/${ctx.repo}`
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
    const prSuffix = ctx.prNumber ? `/pull/${ctx.prNumber}` : "";
    throw new MinskyError(
      `GitHub Not Found\n\n${subject}\n\n` +
        `To fix this:\n` +
        `  - Verify the repository/PR exists and is accessible\n` +
        `  - Check if the repository is private and you have access\n\n` +
        `https://github.com/${ctx.owner}/${ctx.repo}${prSuffix}`
    );
  }

  // ── Server-side degradation (5xx) ────────────────────────────────
  //
  // mt#2890: distinct from the generic fallback below so the status code
  // survives into the message text — the fallback's `getErrorMessage(error)`
  // typically does NOT include the numeric status, which downstream
  // classifiers (workflow-commands.ts's merge-error classifier) rely on to
  // tell a real GitHub-side outage apart from a merge conflict or a rate
  // limit.
  if (info.status !== undefined && info.status >= 500 && info.status < 600) {
    throw new MinskyError(
      `GitHub API degraded/unavailable (HTTP ${info.status})\n\n` +
        `GitHub's API returned a server error for this request. This is not a problem with ` +
        `your PR or credentials — GitHub's service is temporarily degraded.\n\n` +
        `To fix this:\n` +
        `  - Check GitHub status: https://www.githubstatus.com/\n` +
        `  - Retry the operation in a few minutes\n\n` +
        `Error: ${info.message}`
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
        `Error: ${info.message}`
    );
  }

  // ── Self-approval ───────────────────────────────────────────────
  if (
    info.messageLower.includes("can not approve your own pull request") ||
    info.messageLower.includes("cannot approve your own pull request")
  ) {
    const prLink = ctx.prNumber
      ? `PR: https://github.com/${ctx.owner}/${ctx.repo}/pull/${ctx.prNumber}\n\n`
      : "";
    throw new MinskyError(
      `Cannot Approve Your Own Pull Request\n\n` +
        `GitHub prevents authors from approving their own PR.\n\n` +
        `${prLink}Next steps:\n` +
        `  - Request a review from a maintainer\n` +
        `  - Have another collaborator approve the PR`
    );
  }

  // ── Fallback ────────────────────────────────────────────────────
  throw new MinskyError(`Failed to ${ctx.operation}: ${getErrorMessage(error)}`);
}

/**
 * Handle 422 validation errors for PR creation specifically.
 *
 * Separated because only createPullRequest needs the fine-grained
 * "already exists" / "no commits between" sub-classification.
 */
export function handleCreatePR422(info: OctokitErrorInfo, ctx: ErrorContext): void {
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
        `  - Verify you're on the correct branch: git branch`
    );
  }

  // PR already exists
  if (
    text.includes("already exists") ||
    info.ghErrors.some((e) =>
      String(e?.["message"] || e?.["code"] || "")
        .toLowerCase()
        .includes("already exists")
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
        `Check: https://github.com/${ctx.owner}/${ctx.repo}/pulls`
    );
  }

  // Generic 422
  throw new MinskyError(
    `GitHub Validation Failed\n\n` + `${info.ghMessage || "Unprocessable Entity"}`
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
  diagnosis?: string
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
      `https://github.com/${ctx.owner}/${ctx.repo}/pull/${ctx.prNumber}`
  );
}
