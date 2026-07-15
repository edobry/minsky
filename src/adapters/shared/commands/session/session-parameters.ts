/**
 * Session Command Parameters
 *
 * Consolidated parameter definitions for all session commands.
 * Extracted from session.ts as part of modularization effort.
 */
import { z } from "zod";
import { CONVENTIONAL_COMMIT_TYPES } from "@minsky/domain/git/conventional-commit-types";

/**
 * Common parameter building blocks for session commands
 */
export const commonSessionParams = {
  sessionId: {
    schema: z.string(),
    description: "Session ID",
    required: false,
  },
  task: {
    schema: z.string(),
    description: "Task ID",
    required: false,
  },
  repo: {
    schema: z.string(),
    description: "Repository path",
    required: false,
  },
  json: {
    schema: z.boolean(),
    description: "Output in JSON format",
    required: false,
    defaultValue: false,
  },
  force: {
    schema: z.boolean(),
    description: "Force the operation",
    required: false,
    defaultValue: false,
  },
  debug: {
    schema: z.boolean(),
    description: "Enable debug output",
    required: false,
    defaultValue: false,
  },
  quiet: {
    schema: z.boolean(),
    description: "Suppress output",
    required: false,
    defaultValue: false,
  },
  noStash: {
    schema: z.boolean(),
    description: "Skip stashing changes",
    required: false,
    defaultValue: false,
  },
  noPush: {
    schema: z.boolean(),
    description: "Skip pushing changes",
    required: false,
    defaultValue: false,
  },
};

/**
 * Session list command parameters
 */
export const sessionListCommandParams = {
  repo: commonSessionParams.repo,
  json: commonSessionParams.json,
  task: {
    schema: z.string(),
    description: "Filter sessions by task ID (e.g. 'mt#283' or '283')",
    required: false,
  },
  since: {
    schema: z.string(),
    description: "Only include sessions created on/after this time (YYYY-MM-DD or 7d/24h/30m)",
    required: false,
  },
  until: {
    schema: z.string(),
    description: "Only include sessions created on/before this time (YYYY-MM-DD or 7d/24h/30m)",
    required: false,
  },
  limit: {
    schema: z.number().int().positive(),
    description: "Maximum number of sessions to return (default: 20)",
    required: false,
    defaultValue: 20,
  },
  offset: {
    schema: z.number().int().nonnegative(),
    description: "Number of sessions to skip for pagination (default: 0)",
    required: false,
    defaultValue: 0,
  },
  verbose: {
    schema: z.boolean(),
    description:
      "Include full session record (PR state, pull request info). Default omits these large fields.",
    required: false,
    defaultValue: false,
  },
  allProjects: {
    schema: z.boolean().optional(),
    description:
      "Return sessions from all projects (disable project-scope filtering; ADR-021, mt#2416)",
    required: false,
  },
};

/**
 * Session get command parameters
 */
export const sessionGetCommandParams = {
  sessionId: commonSessionParams.sessionId,
  task: commonSessionParams.task,
  repo: commonSessionParams.repo,
  json: commonSessionParams.json,
  since: {
    schema: z.string(),
    description: "Only match if session created on/after this time (YYYY-MM-DD or 7d/24h/30m)",
    required: false,
  },
  until: {
    schema: z.string(),
    description: "Only match if session created on/before this time (YYYY-MM-DD or 7d/24h/30m)",
    required: false,
  },
};

/**
 * Session start command parameters
 */
export const sessionStartCommandParams = {
  sessionId: {
    schema: z.string(),
    description: "Session ID",
    required: false,
  },
  task: commonSessionParams.task,
  description: {
    schema: z.string(),
    description: "Task description for auto-creation",
    required: false,
  },
  branch: {
    schema: z.string(),
    description: "Git branch to use",
    required: false,
  },
  repo: commonSessionParams.repo,
  json: commonSessionParams.json,
  quiet: commonSessionParams.quiet,
  noStatusUpdate: {
    schema: z.boolean(),
    description: "Skip updating task status",
    required: false,
    defaultValue: false,
  },
  skipInstall: {
    schema: z.boolean(),
    description:
      "⚠️ DEPRECATED — DO NOT USE. Skips dependency installation, creating a workspace that cannot pass typecheck hooks or run tests. Will be removed in a future release.",
    required: false,
    defaultValue: false,
  },
  packageManager: {
    schema: z.enum(["npm", "yarn", "pnpm", "bun"]),
    description: "Package manager to use",
    required: false,
  },
  recover: {
    schema: z.boolean(),
    description:
      "Recover abandoned session: if existing session for this task is stale/orphaned, delete it and create a fresh one",
    required: false,
    defaultValue: false,
  },
};

/**
 * Session directory command parameters
 */
export const sessionDirCommandParams = {
  sessionId: commonSessionParams.sessionId,
  task: commonSessionParams.task,
  repo: commonSessionParams.repo,
  json: commonSessionParams.json,
};

/**
 * Session ps (alias: session attached) command parameters (mt#2284).
 */
export const sessionPsCommandParams = {
  sessionId: commonSessionParams.sessionId,
  task: commonSessionParams.task,
  json: commonSessionParams.json,
};

