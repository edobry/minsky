/**
 * Session Command Parameters
 *
 * Consolidated parameter definitions for all session commands.
 * Extracted from session.ts as part of modularization effort.
 */
import { z } from "zod";

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
export const sessionApproveCommandParams = {
  sessionId: commonSessionParams.sessionId,
  task: commonSessionParams.task,
  repo: commonSessionParams.repo,
  json: commonSessionParams.json,
};

/**
 * Session merge command parameters.
 * Extends the approve base with merge-only flags.
 */
export const sessionMergeCommandParams = {
  ...sessionApproveCommandParams,
  skipCleanup: {
    schema: z.boolean(),
    description: "Skip session cleanup after merge (preserves session files)",
    required: false,
    defaultValue: false,
  },
  acceptStaleReviewerSilence: {
    schema: z.boolean(),
    description:
      "Operator-override waiver: allow merge when minsky-reviewer[bot] is absent (webhook-miss class). " +
      "All four constraints must hold: (1) PR author must be minsky-ai[bot] -- waiver never applies to human-authored PRs; " +
      "(2) at least one COMMENTED review from the same identity as the PR author must exist; " +
      "(3) no non-DISMISSED CHANGES_REQUESTED review may exist (DISMISSED reviews are excluded from this check); " +
      "(4) no review from minsky-reviewer[bot] may exist -- waiver is inapplicable when the reviewer bot has already acted. " +
      "Emits an audit log entry at INFO level when the waiver is applied. Default: false.",
    required: false,
    defaultValue: false,
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
    schema: z.enum(["feat", "fix", "docs", "style", "refactor", "perf", "test", "chore"]),
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
    schema: z.enum(["feat", "fix", "docs", "style", "refactor", "perf", "test", "chore"]),
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
      "Only match reviews from this GitHub login (e.g., minsky-reviewer[bot]). " +
      "Case-insensitive. Defaults to any reviewer.",
    required: false,
  },
  since: {
    schema: z.string(),
    description:
      "ISO-8601 timestamp; only reviews submitted at or after this time count as matches " +
      "(inclusive lower bound). Defaults to the call's start time.",
    required: false,
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
      })
    ),
    description: "Optional inline line-level comments",
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
 * CLI wrapper for session.edit_file MCP tool
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