/**
 * Session search command parameters
 */
export const sessionSearchCommandParams = {
  query: {
    schema: z.string().min(1),
    description: "Search query (searches in session ID, repo name, branch, task ID)",
    required: true,
  },
  limit: {
    schema: z.number().int().positive(),
    description: "Maximum number of results to return",
    required: false,
    defaultValue: 10,
  },
};

/**
 * Session delete command parameters
 */
export const sessionDeleteCommandParams = {
  sessionId: commonSessionParams.sessionId,
  task: commonSessionParams.task,
  force: commonSessionParams.force,
  repo: commonSessionParams.repo,
  json: commonSessionParams.json,
};

/**
 * Session update command parameters
 */
export const sessionUpdateCommandParams = {
  sessionId: commonSessionParams.sessionId,
  task: commonSessionParams.task,
  repo: commonSessionParams.repo,
  branch: {
    schema: z.string(),
    description: "Branch to update from",
    required: false,
  },
  noStash: commonSessionParams.noStash,
  noPush: commonSessionParams.noPush,
  force: commonSessionParams.force,
  json: commonSessionParams.json,
  skipConflictCheck: {
    schema: z.boolean(),
    description: "Skip conflict detection",
    required: false,
    defaultValue: false,
  },
  autoResolveDeleteConflicts: {
    schema: z.boolean(),
    description: "Automatically resolve delete conflicts",
    required: false,
    defaultValue: false,
  },
  dryRun: {
    schema: z.boolean(),
    description: "Preview changes without applying",
    required: false,
    defaultValue: false,
  },
  skipIfAlreadyMerged: {
    schema: z.boolean(),
    description: "Skip if changes already merged",
    required: false,
    defaultValue: false,
  },
};

/**
 * Session approve command parameters.
 * Only includes fields relevant to the approve action (not merge-only flags).
 */
// mt#2742: base params shared by approve + merge. `reviewComment` is approve-only
// (a merge posts no review comment), so it lives on sessionApproveCommandParams — NOT
// the base — otherwise sessionMergeCommandParams (which spreads the base) would inherit
// a param its handler never reads (a declared-but-unread bug, the very class this task fixes).
const sessionApproveBaseParams = {
  sessionId: commonSessionParams.sessionId,
  task: commonSessionParams.task,
  repo: commonSessionParams.repo,
  json: commonSessionParams.json,
};

export const sessionApproveCommandParams = {
  ...sessionApproveBaseParams,
  reviewComment: {
    schema: z.string(),
    description: "Optional review comment posted alongside the approval",
    required: false,
  },
};

/**
 * Session merge command parameters.
 * Extends the approve base with merge-only flags.
 */
export const sessionMergeCommandParams = {
  // mt#2742: spread the BASE (not sessionApproveCommandParams) so merge does NOT
  // inherit the approve-only `reviewComment` param (its handler never reads it).
  ...sessionApproveBaseParams,
  skipCleanup: {
    schema: z.boolean(),
    description: "Skip session cleanup after merge (preserves session files)",
    required: false,
    defaultValue: false,
  },
  acceptStaleReviewerSilence: {
    schema: z.boolean(),
    description:
      "Operator-override waiver: allow merge when the reviewer bot (reviewer.botLogin, default minsky-reviewer[bot]) is absent (webhook-miss class). " +
      "All five constraints must hold: (1) PR author must be the configured bot identity (github.botIdentityLogin, default minsky-ai[bot]) -- waiver never applies to human-authored PRs; " +
      "(2) at least one COMMENTED review from the same identity as the PR author must exist; " +
      "(3) no non-DISMISSED CHANGES_REQUESTED review may exist (DISMISSED reviews are excluded from this check); " +
      "(4) no review from the configured reviewer bot may exist -- waiver is inapplicable when the reviewer bot has already acted; " +
      "(5) no other merge blockers (draft PR, merge conflicts, PR not open) may be active -- the waiver only bypasses the approval gate, not other mergeability requirements. " +
      "Emits an audit log entry at INFO level when the waiver is applied. Default: false.",
    required: false,
    defaultValue: false,
  },
  forceBypass: {
    schema: z.boolean(),
    description:
      "Audited reviewer-convergence-failure bypass (mt#2215): merge a self-authored bot PR " +
      "blocked by a CHANGES_REQUESTED review that is a VERIFIED false-positive (per mt#2211), " +
      "or by reviewer CoT-leakage / self-reversal / >5min webhook silence (per " +
      "feedback_self_authored_pr_merge_constraints). Distinct from acceptStaleReviewerSilence, " +
      "which only covers reviewer ABSENCE and refuses when CHANGES_REQUESTED exists. forceBypass " +
      "requires a non-empty bypassReason, requires at least one prior review round to have " +
      "occurred, refuses when a required status check is failing (CI-not-green, where " +
      "status-check data is available) and when any " +
      "non-approval merge blocker is active (draft / conflict / closed). It auto-dismisses every " +
      "non-DISMISSED CHANGES_REQUESTED review (using bypassReason as the dismissal evidence) and " +
      "writes the canonical audit-trail signature plus the reason into the merge-commit body. " +
      "merge_method=merge is always enforced (never squash). Default: false.",
    required: false,
    defaultValue: false,
  },
  bypassReason: {
    schema: z.string(),
    description:
      "Required when forceBypass=true: a non-empty evidence string explaining why the bypass is " +
      "justified (e.g. which review was a verified false-positive and the verification, or the " +
      "reviewer convergence-failure class). Used both as the CHANGES_REQUESTED dismissal message " +
      "and written into the merge-commit body alongside the canonical bypass audit signature.",
    required: false,
  },
};

/**
 * Session PR command parameters
 */
export const sessionPrCommandParams = {
  title: {
    schema: z.string(),
    description: "PR title",
    required: false,
  },
  body: {
    schema: z.string(),
    description: "PR body content",
    required: false,
  },
  bodyPath: {
    schema: z.string(),
    description: "Path to file containing PR body",
    required: false,
  },
  sessionId: commonSessionParams.sessionId,
  task: commonSessionParams.task,
  repo: commonSessionParams.repo,
  noStatusUpdate: {
    schema: z.boolean(),
    description: "Skip updating task status",
    required: false,
    defaultValue: false,
  },
  debug: commonSessionParams.debug,

  autoResolveDeleteConflicts: {
    schema: z.boolean(),
    description: "Automatically resolve delete conflicts",
    required: false,
    defaultValue: false,
  },
  skipConflictCheck: {
    schema: z.boolean(),
    description: "Skip conflict detection",
    required: false,
    defaultValue: false,
  },
};

/**
 * Session migrate-backend command parameters
 */
export const sessionMigrateBackendCommandParams = {
  sessionId: commonSessionParams.sessionId,
  task: commonSessionParams.task,
  repo: commonSessionParams.repo,
  json: commonSessionParams.json,
  dryRun: {
    schema: z.boolean(),
    description: "Preview changes without updating the session DB",
    required: false,
    defaultValue: false,
  },
  to: {
    schema: z.enum(["github"]).default("github"),
    description: "Target backend to migrate to (default: github)",
    required: false,
    defaultValue: "github",
  },
  updateRemote: {
    schema: z.boolean(),
    description: "Also update the session workspace git remotes (default: true)",
    required: false,
    defaultValue: true,
  },
};

/**
 * Session migrate (ID format) command parameters
 */
export const sessionMigrateCommandParams = {
  dryRun: {
    schema: z.boolean(),
    description: "Preview changes without modifying anything",
    required: false,
    defaultValue: false,
  },
  json: commonSessionParams.json,
};

/**
 * Session inspect command parameters
 */
export const sessionInspectCommandParams = {
  json: commonSessionParams.json,
};

/**
 * Session PR Create command parameters
 * Replaces the current session PR command
 */
export const sessionPrCreateCommandParams = {
  title: {
    schema: z.string().refine((t) => !/^(?:[a-z]+)(?:\([^)]*\))?:\s*/i.test(t), {
      message:
        "Title should be description only. Do not include conventional prefix like 'feat:' or 'feat(scope):'",
    }),
    description: "PR title (description only when --type is provided)",
    required: true,
  },
  type: {
    schema: z.enum(CONVENTIONAL_COMMIT_TYPES),
    description: "Conventional commit type to generate title prefix",
    required: true,
  },
  body: {
    schema: z.string(),
    description: "PR body content",
    required: false,
  },
  bodyPath: {
    schema: z.string(),
    description: "Path to file containing PR body",
    required: false,
  },
  sessionId: commonSessionParams.sessionId,
  task: commonSessionParams.task,
  repo: commonSessionParams.repo,
  noStatusUpdate: {
    schema: z.boolean(),
    description: "Skip updating task status",
    required: false,
    defaultValue: false,
  },
  debug: commonSessionParams.debug,

  autoResolveDeleteConflicts: {
    schema: z.boolean(),
    description: "Automatically resolve delete conflicts",
    required: false,
    defaultValue: false,
  },
  skipConflictCheck: {
    schema: z.boolean(),
    description: "Skip conflict detection",
    required: false,
    defaultValue: false,
  },
  draft: {
    schema: z.boolean(),
    description: "Create draft PR (GitHub only, skips session update)",
    required: false,
    defaultValue: false,
  },
};

/**
 * Session PR Edit Command Parameters
 * For editing existing PRs - all fields are optional
 */
export const sessionPrEditCommandParams = {
  title: {
    schema: z.string(),
    description:
      "PR title (to update). With --type, pass description-only; otherwise pass full conventional title",
    required: false,
  },
  type: {
    schema: z.enum(CONVENTIONAL_COMMIT_TYPES),
    description: "Conventional commit type to generate prefix when editing (optional)",
    required: false,
  },
  body: {
    schema: z.string(),
    description: "PR body content (to update)",
    required: false,
  },
  bodyPath: {
    schema: z.string(),
    description: "Path to file containing PR body (to update)",
    required: false,
  },
  sessionId: commonSessionParams.sessionId,
  task: commonSessionParams.task,
  repo: commonSessionParams.repo,
  debug: commonSessionParams.debug,
};

/**
 * Session PR Close Command Parameters (mt#1955)
 *
 * Closes a session's PR without merging, optionally posting a comment
 * before the state flip. The per-tool behavioral spec lives in the tool's
 * `description` field on `createSessionPrCloseCommand`; banned-tool
 * mappings live in the `.claude/hooks/block-git-gh-cli.ts` and
 * `block-github-mcp-pr-writes.ts` denial messages.
 */
export const sessionPrCloseCommandParams = {
  sessionId: commonSessionParams.sessionId,
  task: commonSessionParams.task,
  repo: commonSessionParams.repo,
  prNumber: {
    schema: z.union([z.number().int().positive(), z.string()]),
    description:
      "PR number to close (alternative to identifying via session). Required when " +
      "no `task`/`sessionId` is provided. When both are passed, `prNumber` wins as the " +
      "address and the session backend is reused; the session DB is updated only if the " +
      "closed PR matches the session's recorded PR.",
    required: false,
  },
  comment: {
    schema: z.string(),
    description:
      "Optional comment to post on the PR before closing. Useful for absorb-and-close: " +
      "name the PR that subsumes this work. Posted as a regular PR comment (not a review) " +
      "so it appears chronologically before the close event.",
    required: false,
  },
  json: commonSessionParams.json,
  debug: commonSessionParams.debug,
};

/**
 * Session PR List command parameters
 * Lists all PRs associated with sessions
 */
export const sessionPrListCommandParams = {
  sessionId: {
    schema: z.string(),
    description: "Filter PRs by specific session ID",
    required: false,
  },
  task: commonSessionParams.task,
  status: {
    schema: z.string().refine(
      (value) => {
        const validStatuses = [
          "open",
          "closed",
          "merged",
          "draft",
          "created",
          "unknown",
          "not_found",
          "all",
        ];
        if (value === "all") return true;
        const parts = value.split(",").map((s) => s.trim().toLowerCase());
        return parts.every((part) => validStatuses.includes(part));
      },
      {
        message:
          "Invalid status. Valid options: open, closed, merged, draft, created, unknown, not_found, all (or comma-separated combinations like 'open,draft')",
      }
    ),
    description:
      "Filter by PR status. Valid options: open, closed, merged, draft, created, unknown, not_found, all (or comma-separated combinations)",
    required: false,
  },
  backend: {
    schema: z.enum(["github"]),
    description: "Filter by repository backend type",
    required: false,
  },
  since: {
    schema: z.string(),
    description:
      "Only include PRs updated on/after this time (YYYY-MM-DD or relative like 7d, 24h)",
    required: false,
  },
  until: {
    schema: z.string(),
    description:
      "Only include PRs updated on/before this time (YYYY-MM-DD or relative like 7d, 24h)",
    required: false,
  },
  repo: commonSessionParams.repo,
  json: commonSessionParams.json,
  verbose: {
    schema: z.boolean(),
    description: "Show detailed PR information",
    required: false,
    defaultValue: false,
  },
};

/**
 * Session PR Get command parameters
 * Gets detailed information about a specific PR
 */
export const sessionPrGetCommandParams = {
  sessionId: commonSessionParams.sessionId,
  task: commonSessionParams.task,
  repo: commonSessionParams.repo,
  json: commonSessionParams.json,
  backend: {
    schema: z.enum(["github"]),
    description: "Restrict to a specific repository backend type",
    required: false,
  },
  status: {
    schema: z.string().refine(
      (value) => {
        const validStatuses = [
          "open",
          "closed",
          "merged",
          "draft",
          "created",
          "unknown",
          "not_found",
          "all",
        ];
        if (value === "all") return true;
        const parts = value.split(",").map((s) => s.trim().toLowerCase());
        return parts.every((part) => validStatuses.includes(part));
      },
      {
        message:
          "Invalid status. Valid options: open, closed, merged, draft, created, unknown, not_found, all (or comma-separated combinations like 'open,draft')",
      }
    ),
    description:
      "Optional state constraint for the matched PR: open, closed, merged, draft, created, all (or comma-separated combinations)",
    required: false,
  },
  since: {
    schema: z.string(),
    description: "Only match if PR was updated on/after this time (YYYY-MM-DD or 7d/24h)",
    required: false,
  },
  until: {
    schema: z.string(),
    description: "Only match if PR was updated on/before this time (YYYY-MM-DD or 7d/24h)",
    required: false,
  },
  content: {
    schema: z.boolean(),
    description: "Include PR description and diff content",
    required: false,
    defaultValue: false,
  },
};

/**
 * Session PR Open command parameters
 * Opens the pull request in the default web browser
 */
export const sessionPrOpenCommandParams = {
  sessionId: commonSessionParams.sessionId,
  task: commonSessionParams.task,
  repo: commonSessionParams.repo,
};

/**
 * Session PR Checks command parameters
 * Gets CI check-run status for a session's pull request
 */
export const sessionPrChecksCommandParams = {
  sessionId: commonSessionParams.sessionId,
  task: commonSessionParams.task,
  repo: commonSessionParams.repo,
  json: commonSessionParams.json,
  wait: {
    schema: z.boolean(),
    description: "Wait for all checks to complete before returning",
    required: false,
    defaultValue: false,
  },
  timeoutSeconds: {
    schema: z.number(),
    description: "Maximum seconds to wait when --wait is enabled (default: 600)",
    required: false,
    defaultValue: 600,
  },
  intervalSeconds: {
    schema: z.number(),
    description: "Polling interval in seconds when --wait is enabled (default: 30)",
    required: false,
    defaultValue: 30,
  },
};

/**
 * Session PR Wait-For-Review command parameters (mt#1203)
 * Blocks until a review appears on the session's PR, with optional
 * reviewer-login and since-timestamp filters.
 */
export const sessionPrWaitForReviewCommandParams = {
  sessionId: {
    schema: z.string(),
    description: "Session ID (positional)",
    required: false,
  },
  task: commonSessionParams.task,
  repo: commonSessionParams.repo,
  json: commonSessionParams.json,
  timeoutSeconds: {
    schema: z.number().int().min(1).max(1800),
    description: "Maximum seconds to wait for a matching review (default: 600, max: 1800 / 30 min)",
    required: false,
    defaultValue: 600,
  },
  intervalSeconds: {
    schema: z.number().int().min(5).max(60),
    description: "Polling interval in seconds (default: 15, min: 5, max: 60)",
    required: false,
    defaultValue: 15,
  },
  reviewer: {
    schema: z.string(),
    description:
      "Only match reviews from this reviewer. Accepts either: " +
      '(1) a TokenRole identifier ("reviewer" or "implementer", ' +
      "case-insensitive) — resolved at call setup against the configured GitHub " +
      "App identity; throws a typed error if the role's service account is not " +
      "configured. (2) a literal GitHub login (e.g., minsky-reviewer[bot] or " +
      "the bare minsky-reviewer form, or any human reviewer's login) — " +
      "case-insensitive with optional trailing [bot] suffix on either side. " +
      "Role identifiers shadow literal logins of the same name; pass the " +
      "[bot]-suffixed form to disambiguate. Defaults to any reviewer.",
    required: false,
  },
  since: {
    schema: z.string(),
    description:
      "ISO-8601 timestamp; only reviews submitted strictly AFTER this time count as matches " +
      "(exclusive lower bound, mt#2656 — an exactly-equal submittedAt does not re-match, so " +
      "you can safely pass a previous review's exact submittedAt to wait for its successor). " +
      "Defaults to the PR's created_at timestamp, so pre-existing reviews on the PR match by " +
      "default. Pass an explicit value to narrow the window (e.g., wait only for reviews " +
      "newer than a known stale one).",
    required: false,
  },
  requireCurrentHead: {
    schema: z.boolean(),
    description:
      "When true (default), only a review whose commit SHA matches the PR's current HEAD " +
      "counts as a match, so a stale review of a superseded commit no longer resolves a " +
      "re-review wait (mt#2586). Set false to accept any review regardless of commit " +
      "(pre-mt#2586 behavior). Ignored on backends without HEAD-sha support.",
    required: false,
    defaultValue: true,
  },
  fullBody: {
    schema: z.boolean(),
    description:
      "When true, return the full review (raw markdown body, spec-verification table, " +
      "embedded provenance JSON comment) instead of the default trimmed payload (mt#2656: " +
      "state, submittedAt, reviewer, blocking/non-blocking finding counts, and a findings " +
      "list of severity + file:line + one-sentence summary). Defaults to false.",
    required: false,
    defaultValue: false,
  },
};

/**
 * Session PR Drive command parameters (mt#2647)
 *
 * Convergence-tail driver: composes wait-for-review + checks-wait (default
 * mode), or the postMerge deploy-watch mode when `postMerge: true`. Does NOT
 * merge — the caller makes the `session.pr.merge` call itself so every
 * harness-side merge-gate hook still fires normally.
 */
export const sessionPrDriveCommandParams = {
  sessionId: commonSessionParams.sessionId,
  task: commonSessionParams.task,
  repo: commonSessionParams.repo,
  json: commonSessionParams.json,
  postMerge: {
    schema: z.boolean(),
    description:
      "When true, switch to the post-merge deploy-watch mode: run " +
      "deployment.wait-for-latest for every deploy service the merged PR's changed " +
      "files affect (or an explicit `services` override), and report results. Call " +
      "this AFTER your own session.pr.merge call succeeds — it does not merge " +
      "anything. When false (default), run the review-wait + checks-wait " +
      "convergence-tail mode.",
    required: false,
    defaultValue: false,
  },
  // --- convergence-tail mode params ---
  reviewer: {
    schema: z.string(),
    description:
      "Only match reviews from this reviewer. Accepts a TokenRole identifier " +
      '("reviewer" or "implementer") or a literal GitHub login (e.g. ' +
      "minsky-reviewer[bot]). See session.pr.wait-for-review's `reviewer` param " +
      "for full precedence rules. Defaults to any reviewer. Ignored in postMerge mode.",
    required: false,
  },
  since: {
    schema: z.string(),
    description:
      "ISO-8601 timestamp; only reviews submitted strictly AFTER this time count as " +
      "matches (exclusive lower bound, mt#2656). Pass the previous terminal result's " +
      "review.submittedAt when re-invoking after pushing a fix for " +
      "CHANGES_REQUESTED/COMMENT — the exact same review will not re-match. Defaults to " +
      "the PR's created_at timestamp. Ignored in postMerge mode.",
    required: false,
  },
  requireCurrentHead: {
    schema: z.boolean(),
    description:
      "When true (default), only a review of the PR's current HEAD commit counts " +
      "as a match (mt#2586). Ignored in postMerge mode.",
    required: false,
    defaultValue: true,
  },
  fullBody: {
    schema: z.boolean(),
    description:
      "When true, return the full review body and full per-check breakdown instead of " +
      "the default trimmed payloads (mt#2656). Defaults to false. Ignored in postMerge mode.",
    required: false,
    defaultValue: false,
  },
  reviewTimeoutSeconds: {
    schema: z.number().int().min(1).max(1800),
    description: "Maximum seconds to wait for a matching review (default 600, max 1800).",
    required: false,
    defaultValue: 600,
  },
  reviewIntervalSeconds: {
    schema: z.number().int().min(5).max(60),
    description: "Review polling interval in seconds (default 15, min 5, max 60).",
    required: false,
    defaultValue: 15,
  },
  checksTimeoutSeconds: {
    schema: z.number(),
    description: "Maximum seconds to wait for CI checks to complete (default 600).",
    required: false,
    defaultValue: 600,
  },
  checksIntervalSeconds: {
    schema: z.number(),
    description: "Checks polling interval in seconds (default 30).",
    required: false,
    defaultValue: 30,
  },
  skipChecks: {
    schema: z.boolean(),
    description:
      "Skip the checks-wait step entirely (e.g. the repo has no CI configured). " +
      "An APPROVED review alone resolves to READY_TO_MERGE. Ignored in postMerge mode.",
    required: false,
    defaultValue: false,
  },
  // --- postMerge mode params ---
  services: {
    schema: z.array(z.string()),
    description:
      "postMerge mode only: explicit list of deploy services to watch, overriding " +
      "auto-detection from the merged PR's changed files. Pass `[]` to explicitly " +
      "watch nothing. When omitted, services are auto-detected via the deploy-surface " +
      "pattern list against the services that declare a deploy.config.ts.",
    required: false,
  },
  deployTimeoutSeconds: {
    schema: z.number().int().positive(),
    description:
      "postMerge mode only: maximum seconds to wait for each service's deployment " +
      "(default 600).",
    required: false,
    defaultValue: 600,
  },
  deployIntervalSeconds: {
    schema: z.number().int().positive(),
    description: "postMerge mode only: poll cadence for each deployment wait (default 10).",
    required: false,
    defaultValue: 10,
  },
};

/**
 * Session PR Review Submit command parameters
 * Submits a GitHub PR review through Minsky using the bot identity
 */
export const sessionPrReviewSubmitCommandParams = {
  sessionId: commonSessionParams.sessionId,
  task: commonSessionParams.task,
  repo: commonSessionParams.repo,
  body: {
    schema: z.string().min(1),
    description: "Review body text (overall comment)",
    required: true,
  },
  event: {
    schema: z.enum(["APPROVE", "COMMENT", "REQUEST_CHANGES"]),
    description: "Review event type: APPROVE, COMMENT, or REQUEST_CHANGES",
    required: true,
  },
  comments: {
    schema: z.array(
      z.object({
        path: z.string(),
        line: z.number().int().positive(),
        body: z.string().min(1),
        side: z.enum(["LEFT", "RIGHT"]).optional(),
        startLine: z.number().int().positive().optional(),
        startSide: z.enum(["LEFT", "RIGHT"]).optional(),
        suggestion: z
          .string()
          .optional()
          .describe(
            "Replacement code for a GitHub suggestion block. Line count must match the anchored range."
          ),
        inReplyTo: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "When present, this comment is a REPLY to the existing review comment with this " +
              "database ID. Obtain the ID from reviewThreads[].comments[].databaseId in " +
              "session_pr_review_context. When inReplyTo is set, path/line/side are ignored " +
              "by GitHub — the reply is anchored to the parent comment's location."
          ),
      })
    ),
    description: "Optional inline line-level comments",
    required: false,
  },
  identity: {
    schema: z.enum(["implementer", "reviewer"]).optional(),
    description:
      "Bot identity to post the review under. Defaults: COMMENT → " +
      "implementer (minsky-ai); APPROVE / REQUEST_CHANGES → reviewer " +
      "(minsky-reviewer). APPROVE and REQUEST_CHANGES require " +
      "`github.reviewer.serviceAccount` to be configured. Override only " +
      "when you need to force a specific identity. Supersedes mt#1065.",
    required: false,
  },
  json: commonSessionParams.json,
};

/**
 * Session PR Review Dismiss command parameters
 * Dismisses a GitHub PR review (typically a stale adversarial review after
 * the blocker has been addressed). Posts the dismissal through Minsky using
 * the configured bot identity.
 */
export const sessionPrReviewDismissCommandParams = {
  sessionId: commonSessionParams.sessionId,
  task: commonSessionParams.task,
  repo: commonSessionParams.repo,
  reviewId: {
    schema: z.coerce.number().int().positive(),
    description: "GitHub review ID to dismiss (numeric — see PR review URLs)",
    required: true,
  },
  message: {
    schema: z.string().min(1),
    description:
      "Dismissal reason / message — required by the GitHub API and shown on " +
      "the dismissed review. Include why the review is stale (e.g. 'covers " +
      "commit <sha>; blocker addressed in <sha>').",
    required: true,
  },
  json: commonSessionParams.json,
};

/**
 * Session PR Review Thread Resolve command parameters
 * Resolves or unresolves a GitHub PR review thread (GraphQL-only operation)
 * through Minsky using the configured bot identity.
 *
 * `threadId` is the GraphQL node ID of a `PullRequestReviewThread` object.
 * Sources:
 *  - GraphQL: `pullRequest.reviewThreads.nodes[].id`
 *  - REST: items returned by `GET /repos/{owner}/{repo}/pulls/{n}/threads` carry `node_id` of the thread
 *  - The `reviewThreads[].id` field on `session_pr_review_context` (mt#1343)
 *
 * Note: a review comment's `node_id` is NOT a thread ID. The two are distinct
 * objects in the GitHub API; only thread node IDs are accepted here.
 */
export const sessionPrReviewThreadResolveCommandParams = {
  sessionId: commonSessionParams.sessionId,
  task: commonSessionParams.task,
  repo: commonSessionParams.repo,
  threadId: {
    schema: z.string().min(1),
    description:
      "GraphQL node ID of a PullRequestReviewThread. Obtain from one of: " +
      "(1) session_pr_review_context.reviewThreads[].id, " +
      "(2) GraphQL pullRequest.reviewThreads.nodes[].id, or " +
      "(3) REST GET /repos/{owner}/{repo}/pulls/{pull_number}/threads (each item's node_id). " +
      "Do NOT pass a review comment's node_id (from /pulls/{n}/comments or /pulls/{n}/reviews) — " +
      "comment IDs and thread IDs are distinct objects; the GraphQL mutation will reject the wrong type.",
    required: true,
  },
  action: {
    schema: z.enum(["resolve", "unresolve"]),
    description: 'Action to perform: "resolve" marks the thread as done; "unresolve" reopens it.',
    required: true,
  },
  json: commonSessionParams.json,
};

/**
 * Session PR Check Run Submit command parameters
 * Submits a GitHub Check Run for the session's PR, compiling reviewer findings
 * into check-run annotations (machine-shaped, branch-protection-eligible surface).
 */
export const sessionPrCheckRunSubmitCommandParams = {
  sessionId: commonSessionParams.sessionId,
  task: commonSessionParams.task,
  repo: commonSessionParams.repo,
  findings: {
    schema: z.array(
      z.object({
        path: z.string().min(1),
        startLine: z.number().int().positive(),
        endLine: z.number().int().positive().optional(),
        severity: z.string().min(1),
        title: z.string().min(1),
        message: z.string().min(1),
        rawDetails: z.string().optional(),
      })
    ),
    description:
      "List of reviewer findings to compile into check-run annotations. " +
      "severity: 'BLOCKING' → failure, 'NON-BLOCKING' → warning, other → notice. " +
      "An empty list produces a check run with conclusion 'success' and no annotations.",
    required: true,
  },
  checkRunName: {
    schema: z.string().min(1),
    description:
      "Override the check run name (default: 'minsky-reviewer/findings'). " +
      "Must be stable across runs for branch-protection integration.",
    required: false,
  },
  json: commonSessionParams.json,
};

/**
 * Session exec command parameters
 * Executes a shell command in a session's working directory
 */
export const sessionExecCommandParams = {
  sessionId: commonSessionParams.sessionId,
  task: commonSessionParams.task,
  repo: commonSessionParams.repo,
  command: {
    schema: z.string().min(1),
    description: "Shell command to execute",
    required: true,
  },
  timeout: {
    schema: z.number().int().positive().max(120000).optional(),
    description: "Timeout in milliseconds (default: 30000, max: 120000)",
    required: false,
  },
};

/**
 * Session cleanup command parameters
 * Identifies and removes stale/orphaned sessions
 */
export const sessionCleanupCommandParams = {
  stale: {
    schema: z.boolean(),
    description: "Include stale sessions (>2h inactive)",
    required: false,
    defaultValue: false,
  },
  orphaned: {
    schema: z.boolean(),
    description: "Include orphaned sessions (no local dir AND no remote branch)",
    required: false,
    defaultValue: false,
  },
  olderThan: {
    schema: z.string(),
    description:
      "Include sessions with no activity older than this duration (e.g., '7d', '24h', '30m')",
    required: false,
  },
  dryRun: {
    schema: z.boolean(),
    description: "Preview what would be deleted without actually deleting (default: true)",
    required: false,
    defaultValue: true,
  },
  yes: {
    schema: z.boolean(),
    description: "Skip confirmation prompt",
    required: false,
    defaultValue: false,
  },
  json: {
    schema: z.boolean(),
    description: "Output as JSON",
    required: false,
  },
};

/**
 * Session repair command parameters
 * Repairs various session state issues
 */
export const sessionRepairCommandParams = {
  sessionId: commonSessionParams.sessionId,
  task: commonSessionParams.task,
  repo: commonSessionParams.repo,
  json: commonSessionParams.json,
  debug: commonSessionParams.debug,
  dryRun: {
    schema: z.boolean(),
    description: "Preview repairs without applying changes",
    required: false,
    defaultValue: false,
  },
  auto: {
    schema: z.boolean(),
    description: "Automatically apply safe repairs without confirmation",
    required: false,
    defaultValue: false,
  },
  interactive: {
    schema: z.boolean(),
    description: "Interactive repair mode with confirmations",
    required: false,
    defaultValue: false,
  },
  prState: {
    schema: z.boolean(),
    description: "Focus on PR state issues (branch format, stale state)",
    required: false,
    defaultValue: false,
  },
  backendSync: {
    schema: z.boolean(),
    description: "Sync session record with actual repository backend",
    required: false,
    defaultValue: false,
  },
  force: commonSessionParams.force,
};

/**
 * Session edit-file command parameters
 *
 * CLI wrapper for session.edit_file MCP tool (mt#2612): both entry points now
 * delegate to the same canonical apply-model operation
 * (`applySessionFileEditOperation`, `packages/domain/src/session/session-file-edit-operation.ts`),
 * including the mt#2400 FAIL-CLOSED guard.
 */
export const sessionEditFileCommandParams = {
  sessionId: commonSessionParams.sessionId,
  path: {
    schema: z.string(),
    description: "Path to the file within the session workspace",
    required: true,
  },
  instruction: {
    schema: z.string(),
    description: "Optional high-level instruction guiding how to apply the edit",
    required: false,
  },
  patternFile: {
    schema: z.string(),
    description: "Path to file containing edit pattern (alternative to stdin)",
    required: false,
  },
  dryRun: {
    schema: z.boolean(),
    description: "Preview changes without writing to disk",
    required: false,
    defaultValue: false,
  },
  createDirs: {
    schema: z.boolean(),
    description: "Create parent directories if they don't exist",
    required: false,
    defaultValue: true,
  },
  fullReplace: {
    schema: z.boolean(),
    description:
      "Override the marker-less fail-closed guard (mt#2400). When false (default), editing " +
      "an EXISTING file with marker-less content is REFUSED (it would silently overwrite the " +
      "whole file). Set true to intentionally replace the entire file content.",
    required: false,
    defaultValue: false,
  },
  json: commonSessionParams.json,
  debug: commonSessionParams.debug,
};

/**
 * Session review command parameters
 */
export const sessionReviewCommandParams = {
  sessionId: commonSessionParams.sessionId,
  task: commonSessionParams.task,
  repo: commonSessionParams.repo,
  json: commonSessionParams.json,
  output: {
    schema: z.string(),
    description: "Output format (json, text)",
    required: false,
  },
  prBranch: {
    schema: z.string(),
    description: "PR branch name (defaults to pr/<session-id>)",
    required: false,
  },
  // AI-powered review options
  ai: {
    schema: z.boolean(),
    description: "Enable AI-powered code review analysis",
    required: false,
    defaultValue: false,
  },
  model: {
    schema: z.string(),
    description: "AI model to use (gpt-4o, claude-3.5, etc.)",
    required: false,
  },
  provider: {
    schema: z.string(),
    description: "AI provider (openai, anthropic, google, cohere, mistral)",
    required: false,
  },
  focus: {
    schema: z.enum(["security", "performance", "style", "logic", "testing", "general"]),
    description: "Focus area for AI review",
    required: false,
    defaultValue: "general",
  },
  detailed: {
    schema: z.boolean(),
    description: "Enable detailed file-level AI analysis",
    required: false,
    defaultValue: false,
  },
  autoApprove: {
    schema: z.boolean(),
    description: "Auto-approve if AI score is above threshold",
    required: false,
    defaultValue: false,
  },
  autoComment: {
    schema: z.boolean(),
    description: "Auto-add AI review as changeset comment",
    required: false,
    defaultValue: false,
  },
  includeTaskSpec: {
    schema: z.boolean(),
    description: "Include task specification in AI context",
    required: false,
    defaultValue: false,
  },
  includeHistory: {
    schema: z.boolean(),
    description: "Include git history in AI context",
    required: false,
    defaultValue: false,
  },
  temperature: {
    schema: z.number().min(0).max(1),
    description: "AI creativity vs consistency (0.0-1.0)",
    required: false,
  },
  maxTokens: {
    schema: z.number().positive(),
    description: "Maximum tokens for AI response",
    required: false,
  },
};
